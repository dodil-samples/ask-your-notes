# Ask Your Notes — an Obsidian-killer on Ignite + K3

A local-first personal knowledge base where **K3 is the whole backend** and one
action-routed **Deno** function is the whole API:

- **Markdown note bodies** live as K3 **objects** (`notes/<id>.md`).
- **Note metadata** and the **`[[wikilink]]` graph** live in the K3 **SQL warehouse**
  (`notes`, `links`) — so backlinks, the graph view, tags, and lists are plain SQL.
- A **vector collection** over the note bodies powers **semantic search** and the
  headline feature, **`ask`**: retrieval-augmented answers grounded in your notes,
  with citations, via **Ignite Models**.

It ships as a **public/private split** (like the other samples in this org):
reading the vault is anonymous (a published "digital garden"); editing needs an
admin key.

```
┌────────────┐  POST /api (same-origin)   ┌──────────────┐   K3 REST     ┌─────────┐
│  console   │ ─────────────────────────► │  web/        │ ────────────► │  Ignite │
│ (browser)  │                            │  server.mjs  │  inject key   │  fn     │
└────────────┘ ◄───────────────────────── │  (proxy)     │ ◄──────────── │ (Deno)  │
                                          └──────────────┘               └────┬────┘
                                                                              │ objects · tables · vector · models
                                                                         ┌────▼────┐
                                                                         │   K3    │
                                                                         └─────────┘
```

## Actions

| Tier | Action | What it does |
|------|--------|--------------|
| **PUBLIC** (anon-safe, read) | `search` | semantic search over note bodies (keyword fallback while the index warms) |
| | `ask` | RAG: retrieve top notes → model answers, grounded + cited |
| | `get_note` | one note: body + outgoing links + backlinks (by `note_id` or `slug`) |
| | `list_notes` | recent / by-`tag` list (metadata only) |
| | `backlinks` | who links here — works even for an unresolved stub slug ("future links") |
| | `tags` | tag → note counts |
| | `graph` | nodes + resolved edges for a graph view |
| | `public_overview` | counts (notes/words/links/tags) + recent + top tags |
| **PRIVATE** (admin key) | `put_note` | create/update: writes the body object, upserts metadata, parses `[[wikilinks]]` into the graph, re-indexes |
| | `delete_note` | soft-delete + drop its edges |
| | `reindex` | kick a vector re-ingest of the vault |
| | `export` | dump the vault as `json` or `csv` |
| | `create_key` / `list_keys` / `revoke_key` | API-key (user) management |

The gate (`lib/gate.ts`): PUBLIC actions are anon-safe (optionally gated by a
non-secret **project key**); PRIVATE actions need an **admin key**. Keys travel in
the JSON body (the anon FQDN's CORS preflight only allows `content-type`). A tier
with **no key configured stays open**, so a bare `dodil ignite invoke` just works;
configure `ADMIN_KEYS` / `PUBLIC_KEYS` (env) or mint keys at runtime to lock it.

## Layout

```
main.ts            Ignite entrypoint (start(handle)) — wiring only
handler.ts         dispatch: parse → bootstrap → gate → dispatch
actions/           the product (one file per domain — maps 1:1 to the actions table):
  common.ts          slugs, wikilink parsing, excerpts, id resolution
  notes.ts           put/delete/get, backlinks, list, tags, graph, export, overview
  search.ts          semantic search + the RAG `ask`
  mod.ts             the action registry (name → function)
lib/gate.ts        public/private tiers + API-key management
lib/bootstrap.ts   idempotent bucket + tables + vector provisioning
lib/k3.ts          K3 client (objects, SQL, vector) — web fetch only
lib/models.ts      Ignite Models (chat for `ask`, embeddings)
lib/auth.ts        service-account → bearer token (cached)
tests/smoke.ts     offline end-to-end test (FakeK3 + fake chat) — deno task smoke
tests/ui_smoke.mjs offline UI/proxy test (mock backend)
web/               the console: server.mjs (proxy) + index.html + app.js + Dockerfile
```

## Run the smoke tests (no deploy, no credentials)

```bash
deno task smoke                # backend: put/get, wikilinks→backlinks+graph,
                               # search + keyword fallback, RAG ask, gate, export
node tests/ui_smoke.mjs        # UI: static host + /api proxy + key injection
```

Both run fully offline against an in-memory K3 and a deterministic fake model.

## Deploy (later)

```bash
# 1) service account for the function to call K3 + models
export DODIL_SA_ID=...  DODIL_SA_SECRET=...

# 2) the backend (anonymous public FQDN)
dodil ignite app deploy ask-your-notes --code . --allow-unauthenticated --tier small \
  --env DODIL_SA_ID=$DODIL_SA_ID --env DODIL_SA_SECRET=$DODIL_SA_SECRET
#   lock the private tier:  --env ADMIN_KEYS=ak_your_admin_key

# 3) the console (its own anonymous FQDN, proxies to the backend)
dodil ignite app deploy ask-your-notes-ui --code ./web --dockerfile-path Dockerfile \
  --allow-unauthenticated --tier small \
  --env BACKEND_URL=https://ask-your-notes-<org>.ignite.dodil.cloud/
```

Open the console URL, drop your `ak_…` admin key into ⚙ Settings, and start writing
notes with `[[wikilinks]]` — search, backlinks, the graph, and `ask` populate as
K3 indexes them.
