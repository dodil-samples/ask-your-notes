/**
 * Service-account -> bearer token, shared by the K3 and Models clients.
 *
 * Mints a short-lived access token via OIDC `client_credentials`, caches it until
 * just before expiry, and reads the org id/name out of the JWT so callers never
 * pass them. Web-standard `fetch` only — no deps.
 *
 * Env: DODIL_SA_ID / DODIL_SA_SECRET (required), DODIL_OIDC_URL (optional).
 */

const OIDC_URL = Deno.env.get("DODIL_OIDC_URL") ??
  "https://id.dev.dodil.io/realms/dodil/protocol/openid-connect/token";

interface AuthState {
  token: string | null;
  exp: number;
  orgId: string;
  orgName: string;
}
const state: AuthState = { token: null, exp: 0, orgId: "", orgName: "" };

export class NotConfigured extends Error {}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(part + "=".repeat((4 - (part.length % 4)) % 4));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function orgFromClaims(claims: Record<string, unknown>): [string, string] {
  const orgs = (claims.organization ?? {}) as Record<string, { id?: string }>;
  const name = Object.keys(orgs)[0];
  if (name) return [orgs[name]?.id ?? "", name];
  return [String(claims.org_id ?? ""), String(claims.org_name ?? "")];
}

export async function getToken(): Promise<string> {
  const now = Date.now() / 1000;
  if (state.token && now < state.exp - 30) return state.token;

  const id = Deno.env.get("DODIL_SA_ID") ?? "";
  const secret = Deno.env.get("DODIL_SA_SECRET") ?? "";
  if (!id || !secret) {
    throw new NotConfigured(
      "DODIL_SA_ID / DODIL_SA_SECRET are not set — the function needs a service account.",
    );
  }
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: "client_credentials",
  });
  const resp = await fetch(OIDC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10000), // bound the token round-trip too
  });
  if (!resp.ok) throw new NotConfigured(`token request failed: HTTP ${resp.status}`);
  const data = await resp.json();
  const token = data.access_token as string;
  const claims = decodeClaims(token);
  state.token = token;
  state.exp = Number(claims.exp ?? now + 300);
  [state.orgId, state.orgName] = orgFromClaims(claims);
  return token;
}

export async function orgId(): Promise<string> {
  await getToken();
  return state.orgId;
}
export async function orgName(): Promise<string> {
  await getToken();
  return state.orgName;
}

/** Test hook: inject a cached token so the app can run without the OIDC round-trip. */
export function _setToken(token: string, orgId: string, orgName: string): void {
  state.token = token;
  state.exp = Date.now() / 1000 + 3600;
  state.orgId = orgId;
  state.orgName = orgName;
}
