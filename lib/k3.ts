/**
 * K3 client — object store (S3), SQL warehouse (tables), and vector search over
 * the K3 HTTP REST API. Web-standard `fetch` only. Wire shapes verified live:
 *
 *   create   POST /{bucket}/tables            body { bucket, name, columns[], merge_keys, partition_columns }
 *   read     POST /{bucket}/tables/_execute   body { bucket, sql, freshness }   -> { query: { columns, rows[] } }
 *   write    POST /{bucket}/tables/{t}/insert body { bucket, table_name, rows[] as JSON strings }  (UPSERTs on merge-keyed tables)
 *   compact  POST /{bucket}/tables/{t}/_compact
 *   object   PUT  /{bucket}/{key}
 *   vector   POST /{bucket}/vector, /{bucket}/vector/pipelines, /{bucket}/vector/search
 *
 * NB: the create endpoint keys the table on `name`; the row endpoints on `table_name`.
 */

import * as auth from "./auth.ts";

const BASE = (Deno.env.get("K3_API_BASE") ?? "https://k3.dev.dodil.io").replace(/\/$/, "");

export const T = {
  STRING: "COLUMN_TYPE_STRING",
  LONG: "COLUMN_TYPE_LONG",
  INT: "COLUMN_TYPE_INT",
  DOUBLE: "COLUMN_TYPE_DOUBLE",
  BOOL: "COLUMN_TYPE_BOOLEAN",
  TS: "COLUMN_TYPE_TIMESTAMP",
} as const;

export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
}
export function col(name: string, type: string, nullable = true): Column {
  return { name, type, nullable };
}

export class K3Error extends Error {}

// Deno's fetch has NO default timeout — a slow K3/VBase call would otherwise
// block until the Ignite function's execution timeout and fail the whole request.
// Every call is bounded by a per-call timeout AND, for the best-effort vector
// provisioning, an outer `budget` AbortSignal. When the caller's budget fires,
// every in-flight and subsequent provisioning fetch aborts at once — unlike a
// Promise.race time-box, which leaves the losing fetches running past the budget
// and was what let register_event blow the 120s function limit.
const DEFAULT_TIMEOUT_MS = Number(Deno.env.get("K3_TIMEOUT_MS") ?? "15000");
const PROVISION_TIMEOUT_MS = 8000;
// Vector search embeds the query (model inference, ~0.7s warm) and can hit a Milvus
// cold segment-load (~5-10s) on an idle collection, so it needs more headroom than a
// plain table read. We also retry it once: a cold-load / briefly-saturated-embedder
// first attempt usually warms things so the second returns fast.
const VECTOR_TIMEOUT_MS = Number(Deno.env.get("K3_VECTOR_TIMEOUT_MS") ?? "20000");
const VECTOR_ATTEMPTS = 2;

function fetchT(url: string, init: RequestInit, timeoutMs: number, budget?: AbortSignal): Promise<Response> {
  const perCall = AbortSignal.timeout(timeoutMs);
  const signal = budget ? AbortSignal.any([perCall, budget]) : perCall;
  return fetch(url, { ...init, signal });
}

export class K3 {
  constructor(readonly bucket: string) {}

  private async headers(contentType = "application/json"): Promise<HeadersInit> {
    const h: Record<string, string> = {
      "Authorization": `Bearer ${await auth.getToken()}`,
      "x-organization-id": await auth.orgId(),
      "x-organization-name": await auth.orgName(),
    };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  private async post(path: string, body: unknown, soft = false, timeoutMs = DEFAULT_TIMEOUT_MS, budget?: AbortSignal): Promise<any> {
    try {
      const resp = await fetchT(`${BASE}${path}`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(body),
      }, timeoutMs, budget);
      const text = await resp.text();
      if (!resp.ok) {
        if (soft) return {};
        throw new K3Error(`POST ${path} -> HTTP ${resp.status}: ${text.slice(0, 240)}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } catch (e) {
      if (soft) return {}; // timeout/abort on a best-effort call — skip, retry later
      if (e instanceof K3Error) throw e;
      throw new K3Error(`POST ${path} -> ${(e as Error).name}: ${(e as Error).message}`);
    }
  }

  private async getJson(path: string, timeoutMs = DEFAULT_TIMEOUT_MS, budget?: AbortSignal): Promise<any> {
    try {
      const resp = await fetchT(`${BASE}${path}`, { method: "GET", headers: await this.headers("") }, timeoutMs, budget);
      if (!resp.ok) return {};
      return await resp.json();
    } catch {
      return {}; // timeout/abort — treat as "not present"
    }
  }

  // -- bucket ------------------------------------------------------------
  async ensureBucket(description = ""): Promise<void> {
    // Idempotent: an already-exists response is fine.
    await this.post("/admin/buckets", { name: this.bucket, description }, true);
  }

  // -- objects (S3) ------------------------------------------------------
  async putObject(key: string, body: string | Uint8Array, contentType = "text/plain"): Promise<void> {
    const resp = await fetchT(`${BASE}/${this.bucket}/${key}`, {
      method: "PUT",
      headers: await this.headers(contentType),
      body: body as BodyInit,
    }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) throw new K3Error(`PUT ${key} -> HTTP ${resp.status}`);
  }

  async getObject(key: string): Promise<string> {
    const resp = await fetchT(`${BASE}/${this.bucket}/${key}`, {
      method: "GET",
      headers: await this.headers(""),
    }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) throw new K3Error(`GET ${key} -> HTTP ${resp.status}`);
    return await resp.text();
  }

  // -- warehouse (SQL tables) -------------------------------------------
  createTable(
    name: string,
    columns: Column[],
    mergeKeys: string[] = [],
    partitionColumns: string[] = [],
  ): Promise<any> {
    return this.post(`/${this.bucket}/tables`, {
      bucket: this.bucket,
      name,
      columns,
      merge_keys: mergeKeys,
      partition_columns: partitionColumns,
    });
  }

  async execute(sql: string, freshness = "FRESHNESS_STRONG"): Promise<Record<string, unknown>[]> {
    const data = await this.post(`/${this.bucket}/tables/_execute`, {
      bucket: this.bucket,
      sql,
      freshness,
    });
    return rowsToObjects(data);
  }

  /** Insert rows; UPSERTs on a merge-keyed table (safe to re-run). Rows go as JSON strings. */
  insert(table: string, rows: Record<string, unknown>[]): Promise<any> {
    return this.post(`/${this.bucket}/tables/${table}/insert`, {
      bucket: this.bucket,
      table_name: table,
      rows: rows.map((r) => JSON.stringify(r)),
    });
  }
  upsert = this.insert;

  /** Flush the write-log so multi-table (and self-)JOINs see just-written rows. */
  compact(table: string): Promise<any> {
    return this.post(`/${this.bucket}/tables/${table}/_compact`, {
      bucket: this.bucket,
      table_name: table,
    });
  }

  // -- vector ------------------------------------------------------------
  async ensureVector(
    collection: string,
    templateId = "text_embedding_index",
    includePatterns: string[] = ["**"],
    budget?: AbortSignal,
  ): Promise<void> {
    // ConfigureEngine is NOT idempotent server-side — each auto-mode call
    // allocates a brand-new VBase instance. Only configure when the bucket has no
    // engine yet, or a second call would create a duplicate vector DB.
    // Every call carries the outer `budget`: if it fires, the whole step aborts at
    // once with no fetches left running past it.
    const P = PROVISION_TIMEOUT_MS; // tight per-call budget on top of `budget`
    const eng = await this.getJson(`/${this.bucket}/vector`, P, budget);
    if (!eng.engineId && !eng.engine_id) {
      await this.post(`/${this.bucket}/vector`, { bucket: this.bucket, mode: "ENGINE_MODE_AUTO" }, true, P, budget);
    }
    const cols = (await this.getJson(`/${this.bucket}/vector/collections`, P, budget)).collections ?? [];
    let pipe = cols.find((c: any) => c.embedPipelineName === templateId) ??
      cols.find((c: any) => (c.name ?? "").includes(collection));
    if (!pipe) {
      pipe = await this.post(`/${this.bucket}/vector/pipelines`, {
        bucket: this.bucket,
        name: collection,
        template_id: templateId,
      }, true, P, budget);
    }
    const pipelineId = pipe?.embedPipelineId;
    const srcs = (await this.getJson(`/${this.bucket}/sources`, P, budget)).sources ?? [];
    const sourceId = srcs[0]?.sourceId;
    const rules = (await this.getJson(`/${this.bucket}/rules`, P, budget)).rules ?? [];
    if (sourceId && pipelineId && rules.length === 0) {
      await this.post(`/${this.bucket}/rules`, {
        bucket: this.bucket,
        source_id: sourceId,
        name: `${collection}-rule`,
        include_patterns: includePatterns,
        pipeline_id: pipelineId,
        enabled: true,
      }, true, P, budget);
    }
  }

  async hasVectorCollection(budget?: AbortSignal): Promise<boolean> {
    const cols = (await this.getJson(`/${this.bucket}/vector/collections`, PROVISION_TIMEOUT_MS, budget)).collections ?? [];
    return cols.length > 0;
  }

  async triggerIngest(budget?: AbortSignal): Promise<void> {
    const srcs = (await this.getJson(`/${this.bucket}/sources`, PROVISION_TIMEOUT_MS, budget)).sources ?? [];
    const sid = srcs[0]?.sourceId;
    if (!sid) return;
    await this.post(`/${this.bucket}/sources/${sid}/discover`, { bucket: this.bucket, source_id: sid, full_sync: true }, true, PROVISION_TIMEOUT_MS, budget);
    await this.post(`/${this.bucket}/sources/${sid}/ingest`, { bucket: this.bucket, source_id: sid }, true, PROVISION_TIMEOUT_MS, budget);
  }

  async vectorSearch(query: string, topK = 5): Promise<Array<Record<string, unknown>>> {
    // Best-effort: degrade to [] instead of throwing if the embedder is down or slow.
    // Retry once on a failed/slow first attempt (see VECTOR_TIMEOUT_MS) — the retry
    // rides a now-warm segment/embedder and returns quickly.
    for (let attempt = 1; attempt <= VECTOR_ATTEMPTS; attempt++) {
      try {
        const resp = await fetchT(`${BASE}/${this.bucket}/vector/search`, {
          method: "POST",
          headers: await this.headers(),
          body: JSON.stringify({ bucket: this.bucket, text: query, top_k: topK, include_content: true }),
        }, VECTOR_TIMEOUT_MS);
        if (!resp.ok) {
          if (attempt < VECTOR_ATTEMPTS) continue;
          return [];
        }
        const data = await resp.json().catch(() => ({}));
        return (data.results ?? []).map((m: any) => ({
          text: (m.content ?? m.text ?? "").trim(),
          // K3 vector/search nests the source key under `object` (results[].object.key).
          // Reading a bare `m.key` yields undefined → every hit is dropped and search
          // silently falls back to keyword. Accept both shapes.
          key: m.object?.key ?? m.key ?? "",
          score: m.score,
        }));
      } catch {
        if (attempt < VECTOR_ATTEMPTS) continue; // timeout/abort — one more try
        return [];
      }
    }
    return [];
  }
}

/** Normalize an Execute response ({ query: { columns, rows[] } }) into row objects.
 *  Rows arrive as JSON-encoded strings. */
function rowsToObjects(data: any): Record<string, unknown>[] {
  const q = data?.query ?? data ?? {};
  const rows = q.rows ?? [];
  const columns: string[] = q.columns ?? [];
  const out: Record<string, unknown>[] = [];
  for (let r of rows) {
    if (typeof r === "string") {
      try {
        r = JSON.parse(r);
      } catch {
        continue;
      }
    }
    if (Array.isArray(r) && columns.length) {
      const obj: Record<string, unknown> = {};
      columns.forEach((c, i) => (obj[c] = r[i]));
      out.push(obj);
    } else if (r && typeof r === "object") {
      out.push(r);
    }
  }
  return out;
}
