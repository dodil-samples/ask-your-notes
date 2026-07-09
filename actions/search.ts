/**
 * Search + Ask — semantic search over note bodies (keyword fallback while the
 * index warms), and the headline feature: `ask`, a retrieval-augmented answer
 * grounded in the vault, with citations.
 */

import { K3 } from "../lib/k3.ts";
import * as models from "../lib/models.ts";
import { EVENTUAL, type Json, noteIdFromKey, sqlStr } from "./common.ts";

export async function search(k3: K3, p: Json): Promise<Json> {
  const query = String(p.query ?? "").trim();
  if (!query) return { query, results: [] };
  const hits = await k3.vectorSearch(query, Number(p.top_k ?? 8));
  const results = await hydrateHits(k3, hits);
  // Semantic index still warming up? Fall back to a keyword scan so the box is
  // never dead on a fresh vault. Two things the naive `title LIKE '%<whole query>%'`
  // got wrong: (1) K3's SQL LIKE is CASE-SENSITIVE, so "zettelkasten" missed a note
  // titled "Zettelkasten"; (2) matching the entire query as one substring can never
  // hit a natural-language question ("what is a zettelkasten?"). So: lowercase both
  // sides and match on any significant content word across title / excerpt / tags.
  if (results.length === 0) {
    const rows = await keywordScan(k3, query, Number(p.top_k ?? 8));
    return { query, mode: "keyword", results: rows.map((r) => ({ ...r, score: null })) };
  }
  return { query, mode: "semantic", results };
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "was", "were", "what", "which", "how",
  "why", "who", "when", "where", "and", "or", "for", "on", "with", "about", "do", "does",
  "did", "my", "your", "me", "i", "it", "this", "that", "note", "notes", "tell", "explain",
]);

/** Case-insensitive, tokenized keyword match: a row hits if ANY content word of the
 *  query appears in its title, excerpt, or tags. Falls back to the raw query when the
 *  question is all stopwords/short tokens. */
async function keywordScan(k3: K3, query: string, topK: number): Promise<Record<string, unknown>[]> {
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))].slice(0, 8);
  const terms = tokens.length ? tokens : [query.toLowerCase().trim()].filter(Boolean);
  if (!terms.length) return [];
  const ors = terms.map((t) => {
    const like = sqlStr("%" + t.replace(/[%_]/g, "") + "%");
    return `LOWER(title) LIKE ${like} OR LOWER(excerpt) LIKE ${like} OR LOWER(tags) LIKE ${like}`;
  }).join(" OR ");
  return await k3.execute(
    `SELECT note_id, title, slug, excerpt FROM notes WHERE deleted=0 AND (${ors}) ORDER BY updated_at DESC LIMIT ${topK}`,
    EVENTUAL,
  );
}

/** Turn raw vector hits (which carry the object `key` + `content`) into note cards. */
export async function hydrateHits(k3: K3, hits: Array<Record<string, unknown>>): Promise<Json[]> {
  const byId = new Map<string, Json>();
  for (const h of hits) {
    const id = noteIdFromKey(String(h.key ?? ""));
    if (id && !byId.has(id)) byId.set(id, { note_id: id, score: h.score, snippet: String(h.text ?? "").slice(0, 240) });
  }
  if (byId.size === 0) return [];
  const rows = await k3.execute(
    `SELECT note_id, title, slug, excerpt FROM notes WHERE deleted=0 AND ` +
      `note_id IN (${[...byId.keys()].map(sqlStr).join(", ")})`,
    EVENTUAL,
  );
  const out: Json[] = [];
  for (const r of rows) {
    const base = byId.get(String(r.note_id))!;
    out.push({ ...base, title: r.title, slug: r.slug, excerpt: r.excerpt });
  }
  // Preserve the vector-ranked order.
  out.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  return out;
}

// The headline feature: retrieval-augmented answer over the vault. Retrieve the
// most relevant notes, then have an Ignite model answer the question grounded in
// their text, citing note titles. Degrades to "here are relevant notes" when the
// model or the vector index is unavailable — the search still works.
export async function ask(k3: K3, p: Json): Promise<Json> {
  const query = String(p.query ?? p.question ?? "").trim();
  if (!query) return { error: "ask needs a `query`", code: 400 };
  const topK = Math.min(Number(p.top_k ?? 6), 12);
  const found = await search(k3, { query, top_k: topK });
  const results: Json[] = found.results ?? [];
  if (results.length === 0) {
    return { query, answer: "I couldn't find anything in your notes about that yet.", citations: [], used_notes: 0 };
  }
  // Pull the bodies of the top hits to ground the answer.
  const contexts: string[] = [];
  const citations: Json[] = [];
  for (const r of results.slice(0, topK)) {
    let body = String(r.snippet ?? "");
    try {
      body = await k3.getObject(`notes/${r.note_id}.md`) || body;
    } catch { /* use the snippet we already have */ }
    contexts.push(`### ${r.title}\n${body.slice(0, 1500)}`);
    citations.push({ note_id: r.note_id, title: r.title, slug: r.slug, score: r.score });
  }
  let answer = "";
  try {
    answer = await models.chat([
      {
        role: "system",
        content:
          "You are a helpful assistant answering questions using ONLY the user's personal notes provided " +
          "below. Cite the notes you use by their title in [square brackets]. If the notes don't contain " +
          "the answer, say so plainly — do not invent facts.",
      },
      { role: "user", content: `Notes:\n\n${contexts.join("\n\n---\n\n")}\n\nQuestion: ${query}` },
    ], 700);
  } catch { /* model unavailable */ }
  if (!answer) {
    answer = `Found ${citations.length} relevant note(s): ` + citations.map((c) => c.title).join(", ") +
      ". (The answer model is unavailable right now — open the notes above.)";
  }
  return { query, answer, citations, used_notes: citations.length, mode: found.mode };
}
