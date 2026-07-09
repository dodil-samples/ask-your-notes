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

// ------------------------------------------------------------------- overview
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
}

// ------------------------------------------------------------------- list + search
let activeTag = "";
function renderList(notes) {
  const el = $("notelist");
  if (!notes.length) { el.innerHTML = `<span class="muted small">No notes yet — create one on the right.</span>`; return; }
  el.innerHTML = notes.map((n) => `
    <div class="noteitem" data-slug="${esc(n.slug)}" data-id="${esc(n.note_id || "")}">
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
async function openNote(slugOrId) {
  const payload = slugOrId.startsWith("n_") ? { note_id: slugOrId } : { slug: slugOrId };
  const r = await invoke("get_note", payload);
  if (!r.ok) { $("viewer").innerHTML = `<span class="err">${esc(r.error || "not found")}</span>`; return; }
  const n = r.result;
  $("viewerHead").innerHTML = `${esc(n.title)} <span class="sub">/${esc(n.slug)}</span>`;
  $("viewerSub").textContent = "";
  const tags = (n.tags || []).map((t) => `<span class="chip" data-tag="${esc(t)}">${esc(t)}</span>`).join("");
  const back = (n.backlinks || []).map((b) => `<div class="noteitem" data-slug="${esc(b.slug)}"><div class="t">${esc(b.title)}</div></div>`).join("")
    || `<span class="muted small">No backlinks.</span>`;
  const out = (n.outgoing_links || []).map((l) => `<a data-slug="${esc(l.dst_slug)}">${esc(l.dst_title || l.dst_slug)}</a>`).join(" · ")
    || `<span class="muted small">none</span>`;
  $("viewer").innerHTML = `
    <div style="margin-bottom:8px">${tags}</div>
    <div class="prose">${renderMd(n.body || "*empty note*")}</div>
    <div class="small" style="margin-top:12px"><b class="muted">Links to:</b> ${out}</div>
    <div style="margin-top:12px"><h2 style="margin-bottom:6px">Backlinks</h2>${back}</div>`;
  if (store.ak) loadIntoEditor(n);
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
  if (r.ok) { clearEditor(); $("viewer").innerHTML = `<span class="muted small">Nothing selected.</span>`; loadOverview(); }
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
