/*
 * Vault console server — static host + same-origin API proxy for Ask-Your-Notes.
 *
 * The browser only ever calls its own origin (`POST /api`); this server forwards
 * to the app's public backend and injects the project (public) key server-side.
 * So the reading experience ships with zero configuration — no keys in the page,
 * and CORS never enters the picture. The authoring side sends an admin key in the
 * body (entered in the console's ⚙ settings); the proxy forwards it untouched, so
 * the admin credential still only lives in the operator's browser, never the page.
 *
 * Zero dependencies (Node http/fs only). Env:
 *   BACKEND_URL   the app's public (anon) FQDN (required)
 *   PUBLIC_KEY    project key injected into calls that don't already carry a key (optional)
 *   PORT          listen port (default 8789; Ignite injects PORT)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_URL = process.env.BACKEND_URL || "https://ask-your-notes-cardinalai.ignite.dodil.cloud/";
const PUBLIC_KEY = process.env.PUBLIC_KEY || "";
const PORT = Number(process.env.PORT || 8789);

// The console is a combined reader + author surface, so every action is proxied.
// Read actions run anonymously (or with the injected project key); write actions
// need the admin key the browser attaches. The backend's gate is the real trust
// boundary either way.
const KNOWN_ACTIONS = new Set([
  "search", "ask", "get_note", "list_notes", "backlinks", "tags", "graph", "public_overview",
  "put_note", "delete_note", "reindex", "export",
  "create_key", "list_keys", "revoke_key",
]);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

// Transient errors worth retrying: DNS blips (the platform's per-app record can be
// briefly NXDOMAIN right after deploy while it propagates), connection resets, and a
// stalled attempt we aborted on TIMEOUT_MS.
const TRANSIENT = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "TimeoutError", "AbortError", "UND_ERR_ABORTED",
]);
const TIMEOUT_MS = 15000; // abort a single stalled attempt (Node fetch has NO default timeout)
const DEADLINE_MS = 30000; // give up overall — better a clear error than a spinner that never ends
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forward(body) {
  // Only fill in the project key when the caller didn't bring their own (an admin
  // key must win, so the private tier stays reachable through this same proxy).
  if (!body.key && PUBLIC_KEY) body.key = PUBLIC_KEY;
  const payload = JSON.stringify(body);
  const started = Date.now();
  let lastCode = "";
  for (let attempt = 0; Date.now() - started < DEADLINE_MS; attempt++) {
    if (attempt) await sleep(Math.min(150 * attempt, 800)); // backoff so a new DNS lookup is issued
    const res = await fetch(BACKEND_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((e) => { lastCode = e?.cause?.code || e.name || e.message; return null; });
    if (res) return await res.json().catch(() => ({ ok: false, error: "non-JSON response" }));
    if (!TRANSIENT.has(lastCode)) break; // a non-transient failure won't get better by retrying
  }
  console.error("backend fetch failed:", lastCode);
  return { ok: false, error: "backend unreachable" };
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = join(HERE, rel);
  if (!file.startsWith(HERE)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404).end("not found"); }
}

createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === "/healthz") { // Ignite BYOI readiness/liveness probe
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (u.pathname === "/api" && req.method === "POST") {
    const body = await readBody(req);
    if (!KNOWN_ACTIONS.has(body.action)) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: `unknown action ${JSON.stringify(body.action)}` }));
    }
    const json = await forward(body);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(json));
  }
  return serveStatic(res, u.pathname);
}).listen(PORT, () => {
  console.log(`vault console → backend ${BACKEND_URL}`);
  console.log(`console         http://localhost:${PORT}/`);
});
