/*
 * Offline UI smoke: prove web/server.mjs serves the console and correctly proxies
 * /api to the backend — injecting the project key only when the caller has none,
 * and forwarding an admin key untouched. Uses a local mock backend, so it needs
 * no network, no creds, and no deployed app.  Run: node tests/ui_smoke.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "web", "server.mjs");
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗ FAIL:"} ${m}`); if (!c) fails++; };

// 1) a mock backend that just echoes the body it received
let lastBody = null;
const mock = createServer((req, res) => {
  let d = ""; req.on("data", (c) => (d += c));
  req.on("end", () => { lastBody = JSON.parse(d || "{}"); res.end(JSON.stringify({ ok: true, echo: lastBody })); });
});
mock.listen(0); await once(mock, "listening");
const BACKEND_URL = `http://127.0.0.1:${mock.address().port}/`;
const PORT = 8991;

// 2) boot server.mjs pointed at the mock, with a project key configured
const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, BACKEND_URL, PUBLIC_KEY: "pk_demo", PORT: String(PORT) },
  stdio: "inherit",
});
for (let i = 0; i < 50; i++) { // wait for listen
  try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const base = `http://127.0.0.1:${PORT}`;
const api = (body) => fetch(`${base}/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, j })));

try {
  console.log("\n### web/server.mjs proxy");
  const health = await (await fetch(`${base}/healthz`)).text();
  ok(health === "ok", "GET /healthz → ok");
  const index = await (await fetch(`${base}/`)).text();
  ok(index.includes("<title>Ask Your Notes"), "GET / serves the console HTML");

  await api({ action: "public_overview" });
  ok(lastBody.key === "pk_demo", "keyless read gets the project key injected server-side");

  await api({ action: "put_note", title: "x", key: "ak_admin" });
  ok(lastBody.key === "ak_admin", "an admin key is forwarded untouched (not overridden by the project key)");

  const bogus = await api({ action: "nope" });
  ok(bogus.status === 404 && bogus.j.ok === false, "unknown action is rejected with 404");
} finally {
  child.kill(); mock.close();
}
console.log(`\n${fails === 0 ? "✅ UI SMOKE PASSED" : `❌ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
