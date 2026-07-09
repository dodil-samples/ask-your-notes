/**
 * Notes — the vault: authoring (put/delete, PRIVATE), reading a note with its
 * links + backlinks, listing, tags, the link graph, and export.
 */

import { K3 } from "../lib/k3.ts";
import { retry } from "@std/async";
import { stringify as csvStringify } from "@std/csv";
import {
  excerptOf,
  type Json,
  noteIdFromKey,
  nowIso,
  parseWikilinks,
  resolveId,
  slugify,
  sqlStr,
  uid,
  wordCount,
} from "./common.ts";

// ------------------------------------------------------------------------- writes
export async function putNote(k3: K3, p: Json): Promise<Json> {
  const title = String(p.title ?? "").trim();
  const body = String(p.body ?? "");
  if (!title && !body) return { error: "a note needs a title or a body", code: 400 };
  const now = nowIso();
  const slug = slugify(p.slug ?? title ?? body.slice(0, 40));
  // Update-in-place when an id (or an existing slug) is supplied; otherwise mint one.
  let noteId = String(p.note_id ?? "");
  if (!noteId) {
    const hit = (await k3.execute(
      `SELECT note_id FROM notes WHERE slug=${sqlStr(slug)} AND deleted=0 LIMIT 1`,
    ))[0];
    noteId = String(hit?.note_id ?? "") || uid();
  }

  // The markdown body is the durable source of truth — write it first, with a
  // bounded retry, since it's the one write we can't lose.
  await retry(() => k3.putObject(`notes/${noteId}.md`, body, "text/markdown"), {
    maxAttempts: 3,
    minTimeout: 200,
    maxTimeout: 1500,
    multiplier: 2,
  });

  await k3.upsert("notes", [{
    note_id: noteId,
    title: title || slug,
    slug,
    tags: (Array.isArray(p.tags) ? p.tags.join(",") : String(p.tags ?? "")).toLowerCase(),
    excerpt: excerptOf(body),
    word_count: wordCount(body),
    created_at: now,
    updated_at: now,
    deleted: 0,
  }]);
  // Preserve created_at on updates without clobbering it.
  await k3.execute(
    `UPDATE notes SET created_at=CASE WHEN created_at='' OR created_at IS NULL OR created_at>${sqlStr(now)} ` +
      `THEN ${sqlStr(now)} ELSE created_at END WHERE note_id=${sqlStr(noteId)}`,
  );

  // Rebuild this note's outgoing wikilink edges: drop the old set, insert the new.
  const targets = parseWikilinks(body);
  await k3.execute(`DELETE FROM links WHERE src_id=${sqlStr(noteId)}`);
  if (targets.length) {
    const slugs = targets.map(slugify);
    const resolved = new Map<string, { note_id: string; title: string }>();
    const rows = await k3.execute(
      `SELECT note_id, slug, title FROM notes WHERE deleted=0 AND slug IN (${slugs.map(sqlStr).join(", ")})`,
    );
    for (const r of rows) resolved.set(String(r.slug), { note_id: String(r.note_id), title: String(r.title) });
    await k3.insert("links", targets.map((t) => {
      const s = slugify(t);
      const hit = resolved.get(s);
      return { src_id: noteId, dst_slug: s, dst_id: hit?.note_id ?? "", dst_title: hit?.title ?? t };
    }));
  }

  // Kick vector re-ingest of the new/changed body (best-effort, budgeted).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("ingest budget", "TimeoutError")), 12000);
  try {
    await k3.triggerIngest(ctrl.signal);
  } catch { /* best-effort */ } finally {
    clearTimeout(timer);
  }
  return { note_id: noteId, slug, title: title || slug, links: targets.length, word_count: wordCount(body) };
}

export async function deleteNote(k3: K3, p: Json): Promise<Json> {
  const noteId = await resolveId(k3, p);
  if (!noteId) return { error: "note not found (pass note_id or slug)", code: 404 };
  await k3.execute(`UPDATE notes SET deleted=1, updated_at=${sqlStr(nowIso())} WHERE note_id=${sqlStr(noteId)}`);
  await k3.execute(`DELETE FROM links WHERE src_id=${sqlStr(noteId)}`);
  try {
    await k3.putObject(`notes/${noteId}.md`, "", "text/markdown"); // tombstone the body
  } catch { /* best-effort */ }
  return { deleted: noteId };
}

export async function reindex(k3: K3, _p: Json): Promise<Json> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("reindex budget", "TimeoutError")), 15000);
  try {
    await k3.triggerIngest(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
  return { note: "K3 is re-embedding the vault for semantic search." };
}

// ------------------------------------------------------------------------- reads
export async function getNote(k3: K3, p: Json): Promise<Json> {
  const noteId = await resolveId(k3, p);
  if (!noteId) return { error: "note not found (pass note_id or slug)", code: 404 };
  const meta = (await k3.execute(
    `SELECT note_id, title, slug, tags, word_count, created_at, updated_at FROM notes ` +
      `WHERE note_id=${sqlStr(noteId)} AND deleted=0 LIMIT 1`,
  ))[0];
  if (!meta) return { error: "note not found", code: 404 };
  let body = "";
  try {
    body = await k3.getObject(`notes/${noteId}.md`);
  } catch { /* body missing — return metadata only */ }
  const outgoing = await k3.execute(
    `SELECT dst_slug, dst_id, dst_title FROM links WHERE src_id=${sqlStr(noteId)} ORDER BY dst_title`,
  );
  const incoming = await backlinksFor(k3, meta);
  return {
    ...meta,
    tags: String(meta.tags ?? "").split(",").filter(Boolean),
    body,
    outgoing_links: outgoing,
    backlinks: incoming,
  };
}

export async function backlinksFor(k3: K3, meta: Json): Promise<Json[]> {
  const noteId = String(meta.note_id ?? "");
  const slug = String(meta.slug ?? "");
  // A backlink resolves either by id (target existed when the link was saved) or
  // by slug (a "future link" that pointed here before this note existed). For an
  // unresolved stub node (no note yet) we match by slug only — matching an empty
  // dst_id would wrongly capture every unresolved link.
  const conds: string[] = [];
  if (noteId) conds.push(`l.dst_id=${sqlStr(noteId)}`);
  if (slug) conds.push(`l.dst_slug=${sqlStr(slug)}`);
  if (!conds.length) return [];
  return await k3.execute(
    `SELECT DISTINCT n.note_id, n.title, n.slug, n.excerpt FROM links l ` +
      `JOIN notes n ON n.note_id = l.src_id AND n.deleted=0 ` +
      `WHERE ${conds.join(" OR ")} ORDER BY n.title LIMIT 100`,
  );
}

export async function backlinks(k3: K3, p: Json): Promise<Json> {
  const noteId = await resolveId(k3, p);
  let meta = noteId
    ? (await k3.execute(`SELECT note_id, slug FROM notes WHERE note_id=${sqlStr(noteId)} LIMIT 1`))[0]
    : undefined;
  if (!meta) {
    // Stub / unresolved node: no note exists at this slug yet, but other notes may
    // already link to it ("future links"). Answer purely from the slug.
    const slug = p.slug ? slugify(String(p.slug)) : "";
    if (!slug) return { error: "pass note_id or slug", code: 400 };
    meta = { note_id: "", slug };
  }
  return { note_id: meta.note_id, slug: meta.slug, backlinks: await backlinksFor(k3, meta) };
}

export async function listNotes(k3: K3, p: Json): Promise<Json> {
  const limit = Math.min(Number(p.limit ?? 50), 500);
  const tag = String(p.tag ?? "").toLowerCase().trim();
  const where = ["deleted=0"];
  if (tag) where.push(`(tags = ${sqlStr(tag)} OR tags LIKE ${sqlStr("%" + tag + "%")})`);
  const order = p.sort === "title" ? "title ASC" : "updated_at DESC";
  const rows = await k3.execute(
    `SELECT note_id, title, slug, tags, excerpt, word_count, updated_at FROM notes ` +
      `WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
  );
  return {
    notes: rows.map((r) => ({ ...r, tags: String(r.tags ?? "").split(",").filter(Boolean) })),
    count: rows.length,
  };
}

export async function tags(k3: K3, _p: Json): Promise<Json> {
  const rows = await k3.execute("SELECT tags FROM notes WHERE deleted=0 AND tags <> ''");
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of String(r.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const out = [...counts.entries()].map(([tag, n]) => ({ tag, notes: n })).sort((a, b) => b.notes - a.notes);
  return { tags: out, count: out.length };
}

export async function graph(k3: K3, p: Json): Promise<Json> {
  const limit = Math.min(Number(p.limit ?? 200), 1000);
  const nodes = await k3.execute(
    `SELECT note_id, title, slug, excerpt FROM notes WHERE deleted=0 ORDER BY updated_at DESC LIMIT ${limit}`,
  );
  const ids = new Set(nodes.map((n) => String(n.note_id)));
  const edgeRows = await k3.execute(`SELECT src_id, dst_id FROM links WHERE dst_id <> ''`);
  const edges = edgeRows
    .filter((e) => ids.has(String(e.src_id)) && ids.has(String(e.dst_id)))
    .map((e) => ({ source: String(e.src_id), target: String(e.dst_id) }));

  // The structural graph (wikilink edges) is always returned. When the client asks
  // to `group`, we ALSO overlay a semantic clustering: run each note through vector
  // search, connect notes whose similarity clears a threshold, and union-find the
  // result into colour-able clusters — Obsidian's "group by folder", but by meaning.
  let groups: number[] | undefined, simEdges: Json[] | undefined, groupCount = 0;
  if (p.group && nodes.length > 1 && nodes.length <= 80) {
    // 0.58 sits in the natural gap for jina-embeddings-v4: same-topic notes score
    // ~0.6-0.75, loosely-related cross-topic notes ~0.5-0.54. Tune per embed model.
    const g = await similarityGroups(k3, nodes, Number(p.sim_threshold ?? 0.58));
    groups = g.groups;
    simEdges = g.simEdges;
    groupCount = g.groupCount;
  }

  const outNodes = nodes.map((n, i) => ({
    note_id: n.note_id,
    title: n.title,
    slug: n.slug,
    ...(groups ? { group: groups[i] } : {}),
  }));
  return {
    nodes: outNodes,
    edges,
    node_count: nodes.length,
    edge_count: edges.length,
    ...(groups ? { grouped: true, group_count: groupCount, sim_edges: simEdges } : {}),
  };
}

/** Cluster notes by vector similarity. For each note we embed-search the vault and
 *  union it with its nearest neighbours above `threshold`; connected components are
 *  the groups. Searches run in parallel (bounded by node count ≤ 80). Best-effort:
 *  if the vector index is cold/unavailable, every note lands in its own group. */
async function similarityGroups(
  k3: K3,
  nodes: Record<string, unknown>[],
  threshold: number,
): Promise<{ groups: number[]; simEdges: Json[]; groupCount: number }> {
  const idOf = (n: Record<string, unknown>) => String(n.note_id);
  const index = new Map(nodes.map((n, i) => [idOf(n), i]));
  const parent = nodes.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) parent[x] = parent[parent[x]], x = parent[x];
    return x;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };

  const hitsPer = await Promise.all(
    nodes.map((n) =>
      k3.vectorSearch(`${String(n.title ?? "")}. ${String(n.excerpt ?? "")}`.trim(), 5).catch(() => [])
    ),
  );

  const seen = new Set<string>();
  const simEdges: Json[] = [];
  hitsPer.forEach((hits, i) => {
    const srcId = idOf(nodes[i]);
    for (const h of hits) {
      const tid = noteIdFromKey(String(h.key ?? ""));
      if (!tid || tid === srcId || !index.has(tid)) continue;
      const score = Number(h.score ?? 0);
      if (score < threshold) continue;
      union(i, index.get(tid)!);
      const pair = [srcId, tid].sort().join("|");
      if (!seen.has(pair)) {
        seen.add(pair);
        simEdges.push({ source: srcId, target: tid, score: Math.round(score * 1000) / 1000 });
      }
    }
  });

  const rootToGroup = new Map<number, number>();
  const groups = nodes.map((_, i) => {
    const r = find(i);
    if (!rootToGroup.has(r)) rootToGroup.set(r, rootToGroup.size);
    return rootToGroup.get(r)!;
  });
  return { groups, simEdges, groupCount: rootToGroup.size };
}

export async function exportVault(k3: K3, p: Json): Promise<Json> {
  const format = String(p.format ?? "json");
  const rows = await k3.execute(
    `SELECT note_id, title, slug, tags, word_count, created_at, updated_at FROM notes ` +
      `WHERE deleted=0 ORDER BY updated_at DESC LIMIT 1000`,
  );
  if (format === "csv") {
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const csv = rows.length ? csvStringify(rows, { columns, headers: true }) : "";
    return { format, row_count: rows.length, columns, csv };
  }
  return { format: "json", count: rows.length, notes: rows };
}

// Aggregate, anon-safe rollup for the dashboard's default view.
export async function publicOverview(k3: K3, p: Json): Promise<Json> {
  const [totals] = await k3.execute(
    `SELECT COUNT(*) AS notes, SUM(word_count) AS words FROM notes WHERE deleted=0`,
  );
  const [linkRow] = await k3.execute(`SELECT COUNT(*) AS links FROM links`);
  const recent = (await listNotes(k3, { limit: Number(p.limit ?? 8) })).notes ?? [];
  const topTags = ((await tags(k3, {})).tags ?? []).slice(0, 12);
  return {
    totals: {
      notes: Number(totals?.notes ?? 0),
      words: Number(totals?.words ?? 0),
      links: Number(linkRow?.links ?? 0),
      tags: topTags.length,
    },
    recent,
    top_tags: topTags,
    updated_at: nowIso(),
  };
}
