/**
 * Ignite Models client — OpenAI-compatible chat + embeddings. Powers the RAG
 * `ask` action (chat, grounded in retrieved notes) and is available for any other
 * generation the app wants.
 *
 * Env: MODEL_API_BASE (default https://api.dev.dodil.io/v1), MODEL_NAME (kimi-k2.6).
 */

import * as auth from "./auth.ts";

const BASE = (Deno.env.get("MODEL_API_BASE") ?? "https://api.dev.dodil.io/v1").replace(/\/$/, "");
const CHAT_MODEL = Deno.env.get("MODEL_NAME") ?? "kimi-k2.6";

async function bearer(): Promise<string> {
  return Deno.env.get("MODEL_API_KEY") ?? (await auth.getToken());
}

// Test hook: inject a deterministic chat so smoke.ts can exercise the RAG path
// offline (mirrors auth._setToken). `null` = call the real endpoint.
type ChatFn = (messages: Array<{ role: string; content: string }>, maxTokens?: number) => Promise<string>;
let _chatOverride: ChatFn | null = null;
export function _setChat(fn: ChatFn | null): void {
  _chatOverride = fn;
}

// Unwrap Ignite's {"data": <openai>, "status": ...} envelope if present.
function unwrap(data: any): any {
  if (data && typeof data === "object" && !("choices" in data) && "data" in data) {
    return data.data;
  }
  return data;
}

export async function chat(messages: Array<{ role: string; content: string }>, maxTokens = 800): Promise<string> {
  if (_chatOverride) return _chatOverride(messages, maxTokens);
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${await bearer()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, messages, max_tokens: maxTokens }),
  });
  if (!resp.ok) throw new Error(`chat HTTP ${resp.status}`);
  const data = unwrap(await resp.json());
  const msg = data?.choices?.[0]?.message;
  return (msg?.content ?? msg?.reasoningContent ?? "").trim();
}

/** Return an embedding vector, or [] if the embedder is unavailable. */
export async function embed(text: string): Promise<number[]> {
  const model = Deno.env.get("EMBED_MODEL") ?? "jina-embeddings-v4";
  const resp = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${await bearer()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!resp.ok) return [];
  const data = unwrap(await resp.json());
  return data?.data?.[0]?.embedding ?? [];
}
