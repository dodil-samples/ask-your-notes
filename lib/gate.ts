/**
 * Public / private access gate + lightweight API-key management.
 *
 * The app is deployed with `--allow-unauthenticated` so its public FQDN is
 * anonymously invokable (CORS-open) — a "digital garden" reader, a website's
 * search box, or a docs widget can POST straight to it with no Dodil credentials.
 * That makes an in-app gate the real trust boundary, so we split every action
 * into two tiers:
 *
 *   PUBLIC  — reading the vault: semantic search, ask (RAG), fetch a note, list,
 *             backlinks, tags, graph. Safe to expose anonymously — this is a
 *             published, read-only knowledge base. Optionally gated by a
 *             non-secret *project key* embedded in the page. The "public backend".
 *   PRIVATE — editing the vault: create/update/delete notes, rename, reindex,
 *             export, and key management. Gated by an *admin key*. This is your
 *             private authoring backend.
 *
 * Keys travel in the JSON body (field `key`), because the anon FQDN's CORS
 * preflight only allows the `content-type` request header — a browser cannot send
 * a custom `x-api-key` header cross-origin.
 *
 * Keys come from two places, merged:
 *   • env  — ADMIN_KEYS / PUBLIC_KEYS (comma-separated). Provisioned by the
 *            IAM-authenticated operator at deploy time; the bootstrap credential.
 *   • K3   — the `api_keys` table, managed at runtime via create_key/list_keys/
 *            revoke_key (all PRIVATE actions). This is the "user management".
 *
 * Graceful default: if a tier has NO keys configured (env empty AND table empty),
 * that tier is OPEN. So a bare `deno task smoke` / `dodil ignite invoke` keeps
 * working unchanged, and you lock a tier down simply by configuring a key for it.
 */

import type { K3 } from "./k3.ts";

/** Actions any anonymous caller may run. Everything else is PRIVATE. */
export const PUBLIC_ACTIONS = new Set<string>([
  "search",
  "ask",
  "get_note",
  "list_notes",
  "backlinks",
  "tags",
  "graph",
  "public_overview",
]);

export function isPublicAction(action: string): boolean {
  return PUBLIC_ACTIONS.has(action);
}

// --------------------------------------------------------------------------- env keys
function envKeys(name: string): Set<string> {
  return new Set(
    (Deno.env.get(name) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
const ENV_ADMIN = envKeys("ADMIN_KEYS");
const ENV_PUBLIC = envKeys("PUBLIC_KEYS");

// --------------------------------------------------------------------------- table cache
// One read per cold start, refreshed after a create/revoke on THIS replica. `null`
// = not loaded yet. Env keys are immediate + globally consistent; a create_key /
// revoke_key done via the table converges on other warm replicas within one
// cold-start cycle (they reload on their next start). Use env keys for anything
// that must flip instantly fleet-wide.
let tableAdmin: Set<string> | null = null;
let tablePublic: Set<string> | null = null;

export function invalidateKeyCache(): void {
  tableAdmin = null;
  tablePublic = null;
}

async function loadTableKeys(k3: K3): Promise<void> {
  if (tableAdmin && tablePublic) return;
  tableAdmin = new Set();
  tablePublic = new Set();
  try {
    const rows = await k3.execute("SELECT key, kind FROM api_keys WHERE disabled = 0");
    for (const r of rows) {
      const key = String(r.key ?? "");
      if (!key) continue;
      (String(r.kind) === "admin" ? tableAdmin : tablePublic).add(key);
    }
  } catch {
    // Table missing / not yet compacted — treat as no dynamic keys this round.
  }
}

interface Resolved {
  adminSet: Set<string>;
  publicSet: Set<string>;
  adminConfigured: boolean;
  publicConfigured: boolean;
}

async function resolveKeys(k3: K3): Promise<Resolved> {
  await loadTableKeys(k3);
  const adminSet = new Set([...ENV_ADMIN, ...(tableAdmin ?? [])]);
  const publicSet = new Set([...ENV_PUBLIC, ...(tablePublic ?? [])]);
  return {
    adminSet,
    publicSet,
    adminConfigured: adminSet.size > 0,
    publicConfigured: publicSet.size > 0,
  };
}

// --------------------------------------------------------------------------- authorize
export interface Decision {
  ok: boolean;
  role: "admin" | "public" | "anon";
  error?: string;
}

/**
 * Decide whether `action` may run given the key on the payload. Admin keys are a
 * superset of public — an admin key satisfies any tier.
 */
export async function authorize(
  k3: K3,
  action: string,
  payload: { key?: string; public_key?: string; admin_key?: string },
): Promise<Decision> {
  const provided = String(payload.key ?? payload.admin_key ?? payload.public_key ?? "");
  const { adminSet, publicSet, adminConfigured, publicConfigured } = await resolveKeys(k3);
  const isAdmin = !!provided && adminSet.has(provided);
  const isPublic = !!provided && publicSet.has(provided);
  const role: Decision["role"] = isAdmin ? "admin" : isPublic ? "public" : "anon";

  if (isPublicAction(action)) {
    if (!publicConfigured || isPublic || isAdmin) return { ok: true, role };
    return { ok: false, role, error: "a valid project key is required (payload.key)" };
  }
  // PRIVATE
  if (!adminConfigured || isAdmin) return { ok: true, role };
  return { ok: false, role, error: "admin key required for this action (payload.key)" };
}

// --------------------------------------------------------------------------- key mgmt (PRIVATE)
function mint(kind: "admin" | "public"): string {
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${kind === "admin" ? "ak" : "pk"}_${rand}`;
}

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

/** Create a new project (public) or admin key. */
export async function createKey(k3: K3, p: Json): Promise<Json> {
  const kind = p.kind === "admin" ? "admin" : "public";
  const key = mint(kind);
  await k3.upsert("api_keys", [{
    key,
    label: String(p.label ?? ""),
    kind,
    created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    disabled: 0,
  }]);
  invalidateKeyCache();
  return { key, kind, label: p.label ?? "" };
}

/** List keys (admin view). Full keys are returned — this is an admin-only action. */
export async function listKeys(k3: K3, _p: Json): Promise<Json> {
  const rows = await k3.execute(
    "SELECT key, label, kind, created_at, disabled FROM api_keys ORDER BY created_at DESC LIMIT 200",
  );
  return { keys: rows, count: rows.length };
}

/** Revoke a key (soft-delete: disabled=1). */
export async function revokeKey(k3: K3, p: Json): Promise<Json> {
  const key = String(p.revoke ?? p.target_key ?? "");
  if (!key) return { error: "provide `revoke` (or `target_key`) — the key to revoke" };
  await k3.execute(`UPDATE api_keys SET disabled = 1 WHERE key = '${key.replace(/'/g, "''")}'`);
  invalidateKeyCache();
  return { revoked: key };
}
