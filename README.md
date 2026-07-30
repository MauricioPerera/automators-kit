# Automators Kit

**Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.**

746 tests | 0 deps | 23 modules | Bun + Deno + Node.js

By [automators.work](https://automators.work)

## What it is

A full-stack automation toolkit in vanilla JavaScript with zero npm dependencies. 23 core modules covering: document database, vector search (HNSW), HTTP router, CMS, n8n-style workflow engine, A2E executor, agent shell (command gateway), job queue, cron scheduler, agent memory, and more.

Born from merging and distilling ideas from 10+ repos (lokiCMS, js-doc-store, js-vector-store, a2e, minimemory, Agent-Shell, php-agent-memory, EasyDB, RepoMemory, EmDash, ATDF) into a single portable project.

## Install

```bash
git clone https://github.com/MauricioPerera/automators-kit.git
cd automators-kit
bun seed.js        # create admin + default content types
bun server-bun.js  # start at http://localhost:3000
```

No `npm install`. Zero dependencies.

## 23 Core Modules

| Module | What it does |
|--------|-------------|
| **db.js** | Document DB: MongoDB queries, 26 operators, indices, JWT auth, AES-256-GCM encryption, proxy access, watch |
| **vector.js** | Vector DB: Float32/Int8/Polar/Binary quantization, IVF, Matryoshka, BM25, hybrid search |
| **hnsw.js** | HNSW index: O(log n) approximate nearest neighbor search |
| **http.js** | HTTP router: Web Standard Request/Response, middleware chain, params, sub-routers, CORS |
| **validate.js** | Schema validation: types, formats, defaults (replaces Zod) |
| **cms.js** | CMS: content types, entries, taxonomies, terms, users, roles, autosave |
| **plugins.js** | Plugin system: hooks, capability-based access control, registry |
| **portable-text.js** | Rich content: JSON blocks to HTML/Markdown/PlainText, fromMarkdown parser |
| **mcp.js** | MCP server: JSON-RPC 2.0 over stdio, 20 tools for AI agents |
| **a2e.js** | A2E executor: 19 declarative operations, DAG parallel execution, middleware |
| **workflow.js** | Workflow engine: n8n-style nodes, triggers, credentials, execution history, DAG-parallel execution |
| **dag.js** | Shared DAG level-scheduling (Kahn's algorithm), used by both `workflow.js` and `a2e.js` |
| **nodes.js** | Node registry: 20 built-in nodes (core, communication, data, AI) + ARDF export |
| **triggers.js** | Trigger system: manual, webhook, cron, polling with change detection |
| **credentials.js** | Credential vault: AES-256-GCM encrypted API keys and tokens |
| **shell.js** | Agent shell: command gateway, parser, pipeline, JQ filter, RBAC |
| **shell-mcp.js** | Exposes `shell.js` over MCP as exactly 2 fixed tools (`shell_help`/`shell_exec`), ~600 constant tokens regardless of registry size — port of [Agent-Shell](https://github.com/MauricioPerera/Agent-Shell)'s `McpServer` |
| **queue.js** | Job queue: async processing, retries with exponential backoff, dead letter, stuck-job lease reclaim |
| **cron.js** | Cron scheduler: 5-field expressions, enable/disable, manual run, anti-reentrancy guard |
| **connector.js** | HTTP client: auth presets (bearer/basic/apikey), retries, timeout, optional SSRF guard |
| **memory.js** | Agent memory: semantic + episodic + working, scoping, dedup, dream cycle, correction boost |
| **parallel.js** | Task orchestration: race/merge/all strategies, timeout, weighted scoring |
| **net-guard.js** | SSRF guard: blocks fetches to loopback/RFC1918/link-local/cloud-metadata destinations |

**Picking between similar-sounding modules:**
- **`memory.js` vs `vector.js`** — `memory.js`'s `recall()` is keyword/term matching with time decay, zero ML dependency, works out of the box (see [`examples/agent-memory-backend`](examples/agent-memory-backend/)). `vector.js` does real cosine-similarity search over embeddings *you* provide — it never calls an embedding API itself (see [`examples/vector-memory`](examples/vector-memory/)). Reach for `memory.js` first; reach for `vector.js` when word-overlap isn't good enough and you're willing to bring an embedding function.
- **`workflow.js` vs `a2e.js`** — two separate execution engines, not layers of one system. `workflow.js` is the n8n-style engine: named nodes wired by `{{ref}}` templates, triggered by webhook/cron/poll/manual, DAG-parallel. `a2e.js` is a smaller, declarative multi-step executor (`SetData`/`FilterData`/`ApiCall`/`Conditional`/`Loop`/...) with its own DAG and middleware, generally used standalone or from an `a2e.js`-authored node. They share the DAG level-scheduling algorithm itself (`dag.js`) since it was byte-for-byte duplicated code, but each keeps its own dependency-detection convention — an engine-specific improvement (e.g. how deps are inferred) still has to be ported to the other by hand.
- **`mcp.js` vs `shell-mcp.js`** — two different answers to "how many MCP tools should this expose." `mcp.js` gives each capability its own tool with a real JSON schema (`list_entries`, `create_entry`...) — the client sees full discovery via `tools/list`, but context cost grows with every tool added. `shell-mcp.js` exposes `shell.js`'s entire command registry through exactly 2 fixed tools (`shell_help`/`shell_exec`); the agent discovers commands at runtime via `shell_exec("search ...")`/`("describe ...")` instead of `tools/list`, so the tool-list cost stays constant no matter how large the registry gets. Verified against a real external MCP client (poolside.ai's `pool exec`): given only `shell_help`/`shell_exec`, it correctly called help first, searched for the right commands, described their params, then executed them — no schema handed to it upfront.

## Usage

### As a CMS
```bash
bun seed.js && bun server-bun.js
# POST /api/auth/login, GET /api/entries, POST /api/entries
```

### As a workflow engine (n8n-style)
```bash
# POST /api/workflows — create workflow with nodes + triggers
# POST /api/workflows/:id/run — execute
# POST /api/workflows/webhook/:path — trigger via webhook
# GET  /api/workflows/nodes/list — available nodes
```

### As an agent shell (command gateway)
```bash
# POST /api/shell/exec — { cmd: "users:list --limit 10 | .[0].name" }
# GET  /api/shell/help — interaction protocol (~600 tokens)
# Supports: pipeline (>>), batch, JQ filter (|), --dry-run, --validate
```

### As an MCP server (for Claude, Cursor, etc.)
```json
{ "mcpServers": { "automators-kit": { "command": "bun", "args": ["mcp.js"] } } }
```

### As a CLI
```bash
bun cli.js entries list --type post
bun cli.js entries create --type post --title "Hello" --json '{"body":"World"}'
bun cli.js structure
```

### As a framework
```javascript
import { DocStore, Router, VectorStore, WorkflowEngine, Shell, AgentMemory } from './index.js';
// Build whatever you want — each module works independently
```

## Examples

**[`examples/content-pipeline/`](examples/content-pipeline/)** — a worked end-to-end scenario:
webhook intake (authenticated) → markdown→HTML → CMS draft → publish → agent-shell
inspection with RBAC, wired up with the framework's public API. Run it with
`bun examples/content-pipeline/setup.js`; see its README for the full curl
walkthrough, including live checks of the SSRF guard and body-size limit
against a running server (not just unit tests).

**[`examples/command-gateway/`](examples/command-gateway/)** — "let an agent
operate the system through a safe, curated command surface, never raw DB
access." One `CommandRegistry` (the entire reachable set of commands) mounted
at 4 HTTP endpoints, each backed by its own `Shell` instance with a different
permission scope (admin / editor / read-only / public), so the same commands
exist everywhere but what each persona can reach differs — including a
custom scope (create+publish, no delete) that isn't one of the 4 built-in
`AGENT_PROFILES`. Run it with `bun examples/command-gateway/setup.js`.

**[`examples/agent-memory-backend/`](examples/agent-memory-backend/)** —
"give an agent its own state." Persistent semantic + episodic memory
(`core/memory.js`, keyword-matched recall, no embeddings provider needed)
reachable two ways from one set of shared handlers: the agent shell/HTTP for
testing, and a real MCP server (`mcp-server.js`) so an actual AI client
(Claude, Cursor) can read/write the same memory directly. Memory is isolated
per `agentId` on the same underlying db, and self-maintains via an hourly
`core/cron.js` job running the heuristic dedup cycle. Run with
`bun examples/agent-memory-backend/setup.js`.

**[`examples/vector-memory/`](examples/vector-memory/)** — semantic search
for a personal assistant using `core/vector.js`'s real cosine-similarity
`VectorStore` (not keyword recall like `agent-memory-backend` above). Ships
a zero-dependency offline embedding (the hashing trick, no API key) that's a
drop-in-replaceable stand-in for a real embeddings API. Run with
`bun examples/vector-memory/setup.js`. Building it found and fixed a real bug:
`core/shell.js`'s builtin dispatch was matching `search`/`describe`/`help` by
name alone regardless of namespace, silently shadowing any registered
`<namespace>:search`/`:describe`/`:help` command (this had already broken
`content:search` in `command-gateway` unnoticed).

**[`examples/integrations/`](examples/integrations/)** — "wire up Slack +
Discord + a REST API without standing up infra," using `core/connector.js`
(auth presets, retry/backoff, optional SSRF guard) + `core/credentials.js`
(encrypted vault). Runs fully offline — local mocks stand in for
Slack/Discord/a flaky third-party API, so retries and delivery are visible
end-to-end with zero real webhook URLs; swap in production URLs and the
integration code doesn't change. Run with `bun examples/integrations/setup.js`.

**[`examples/scheduled-sync/`](examples/scheduled-sync/)** — the reverse of
`integrations` above: pushes published CMS entries OUT to an external system
on a `core/cron.js` schedule via `core/connector.js`, tracked with a cursor
so re-runs never resend what already synced. Documents the trade-off of
simple cursor-based sync (a failure stops the cursor there — gap-free,
at-least-once, but blocks newer entries until it's retried) and a real
gotcha: a single simulated failure gets silently absorbed by
`core/connector.js`'s own retry logic before the sync's own failure handling
ever sees it. Run with `bun examples/scheduled-sync/setup.js`.

**[`examples/provider-fanout/`](examples/provider-fanout/)** — "ask 3
redundant suppliers for the same quote and take the best or fastest
answer," using `core/parallel.js` (`parallelRace` for fastest-wins,
`parallelMerge` for strategy-based winner selection) fanned out over
`core/connector.js` calls, so one slow or failing supplier never blocks
the others. Documents a real gotcha: `parallelMerge`'s default
`minConfidence` (0) silently discards a winner whose custom scorer
returns a negative value — a naive "lower price wins" scorer needs a
positive-valued score (`1/price`, not `-price`). Run with
`bun examples/provider-fanout/setup.js`.

**[`examples/large-catalog-search/`](examples/large-catalog-search/)** —
"when does `vector.js`'s linear scan stop being good enough?", answered
with real measured numbers instead of asserting it. Indexes 8000 synthetic
products into `core/hnsw.js`'s standalone `HNSWIndex`, then runs every
query both ways — approximate HNSW graph search vs. a brute-force exact
cosine scan over the same vectors — and reports timing and recall
honestly: 4.9x–8.5x faster, recall between 0.7 and 1.0 depending on the
query (ANN is genuinely approximate, not always perfect). Documents a real
gotcha: `HNSWIndex` has no persistence of its own (no `save()`/`load()`) —
confirmed by reading the whole module. Run with
`bun examples/large-catalog-search/setup.js`.

**[`examples/job-queue/`](examples/job-queue/)** — "kick off slow work,
return immediately, poll for status," using `core/queue.js`'s `JobQueue`
for retries with exponential backoff and dead-letter handling off the HTTP
request/response path entirely (the same "kick off + poll" shape the MCP
Tasks extension formalizes for long-running tool calls — see the
`mcp.js`/`shell-mcp.js` note above). Verified live end-to-end: a job
exhausts its retries into the dead letter, gets retried, and completes.
Found a real API-consistency gap while building: `queue.retry()` returns
the raw new job document, not the `{jobId, status}` shape `enqueue()`'s
other callers get — `tools.js` normalizes it. Run with
`bun examples/job-queue/setup.js`.

**[`examples/plugin-system/`](examples/plugin-system/)** — "extend the CMS
with third-party modules without giving them raw DB access," using
`core/plugins.js`'s capability-gated `createPluginAPI` + `loadPlugins`.
3 real local plugins with deliberately narrow, different capabilities
(`entries:read`+`database:write`, and two with `entries:read` only).
Verified live: a plugin without `database:write` genuinely has no
`api.database` property at all. Found and documented a real gotcha:
`core/cms.js`'s ~30 hook call sites never pass `{ throwOnHookError: true }`,
so a plugin hook can observe/mutate an operation but can never veto it —
confirmed live, not just by reading the code. Run with
`bun examples/plugin-system/setup.js`.

**[`examples/workflow-engine/`](examples/workflow-engine/)** — the n8n-style
engine itself, front and center: a webhook-triggered order workflow with 3
independent enrichment nodes measured running in genuine DAG-parallel
(186ms total vs. ~450ms sequential), `{{ref}}`-wired nodes, and
vault-backed credentials. Found a real gotcha: built-in HTTP nodes
(`email.send` and similar, with no custom `handler`) always call
net-guard's `assertPublicUrl` with **no opt-out** — unlike
`core/connector.js`'s opt-in `blockInternalHosts` — so they correctly
reject this example's own local mock API; the demo keeps that failure
visible (`continueOnError: true`) and adds a custom-handler node using the
same credential to show the working alternative. Run with
`bun examples/workflow-engine/setup.js`.

**[`examples/a2e-pipeline/`](examples/a2e-pipeline/)** — `a2e.js`'s own
distinctive shape: a declarative compact-JSON signup-batch pipeline using
`Loop`, `Conditional`, `StoreData`, and both middleware classes
(`AuditMiddleware`, `CacheMiddleware` — measured live: a repeated slow
lookup goes from 154ms to 0.2ms on cache hit, ~770x). Building it found
and fixed **2 real bugs in `core/a2e.js` itself**: `Loop` with
sub-operations threw a `ReferenceError` on its very first item (a `depth`
variable referenced outside its scope, zero prior test coverage), and
`Conditional` always executed **both** branches — the taken one **twice**
— because `execute()` blanket-dispatched every declared operation
regardless of which branch was chosen. For anything with a real side
effect (an API call, a payment) both fixes matter for correctness, not
just cosmetics. Run with `bun examples/a2e-pipeline/setup.js`.

**[`examples/content-formats/`](examples/content-formats/)** — "author
once in Markdown, publish everywhere," using `core/portable-text.js` to
store content as structured JSON blocks and render the same article to
HTML, Markdown, and plain text for different channels, plus a custom
`callout` block type via `toHTML`'s `customRenderers` hook. Verified live:
the 2026-07 audit's stored-XSS fix in the built-in renderers is still
intact — but `customRenderers` itself does **not** auto-escape (an
intentionally unsafe custom renderer let a `<script>` tag through raw;
this example's own renderer escapes explicitly for that reason). Also
confirmed: a custom block only renders where you gave it a renderer —
`toMarkdown`/`toPlainText` have no equivalent hook and silently drop it.
Run with `bun examples/content-formats/setup.js`.

## Testing

```bash
bun test tests/    # 746 tests across 35 files, ~10 seconds
```

35 test files covering all core modules plus the `examples/content-pipeline`,
`examples/command-gateway`, `examples/agent-memory-backend`,
`examples/vector-memory`, `examples/integrations`, `examples/scheduled-sync`,
`examples/provider-fanout`, `examples/large-catalog-search`,
`examples/job-queue`, `examples/plugin-system`, `examples/workflow-engine`,
`examples/a2e-pipeline`, and `examples/content-formats` end-to-end scenarios
(includes the regression tests added by the 2026-07 security audit
— see [Security](#security) below). Fully deterministic — no known-flaky
tests: `memory.test.js`'s dream-heuristic test used to assert
`duration_ms > 0` on an operation that can legitimately finish in under
0.5ms (rounds to exactly 0), now asserts the type/shape instead; and
`vector.test.js`'s `QuantizedStore` test used to assert the quantized
top-1 result always exactly matches the float32 top-1 — INT8 quantization
is lossy by design, so that held only 498/500 over random trials. Now
asserts the real guarantee (float32's top-1 shows up within the quantized
top-3, which held 500/500).

## Multi-runtime

```bash
bun server-bun.js      # Bun (fastest)
node server-node.js    # Node.js 20+
deno run --allow-net --allow-read --allow-write --allow-env server-deno.js
```

## Security

3 full security audits to date, all findings remediated:

- **2026-07**: full-repo audit of all 21 core modules (4 parallel auditors) — 65 findings (7 critical, 13 high, 28 medium, 17 low), all fixed and verified against the real code with regression tests. Highlights: removed the `code.run` node (its "sandbox" was a bypassable keyword denylist over `new Function` — real RCE), added SSRF guards (`net-guard.js`) across HTTP nodes/triggers/a2e/connector, closed prototype-pollution paths (db.js, validate.js, shell.js, workflow.js), fixed stored XSS in `portable-text.js`, bounded the a2e DAG executor's recursion, gated plugin capability bypasses, replaced predictable default secrets (CMS JWT, workflow vault key, credential-vault PBKDF2 salt) with per-instance random values, and fixed assorted correctness/DoS bugs (HNSW memory leak, broken cache middleware, cron reentrancy, `parallelRace([])` hang, non-atomic writes). Full reports and per-fix specs in [`specs/`](specs/).
- **2026-07 (follow-up)**: building [`examples/content-pipeline/`](examples/content-pipeline/) as a real end-to-end exercise surfaced 2 more gaps the audit's unit tests didn't catch, both fixed: the webhook secret from FIX-10 was enforced in `core/triggers.js` but never wired through `routes/workflows.js`/`WorkflowEngine.webhookTrigger`, so no webhook could actually authenticate over real HTTP; and `core/shell.js` exported `AGENT_PROFILES` but never consulted it — `new Shell({ profile: 'restricted' })` alone enforced nothing unless the caller *also* passed `permissions` explicitly. `permissions` now derives from `profile` when omitted, failing closed to `restricted` for unrecognized profiles.
- **2026-07 (`shell.js` line-by-line audit)**: a manual read of the whole command-gateway module (parser, RBAC, batch/pipeline execution) found 2 real correctness bugs, both fixed with regression tests: `batch [...]` used `Promise.all` directly over each command, so one handler *throwing* (vs returning a normal error) silently discarded every sibling command's already-succeeded result instead of isolating the failure; and the `' | '`/`' >> '`/`','` split points used plain `indexOf`/`split` with **no** quote-awareness (despite one of them claiming otherwise in its own comment) — a quoted argument containing the literal delimiter (e.g. `--template "a | b"`) was silently mis-parsed into a broken command plus a garbage filter, succeeding with corrupted/`undefined` output instead of erroring.
- **2026-07 (`a2e.js` found while building `examples/a2e-pipeline`)**: 2 real correctness bugs in `WorkflowExecutor`, both fixed with regression tests: `Loop` with sub-operations threw a `ReferenceError` on its very first item (a `depth` variable referenced outside its own scope — zero prior test coverage caught it); and `Conditional` always executed **both** branches, with the taken one running **twice** (`execute()`'s DAG-level loop blanket-dispatched every declared operation regardless of which branch was chosen, in addition to `Conditional`'s own dynamic dispatch of the taken one). For any branch with a real side effect (an API call, a payment) this meant unintended executions, not just a cosmetic mismatch.
- **2026-07 (`portable-text.js` verified while building `examples/content-formats`)**: no bug found, but confirmed *live* rather than assumed — the 2026-07 audit's stored-XSS fix in `core/portable-text.js`'s built-in HTML renderers is still intact (a `<script>` tag typed as plain text renders as `&lt;script&gt;`). Also documented a real API contract clarification: `toHTML`'s `customRenderers` escape hatch does **not** auto-escape — an intentionally unsafe custom renderer let a `<script>` tag straight through in testing, confirming that escaping a custom renderer's own interpolated values is the implementer's responsibility, the same way it already is inside `core/portable-text.js` itself.
- 2 earlier audits, 26 fixes applied

Current security posture:
- Timing-safe password comparison (byte-level XOR)
- AES-256-GCM encryption (database, field-level, credential vault) with random per-installation PBKDF2 salts
- JWT auth via Web Crypto API (PBKDF2 + HMAC-SHA256), random per-instance secret unless configured explicitly
- SSRF guard (`net-guard.js`) on all outbound fetches driven by workflow/trigger definitions
- RBAC: 4 CMS roles + 4 agent profiles, enforced on shell built-ins and `:own`-scoped entry operations
- Plugin capability manifest, gated `database`/collection access, path-traversal guard on local plugin loading
- Content size limits, bounded queries, ReDoS guards on user-supplied `$regex`/pattern input
- HMAC-SHA256 webhook signing + optional per-webhook secret

## Documentation

See [AGENTS.md](AGENTS.md) for complete API reference, all endpoints, and AI agent integration guide.

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera) / [automators.work](https://automators.work)
