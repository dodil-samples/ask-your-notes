/**
 * Idempotent schema + storage bootstrap for Ask-Your-Notes.
 *
 * Creates the bucket, two warehouse tables (`notes` metadata, `links` graph),
 * the `api_keys` gate table, and the notes vector collection (semantic search +
 * RAG). Guarded so it runs once per cold start; re-creating an existing
 * table/bucket is ignored.
 *
 * Full note bodies live as markdown OBJECTS (`notes/<id>.md`); the table holds
 * only lightweight metadata, so a list/search never drags whole documents around
 * and the vector engine ingests the object bodies directly.
 */

import { col, K3, T } from "./k3.ts";

export const BUCKET = Deno.env.get("NOTES_BUCKET") ?? "ask-your-notes";
export const NOTES_COLLECTION = Deno.env.get("NOTES_COLLECTION") ?? "notes";

const state = { base: false, vector: false };

// One row per note — the metadata index. The markdown body is the object
// `notes/<note_id>.md`; `excerpt` is a short plaintext lead for list views.
const NOTES_COLUMNS = [
  col("note_id", T.STRING, false),
  col("title", T.STRING),
  col("slug", T.STRING), // normalized title, the wikilink target
  col("tags", T.STRING), // comma-separated
  col("excerpt", T.STRING),
  col("word_count", T.INT),
  col("created_at", T.STRING),
  col("updated_at", T.STRING),
  col("deleted", T.INT), // soft-delete tombstone
];

// One row per wikilink edge (`[[Target]]` inside a note body). `dst_id` is filled
// when the target resolves to an existing note; unresolved links keep `dst_slug`
// only, so a backlink appears the moment the target is created ("future link").
const LINKS_COLUMNS = [
  col("src_id", T.STRING, false),
  col("dst_slug", T.STRING, false),
  col("dst_id", T.STRING),
  col("dst_title", T.STRING),
];

// One row per API key — the public/private gate's user-management store (gate.ts).
const API_KEYS_COLUMNS = [
  col("key", T.STRING, false),
  col("label", T.STRING),
  col("kind", T.STRING), // public | admin
  col("created_at", T.STRING),
  col("disabled", T.INT),
];

export function k3(): K3 {
  return new K3(BUCKET);
}

// Test hook: inject a fake K3 so smoke.ts drives the real handler offline.
// deno-lint-ignore no-explicit-any
let _override: any = null;
// deno-lint-ignore no-explicit-any
export function _setEnsure(fake: any): void {
  _override = fake;
  state.base = true; // skip real provisioning
  state.vector = true;
}

export async function ensure(): Promise<K3> {
  if (_override) return _override as K3;
  const c = k3();
  if (!state.base) {
    await c.ensureBucket("Ask-your-notes: notes, links, vault vector index");
    try {
      await c.createTable("notes", NOTES_COLUMNS, ["note_id"]);
    } catch { /* already exists */ }
    try {
      // A note may link the same slug more than once; merge on the (src,dst) pair
      // so re-saving a note doesn't fan out duplicate edges.
      await c.createTable("links", LINKS_COLUMNS, ["src_id", "dst_slug"]);
    } catch { /* already exists */ }
    try {
      await c.createTable("api_keys", API_KEYS_COLUMNS, ["key"]);
    } catch { /* already exists */ }
    state.base = true;
  }
  // Vector engine provisions asynchronously (VBase spin-up takes minutes), so
  // NEVER block the request on it: run setup under a hard, *cancelling* time
  // budget. One AbortController is threaded into every provisioning fetch, so
  // when the budget fires all in-flight and pending calls abort at once.
  if (!state.vector) {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException("vector setup budget exceeded", "TimeoutError")),
      30000,
    );
    try {
      await c.ensureVector(NOTES_COLLECTION, "text_embedding_index", ["notes/**"], ctrl.signal);
      state.vector = await c.hasVectorCollection(ctrl.signal);
    } catch { /* slow / not ready — retry next invocation, request still succeeds */ } finally {
      clearTimeout(timer);
    }
  }
  return c;
}
