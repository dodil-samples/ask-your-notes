/**
 * Shared helpers for the action modules: time, slugs, wikilink parsing, excerpts,
 * and id resolution.
 *
 * The rule that keeps this repo traceable: `actions/` is WHAT the product does
 * (one file per domain, mapping 1:1 to the actions table in the README), `lib/`
 * is HOW it talks to things (K3, models, the gate).
 */

import { K3 } from "../lib/k3.ts";
import { monotonicUlid } from "@std/ulid";

// deno-lint-ignore no-explicit-any
export type Json = Record<string, any>;

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const uid = () => "n_" + monotonicUlid();
export const sqlStr = (v: unknown) => "'" + String(v).replace(/'/g, "''") + "'";

// Freshness for read queries. STRONG merges the write-log on every read (~1.5s+ per
// query here); EVENTUAL serves the compacted snapshot (cheap). Reads use EVENTUAL and
// writes compact() right after, so the vault still reads-your-writes.
export const EVENTUAL = "FRESHNESS_EVENTUAL";

/** Obsidian-style slug: lowercased, non-alnum → hyphen. The wikilink target. */
export function slugify(s: string): string {
  return (String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled").slice(0, 80);
}

/** Extract `[[Wiki Links]]` (with optional `|alias`) from a markdown body. */
export function parseWikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].trim();
    if (target) out.add(target);
  }
  return [...out];
}

/** First ~240 chars of the body as plain text, markdown syntax stripped. */
export function excerptOf(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, 240);
}

export const wordCount = (body: string) => (body.trim().match(/\S+/g) ?? []).length;
export const noteIdFromKey = (key: string) => (key.match(/notes\/([^/]+)\.md$/) ?? [])[1] ?? "";

/** Resolve a note id from either `note_id` or a `slug` on the payload. */
export async function resolveId(k3: K3, p: Json): Promise<string> {
  if (p.note_id) return String(p.note_id);
  if (p.slug) {
    const hit = (await k3.execute(
      `SELECT note_id FROM notes WHERE slug=${sqlStr(slugify(p.slug))} AND deleted=0 LIMIT 1`,
    ))[0];
    return String(hit?.note_id ?? "");
  }
  return "";
}
