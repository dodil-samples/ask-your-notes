/**
 * Offline smoke test — drives the real router (lib/handler.ts) against an
 * in-memory FakeK3 and a deterministic fake chat, so it runs with NO network,
 * NO credentials, and NO deployed backend: `deno task smoke`.
 *
 * It exercises the whole product: put/get notes, [[wikilink]] parsing →
 * backlinks + graph, semantic search and the keyword fallback, the RAG `ask`
 * path, aggregates, CSV export, and the public/private gate (private locks down
 * the moment an admin key exists). A tiny SQL interpreter backs the handful of
 * queries the handler issues — enough to make every action round-trip for real.
 */

import { handle } from "../handler.ts";
import { parseWikilinks, slugify } from "../actions/common.ts";
import * as bootstrap from "../lib/bootstrap.ts";
import * as models from "../lib/models.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** In-memory K3: object store + three tables + a targeted SQL interpreter. */
class FakeK3 {
  objects = new Map<string, string>();
  tables: Record<string, Row[]> = { notes: [], links: [], api_keys: [] };
  vectorEnabled = true;

  // -- provisioning (no-ops) --
  ensureBucket() {}
  createTable() {}
  ensureVector() {}
  hasVectorCollection() { return true; }
  triggerIngest() {}
  compact() {}

  // -- objects --
  putObject(key: string, body: string) { this.objects.set(key, String(body)); }
  getObject(key: string): string {
    if (!this.objects.has(key)) throw new Error(`no object ${key}`);
    return this.objects.get(key)!;
  }

  // -- writes (honor merge keys) --
  private mergeKeys: Record<string, string[]> = {
    notes: ["note_id"], links: ["src_id", "dst_slug"], api_keys: ["key"],
  };
  insert(table: string, rows: Row[]) {
    const keys = this.mergeKeys[table] ?? [];
    for (const r of rows) {
      const i = this.tables[table].findIndex((x) => keys.every((k) => x[k] === r[k]));
      if (i >= 0) this.tables[table][i] = { ...this.tables[table][i], ...r };
      else this.tables[table].push({ ...r });
    }
  }
  upsert(table: string, rows: Row[]) { this.insert(table, rows); }

  // -- vector: rank notes by naive token overlap with the query --
  vectorSearch(query: string, topK = 8): Row[] {
    if (!this.vectorEnabled) return [];
    const live = this.tables.notes.filter((n) => Number(n.deleted) !== 1);
    const toks = query.toLowerCase().split(/\W+/).filter(Boolean);
    const scored = live.map((n) => {
      const hay = `${n.title} ${n.excerpt} ${this.objects.get(`notes/${n.note_id}.md`) ?? ""}`.toLowerCase();
      const score = toks.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
      return { n, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
    return scored.map((x, i) => ({
      key: `notes/${x.n.note_id}.md`,
      text: this.objects.get(`notes/${x.n.note_id}.md`) ?? x.n.excerpt,
      score: 0.9 - i * 0.05,
    }));
  }

  // -- a small SQL interpreter for exactly the queries the handler issues --
  execute(sql: string): Row[] {
    const S = sql.replace(/\s+/g, " ").trim();
    const live = () => this.tables.notes.filter((n) => Number(n.deleted) !== 1);
    const val = (col: string) => {
      const m = S.match(new RegExp(col.replace(/[.]/g, "\\.") + "\\s*=\\s*'((?:[^']|'')*)'"));
      return m ? m[1].replace(/''/g, "'") : null;
    };
    const inList = (): string[] => {
      const m = S.match(/IN \(([^)]*)\)/);
      if (!m) return [];
      return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    };
    const limit = () => { const m = S.match(/LIMIT (\d+)/); return m ? Number(m[1]) : 1000; };

    // ---- writes via SQL ----
    if (S.startsWith("UPDATE notes SET deleted=1")) {
      const id = val("note_id"); const n = this.tables.notes.find((x) => x.note_id === id);
      if (n) n.deleted = 1; return [];
    }
    if (S.startsWith("UPDATE notes SET created_at")) return []; // preserve-created_at no-op
    if (S.startsWith("UPDATE api_keys SET disabled = 1")) {
      const k = val("key"); const r = this.tables.api_keys.find((x) => x.key === k);
      if (r) r.disabled = 1; return [];
    }
    if (S.startsWith("DELETE FROM links")) {
      const src = val("src_id"); this.tables.links = this.tables.links.filter((l) => l.src_id !== src); return [];
    }

    // ---- aggregates ----
    if (S.includes("COUNT(*) AS notes")) {
      const l = live();
      return [{ notes: l.length, words: l.reduce((a, n) => a + Number(n.word_count || 0), 0) }];
    }
    if (S.includes("COUNT(*) AS links")) return [{ links: this.tables.links.length }];

    // ---- api_keys ----
    if (S.includes("FROM api_keys")) {
      const active = this.tables.api_keys.filter((k) => Number(k.disabled) === 0);
      if (S.includes("disabled = 0")) return active.map((k) => ({ key: k.key, kind: k.kind }));
      return [...this.tables.api_keys];
    }

    // ---- tags ----
    if (S.startsWith("SELECT tags FROM notes")) return live().filter((n) => (n.tags ?? "") !== "").map((n) => ({ tags: n.tags }));

    // ---- backlinks step 1: source ids that link here (the notes IN-scan is below) ----
    if (S.startsWith("SELECT DISTINCT src_id FROM links WHERE")) {
      const dstId = val("dst_id"); const dstSlug = val("dst_slug");
      const ids = [...new Set(this.tables.links.filter((l) => l.dst_id === dstId || l.dst_slug === dstSlug).map((l) => l.src_id))];
      return ids.map((id) => ({ src_id: id }));
    }

    // ---- outgoing links for a note ----
    if (S.startsWith("SELECT dst_slug, dst_id, dst_title FROM links WHERE src_id=")) {
      const src = val("src_id");
      return this.tables.links.filter((l) => l.src_id === src)
        .map((l) => ({ dst_slug: l.dst_slug, dst_id: l.dst_id, dst_title: l.dst_title }));
    }

    // ---- graph edges ----
    if (S.startsWith("SELECT src_id, dst_id FROM links")) {
      return this.tables.links.filter((l) => (l.dst_id ?? "") !== "").map((l) => ({ src_id: l.src_id, dst_id: l.dst_id }));
    }

    // ---- single-note lookups ----
    if (S.startsWith("SELECT note_id FROM notes WHERE slug=")) {
      const slug = val("slug"); const n = live().find((x) => x.slug === slug);
      return n ? [{ note_id: n.note_id }] : [];
    }
    if (S.startsWith("SELECT note_id, slug FROM notes WHERE note_id=")) {
      const id = val("note_id"); const n = this.tables.notes.find((x) => x.note_id === id);
      return n ? [{ note_id: n.note_id, slug: n.slug }] : [];
    }
    if (S.startsWith("SELECT note_id, title, slug, tags, word_count, created_at, updated_at FROM notes WHERE")
      && (S.includes("WHERE note_id=") || S.includes("WHERE slug="))) {
      // get_note now resolves by note_id OR slug in one query.
      const n = S.includes("WHERE note_id=")
        ? live().find((x) => x.note_id === val("note_id"))
        : live().find((x) => x.slug === val("slug"));
      return n ? [n] : [];
    }
    if (S.startsWith("SELECT note_id, slug, title FROM notes WHERE deleted=0 AND slug IN")) {
      const slugs = new Set(inList()); return live().filter((n) => slugs.has(n.slug))
        .map((n) => ({ note_id: n.note_id, slug: n.slug, title: n.title }));
    }
    if (S.includes("FROM notes WHERE deleted=0 AND note_id IN")) {
      const ids = new Set(inList()); return live().filter((n) => ids.has(n.note_id))
        .map((n) => ({ note_id: n.note_id, title: n.title, slug: n.slug, excerpt: n.excerpt }));
    }

    // ---- keyword search fallback ----
    if (S.includes("title LIKE") && S.includes("excerpt LIKE")) {
      const m = S.match(/title LIKE '%((?:[^']|'')*)%'/); const q = (m ? m[1] : "").toLowerCase();
      return live().filter((n) => `${n.title} ${n.excerpt}`.toLowerCase().includes(q))
        .map((n) => ({ note_id: n.note_id, title: n.title, slug: n.slug, excerpt: n.excerpt })).slice(0, limit());
    }

    // ---- list / export / graph nodes: any remaining "FROM notes WHERE deleted=0" ----
    if (S.includes("FROM notes WHERE deleted=0")) {
      let rows = live();
      const tag = val("tags");
      if (tag) rows = rows.filter((n) => String(n.tags ?? "").split(",").includes(tag));
      rows = [...rows].sort((a, b) => S.includes("ORDER BY title")
        ? String(a.title).localeCompare(String(b.title))
        : String(b.updated_at).localeCompare(String(a.updated_at)));
      return rows.slice(0, limit());
    }
    return [];
  }
}

// --------------------------------------------------------------------------- harness
const fake = new FakeK3();
bootstrap._setEnsure(fake);
models._setChat((messages) => {
  // Deterministic "grounded" answer: echo the note titles handed in as context.
  const ctx = messages.find((m) => m.role === "user")?.content ?? "";
  const titles = [...ctx.matchAll(/### (.+)/g)].map((m) => m[1]);
  return Promise.resolve(`Based on your notes, see ${titles.map((t) => `[${t}]`).join(", ")}.`);
});

const enc = new TextEncoder();
let failures = 0;
const assert = (cond: unknown, msg: string) => {
  if (cond) { console.log(`  ✓ ${msg}`); } else { console.log(`  ✗ FAIL: ${msg}`); failures++; }
};
async function call(payload: unknown): Promise<Row> {
  return JSON.parse(await handle(enc.encode(JSON.stringify(payload)), {}));
}

// --------------------------------------------------------------------------- 0) pure helpers
console.log("\n### pure helpers");
assert(slugify("Atomic Notes!") === "atomic-notes", "slugify normalizes to a wikilink target");
const links = parseWikilinks("Links to [[Atomic notes]], [[Backlinks|see here]] and [[Atomic notes]] again.");
assert(links.length === 2 && links.includes("Atomic notes") && links.includes("Backlinks"),
  "parseWikilinks dedupes and strips aliases");

// --------------------------------------------------------------------------- 1) authoring
console.log("\n### authoring (put_note) + wikilink graph");
const a = await call({ action: "put_note", title: "Zettelkasten",
  body: "A vault is atomic notes that link. See [[Atomic notes]] and [[Backlinks]].", tags: ["pkm", "method"] });
assert(a.ok && a.result.note_id?.startsWith("n_"), "put_note mints a note id");
assert(a.result.links === 2, "put_note recorded 2 outgoing wikilinks");
assert(fake.objects.has(`notes/${a.result.note_id}.md`), "note body persisted as a markdown object");

const b = await call({ action: "put_note", title: "Atomic notes",
  body: "One idea per note. This is the heart of [[Zettelkasten]].", tags: ["pkm"] });
assert(b.ok, "put_note (second note) ok");

// --------------------------------------------------------------------------- 2) reading
console.log("\n### reading (get_note, backlinks, graph)");
const g = await call({ action: "get_note", slug: "atomic-notes" });
assert(g.ok && g.result.title === "Atomic notes", "get_note resolves by slug");
assert(g.result.body.includes("One idea per note"), "get_note round-trips the body object");
assert(g.result.backlinks.some((n: Row) => n.slug === "zettelkasten"), "Zettelkasten backlinks to Atomic notes");
assert(String(g.result.body).includes("[[Zettelkasten]]"), "body carries the outgoing [[wikilink]] (client derives 'Links to')");

const bl = await call({ action: "backlinks", slug: "backlinks" });
assert(bl.ok && bl.result.backlinks.some((n: Row) => n.slug === "zettelkasten"),
  "a 'future link' backlinks even before its target note exists");

const graph = await call({ action: "graph" });
assert(graph.ok && graph.result.node_count === 2 && graph.result.edge_count >= 1,
  "graph returns nodes + resolved edges");

// --------------------------------------------------------------------------- 3) search + ask
console.log("\n### semantic search + RAG ask");
const s = await call({ action: "search", query: "atomic linking method" });
assert(s.ok && s.result.mode === "semantic" && s.result.results.length >= 1, "semantic search returns ranked hits");

fake.vectorEnabled = false;
const sk = await call({ action: "search", query: "Zettelkasten" });
assert(sk.ok && sk.result.mode === "keyword" && sk.result.results.length >= 1,
  "search degrades to a keyword scan when the index is cold");
fake.vectorEnabled = true;

const ans = await call({ action: "ask", query: "what is a zettelkasten?" });
assert(ans.ok && ans.result.citations.length >= 1, "ask returns citations");
assert(String(ans.result.answer).includes("["), "ask answer is grounded (cites note titles)");

// --------------------------------------------------------------------------- 4) aggregates + export
console.log("\n### aggregates + export");
const ov = await call({ action: "public_overview" });
assert(ov.ok && ov.result.totals.notes === 2 && ov.result.totals.links >= 2, "public_overview counts notes + links");
assert(ov.result.top_tags.some((t: Row) => t.tag === "pkm"), "public_overview surfaces top tags");
const csv = await call({ action: "export", format: "csv" });
assert(csv.ok && csv.result.format === "csv" && csv.result.csv.includes("note_id"), "export renders CSV");

// --------------------------------------------------------------------------- 5) public/private gate
console.log("\n### public/private gate");
const created = await call({ action: "create_key", kind: "admin", label: "smoke" });
const adminKey = created.result.key as string;
assert(created.ok && adminKey.startsWith("ak_"), "create_key mints an admin key");
const denied = await call({ action: "put_note", title: "should fail", body: "no key" });
assert(!denied.ok && denied.code === 401, "private tier locks down once an admin key exists");
const allowed = await call({ action: "put_note", title: "with key", body: "ok", key: adminKey });
assert(allowed.ok, "admin key unlocks the private tier");
const stillPublic = await call({ action: "public_overview" });
assert(stillPublic.ok, "public tier stays open (no public key configured)");
await call({ action: "revoke_key", key: adminKey, revoke: adminKey });

// --------------------------------------------------------------------------- done
console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILURE(S)`}`);
if (failures > 0) Deno.exit(1);
