/*
 * Ask-Your-Notes console — a static page that talks to its own origin's `/api`
 * proxy (server.mjs), which forwards to the app's public backend. Reading is
 * anonymous; the admin key (for authoring) is entered in ⚙ Settings, kept in
 * localStorage, and sent in the request body — the proxy forwards it untouched.
 *
 * Set `?backend=` (or the Settings field) to call a backend FQDN directly instead
 * of the proxy — handy when opening index.html straight off disk.
 */
const qs = new URLSearchParams(location.search);
const store = {
  get url() { return qs.get("backend") || localStorage.getItem("ayn_url") || "/api"; },
  get ak() { return qs.get("ak") || localStorage.getItem("ayn_ak") || ""; },
  set(url, ak) { localStorage.setItem("ayn_url", url); localStorage.setItem("ayn_ak", ak); },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => (Number(n) || 0).toLocaleString();

/** One invocation. Public reads go keyless; writes attach the admin key. */
async function invoke(action, payload = {}) {
  const body = { action, ...payload };
  if (store.ak) body.key = store.ak; // admin key (if set) — proxy forwards it
  const res = await fetch(store.url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { ok: false, error: "network error" };
  return res.json().catch(() => ({ ok: false, error: "bad response" }));
}

// ------------------------------------------------------------------- markdown (tiny)
/** A deliberately small markdown renderer — headings, code, lists, and clickable
 *  [[wikilinks]]. Everything is escaped first, so it's safe on untrusted bodies. */
function renderMd(src) {
  const lines = esc(src).split("\n");
  let html = "", inCode = false, inList = false;
  const inline = (t) => t
    .replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_, tgt, al) =>
      `<a data-slug="${esc(slug(tgt))}">${esc(al || tgt)}</a>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (const ln of lines) {
    if (ln.trim().startsWith("```")) {
      html += inCode ? "</pre>" : "<pre>"; inCode = !inCode; continue;
    }
    if (inCode) { html += ln + "\n"; continue; }
    const h = ln.match(/^(#{1,3})\s+(.*)/);
    if (h) { if (inList) { html += "</ul>"; inList = false; } html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    if (ln.trim()) html += `<p>${inline(ln)}</p>`;
  }
  if (inList) html += "</ul>"; if (inCode) html += "</pre>";
  return html;
}
const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled").slice(0, 80);

/** Outgoing links are just the [[wikilinks]] in the body — derive them here rather
 *  than making the backend run an extra query on every note open. */
function outgoingFromBody(body) {
  const seen = new Set(), out = [];
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(body || ""))) !== null) {
    const title = m[1].trim();
    if (!title) continue;
    const s = slug(title);
    if (!seen.has(s)) { seen.add(s); out.push({ slug: s, title }); }
  }
  return out;
}

// ------------------------------------------------------------------- overview + graph
async function loadOverview() {
  const r = await invoke("public_overview", { limit: 8 });
  if (!r.ok) { $("tiles").innerHTML = `<span class="err">${esc(r.error || "failed")}</span>`; return; }
  const t = r.result.totals || {};
  $("tiles").innerHTML = [["Notes", t.notes], ["Words", t.words], ["Links", t.links], ["Tags", t.tags]]
    .map(([l, v]) => `<div class="tile"><div class="v">${fmt(v)}</div><div class="l">${l}</div></div>`).join("");
  $("tagcloud").innerHTML = (r.result.top_tags || [])
    .map((t) => `<span class="chip" data-tag="${esc(t.tag)}">${esc(t.tag)} · ${t.notes}</span>`).join("") ||
    `<span class="muted small">No tags yet.</span>`;
  renderList(r.result.recent || []);
  graph.load(); // paint the vault map alongside the tiles
}

// ------------------------------------------------------------------- list + search
let activeTag = "";
let activeNoteId = "";
function renderList(notes) {
  const el = $("notelist");
  if (!notes.length) { el.innerHTML = `<span class="muted small">No notes found.</span>`; return; }
  el.innerHTML = notes.map((n) => `
    <div class="noteitem${n.note_id === activeNoteId ? " active" : ""}" data-slug="${esc(n.slug)}" data-id="${esc(n.note_id || "")}">
      <div class="t">${esc(n.title)}</div>
      <div class="e">${esc(n.excerpt || "")}</div>
    </div>`).join("");
}
async function doSearch() {
  const q = $("searchQ").value.trim();
  if (!q) { activeTag = ""; return loadOverview(); }
  const r = await invoke("search", { query: q, top_k: 12 });
  renderList(r.ok ? (r.result.results || []) : []);
}
async function filterByTag(tag) {
  activeTag = tag;
  const r = await invoke("list_notes", { tag, limit: 50 });
  renderList(r.ok ? (r.result.notes || []) : []);
}

// ------------------------------------------------------------------- viewer
/** Open a note in the reading pane. Highlights it in the list + graph, and brings
 *  the pane into view — the "why did nothing happen?" fix on narrow screens. */
async function openNote(slugOrId) {
  $("viewerHead").innerHTML = `Loading… <span class="sub"></span>`;
  $("viewer").innerHTML = `<span class="muted small">Fetching note…</span>`;
  bringViewerIntoView();
  const payload = slugOrId.startsWith("n_") ? { note_id: slugOrId } : { slug: slugOrId };
  const r = await invoke("get_note", payload);
  if (!r.ok) {
    $("viewerHead").innerHTML = `Note <span class="sub">— not found</span>`;
    $("viewer").innerHTML = `<span class="err">${esc(r.error || "not found")}</span>`;
    return;
  }
  const n = r.result;
  try {
    setActiveNote(n.note_id);
    // NB: replacing viewerHead's innerHTML destroys the #viewerSub span that lived
    // inside it — so DON'T touch $("viewerSub") after this line (it's now null).
    $("viewerHead").innerHTML = `${esc(n.title)} <span class="sub">/${esc(n.slug)}</span>`;
    const tags = (n.tags || []).map((t) => `<span class="chip" data-tag="${esc(t)}">${esc(t)}</span>`).join("");
    const back = (n.backlinks || []).map((b) => `<div class="noteitem" data-slug="${esc(b.slug)}"><div class="t">${esc(b.title)}</div></div>`).join("")
      || `<span class="muted small">No backlinks.</span>`;
    const out = outgoingFromBody(n.body).map((l) => `<a data-slug="${esc(l.slug)}">${esc(l.title)}</a>`).join(" · ")
      || `<span class="muted small">none</span>`;
    $("viewer").innerHTML = `
      <div style="margin-bottom:8px">${tags}</div>
      <div class="prose">${renderMd(n.body || "*empty note*")}</div>
      <div class="small" style="margin-top:12px"><b class="muted">Links to:</b> ${out}</div>
      <div style="margin-top:12px"><h2 style="margin-bottom:6px">Backlinks</h2>${back}</div>`;
    if (store.ak) loadIntoEditor(n);
  } catch (e) {
    // Never leave the pane stuck on the loading state if rendering throws.
    $("viewer").innerHTML = `<span class="err">Couldn't render note: ${esc(e.message)}</span>`;
  }
}

/** Reflect the open note everywhere: list rows, graph node, and remembered id. */
function setActiveNote(noteId) {
  activeNoteId = noteId || "";
  document.querySelectorAll("#notelist .noteitem").forEach((el) =>
    el.classList.toggle("active", el.getAttribute("data-id") === activeNoteId));
  graph.setActive(activeNoteId);
}

function bringViewerIntoView() {
  // Only scroll when the pane is off-screen (i.e. stacked below on narrow layouts).
  const rect = $("viewerCard").getBoundingClientRect();
  if (rect.top < 0 || rect.top > window.innerHeight - 120) {
    $("viewerCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ------------------------------------------------------------------- ask (RAG)
async function doAsk() {
  const q = $("askQ").value.trim(); if (!q) return;
  const out = $("askOut"); out.classList.remove("hidden");
  out.innerHTML = `<span class="muted">Thinking…</span>`;
  const r = await invoke("ask", { query: q, top_k: 6 });
  if (!r.ok) { out.innerHTML = `<span class="err">${esc(r.error || "failed")}</span>`; return; }
  const cites = (r.result.citations || [])
    .map((c) => `<span class="chip" data-slug="${esc(c.slug)}">${esc(c.title)}</span>`).join("");
  out.innerHTML = `<div class="answer">${esc(r.result.answer)}</div>` +
    (cites ? `<div class="cites"><span class="small muted">Sources:</span> ${cites}</div>` : "");
}

// ================================================================= graph (force layout)
// A dependency-free, Obsidian-style force-directed graph on <canvas>. Nodes are notes,
// solid edges are [[wikilinks]]. The "Group" toggle asks the backend to cluster notes by
// vector similarity; grouped nodes are coloured by cluster and pulled together, with the
// faint similarity edges drawn dashed.
const GROUP_COLORS = ["#6d4bd6", "#0ca30c", "#e0842b", "#2f7fe0", "#d03b3b", "#12a6a6", "#b23bd0", "#8a8f2a", "#d0417f", "#4a5568"];
const graph = (() => {
  const canvas = $("graphCanvas");
  let ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let nodes = [], links = [], grouped = false, groupCount = 0;
  let cam = { s: 1, x: 0, y: 0 };
  let alpha = 0, running = false, autoFit = true;
  let activeId = "", hoverId = "";
  let drag = null, pan = null, downAt = null, moved = false;

  const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim() || "#888";

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  async function load() {
    const r = await invoke("graph", grouped ? { group: true, limit: 400 } : { limit: 400 });
    if (!r.ok) { $("graphEmpty").textContent = r.error || "graph unavailable"; $("graphEmpty").classList.remove("hidden"); return; }
    build(r.result);
  }

  function build(data) {
    resize();
    const prev = new Map(nodes.map((n) => [n.note_id, n]));
    const list = data.nodes || [];
    nodes = list.map((n, i) => {
      const p = prev.get(n.note_id);
      const a = (i / Math.max(list.length, 1)) * Math.PI * 2;
      return {
        ...n,
        x: p ? p.x : Math.cos(a) * 150 + (Math.random() * 16 - 8),
        y: p ? p.y : Math.sin(a) * 150 + (Math.random() * 16 - 8),
        vx: 0, vy: 0, deg: 0,
      };
    });
    const byId = new Map(nodes.map((n) => [n.note_id, n]));
    grouped = !!data.grouped;
    groupCount = data.group_count || 0;
    const struct = (data.edges || []).map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), kind: "link" }));
    const sim = grouped ? (data.sim_edges || []).map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), kind: "sim" })) : [];
    links = [...struct, ...sim].filter((l) => l.s && l.t && l.s !== l.t);
    for (const l of links) { if (l.kind === "link") { l.s.deg++; l.t.deg++; } }
    $("graphEmpty").classList.toggle("hidden", nodes.length > 0);
    if (!nodes.length) $("graphEmpty").textContent = "No notes yet — create one to grow the graph.";
    setMeta(data); setLegend();
    autoFit = true; reheat(1); loop();
  }

  function setMeta(data) {
    const parts = [`${data.node_count || 0} notes`, `${data.edge_count || 0} links`];
    if (grouped) parts.push(`${groupCount} cluster${groupCount === 1 ? "" : "s"}`);
    $("graphMeta").textContent = parts.join(" · ");
  }
  function setLegend() {
    const el = $("graphLegend");
    if (!grouped || groupCount < 2) { el.innerHTML = ""; return; }
    const counts = {};
    for (const n of nodes) counts[n.group] = (counts[n.group] || 0) + 1;
    el.innerHTML = Object.keys(counts).sort((a, b) => a - b).map((g) =>
      `<span class="lg"><span class="dot" style="background:${GROUP_COLORS[g % GROUP_COLORS.length]}"></span>Cluster ${Number(g) + 1} · ${counts[g]}</span>`).join("");
  }

  // ---- simulation ----
  const REPULSE = 2600, SPRING = 0.035, LINK_LEN = 66, SIM_LEN = 40, GRAVITY = 0.02, GROUP_PULL = 0.05, DAMP = 0.82;
  function reheat(a = 0.6) { alpha = Math.max(alpha, a); }
  function tick() {
    for (const n of nodes) { n.fx = 0; n.fy = 0; }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2), f = REPULSE / d2, ux = dx / d, uy = dy / d;
        a.fx += ux * f; a.fy += uy * f; b.fx -= ux * f; b.fy -= uy * f;
      }
    }
    for (const l of links) {
      let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const len = l.kind === "sim" ? SIM_LEN : LINK_LEN, f = (d - len) * SPRING, ux = dx / d, uy = dy / d;
      l.s.fx += ux * f; l.s.fy += uy * f; l.t.fx -= ux * f; l.t.fy -= uy * f;
    }
    if (grouped && groupCount > 1) {
      const c = {};
      for (const n of nodes) { const g = c[n.group] || (c[n.group] = { x: 0, y: 0, n: 0 }); g.x += n.x; g.y += n.y; g.n++; }
      for (const g in c) { c[g].x /= c[g].n; c[g].y /= c[g].n; }
      for (const n of nodes) { const g = c[n.group]; n.fx += (g.x - n.x) * GROUP_PULL; n.fy += (g.y - n.y) * GROUP_PULL; }
    }
    for (const n of nodes) { n.fx += -n.x * GRAVITY; n.fy += -n.y * GRAVITY; }
    for (const n of nodes) {
      if (n === (drag && drag.node)) continue;
      n.vx = (n.vx + n.fx * alpha) * DAMP; n.vy = (n.vy + n.fy * alpha) * DAMP;
      const sp = Math.hypot(n.vx, n.vy); if (sp > 40) { n.vx *= 40 / sp; n.vy *= 40 / sp; }
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.985;
  }

  function fitCamera(lerp) {
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const pad = 60, w = (maxX - minX) || 1, h = (maxY - minY) || 1;
    const s = Math.max(0.25, Math.min(2.4, Math.min(W / (w + pad), H / (h + pad))));
    const tx = W / 2 - ((minX + maxX) / 2) * s, ty = H / 2 - ((minY + maxY) / 2) * s;
    cam.s += (s - cam.s) * lerp; cam.x += (tx - cam.x) * lerp; cam.y += (ty - cam.y) * lerp;
  }

  const sx = (n) => cam.x + n.x * cam.s;
  const sy = (n) => cam.y + n.y * cam.s;
  const radius = (n) => (5 + Math.min(n.deg, 8) * 0.9) * Math.max(0.7, Math.min(cam.s, 1.4));

  function render() {
    ctx.clearRect(0, 0, W, H);
    const edgeCol = cssVar("--grid"), accent = cssVar("--accent"), ink = cssVar("--ink2");
    const active = nodes.find((n) => n.note_id === activeId);
    const hover = nodes.find((n) => n.note_id === hoverId);
    const focus = active || hover;
    const near = new Set();
    if (focus) { near.add(focus.note_id); for (const l of links) { if (l.s === focus) near.add(l.t.note_id); if (l.t === focus) near.add(l.s.note_id); } }
    // edges
    for (const l of links) {
      const hot = focus && (l.s === focus || l.t === focus);
      ctx.beginPath(); ctx.moveTo(sx(l.s), sy(l.s)); ctx.lineTo(sx(l.t), sy(l.t));
      if (l.kind === "sim") { ctx.setLineDash([4, 4]); ctx.strokeStyle = GROUP_COLORS[(l.s.group ?? 0) % GROUP_COLORS.length]; ctx.globalAlpha = hot ? 0.5 : 0.22; ctx.lineWidth = 1; }
      else { ctx.setLineDash([]); ctx.strokeStyle = hot ? accent : edgeCol; ctx.globalAlpha = focus && !hot ? 0.25 : 1; ctx.lineWidth = hot ? 1.8 : 1; }
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // nodes
    for (const n of nodes) {
      const r = radius(n), x = sx(n), y = sy(n);
      const col = grouped ? GROUP_COLORS[(n.group ?? 0) % GROUP_COLORS.length] : accent;
      ctx.globalAlpha = focus && !near.has(n.note_id) ? 0.35 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      if (n.note_id === activeId) { ctx.lineWidth = 2.5; ctx.strokeStyle = cssVar("--ink"); ctx.stroke(); }
      // labels: all when the graph is small or zoomed in; else only focused/neighbours
      if (nodes.length <= 24 || cam.s > 1.05 || (focus && near.has(n.note_id))) {
        ctx.globalAlpha = focus && !near.has(n.note_id) ? 0.35 : 1;
        ctx.fillStyle = ink; ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title, x, y + r + 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (running) return; running = true;
    const step = () => {
      if (alpha > 0.02) tick();
      if (autoFit) fitCamera(0.12);
      render();
      if (alpha > 0.015 || autoFit) requestAnimationFrame(step);
      else { running = false; render(); }
    };
    requestAnimationFrame(step);
  }

  // ---- interaction ----
  const toWorld = (px, py) => ({ x: (px - cam.x) / cam.s, y: (py - cam.y) / cam.s });
  function nodeAt(px, py) {
    const w = toWorld(px, py); let best = null, bd = Infinity;
    for (const n of nodes) { const d = Math.hypot(n.x - w.x, n.y - w.y); const rr = radius(n) / cam.s + 6 / cam.s; if (d < rr && d < bd) { bd = d; best = n; } }
    return best;
  }
  const relPos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId); const p = relPos(e); downAt = p; moved = false;
    const n = nodeAt(p.x, p.y);
    if (n) drag = { node: n }; else pan = { x: e.clientX, y: e.clientY };
    canvas.classList.add("grabbing");
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = relPos(e);
    if (drag) { const w = toWorld(p.x, p.y); drag.node.x = w.x; drag.node.y = w.y; drag.node.vx = drag.node.vy = 0; autoFit = false; reheat(0.5); loop(); moved = true; return; }
    if (pan) { cam.x += e.clientX - pan.x; cam.y += e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY }; autoFit = false; moved = true; loop(); return; }
    const n = nodeAt(p.x, p.y); const id = n ? n.note_id : "";
    if (id !== hoverId) { hoverId = id; canvas.style.cursor = n ? "pointer" : "grab"; loop(); }
  });
  const endPointer = (e) => {
    const p = downAt ? relPos(e) : null;
    if (p && downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 5 && !moved) {
      const n = nodeAt(p.x, p.y); if (n) openNote(n.slug);
    }
    drag = null; pan = null; downAt = null; canvas.classList.remove("grabbing");
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => { drag = null; pan = null; downAt = null; canvas.classList.remove("grabbing"); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); const p = relPos(e); const w = toWorld(p.x, p.y);
    const k = Math.exp(-e.deltaY * 0.0015); cam.s = Math.max(0.2, Math.min(4, cam.s * k));
    cam.x = p.x - w.x * cam.s; cam.y = p.y - w.y * cam.s; autoFit = false; loop();
  }, { passive: false });

  window.addEventListener("resize", () => { resize(); reheat(0.2); loop(); });

  return {
    load,
    setActive(id) { activeId = id || ""; loop(); },
    toggleGroup() { grouped = !grouped; $("graphGroup").classList.toggle("on", grouped); $("graphMeta").textContent = "Grouping…"; return load(); },
    reset() { autoFit = true; reheat(0.6); loop(); },
  };
})();

// ------------------------------------------------------------------- editor (admin)
function loadIntoEditor(n) {
  $("edTitle").value = n.title || ""; $("edId").value = n.note_id || "";
  $("edTags").value = (n.tags || []).join(", "); $("edBody").value = n.body || "";
  $("edDelete").classList.toggle("hidden", !n.note_id);
}
function clearEditor() {
  $("edTitle").value = ""; $("edId").value = ""; $("edTags").value = ""; $("edBody").value = "";
  $("edDelete").classList.add("hidden"); $("edMsg").textContent = "";
}
async function saveNote() {
  const title = $("edTitle").value.trim(), body = $("edBody").value;
  if (!title && !body) { $("edMsg").textContent = "needs a title or body"; return; }
  $("edSave").disabled = true; $("edMsg").textContent = "saving…";
  const tags = $("edTags").value.split(",").map((s) => s.trim()).filter(Boolean);
  const payload = { title, body, tags };
  if ($("edId").value) payload.note_id = $("edId").value;
  const r = await invoke("put_note", payload);
  $("edSave").disabled = false;
  $("edMsg").textContent = r.ok ? `saved · ${r.result.links} link(s)` : (r.error || "failed");
  if (r.ok) { await loadOverview(); openNote(r.result.slug); }
}
async function deleteNote() {
  if (!$("edId").value || !confirm("Delete this note?")) return;
  const r = await invoke("delete_note", { note_id: $("edId").value });
  $("edMsg").textContent = r.ok ? "deleted" : (r.error || "failed");
  if (r.ok) { clearEditor(); $("viewer").innerHTML = `<span class="muted small">Nothing selected.</span>`; activeNoteId = ""; loadOverview(); }
}

// ------------------------------------------------------------------- settings + wiring
function applyMode() {
  const admin = !!store.ak;
  $("editorCard").classList.toggle("hidden", !admin);
  $("modeBadge").textContent = admin ? "admin · authoring unlocked" : "public · anon reader";
  $("modeBadge").className = "badge " + (admin ? "admin" : "anon");
}
document.addEventListener("click", (e) => {
  const item = e.target.closest("[data-slug]");
  if (item) { openNote(item.getAttribute("data-slug")); return; }
  const tag = e.target.closest("[data-tag]");
  if (tag) { $("searchQ").value = ""; filterByTag(tag.getAttribute("data-tag")); }
});
$("askBtn").addEventListener("click", doAsk);
$("askQ").addEventListener("keydown", (e) => { if (e.key === "Enter") doAsk(); });
$("searchBtn").addEventListener("click", doSearch);
$("searchQ").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("graphGroup").addEventListener("click", () => graph.toggleGroup());
$("graphReset").addEventListener("click", () => graph.reset());
$("edSave").addEventListener("click", saveNote);
$("edNew").addEventListener("click", clearEditor);
$("edDelete").addEventListener("click", deleteNote);
$("gear").addEventListener("click", () => $("settings").classList.toggle("open"));
$("cfgSave").addEventListener("click", () => {
  store.set($("cfgUrl").value.trim() || "/api", $("cfgAk").value.trim());
  $("settings").classList.remove("open"); applyMode(); loadOverview();
});

// init
$("cfgUrl").value = store.url; $("cfgAk").value = store.ak;
applyMode();
loadOverview();
