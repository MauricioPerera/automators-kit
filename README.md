# Automators Kit

**Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.**

1377 tests | 0 deps | 27 modules | Bun + Deno + Node.js

By [automators.work](https://automators.work)

## What it is

A full-stack automation toolkit in vanilla JavaScript with zero npm dependencies. 27 core modules covering: document database, vector search (HNSW), HTTP router, CMS, n8n-style workflow engine, A2E executor, agent shell (command gateway), job queue, cron scheduler, agent memory, and more.

Born from merging and distilling ideas from 10+ repos (lokiCMS, js-doc-store, js-vector-store, a2e, minimemory, Agent-Shell, php-agent-memory, EasyDB, RepoMemory, EmDash, ATDF) into a single portable project.

## Install

```bash
git clone https://github.com/MauricioPerera/automators-kit.git
cd automators-kit
bun seed.js        # create admin + default content types
bun server-bun.js  # start at http://localhost:3000
```

No `npm install`. Zero dependencies.

## 27 Core Modules

| Module | What it does |
|--------|-------------|
| **db.js** | Document DB: MongoDB queries, 26 operators, indices, JWT auth, AES-256-GCM encryption, proxy access, watch, long-lived API keys (separate from a login session), optional typed tables with validated columns |
| **vector.js** | Vector DB: Float32/Int8/Polar/Binary quantization, IVF (survives deletes/additions, reports index drift), Matryoshka, BM25, hybrid search |
| **hnsw.js** | HNSW index: O(log n) approximate nearest neighbor search (see [`examples/large-catalog-search`](examples/large-catalog-search/), [`examples/agent-memory-hnsw`](examples/agent-memory-hnsw/)) |
| **http.js** | HTTP router: Web Standard Request/Response, middleware chain, params, sub-routers, CORS, request logging + Prometheus instrumentation |
| **validate.js** | Schema validation: types, formats, defaults (replaces Zod) |
| **cms.js** | CMS: content types, entries, taxonomies, terms, users, roles, autosave, last-admin lockout protection |
| **plugins.js** | Plugin system: hooks, capability-based access control, registry (see [`examples/plugin-workflow-nodes`](examples/plugin-workflow-nodes/)) |
| **portable-text.js** | Rich content: JSON blocks to HTML/Markdown/PlainText, fromMarkdown parser (see [`examples/content-render-workflow`](examples/content-render-workflow/)) |
| **mcp.js** | MCP server: JSON-RPC 2.0 over stdio, 20 tools for AI agents |
| **a2e.js** | A2E executor: 19 declarative operations, DAG parallel execution, middleware |
| **workflow.js** | Workflow engine: n8n-style nodes, triggers, credentials, execution history, DAG-parallel execution, N-way branching (`switch`/`runIf`), error workflows, sub-workflows (`workflow.execute`), persisted wait (`wait.until`/`wait.forWebhook`), per-item processing (`loop.forEach`), per-node retry/backoff, native data table read/write (`data.table`), failed-execution retry, persistent per-workflow scratch space (`workflow.staticData`), instance-wide concurrency cap with backpressure, execution-history retention, optional execution queue for horizontal scaling, synchronous webhook response (`respond: 'whenFinished'`), `createdBy`/`updatedBy` attribution |
| **dag.js** | Shared DAG level-scheduling (Kahn's algorithm), used by both `workflow.js` and `a2e.js` |
| **nodes.js** | Node registry: 21 built-in nodes (core, communication, data, AI) + ARDF export |
| **triggers.js** | Trigger system: manual, webhook, cron, polling with change detection (see [`examples/trigger-hub`](examples/trigger-hub/)) |
| **credentials.js** | Credential vault: AES-256-GCM encrypted API keys and tokens, OAuth2 (authorization-code + PKCE + refresh), `createdBy`/`updatedBy` attribution |
| **projects.js** | Projects → Folders → Workflows: project-scoped roles (`owner`/`editor`/`viewer`), separate from CMS's global roles, `createdBy`/`updatedBy` attribution |
| **shell.js** | Agent shell: command gateway, parser, pipeline, JQ filter, RBAC |
| **shell-mcp.js** | Exposes `shell.js` over MCP as exactly 2 fixed tools (`shell_help`/`shell_exec`), ~600 constant tokens regardless of registry size — port of [Agent-Shell](https://github.com/MauricioPerera/Agent-Shell)'s `McpServer` |
| **queue.js** | Job queue: async processing, retries with exponential backoff, dead letter, stuck-job lease reclaim |
| **cron.js** | Cron scheduler: 5-field expressions, enable/disable, manual run, anti-reentrancy guard |
| **connector.js** | HTTP client: auth presets (bearer/basic/apikey), retries, timeout, optional SSRF guard |
| **memory.js** | Agent memory: semantic + episodic + working, scoping, dedup, dream cycle, correction boost |
| **parallel.js** | Task orchestration: race/merge/all strategies, timeout, weighted scoring |
| **net-guard.js** | SSRF guard: blocks fetches to loopback/RFC1918/link-local/cloud-metadata destinations |
| **log.js** | Structured logging: leveled, JSON-per-line entries, pluggable sink |
| **metrics.js** | In-process metrics: counters/gauges/histograms, Prometheus text exposition format |
| **csv.js** | CSV parsing: RFC-4180 quoted fields, embedded delimiters/newlines, escaped quotes |

**Picking between similar-sounding modules:**
- **`memory.js` vs `vector.js`** — `memory.js`'s `recall()` is keyword/term matching with time decay, zero ML dependency, works out of the box (see [`examples/agent-memory-backend`](examples/agent-memory-backend/)). `vector.js` does real cosine-similarity search over embeddings *you* provide — it never calls an embedding API itself (see [`examples/vector-memory`](examples/vector-memory/)). Reach for `memory.js` first; reach for `vector.js` when word-overlap isn't good enough and you're willing to bring an embedding function. Combining them as a keyword-first, vector-fallback strategy is **not** a semantic upgrade with the zero-dependency offline embedding either module ships with — see [`examples/hybrid-recall`](examples/hybrid-recall/) for what verified, honest value the combination actually has (coverage, not paraphrase understanding).
- **`workflow.js` vs `a2e.js`** — two separate execution engines, not layers of one system. `workflow.js` is the n8n-style engine: named nodes wired by `{{ref}}` templates, triggered by webhook/cron/poll/manual, DAG-parallel. `a2e.js` is a smaller, declarative multi-step executor (`SetData`/`FilterData`/`ApiCall`/`Conditional`/`Loop`/...) with its own DAG and middleware, generally used standalone or from an `a2e.js`-authored node. They share the DAG level-scheduling algorithm itself (`dag.js`) since it was byte-for-byte duplicated code, but each keeps its own dependency-detection convention — an engine-specific improvement (e.g. how deps are inferred) still has to be ported to the other by hand. Two more real differences, verified while building [`examples/a2e-vault-api`](examples/a2e-vault-api/): `WorkflowExecutor.execute()` takes no per-call input at all (unlike `workflow.js`'s `execute(id, triggerData)`) — reuse means reloading the pipeline definition, not injecting data into an already-loaded run; and `execute()`'s DAG-level dispatch does **not** stop on a failed op (`workflow.js`'s does, unless `continueOnError`), so a downstream `Conditional` reading a failed op's never-written output silently gets `undefined` unless an explicit `onError` fallback is used.
- **`mcp.js` vs `shell-mcp.js`** — two different answers to "how many MCP tools should this expose." `mcp.js` gives each capability its own tool with a real JSON schema (`list_entries`, `create_entry`...) — the client sees full discovery via `tools/list`, but context cost grows with every tool added (see [`examples/mcp-cms`](examples/mcp-cms/)). `shell-mcp.js` exposes `shell.js`'s entire command registry through exactly 2 fixed tools (`shell_help`/`shell_exec`); the agent discovers commands at runtime via `shell_exec("search ...")`/`("describe ...")` instead of `tools/list`, so the tool-list cost stays constant no matter how large the registry gets (see [`examples/shell-mcp`](examples/shell-mcp/)). Verified against a real external MCP client (poolside.ai's `pool exec`): given only `shell_help`/`shell_exec`, it correctly called help first, searched for the right commands, described their params, then executed them — no schema handed to it upfront.

**Known architectural limit — `db.js` is single-process by design.**
`Collection._ensureLoaded()` loads the storage adapter's data into an
in-memory `Map` once and never re-reads it — every subsequent read/write
hits that `Map` directly, and `flush()` is the only path back to disk. This
is why it's fast, and also why it can't be safely shared across multiple
processes or machines: there's no cache invalidation or coherency protocol,
so two processes each holding their own `Collection` over the same data
would silently diverge instead of erroring. This applies to everything
built on `DocStore` — `cms.js`, `credentials.js`, and `memory.js` — not
just one module. [`integrations/`](#optional-integrations) has three
sidecars addressing this, none of which touch `core/db.js` itself:
`postgres-queue.js`'s `PostgresJobQueue` and `postgres-execution-log.js`'s
`PostgresExecutionLog` sidestep the coherency problem entirely by never
caching state (every operation is a fresh round trip); `postgres-collection.js`'s
`PostgresCollection` is the first one to actually solve it for a real
`Collection`-shaped use case — it caches (for `Collection`-like read
speed) and keeps that cache correct across processes via Postgres
LISTEN/NOTIFY, verified live: a second process's cache reflects a first
process's write with zero manual re-reads. The same pattern could extend
case by case to `cms.js`/`credentials.js`/`memory.js`, but doesn't
generalize into one fix — `Collection`'s caching model itself would need
a redesign from scratch to be safe across processes, a project of a
different scale than async-ifying method signatures alone.

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

### With observability
```javascript
import { Router, logger, metricsHandler } from './core/http.js';
import { createLogger } from './core/log.js';
import { MetricsRegistry } from './core/metrics.js';

const log = createLogger('api');           // structured JSON-per-line entries
const metrics = new MetricsRegistry();     // counters/gauges/histograms

const router = new Router();
router.use(logger({ log, metrics }));      // logs + records http_requests_total / http_request_duration_ms
router.get('/metrics', metricsHandler(metrics)); // Prometheus text exposition format
```
No distributed tracing — not honestly buildable zero-dependency without an
external collector to send spans to; correlation IDs threaded through
`log.js` entries are the practical middle ground.

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

**[`examples/doc-store-analytics/`](examples/doc-store-analytics/)** —
"you don't need the whole CMS to get a document database + HTTP API."
Unlike every other example, this one never calls `createApp()`: it wires
`core/db.js`'s `DocStore` directly to `core/http.js`'s `Router` and
`core/shell.js`'s `Shell` — 3 à la carte modules, zero CMS. An inventory
service demonstrating real MongoDB-style operators, `$group` aggregation,
`$lookup` (a real join — top sellers joined to product details, not
manual post-processing), and export/import backup. Measured live: an
indexed lookup is ~21x faster than the same query before
`createIndex()` (1.334ms → 0.062ms on an 8000-product seed). Run with
`bun examples/doc-store-analytics/setup.js`.

**[`examples/api-validation/`](examples/api-validation/)** —
`core/validate.js` standalone, no CMS: a signup API using
`validateBody`/`validateQuery` middleware, with required/type/min-max,
`format` validators, a `pattern` RegExp, `enum`, nested `object`
properties, typed `array` items, defaults, `opts.partial`, and a
cross-field `$refine` rule. Found and fixed a real gotcha: `validate()`
applies a schema's **function** defaults (like
`createdAt: () => new Date().toISOString()`) on every call —
`opts.partial` included — for any field missing from the input. A naive
partial-update handler that merged the whole validated result back onto
the existing record silently regenerated `createdAt` on every update,
even when the caller never mentioned it; verified live before and after
the fix. Run with `bun examples/api-validation/setup.js`.

**[`examples/mcp-cms/`](examples/mcp-cms/)** — the CMS's own MCP server
(`core/mcp.js`), front and center: 20 base tools, one per capability,
each with a real JSON schema seen up front via `tools/list` — the
complementary pattern to [`core/shell-mcp.js`](core/shell-mcp.js)'s
2-tool gateway (see the module comparison note above). Plus 1 custom tool
(`publish_with_stats`, composing `mcp.js` + `portable-text.js` in one
call) via `buildAllTools`'s `extraTools`. Verified against a real
external MCP client (poolside.ai's `pool exec`): given only the schemas,
it created an entry, confirmed `draft` status, called the custom tool,
and correctly reported the word count and excerpt it returned — no
guessed field names, no `search`/`describe` round-trip needed first
(unlike `shell-mcp.js`). Run with `bun examples/mcp-cms/setup.js`.

**[`examples/shell-mcp/`](examples/shell-mcp/)** — `core/shell-mcp.js`'s
2-tool MCP gateway (see the module comparison note above), wired to a real
task-management command registry
(`tasks:create`/`list`/`complete`/`delete`) — this module had unit tests
but no worked example until now. JSON-RPC 2.0 over stdio, not HTTP:
verified live by spawning the real `setup.js` process and piping actual
JSON-RPC lines to its stdin, confirming `tools/list` stays at exactly 2
regardless of registry size, and discovery via `shell_exec("search
...")`/`("describe ...")` works with zero schema handed to the client
upfront. Verifying it live found and fixed a real bug in `core/shell.js`
itself: `--confirm` was advertised (in `help()` and `shell_exec`'s own
tool description) as "Preview before execute," but the flag was parsed
and never checked — a command carrying `--confirm` executed for real,
immediately, same as not passing it at all. `--confirm` now previews
(same shape as `--dry-run`) without running the handler; a follow-up call
without it executes for real. Run with `bun examples/shell-mcp/setup.js`.

**[`examples/api-gateway/`](examples/api-gateway/)** — `core/http.js`'s
`Router` as the star: global middleware (`cors`, `logger`), per-route-group
rate limiting via mounted sub-routers (`/api/public` vs `/api/admin` get
genuinely different limits — each `Router` instance has its own
middleware stack), and a custom `keyFn` (rate limit by an API key header
instead of client IP). Found and fixed a real bug: `rateLimit()` computed
`X-RateLimit-*` headers for an **allowed** request, but nothing ever
merged them into the response — only the 429-blocked path (built inline)
carried real ones. Measured live: `/api/public/ping`'s `Remaining` steps
4,3,2,1,0 then a real 429 with `Retry-After` on the 6th request. Run with
`bun examples/api-gateway/setup.js`.

**[`examples/trigger-hub/`](examples/trigger-hub/)** — `core/triggers.js`'s
`TriggerManager`, front and center: all 4 trigger types (manual, webhook,
cron, poll) feeding one unified `onTrigger` callback, no CMS/`WorkflowEngine`
needed. Found and fixed 2 real bugs in `core/triggers.js`: `list()` never
surfaced a poll trigger's circuit-breaker error state (only a **private**
`_pollerErrors` map recorded it — confirmed by the module's own unit tests
reaching into it directly), so a dead poller kept showing as an ordinary,
still-running registration; and `_pollOnce` never checked `res.ok`, so an
HTTP error (503) with a valid JSON body was silently treated as *changed
data* — firing the trigger with the error body as its payload and
**resetting** the failure counter instead of tripping the breaker.
Verified live over a real HTTP round trip, real 1s poll interval, before
and after both fixes. Also documents a hard, verified-live constraint:
poll triggers can't target `localhost` at all — `register()` calls
net-guard's `assertPublicUrl` with **no opt-out** (unlike
`connector.js`'s `blockInternalHosts`). Run with
`bun examples/trigger-hub/setup.js`.

### Combined examples

Every example above demonstrates ONE module. These compose 2-3 of them
into a pattern none covers alone:

**[`examples/resilient-notify/`](examples/resilient-notify/)** —
`examples/job-queue` + `examples/provider-fanout` + `examples/integrations`:
an alert job that runs in the background (non-blocking, retryable, dead
letter on total failure) and races all configured channels
(`parallelRace`) so it reaches *someone* fast without caring which
channel got through, using vault-backed `Connector`s exactly like
`integrations`. Verified live end-to-end: happy path, one channel down
not slowing anything, and the full all-channels-down → dead letter →
retry → recovery cycle. Documents an honest, verified-not-assumed
gotcha: `parallelRace` doesn't cancel losing tasks, so when two channels
answer with similar latency, **both** actually deliver the message — not
just the one whose result the job returns. Run with
`bun examples/resilient-notify/setup.js`.

**[`examples/mcp-workflows/`](examples/mcp-workflows/)** —
`examples/shell-mcp` + `examples/workflow-engine`: `core/shell-mcp.js`'s
2-tool MCP gateway driving **real** `core/workflow.js` executions — an
agent runs and inspects a real workflow (Ticket Triage) via
`shell_exec`, something neither `mcp-cms` (CMS ops, not workflows) nor
`workflow-engine` (HTTP/webhook-driven, no MCP) demonstrates. Found and
fixed a real bug: `WorkflowEngine.execute()`/`run()` discarded the
return value of `insert()` (which clones with `_id` assigned, doesn't
mutate the input) and returned an execution object with no `_id` at
all — unlike `core/cms.js`'s `EntryService.create()`, which already
captures it correctly. Verified live before/after: the same execution,
fetched right after the fix by the id `run()` itself returned. Run with
`bun examples/mcp-workflows/setup.js`.

**[`examples/plugin-workflow-nodes/`](examples/plugin-workflow-nodes/)** —
`examples/plugin-system` + `examples/workflow-engine`: a third-party
plugin extending `core/workflow.js`'s `NodeRegistry` with a real new node
type, capability-gated by `core/plugins.js` — something neither example
demonstrates alone. Building it found a real gap: `createPluginAPI` had
no way to reach the workflow engine's `NodeRegistry` at all, so a new
`nodes:register` capability was added (gated exactly like the existing
`database:write`, threaded through `loadPlugins()`/`createApp()`
automatically). Designing it surfaced a real security gap:
`NodeRegistry.add()` has no collision guard — verified live that it
silently lets any caller overwrite `http.request`, including its
net-guard SSRF check, for every workflow in the system. The new
capability's wrapper rejects overwriting an existing node type; a second
plugin in this example demonstrates the rejection live, not just in a
unit test. Run with `bun examples/plugin-workflow-nodes/setup.js`.

**[`examples/hybrid-recall/`](examples/hybrid-recall/)** —
`examples/agent-memory-backend` + `examples/vector-memory`:
`core/memory.js`'s keyword recall tried first, falling back to
`core/vector.js`'s cosine search only on a true empty. The original plan
("semantic fallback for paraphrases") was verified empirically *before
writing any code* and doesn't hold — the shared offline hashing-trick
embedding has no synonym understanding, and a genuine paraphrase can
rank an unrelated stored doc above the real match (verified live). Built
around what's actually true instead: `memory.recall()` hard-empties on
zero shared vocabulary, `store.search()` never does — the fallback adds
coverage, not intelligence, and results are honestly labeled
`source: "keyword"`/`"vector"` plus a `lowConfidence` flag. That
threshold was itself miscalibrated on the first pass (0.3 mislabeled a
clearly unrelated query as confident at 0.429, verified live) and
corrected to 0.5 against a 10-query empirical sample. Run with
`bun examples/hybrid-recall/setup.js`.

**[`examples/poll-to-queue/`](examples/poll-to-queue/)** —
`examples/trigger-hub` + `examples/job-queue`: a poll trigger watching an
external feed, enqueueing **one durable, independently retryable job per
genuinely new item** instead of one all-or-nothing event per poll cycle
— a real production ingestion pattern neither example covers alone
(`trigger-hub` only logs fired events; `job-queue` has no poll source).
Found a real gotcha, no core changes needed — fixed entirely in the
example's own bridge logic: `TriggerManager`'s poll never fires
`onTrigger` on its first cycle (that cycle only establishes the baseline
hash), so without an explicit baseline fetch before the poll trigger
starts, the first real fire would treat every pre-existing feed item as
new and enqueue it — verified live, then fixed by seeding a `seenIds` set
from an initial fetch first, the same cursor philosophy
[`examples/scheduled-sync`](examples/scheduled-sync/) already uses for
outbound sync, applied to inbound polling. Verified live end-to-end:
baseline seeding, a new item becoming a processed job within one poll
cycle, a persistently failing item reaching the dead letter isolated from
others, and the poll circuit-breaker (the `triggers.js` fix from
`trigger-hub`) tripping on 3 real HTTP 503s with zero spurious enqueues.
Run with `bun examples/poll-to-queue/setup.js`.

**[`examples/a2e-vault-api/`](examples/a2e-vault-api/)** — combines
`core/a2e.js`'s declarative executor with `core/credentials.js`'s vault +
`core/connector.js`'s retrying HTTP client, calling a **real** external
API from a pipeline step — something `examples/a2e-pipeline` doesn't
cover (fully offline). Uses the custom-handler extension point `a2e.js`
already has (`WorkflowExecutor.registerHandler()`) but never demonstrated
with a real network call; `a2e.js`'s own built-in `ApiCall` op has no
credential injection at all. No core changes — composition, not a new
capability. Found 2 real, verified differences from `workflow.js` (see
the module comparison note above): no per-call input on `execute()`, and
no stop-on-error across DAG levels — a failed lookup silently routed
into the same path as a genuine standard-tier lead until an explicit
`onError` fallback made the failure state distinguishable, verified live
before and after. Run with `bun examples/a2e-vault-api/setup.js`.

**[`examples/a2e-background/`](examples/a2e-background/)** — combines
`core/queue.js`'s kick-off + poll pattern with `core/a2e.js`'s declarative
executor: a batch enrichment pipeline runs as a durable background job
instead of blocking the HTTP request — neither `examples/job-queue` nor
`examples/a2e-pipeline` demonstrates this. Found and fixed a real,
serious **core bug**, same class as the earlier `Conditional`
both-branches bug (its own fix plan had explicitly flagged this Loop case
as deferred): a `Loop`'s sub-operations were dispatched **twice** — once
spuriously at the top level (`state.loop === {}`, before the loop even
starts), once correctly per iteration. Every prior `Loop` test tolerated
garbage input silently, so this was invisible until a realistic handler
threw on it (verified live: called 3 times for a 2-item loop, not 2).
Fixed via Plan Mode approval with `loopSubOperationTargets()`, mirroring
the existing `conditionalBranchTargets()` exactly. Also found (at the
time, only handled at the example level): a single `WorkflowExecutor`
instance was unsafe for concurrent `execute()` calls — verified live
that two concurrent runs sharing one instance corrupted each other's
results; worked around here by constructing a fresh executor per job.
**Fixed properly in `core/a2e.js` since** (see [Security](#security)
below) — the constructor-per-job workaround shown here is no longer
required, though it remains valid. Verified live: a single background
run completes correctly, and 3 **concurrent** jobs each land their own
correct, isolated result. Run with `bun examples/a2e-background/setup.js`.

**[`examples/agent-memory-hnsw/`](examples/agent-memory-hnsw/)** —
combines `core/memory.js`'s `AgentMemory` with `core/hnsw.js`'s
standalone `HNSWIndex`: real memory content indexed into both, comparing
3 recall strategies as memory scales (keyword, HNSW approximate,
brute-force exact) — same benchmark methodology as
`examples/large-catalog-search`, applied to real agent memory instead of
a synthetic catalog. Found and fixed a real, **severe core bug**: HNSW's
neighbor selection used the naive "M closest by raw distance" heuristic
— with duplicate/near-duplicate vectors (common in real memory content,
unlike `large-catalog-search`'s catalog which embeds a unique index
number per product avoiding this), recall vs. a brute-force exact scan
**collapsed from 1.0 to 0.0** with just 2x exact duplication, verified
live. Fixed via Plan Mode approval (algorithmic change) implementing the
original HNSW paper's diversity-aware neighbor selection; verified live:
2x duplication recovered to 0.8-1.0 recall, ~9x (the real 5000-entry demo
scale) recovered to 0.6 with the top result now exactly matching the
true best (previously it found a measurably worse cluster entirely). The
pre-existing `hnsw.test.js` recall test improved to 1.000 with the fix.
Measured: HNSW is ~7.4x faster than the brute-force exact scan and ~60x
faster than `memory.js`'s own keyword recall over 5000 entries. Run with
`bun examples/agent-memory-hnsw/setup.js`.

**[`examples/validated-webhooks/`](examples/validated-webhooks/)** —
combines `core/validate.js`'s real schema engine with
`core/workflow.js`'s webhook trigger: a malformed payload is rejected
with a clear `400` **before** the workflow ever runs, instead of a
partial/garbage execution. Found a real architectural gotcha, verified
live: `createApp()` always mounts its own bundled `/api/workflows`
router with an **unvalidated** webhook route at
`/api/workflows/webhook/:path`, unconditionally — bolting a validated
route on top while using `createApp()` would leave that route reachable,
bypassing validation entirely. Confirmed with a throwaway script: a
garbage payload the validated route rejects with `400` sailed through the
built-in route with a real `200`, actually executing the workflow. This
example does **not** call `createApp()` at all (same à la carte spirit as
`examples/doc-store-analytics`) specifically so the validated route is
the *only* webhook route that exists. Run with
`bun examples/validated-webhooks/setup.js`.

**[`examples/content-render-workflow/`](examples/content-render-workflow/)**
— combines `core/portable-text.js` with `core/workflow.js`: "author in
markdown, a webhook-triggered workflow renders and distributes it." A
real custom node (`content.render`, registered via
`WorkflowEngine.nodes.add()` — the same extension point
`examples/plugin-workflow-nodes` already uses, no core changes needed)
parses markdown once and derives HTML, plain text, and word count from
the same parsed blocks; a downstream built-in `set.value` node correctly
interpolates the custom node's outputs via `workflow.js`'s own `{{ref}}`
templating. Found and documented a real, honest caveat, verified live
end-to-end: `toHTML()` escapes an inline `<script>` tag (the 2026-07
audit's XSS fix, confirmed still intact), but `toPlainText()`/`excerpt`
correctly does **not** — a real consequence for this specific
combination: a future step embedding `{{render.excerpt}}` into an HTML
context without escaping it itself would reopen the exact XSS surface the
audit closed for `toHTML()`. Run with
`bun examples/content-render-workflow/setup.js`.

**[`examples/hybrid-catalog-search/`](examples/hybrid-catalog-search/)**
— combines `core/vector.js`'s cosine-similarity ranking with a **real**
`core/db.js` `$lookup`/`$group` aggregation, scoped to exactly the
semantic top-K via `$match: {$in}` — a query neither module can answer
alone. `core/vector.js` has no notion of a database;
`examples/doc-store-analytics`'s `topSellers()` joins sales data via a
real `$lookup`, but as an unscoped `$group` over *every* order, no
semantic ranking. Verified live: `hybridSearch()` returns the exact same
ids/order/scores as ranking alone, proving the join never reorders
results — it only adds `unitsSold`/`orderCount` on top, correctly `0`/`0`
for products with no real order history rather than dropping them or
leaving fields `undefined`. A real design detail handled correctly (not a
bug): `$group`'s output order isn't guaranteed to match the vector
search's ranking, so results are explicitly re-sorted back into the
original semantic rank order after the join. Run with
`bun examples/hybrid-catalog-search/setup.js`.

**[`examples/rate-limited-queue/`](examples/rate-limited-queue/)** —
combines `core/http.js`'s `rateLimit()` with `core/queue.js`'s
`JobQueue`, guarding intake instead of just the HTTP response.
`examples/api-gateway`'s `rateLimit()` only ever protects fast inline
handlers, never a queue; `examples/job-queue` has no limiter on
`enqueue()` at all — any caller can flood it with unlimited jobs, and a
failing job's own retries with backoff multiply that flood further. Here
the limiter sits directly in front of `enqueue()`, so an over-limit
client gets `429` **before** a job is ever created. Verified live: a
burst of 4 requests against `max: 3` returns 3× `202` (carrying real
`X-RateLimit-*` headers) then a `429`, and queue stats confirm exactly 3
jobs completed — the 4th request never reached the queue. Run with
`bun examples/rate-limited-queue/setup.js`.

**[`examples/cms-semantic-search/`](examples/cms-semantic-search/)** —
combines `core/cms.js`'s `entry:afterCreate`/`afterUpdate`/`afterDelete`
hooks with `core/hnsw.js`'s `HNSWIndex`, kept in sync with a real content
lifecycle. `examples/hybrid-catalog-search`/`examples/agent-memory-hnsw`
index synthetic generated data — nothing gets created, edited, or
deleted through them; `examples/mcp-cms` exposes real CMS entries but its
only "search" is a title/slug substring filter, no ranking. Building
this the honest way — restarting the server against its own persisted
data, like a real deploy — found and fixed a real core bug (with your
approval): `new CMS()` crashed on any restart against existing
`FileStorageAdapter` data (`Index already exists on field: slug`) —
`core/credentials.js`/`core/memory.js`/`core/workflow.js` already guard
their constructor's `createIndex()` calls with `try/catch` for exactly
this reason, `core/cms.js` never got the same treatment, meaning every
example using `createApp()` + `FileStorageAdapter` had never actually
survived a real process restart. Fixed with a 7-line change mirroring
the existing pattern, verified live before/after. Also verified live:
create/update/delete stay correctly reflected in search results, and
`reindexAll()` catches the still-non-persistent `HNSWIndex` back up after
a restart. Run with `bun examples/cms-semantic-search/setup.js`.

**[`examples/validated-workflow-nodes/`](examples/validated-workflow-nodes/)**
— combines `core/validate.js` with `core/workflow.js`: a schema gates a
node's handler so it only ever runs on data that already passed
validation. `examples/api-validation`/`examples/validated-webhooks` only
validate the request body at the HTTP boundary — the moment a workflow
*starts*, never data a workflow produces for itself mid-pipeline;
`core/nodes.js`'s own `inputs` array is documentation only, never
enforced by `NodeRegistry.execute()`. No core changes needed —
`validatedNode()` is a node-definition-level wrapper, the same extension
point `examples/plugin-workflow-nodes`/`examples/content-render-workflow`
already use. Verified live: a `discountPercent: 150` trigger payload is
perfectly valid by itself, but silently produces a negative amount
inside the pipeline; the validated `charge` node blocks it with
`"Validation failed: amount must be >= 0.01"`, while the identical
unvalidated node **succeeds** while charging `-50` — an unnoticed
refund, not a crash. Run with
`bun examples/validated-workflow-nodes/setup.js`.

**[`examples/mcp-job-queue/`](examples/mcp-job-queue/)** — combines
`core/mcp.js` with `core/queue.js`: an AI agent enqueues background work
and polls for its result using only MCP tool calls, no HTTP/shell.
`examples/job-queue` only ever exposes this over HTTP/shell — no MCP
transport exists for it; `examples/mcp-cms`/`examples/agent-memory-backend`
expose CMS entries and agent memory over MCP, never a `JobQueue`. Reuses
`examples/job-queue`'s own `handlers.js`/`tools.js` directly — the only
new code is the MCP tool shape (3 tools: `enqueue_report`, `job_status`,
`queue_stats`). Verified live over a real spawned stdio process: a full
enqueue → background-completion → status-poll round trip, plus an
unknown job id returning `{ found: false }` as ordinary data instead of
getting swallowed by `core/mcp.js`'s generic error-masking for thrown
errors (a real, documented design detail: masking applies to thrown
errors, not to data a handler deliberately returns). Run with
`bun examples/mcp-job-queue/setup.js`.

**[`examples/queue-access-control/`](examples/queue-access-control/)** —
combines `core/shell.js`'s RBAC with `core/queue.js`: 3 agent sessions
(admin / reader / a custom "queue-operator" permission set) share one
`JobQueue`, gated differently. `core/queue.js` itself has no notion of a
caller at all; `examples/job-queue` registers every queue command on
`createApp()`'s default `admin` shell, no restriction ever demonstrated.
The exact same commands are registered once on a shared
`CommandRegistry`, and 3 `Shell` instances decide for themselves what
their caller may run. Verified live: reader can list/check status but is
denied on enqueue/stats/purge; the custom operator set can enqueue and
read stats but not retry/purge (no built-in profile fits "enqueue +
monitor, no destructive ops"); admin's `purge` removes jobs enqueued by
*all three* sessions, confirming RBAC lives in which `Shell` a caller is
routed to, not in the data. Run with
`bun examples/queue-access-control/setup.js`.

**[`examples/vault-access-control/`](examples/vault-access-control/)** —
combines `core/shell.js`'s RBAC with `core/credentials.js`: 3 agent
sessions (admin / reader / a custom "integration-runner" permission set)
share one `CredentialVault`, gated differently — a more
security-sensitive extension of `examples/queue-access-control`'s same
pattern, applied to secrets instead of jobs. `core/credentials.js` has
no notion of a caller at all; `vault.get(name)` returns the fully
decrypted secret to any code holding a reference. `vault:reveal` (the
only command that ever returns a decrypted value) is admin-only *by
construction* — its verb matches no built-in profile's wildcard set.
Verified live: `integration-runner` can `vault:use` a credential
(decrypted server-side to confirm it's usable) with **zero secret
material** in the response, while `reveal`/`store`/`remove` stay denied;
`reader` sees safe metadata via `vault:list` with no custom grant
needed, since `vault.list()` itself never includes decrypted values. Run
with `bun examples/vault-access-control/setup.js`.

**[`examples/trigger-driven-a2e/`](examples/trigger-driven-a2e/)** —
combines `core/triggers.js` with `core/a2e.js`: a webhook fires a real
`WorkflowExecutor` pipeline, not a `core/workflow.js` `WorkflowEngine`.
`TriggerManager` is built directly into `WorkflowEngine`, but has zero
wiring to `core/a2e.js` — every existing a2e.js example invokes
pipelines manually. Works around a documented a2e.js constraint:
`execute()` takes no per-call input (a fresh definition is built per
fire with the trigger data baked in, same pattern
`examples/a2e-vault-api` used). Built before `execute()`'s per-call
state was fixed to be concurrency-safe in core (see
[Security](#security)), so a fresh executor is also constructed per
fire here — no longer required, but harmless. Building this reproduced
the same `a2e-vault-api`-documented footgun — a failed op's downstream
`Conditional` silently picking the same branch as a genuine negative
result — fixed at the example level. Verified live: correct
business/personal routing, a failed enrichment correctly stored as
`decision: null` instead of a misleading fallback, and two concurrent
fires each getting their own uncorrupted decision. Run with
`bun examples/trigger-driven-a2e/setup.js`.

**[`examples/agent-authored-node/`](examples/agent-authored-node/)** —
answers a real question from the n8n comparison directly: n8n ships a
CSV node, `core/nodes.js`'s 21 built-ins don't. Instead of waiting for
the framework to grow one, this demonstrates building it — an agent
following a [KDD](https://github.com/MauricioPerera/KDD) task contract
for the correctness-critical piece (RFC-4180 quoting/escaping, kept
external per this project's KDD-as-companion-methodology decision),
validated against a frozen-oracle suite and the real CCDD gate before
use. [`core/csv.js`](core/csv.js)'s `parseCsv` is a real, reusable core
module (not example-local throwaway code) — the "created once, stored,
reusable" half of the thesis. `nodes.js`'s `csv.parse` wraps it via the
same `WorkflowEngine.nodes.add()` extension point every other custom
node in this repo already uses, and composes with the **built-in**
`filter` node in a real workflow. Verified live with curl against a
running server: a comma embedded inside a quoted field survives the
whole pipeline intact, never split into an extra column. Run with
`bun examples/agent-authored-node/setup.js`.

**[`examples/workflow-observability/`](examples/workflow-observability/)**
— combines [`core/log.js`](core/log.js) + [`core/metrics.js`](core/metrics.js)
(built to close the "no observability" gap for running Automators Kit in
production) with `core/workflow.js`: real workflow-execution logging and
metrics, complementing `core/http.js`'s own request-level
`logger()`/`metricsHandler()`. `observe.js`'s `observeWorkflowEngine()`
watches `_executions` via `DocStore.watch()` — an existing extension
point — rather than wrapping `execute()`/`run()` directly, since
webhook/cron/poll triggers call `execute()` fire-and-forget internally; a
caller-side "await execute() then log" wrapper (the pattern
[`integrations/postgres-execution-log.js`](integrations/postgres-execution-log.js)
uses) would silently miss every trigger-fired run. No core changes
needed. Found a real routing gotcha while building this (not a bug,
documented in the example's own README): the demo's original webhook
path `run` collided with the protected `POST /:id/run` route registered
earlier in `routes/workflows.js` — `Router`'s first-match-wins semantics
dispatched to the wrong (401'ing) handler. Verified live: `/metrics`
correctly separates successful and failed executions by label. Run with
`bun examples/workflow-observability/setup.js`.

**[`examples/scheduled-report-queue/`](examples/scheduled-report-queue/)**
— combines [`core/cron.js`](core/cron.js) with `core/queue.js`: a cron
tick enqueues one durable, independently-retryable job per report,
instead of doing the work directly inline. Neither existing example
covers this — `examples/scheduled-sync`'s cron job performs its sync
action *directly* (no queue; a single failure blocks the cursor there
until retried); `examples/job-queue` has no scheduling trigger at all,
only manual enqueue calls; `examples/poll-to-queue` enqueues one job per
**new** item detected by a poll trigger (event-driven), not a fixed
batch on a schedule. Real cron ticks fire nightly — `reports:run-now`
exposes the exact same enqueue function for the live demo. Verified
live: two `run-now` calls back-to-back (simulating overlapping cron
ticks) produce 6 distinct job ids, all complete exactly once, zero lost
or duplicated; a deterministic first-attempt failure for one report
proves normal retry/backoff still applies to jobs from a scheduled
batch, not just manually-enqueued ones. Run with
`bun examples/scheduled-report-queue/setup.js`.

**[`examples/csv-bulk-import/`](examples/csv-bulk-import/)** — combines
[`core/csv.js`](core/csv.js) with `core/cms.js`: each CSV row becomes a
real CMS entry via `cms.entries.create()`, not a throwaway in-memory
array like `examples/agent-authored-node`'s `csv.parse` workflow node —
a real n8n-style "import a spreadsheet" pattern neither existing example
covers. `importProductsCsv()` reports per-row failures (a duplicate
title colliding on the auto-generated slug, invalid data) instead of
throwing and discarding everything already imported — a bulk import
where one bad row aborts the other 999 is a bad UX n8n users would never
accept from a CSV node either. Found and fixed a real `core/cms.js` bug
while building this: `validateContent()` checked `typeof value !==
'number'` for a `number`-typed field, but `typeof NaN === 'number'` is
`true` in JavaScript — `Number('not-a-number')` sailed through
validation as a "valid" number (zero prior test coverage for
number-typed fields at all). Fixed to also require
`Number.isFinite(value)` — see [Security](#security). Verified live: a
row with an unparseable price is correctly rejected and reported, while
the rest of the batch still imports with `price` stored as a real
number, not the CSV's original string. Run with
`bun examples/csv-bulk-import/setup.js`.

**[`examples/async-vector-index/`](examples/async-vector-index/)** —
combines [`core/vector.js`](core/vector.js) with `core/queue.js`:
embedding + indexing run inside a background job, off the HTTP request
path — a submitted document is not immediately searchable, only once its
job completes. Every other vector search example indexes synchronously
in the same call that submits the document; this is
`examples/job-queue`'s "kick off + poll" pattern applied to indexing
specifically. A genuinely surprising finding from building this live:
with the fully synchronous offline embedding
(`examples/vector-memory`'s, reused directly) and no artificial delay,
`core/queue.js`'s `enqueue()` triggers `_poll()` internally when already
started, and since the handler has no real `await`, its whole body
(embed + `store.set()` + `flush()`) runs synchronously before
`enqueue()` even returns — an immediate search right after submit **did**
find the document, making the "not searchable yet" window unobservable.
Fixed by simulating a real embeddings API's network latency
(`embedDelayMs`, default 30ms); the regression test proves the race
deterministically with zero-latency in-process JS calls — manual `curl`
testing may not reliably reproduce it, since HTTP round-trip time often
exceeds the simulated delay itself. Run with
`bun examples/async-vector-index/setup.js`.

**[`examples/queue-observability/`](examples/queue-observability/)** —
combines `core/log.js` + `core/metrics.js` with `core/queue.js`: real job
outcomes (completed / dead-lettered / immediately failed with no
registered handler), completing the observability trio alongside
`core/http.js`'s own `logger()`/`metricsHandler()` and
`examples/workflow-observability`. `observe.js`'s `observeJobQueue()`
watches `_queue_jobs`/`_queue_dead` via `DocStore.watch()` — no
`core/queue.js` changes needed. Verified live with a direct `db.watch()`
probe before writing any example code: a job document goes through
several `update()` calls (pending → processing → pending again on retry
→ processing → ...) but exactly **one** terminal event fires per job,
regardless of retries — retries and the final `_queue_jobs` row deletion
after moving to dead are correctly ignored. Documents a real nuance, not
a flaw: `queue_job_duration_ms` measures enqueue-to-terminal-state, not
handler execution time alone — verified live, a job needing one retry
(`backoffMs: 100`) reported ~240ms vs. an immediate success's ~0ms. Run
with `bun examples/queue-observability/setup.js`.

**[`examples/mcp-vector-search/`](examples/mcp-vector-search/)** —
combines `core/mcp.js` with `core/vector.js`: real cosine-similarity
semantic search exposed directly as MCP tools — "give an AI client its
own semantic search tool," distinct from `examples/vector-memory`
(shell/HTTP only, no MCP transport) and `examples/agent-memory-backend`
(MCP, but `core/memory.js`'s keyword recall, not real vector search).
`tools.js` reuses `examples/vector-memory`'s own handlers directly (same
precedent `examples/mcp-job-queue` set reusing `examples/job-queue`'s
`tools.js`). Uses `createMCPServer`'s documented
`{ includeCmsTools: false }` option — deliberately differing from
`agent-memory-backend`'s default of including the base CMS tools — and
verified live over a **real spawned stdio process** (not just
`handleMCPRequest()`): `tools/list` returns exactly the 4 vector tools,
no CMS noise. Found a bug in this example's own first-draft regression
test, not the product: it assumed the shared offline embedding
understands paraphrase/synonyms, which `examples/hybrid-recall` already
documented it does not (word-overlap only) — fixed to use genuinely
shared vocabulary. Run with `bun examples/mcp-vector-search/mcp-server.js`.

**[`examples/validated-job-queue/`](examples/validated-job-queue/)** —
combines `core/validate.js` with `core/queue.js`: a job payload is
validated against a schema **before** `enqueue()` ever runs — a
malformed payload is rejected synchronously, with zero job document
created. No existing example validates a queue job's payload shape at
all — `examples/api-validation`/`examples/validated-webhooks`/
`examples/validated-workflow-nodes` validate HTTP bodies, webhook
trigger data, and node inputs respectively, but a bad job payload today
only fails **inside the handler**, wasting a real processing attempt
(and every retry too, before landing in the dead letter for nothing).
`validated-queue.js`'s `createValidatedEnqueue()` wraps `enqueue()` — no
`core/queue.js` changes needed. Found a real gotcha building this:
`core/shell.js` masks a thrown validation error into a generic
"Internal command error" with no detail (documented, intentional
behavior) — since a validation failure is an expected, actionable
outcome for the caller, not a server fault, the shell handler now
catches it and returns `{ ok: false, error }` as ordinary data instead,
the same reasoning `examples/mcp-job-queue` already documents for MCP
tool errors. Verified live: an invalid payload creates exactly zero new
jobs in `queue.stats()`. Run with
`bun examples/validated-job-queue/setup.js`.

**[`examples/mcp-vault/`](examples/mcp-vault/)** — combines `core/mcp.js`
with `core/credentials.js`: a stored credential can be *used* by an AI
client without ever being *revealed* to it — the same pattern
`examples/vault-access-control` already established at the shell layer
(`vault:use` grantable without `vault:reveal`), applied to MCP instead.
Documents a real structural difference from the shell layer, not just a
cautious choice: `core/shell.js` gates commands **per `Shell` instance**
(RBAC), but `createMCPServer(cms, extraTools)` has no equivalent — every
tool in `extraTools` is available to any connected client, with no
per-caller scoping at the MCP transport level at all. So the safe
design isn't "expose reveal but gate it somehow" — there is no
"somehow" here — it's to never build a tool capable of returning a raw
secret in the first place; `store_credential` is left out for the same
reason. Verified live over a **real spawned stdio process** (not just
`handleMCPRequest()`): stored a credential with a real-looking token,
drove the actual process with real JSON-RPC lines over stdin, and
confirmed the raw secret string is absent from the full response
transcript. Run with `bun examples/mcp-vault/mcp-server.js`.

**[`examples/parallel-workflow-race/`](examples/parallel-workflow-race/)**
— combines `core/parallel.js` with `core/workflow.js`: 3 concurrent
executions of the **same** workflow definition (one per scoring
"model"), raced via `parallelMerge`'s `highest-confidence` strategy.
Distinct from `examples/provider-fanout` (races raw `core/connector.js`
calls, not real workflow executions) and every other `workflow.js`
example (each fires exactly one execution per trigger, never concurrent
runs of the same definition). Relies on `WorkflowEngine.execute()`
having no shared mutable state across concurrent calls on one engine
instance — verified true earlier this session (unlike `core/a2e.js`'s
`WorkflowExecutor`, which needed a real fix for exactly this). Verified
live: 3 executions share the same (or 1ms-apart) `startedAt` timestamp
— genuinely concurrent, not sequential — and model C's fixed 0.85
confidence deterministically wins every time; a regression test also
confirms two concurrent races for different leads never cross-
contaminate each other's scores. Run with
`bun examples/parallel-workflow-race/setup.js`.

**[`examples/memory-consolidation-queue/`](examples/memory-consolidation-queue/)**
— combines `core/memory.js` with `core/queue.js`: `memory.dream()` (the
heuristic near-duplicate consolidation cycle, documented as O(n²)
comparisons over stored memories) runs as a background job instead of
blocking the caller. `examples/agent-memory-backend` already exposes
`dream` two ways (a direct call, an hourly `core/cron.js` job), but
neither is durable/retryable/off-the-request-path the way a queued job
is — a manual "consolidate now" trigger here returns immediately with a
job id, and a failed LLM-powered consolidation call would get the
queue's own retry/backoff for free, unlike a bare cron handler. Reuses
`examples/agent-memory-backend`'s own `buildMemoryHandlers` directly for
everything except `dream`. `concurrency: 1` on the queue is deliberate:
`dream()` reads and rewrites the whole memory collection, and two
consolidation passes racing each other is a correctness risk
`memory.js` was never designed to guard against. Verified live:
`memory:consolidate` returns instantly with a pending job id, the real
`dream()` report arrives later via polling. Run with
`bun examples/memory-consolidation-queue/setup.js`.

**[`examples/shell-a2e-runner/`](examples/shell-a2e-runner/)** —
combines `core/shell.js` with `core/a2e.js`: `pipeline:run` reaches
through the same command gateway `examples/command-gateway` uses for
CRUD into a real, parameterized `core/a2e.js` `WorkflowExecutor`
pipeline, chosen and configured by the shell command's own args at call
time. Distinct from every other `a2e.js` example: `a2e-pipeline`/
`a2e-vault-api`/`a2e-background` invoke pipelines directly from
`setup.js` code, never through a shell command; `trigger-driven-a2e`
fires them from a webhook, not a shell command. `pipelines.js` holds
pipeline **builders**, not fixed definitions — each bakes the shell
command's own args into a fresh compact-JSON definition per call, the
same pattern `a2e-vault-api`/`trigger-driven-a2e` already use for
`execute()`'s lack of per-call input. Found and fixed a real bug in this
example's own first draft, not the product: `op` did double duty as
both the pipeline selector and (inside the `calc` pipeline) the
arithmetic operation, both reading the same `args.op` field — `calc`
silently always defaulted to `add` regardless of what was requested.
Caught before running anything; fixed by renaming the arithmetic field
to `operation`. Run with `bun examples/shell-a2e-runner/setup.js`.

**[`examples/mcp-content-render/`](examples/mcp-content-render/)** —
combines `core/mcp.js` with `core/portable-text.js`: "let an AI client
render/normalize/query markdown itself," directly, without needing a
CMS entry to exist first. Distinct from every other `portable-text.js`
example: `examples/mcp-cms` exposes CMS entry CRUD as MCP tools (entries
may happen to *store* portable-text content, but rendering itself isn't
a tool there); `examples/content-render-workflow` uses
`portable-text.js` as a `core/workflow.js` **node**, not an MCP tool;
`examples/content-formats` is HTTP/shell only, no MCP transport. 3
tools: `render_markdown` (HTML/plain text/word count/excerpt),
`normalize_markdown` (parse then re-serialize, normalizing formatting),
and `find_blocks` (a structural query — e.g. `type: 'code'` to pull
every fenced code block, `type: 'heading'` for the outline — something
no other example demonstrates at all). Uses `{ includeCmsTools: false }`
(same choice `mcp-vector-search`/`mcp-vault` made). Verified live over a
real spawned stdio process; the regression test also confirms
`normalize_markdown`'s round-trip is structurally stable — re-rendering
its output produces byte-identical HTML to the original, even though
the markdown text itself isn't guaranteed to match verbatim. Run with
`bun examples/mcp-content-render/mcp-server.js`.

**[`examples/csv-report-queue/`](examples/csv-report-queue/)** —
combines `core/csv.js` with `core/queue.js`: a sales CSV is aggregated
into a summary report (total, per-category breakdown, top category)
inside a background job — `reports:submit` returns a job id immediately
instead of blocking the request while a (potentially large) CSV is
parsed and aggregated. The "kick off + poll" pattern
(`examples/job-queue`) applied to CSV analytics/ETL specifically,
distinct from `examples/csv-bulk-import`'s **synchronous**
CSV-to-CMS-entries import: that example persists every row as a real
entry and blocks the request until all of them are created; this one
only cares about a summary — a separate real-world use case (bulk
analytics, not bulk import) where a large file makes the synchronous
approach genuinely painful. Verified live: `submit` returns instantly,
the real aggregate arrives via polling; rows with an unparseable
`amount` are skipped and counted in `rowsSkipped`, not silently
included or crashing the job. Run with
`bun examples/csv-report-queue/setup.js`.

**[`examples/mcp-hnsw-search/`](examples/mcp-hnsw-search/)** — combines
`core/mcp.js` with `core/hnsw.js`: a real 3000-product catalog (the same
deterministic generator `examples/large-catalog-search` uses) indexed
into a standalone `HNSWIndex`, exposed as MCP tools — "let an AI client
search a large catalog via approximate nearest-neighbor AND interrogate
the honest speed/recall trade-off itself." Distinct from
`examples/mcp-vector-search`: that one wraps `core/vector.js`'s
`VectorStore` (linear scan, small demo scale, no benchmark tool at all).
This one exposes `benchmark_search` — no other MCP example lets the
client itself measure and compare against ground truth, not just call
search and trust it. Found and fixed a real bug before running anything:
calling `buildCatalogTools(hnsw)` twice (once to index, once inside the
MCP tools) built two separate, unrelated id→vector maps — the second one
empty, silently breaking `benchmark_search`'s exact-scan side (recall
always `0`). Fixed by threading the same instance through both. Verified
live over a real spawned stdio process with 3000 products indexed: a
real ~3.9x speedup, recall 1.0 for the tested query. Run with
`bun examples/mcp-hnsw-search/mcp-server.js`.

**[`examples/postgres-cached-content/`](examples/postgres-cached-content/)**
— combines [`integrations/postgres-collection.js`](#optional-integrations)
with `core/http.js`'s `Router`: a content-pages HTTP API with no
`DocStore`/CMS involved at all — what a `Collection`-shaped API looks
like when `db.js`'s "single-process by design" limit (see above) genuinely
doesn't apply. `server.js` has no offline mode by design; it requires a
real Postgres. Verified live with **two genuinely separate OS processes**
(not two instances in one test) against a real Postgres over an SSH
tunnel: a write via one process's HTTP API (`POST /pages`) showed up on
the other's `GET`/list without it ever querying Postgres directly — a
read attempted 0.3s after the write correctly missed it (honest, real
`NOTIFY` latency over a real network), 2s later it was there; `PUT`/
`DELETE` propagated the same way in the same run. The opt-in regression
test spawns two real `Bun.serve()` instances to prove the same property
survives being wrapped in an HTTP API, one layer above what
`tests/integrations-postgres-collection.test.js` already proves at the
class level.

## Optional integrations

Standalone modules that trade the zero-dependency guarantee for one specific,
justified capability, kept out of `core/` and gated behind
`optionalDependencies` so the framework itself stays deps-free by default.

**[`integrations/postgres-queue.js`](integrations/postgres-queue.js)** —
`PostgresJobQueue`, an async-native job queue mirroring `core/queue.js`'s
`JobQueue` API, built to answer a real gap: `core/queue.js`'s concurrency
control is an in-process counter, so nothing lets multiple worker
processes/machines safely share one queue. `core/db.js`'s storage-adapter
interface (`readJson`/`writeJson`/...) is fully synchronous — confirmed by
reading the module, zero `await` near any adapter call — so this is a
standalone module speaking directly to Postgres via `pg`, not a `DocStore`
adapter. The correctness-critical piece, `claimJobs()`'s atomic
`FOR UPDATE SKIP LOCKED` multi-worker claim, was authored as a KDD task
contract (kept external — see [KDD](https://github.com/MauricioPerera/KDD),
used as a companion methodology, never vendored into this repo) and verified
live against a real Postgres: two concurrent claimers racing 40 pending jobs
never claim the same one, and together claim all 40 exactly once. Building
it live also found a real bug: Postgres's `UPDATE ... RETURNING` does not
preserve a CTE's `ORDER BY` — the claim's priority-then-FIFO ordering was
silently lost until sorted client-side right after the atomic claim.
Requires the optional `pg` dependency (`bun add pg`, or it installs
automatically if your package manager honors `optionalDependencies`). Tests
skip cleanly unless `POSTGRES_TEST_URL` is set:
```bash
POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-queue-claim.test.js tests/integrations-postgres-queue.test.js
```

**[`integrations/postgres-execution-log.js`](integrations/postgres-execution-log.js)**
— `PostgresExecutionLog`, a shared, multi-process-readable workflow
execution history, closing the last of the 3 infra gaps identified for
running Automators Kit as an n8n alternative under intense, own-server use
(the other two: horizontal job-queue scaling, above, and `a2e.js`
concurrent `execute()` — see [Security](#security)). Multiple
`WorkflowEngine` instances (one per worker process, each with its own
local file-based `DocStore` for workflow definitions) can funnel their
execution history into this one shared table instead of each staying
trapped in its own process's local `_executions` collection. No core
change needed: `WorkflowEngine.execute()` already returns the full
execution object once it's done, so a caller just does
`await log.record(exec)` right after `await engine.execute(...)`. Unlike
`claimJobs()` above, there's no atomic/concurrency-critical operation
here (record/read/purge are plain INSERT/SELECT/DELETE), so no KDD
contract for this one — same test-first discipline, without the formal
apparatus. Verified live against a real Postgres (stable across repeated
runs). Tests skip cleanly unless `POSTGRES_TEST_URL` is set; run this
file alone, not stacked with the other `integrations-postgres-*.test.js`
files in one invocation — 3+ concurrent `pg.Pool`s against the same
session-mode pooler tenant can exceed its connection limit and cause
unrelated timeouts (not a bug in any of the modules; each passes cleanly
alone, and the queue's own 2-file pair still passes together):
```bash
POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-execution-log.test.js
```

**[`integrations/postgres-collection.js`](integrations/postgres-collection.js)**
— `PostgresCollection`, the piece the "Known architectural limit" note
above says is missing: a `Collection`-equivalent that actually caches
AND actually invalidates that cache across processes, instead of
sidestepping the problem like the two sidecars above. Reads
(`findById`/`findOne`/`find`/`count`) hit a local in-memory `Map` — no
Postgres round trip — populated by `init()` and kept correct via
Postgres's native `LISTEN`/`NOTIFY`: every write notifies a small
`{op, id}` payload (never the full doc — `NOTIFY` payloads cap at 8000
bytes), and every listening process either drops or targeted-refetches
just that one row. Query/update semantics aren't reinvented: `find()`/
`findOne()`/`update()` run the cached docs through `core/db.js`'s own
exported `matchFilter`/`applyUpdate` — the same `$gt`/`$in`/`$regex`/
`$set`/`$inc`/... language `Collection` uses. Verified live against a
real Postgres: two separate `PostgresCollection` instances against the
same table, one inserts/updates/deletes, the other's cache reflects it
with the client never manually re-reading — the actual point of the
module. Also covers the honest limitation head-on: `LISTEN`/`NOTIFY`
doesn't queue notifications for a dropped connection, so a listener that
disconnects mid-run can miss a change; calling `init()` again does a full
resync and is the documented recovery path (no automatic reconnect is
wired up — out of scope for this pilot). Requires the optional `pg`
dependency. Tests skip cleanly unless `POSTGRES_TEST_URL` is set:
```bash
POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-collection.test.js
```

## Testing

```bash
bun test tests/    # 1377 tests across 84 files, ~35 seconds
```

83 test files covering all core modules (including `log.js`/`metrics.js`/
`csv.js`/`projects.js`) plus the `examples/content-pipeline`,
`examples/command-gateway`, `examples/agent-memory-backend`,
`examples/vector-memory`, `examples/integrations`, `examples/scheduled-sync`,
`examples/provider-fanout`, `examples/large-catalog-search`,
`examples/job-queue`, `examples/plugin-system`, `examples/workflow-engine`,
`examples/a2e-pipeline`, `examples/content-formats`,
`examples/doc-store-analytics`, `examples/api-validation`,
`examples/mcp-cms`, `examples/api-gateway`, `examples/resilient-notify`,
`examples/shell-mcp`, `examples/trigger-hub`, `examples/mcp-workflows`,
`examples/plugin-workflow-nodes`, `examples/hybrid-recall`,
`examples/poll-to-queue`, `examples/a2e-vault-api`,
`examples/a2e-background`, `examples/agent-memory-hnsw`,
`examples/validated-webhooks`, `examples/content-render-workflow`,
`examples/hybrid-catalog-search`, `examples/rate-limited-queue`, and
`examples/cms-semantic-search`, `examples/validated-workflow-nodes`, and
`examples/mcp-job-queue`, `examples/queue-access-control`, and
`examples/vault-access-control`, `examples/trigger-driven-a2e`,
`examples/agent-authored-node`, `examples/workflow-observability`,
`examples/scheduled-report-queue`, `examples/csv-bulk-import`,
`examples/async-vector-index`, `examples/queue-observability`,
`examples/mcp-vector-search`, `examples/validated-job-queue`,
`examples/mcp-vault`, `examples/parallel-workflow-race`,
`examples/memory-consolidation-queue`, `examples/shell-a2e-runner`,
`examples/mcp-content-render`, `examples/csv-report-queue`,
`examples/mcp-hnsw-search`, and `examples/postgres-cached-content`
end-to-end scenarios (includes the regression tests added by the 2026-07 security audit
— see [Security](#security) below), plus 5 opt-in files that skip cleanly
and count as 0 tests unless `POSTGRES_TEST_URL` is set — 4 for the
`integrations/` modules above (`tests/integrations-postgres-queue-claim.test.js`,
`tests/integrations-postgres-queue.test.js`,
`tests/integrations-postgres-execution-log.test.js`,
`tests/integrations-postgres-collection.test.js`) plus
`tests/examples-postgres-cached-content.test.js` for the example above —
the numbers above are the default, fully offline run. Deterministic:
`memory.test.js`'s dream-heuristic test used to assert
`duration_ms > 0` on an operation that can legitimately finish in under
0.5ms (rounds to exactly 0), now asserts the type/shape instead;
`vector.test.js`'s `QuantizedStore` test used to assert the quantized
top-1 result always exactly matches the float32 top-1 — INT8 quantization
is lossy by design, so that held only 498/500 over random trials, now
asserts the real guarantee (float32's top-1 shows up within the quantized
top-3, which held 500/500); and `examples-agent-memory-hnsw.test.js`'s
semantic-vs-exact timing comparison used to flake ~1-in-5 at the file's
560-entry default dataset size — both operations completed in well under
a millisecond there, so the real (confirmed by profiling) HNSW-vs-brute-force
gap was smaller than ordinary measurement noise. Fixed by running that one
assertion against a separate, larger 2000-entry dataset (where the gap is
consistently hundreds-of-microseconds-to-milliseconds) and taking the
median over 5 trials instead of a single sample — verified stable across
20 fresh isolated runs, 0 failures.

## Multi-runtime

```bash
bun server-bun.js      # Bun (fastest)
node server-node.js    # Node.js 20+
deno run --allow-net --allow-read --allow-write --allow-env server-deno.js
```

## Security

4 full security audits to date. **Every finding is remediated, and nothing is left unverified** — 20 from the
2026-08-03/04 full-codebase audit (5 critical, 8 high, 7 medium). That includes all nine of its
initially-unreproduced leads, every one of which turned out to be a real bug once checked, and all three
Postgres integrations, which were finally executed against a real database rather than counted as done
on the strength of having been read. What remains open is stated
rather than left implied by a blanket "all remediated": `net-guard` does no DNS resolution, so a
public-looking hostname resolving to a private IP is still not caught (the module always disclaimed
this), and a set of auditor-reported leads were **not** independently reproduced here and are recorded as
leads rather than conclusions. Both are listed in
[AGENTS.md's Known Security Gaps](AGENTS.md#known-security-gaps-items-1-29-resolved-open-items-listed-at-the-end).

- **2026-07**: full-repo audit of all 21 core modules (4 parallel auditors) — 65 findings (7 critical, 13 high, 28 medium, 17 low), all fixed and verified against the real code with regression tests. Highlights: removed the `code.run` node (its "sandbox" was a bypassable keyword denylist over `new Function` — real RCE), added SSRF guards (`net-guard.js`) across HTTP nodes/triggers/a2e/connector, closed prototype-pollution paths (db.js, validate.js, shell.js, workflow.js), fixed stored XSS in `portable-text.js`, bounded the a2e DAG executor's recursion, gated plugin capability bypasses, replaced predictable default secrets (CMS JWT, workflow vault key, credential-vault PBKDF2 salt) with per-instance random values, and fixed assorted correctness/DoS bugs (HNSW memory leak, broken cache middleware, cron reentrancy, `parallelRace([])` hang, non-atomic writes). Full reports and per-fix specs in [`specs/`](specs/).
- **2026-07 (follow-up)**: building [`examples/content-pipeline/`](examples/content-pipeline/) as a real end-to-end exercise surfaced 2 more gaps the audit's unit tests didn't catch, both fixed: the webhook secret from FIX-10 was enforced in `core/triggers.js` but never wired through `routes/workflows.js`/`WorkflowEngine.webhookTrigger`, so no webhook could actually authenticate over real HTTP; and `core/shell.js` exported `AGENT_PROFILES` but never consulted it — `new Shell({ profile: 'restricted' })` alone enforced nothing unless the caller *also* passed `permissions` explicitly. `permissions` now derives from `profile` when omitted, failing closed to `restricted` for unrecognized profiles.
- **2026-07 (`shell.js` line-by-line audit)**: a manual read of the whole command-gateway module (parser, RBAC, batch/pipeline execution) found 2 real correctness bugs, both fixed with regression tests: `batch [...]` used `Promise.all` directly over each command, so one handler *throwing* (vs returning a normal error) silently discarded every sibling command's already-succeeded result instead of isolating the failure; and the `' | '`/`' >> '`/`','` split points used plain `indexOf`/`split` with **no** quote-awareness (despite one of them claiming otherwise in its own comment) — a quoted argument containing the literal delimiter (e.g. `--template "a | b"`) was silently mis-parsed into a broken command plus a garbage filter, succeeding with corrupted/`undefined` output instead of erroring.
- **2026-07 (`a2e.js` found while building `examples/a2e-pipeline`)**: 2 real correctness bugs in `WorkflowExecutor`, both fixed with regression tests: `Loop` with sub-operations threw a `ReferenceError` on its very first item (a `depth` variable referenced outside its own scope — zero prior test coverage caught it); and `Conditional` always executed **both** branches, with the taken one running **twice** (`execute()`'s DAG-level loop blanket-dispatched every declared operation regardless of which branch was chosen, in addition to `Conditional`'s own dynamic dispatch of the taken one). For any branch with a real side effect (an API call, a payment) this meant unintended executions, not just a cosmetic mismatch.
- **2026-07 (`portable-text.js` verified while building `examples/content-formats`)**: no bug found, but confirmed *live* rather than assumed — the 2026-07 audit's stored-XSS fix in `core/portable-text.js`'s built-in HTML renderers is still intact (a `<script>` tag typed as plain text renders as `&lt;script&gt;`). Also documented a real API contract clarification: `toHTML`'s `customRenderers` escape hatch does **not** auto-escape — an intentionally unsafe custom renderer let a `<script>` tag straight through in testing, confirming that escaping a custom renderer's own interpolated values is the implementer's responsibility, the same way it already is inside `core/portable-text.js` itself.
- **2026-07 (`validate.js` found while building `examples/api-validation`)**: not a bug in `core/validate.js` — it does what it's documented to do — but a real footgun confirmed live: `validate()` applies a schema's **function** defaults (e.g. `createdAt: () => new Date().toISOString()`) on every call, `opts.partial: true` included, for any field missing from the input. A naive partial-update handler that merges the whole validated result back onto an existing record silently regenerates such fields on every update the caller never mentioned them in. This example's own `PATCH` handler applies only the keys present in the caller's request body for exactly that reason.
- **2026-07 (`http.js` found while building `examples/api-gateway`)**: `rateLimit()` computed `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` for an **allowed** request, but `Router`'s post-processing only ever merged CORS headers (`_applyCors`) into the final response — nothing did the equivalent for rate-limit headers, so a successful request under the limit carried none; only the 429-blocked path (built separately, inline) ever had real ones. Fixed by adding `_applyRateLimit()`, mirroring the exact `_applyCors` pattern, verified live before and after (including through a mounted sub-router).
- **2026-07 (`parallel.js` confirmed while building `examples/resilient-notify`)**: not a bug — `parallel.js`'s own doc comments already say JS cannot truly cancel an in-flight promise — but a real, easy-to-miss consequence confirmed live: `parallelRace` doesn't stop the "losing" tasks, so for anything with a side effect (an HTTP POST to a notification channel, not a read-only lookup), a losing task that finishes in time still fully executes — two channels with similar latency can **both** deliver the same message, not just the one whose result the caller sees. Fine for redundant alerting; worth knowing before reusing the pattern for anything where a duplicate side effect (e.g. a charge) would matter.
- **2026-07 (`examples/scheduled-sync` flaky-test root cause)**: not a bug in `core/cms.js` — `EntryService.findAll()` defaulting to `createdAt` DESCENDING when no sort is specified is documented behavior — but a real ordering bug in the example's own `runSync()`: it called `findAll()` with no explicit sort, then re-sorted client-side by `updatedAt` ascending. That re-sort was a silent no-op whenever `updatedAt` ties between entries created in the same millisecond (~85% of the time at in-memory speed), leaving `findAll()`'s descending order in place uncorrected. Reproduced live end-to-end (~10% of runs synced entries out of order); fixed by requesting `sortBy`/`sortOrder` directly from `findAll()` instead of re-sorting after the fact.
- **2026-07 (`shell.js` found while building `examples/shell-mcp`)**: `--confirm` was advertised by `help()` (and `shell_exec`'s own MCP tool description) as "Preview before execute," but the flag was parsed into `cmd.flags.confirm` and never checked anywhere in `_execSingle` — a command carrying `--confirm` executed for real, immediately, identical to not passing it. Verified live: deleting a record "with confirm" deleted it for real. For a destructive command this meant an agent (or a human) trusting the shell's own documented protocol would get a real side effect instead of a preview. Fixed by mirroring the existing `--dry-run` branch: `--confirm` now returns a preview (`mode: "confirm"`, `requiresConfirmation: true`) without running the handler; re-issuing the same command without `--confirm` executes it for real.
- **2026-07 (`triggers.js` found while building `examples/trigger-hub`)**: 2 real bugs, both fixed with regression tests. `list()` never surfaced a poll trigger's circuit-breaker error state — only a **private** `_pollerErrors` map recorded it (confirmed by the module's own unit tests reaching into it directly), so a dead poller kept showing as an ordinary, still-running registration; `list()` now merges in `pollerStatus`/`pollerError` for poll rows. `_pollOnce` never checked `res.ok` — an HTTP error (503) with a valid JSON body parsed fine and fell into the "success" path, firing the trigger with the error body as its payload and **resetting** the consecutive-failure counter instead of incrementing it, so the circuit-breaker never tripped on real HTTP errors, only network-level failures. Both verified live over a real HTTP round trip, before and after. Also documented (not a bug): `register()` calls net-guard's `assertPublicUrl` unconditionally for poll triggers, no opt-out unlike `connector.js`'s `blockInternalHosts` — a poll trigger cannot target `localhost` at all, confirmed live.
- **2026-07 (`workflow.js` found while building `examples/mcp-workflows`)**: `Collection.insert(doc)` clones the input and returns the clone with `_id` assigned — it does not mutate the object passed in. `WorkflowEngine.execute()` called `this._executions.insert(execution)` and discarded the return value, then returned the original `execution` local, which never got an `_id`. Any caller using `run()`'s return value to later fetch the same execution via `getExecution(id)` got `undefined` for the id — `getExecution()` only ever worked for executions already known through `getExecutions()`. `core/cms.js`'s `EntryService.create()` already captures `insert()`'s return value correctly; `workflow.js` just didn't follow its own codebase's existing pattern. Fixed with a 2-line change: capture `insert()`'s return value and assign `_id` onto `execution` before returning it. Verified live before/after through a real MCP server.
- **2026-07 (`plugins.js` extended while building `examples/plugin-workflow-nodes`)**: not a bug — `createPluginAPI` had no way at all for a plugin to reach `workflow.js`'s `NodeRegistry`, a missing capability, not broken behavior. Added a new `nodes:register` capability (gated exactly like the existing `database:write`; threaded through `loadPlugins()`/`createApp()` automatically) with your explicit approval. Designing it surfaced a real security gap, verified live before adding a guard: `NodeRegistry.add()` itself silently lets **any** caller overwrite an existing node type — including `http.request`, replacing its net-guard SSRF check — for every workflow in the system, not just the caller's own. The new capability's `api.nodes.register()` wrapper rejects overwriting an existing type (built-in or registered by another plugin); a second plugin in the example demonstrates the rejection live.
- **2026-07 (`examples/hybrid-recall` premise correction)**: not a core bug — a caught-before-shipping flaw in this example's own original design. The plan was "keyword recall first, vector search as a semantic fallback for paraphrases." Verified empirically *before writing the example*: the offline hashing-trick embedding shared with `examples/vector-memory` has no synonym understanding, and a genuine paraphrase query ranked an unrelated stored doc above the real match. Rebuilt around the honestly-verified value instead — `memory.recall()` hard-empties on zero shared vocabulary, `vector.search()` never does — coverage, not intelligence. A first-pass `lowConfidence` threshold (0.3) was also verified live to mislabel a clearly unrelated query as confident (score 0.429); corrected to 0.5 against a 10-query empirical sample and documented as approximate, not a statistical guarantee.
- **2026-07 (`examples/poll-to-queue` bridge-logic gotcha)**: not a core bug — `TriggerManager`'s poll never firing `onTrigger` on its first cycle (it only establishes the baseline hash) is documented, intentional behavior. But it's a real footgun for exactly the pattern this example builds: without an explicit baseline fetch before the poll trigger starts, the first real fire would hand the whole current item list to a fresh, empty `seenIds` set, making every pre-existing feed item look "new" and get (re)enqueued. Verified live, then fixed entirely in the example's own bridge logic (`hub.js`) by seeding `seenIds` from an initial fetch first — same cursor philosophy `examples/scheduled-sync` already uses for outbound sync, applied here to inbound polling.
- **2026-07 (`a2e.js` found while building `examples/a2e-vault-api`)**: not a core bug — existing, documented behavior of `execute()`'s DAG-level dispatch. But a real, verified footgun: when a custom operation handler throws, `execute()` does **not** stop subsequent DAG levels (unlike `workflow.js`'s `execute()`, which does unless `continueOnError`). The failed op's default `outputPath` never gets written, so a downstream `Conditional` reading it silently resolves to `undefined` — which evaluated to `false` and routed a failed API lookup into the exact same branch as a genuine negative result, indistinguishable without inspecting `errors`. Verified live before and after; fixed entirely at the example level (not core) using `onError`, an existing `a2e.js` mechanism, to write an explicit failure marker instead of leaving the state undefined. Also documented: `WorkflowExecutor.execute()` takes no per-call input at all, unlike `workflow.js`'s `execute(id, triggerData)`.
- **2026-07 (`a2e.js` found while building `examples/a2e-background`)**: real core bug, same class as the earlier `Conditional`-runs-both-branches fix (that fix's own plan explicitly flagged this Loop case as a known, deliberately-deferred limitation). A `Loop`'s sub-operations were dispatched **twice**: once spuriously at the top level (`state.loop === {}`, before the loop even starts — `buildDAG()` models no dependency edge for Loop sub-ops, unlike it does for `Conditional` branches), once correctly per iteration. Every prior `Loop` test used a handler that silently tolerates garbage input, so this went undetected — surfaced by a realistic handler that throws on unexpected input, verified live: called 3 times for a 2-item loop, not 2. Fixed with your explicit approval via Plan Mode (touches `execute()`'s core dispatch logic) with `loopSubOperationTargets()`, mirroring `conditionalBranchTargets()` exactly; hand-traced against all 4 pre-existing `Loop` tests (none broke) and covered by 3 new regression tests using throwing handlers. Also found (not a core bug, handled at the example level): a single `WorkflowExecutor` instance is unsafe for concurrent `execute()` calls — verified live that two concurrent runs sharing one instance corrupt each other's results; fixed by constructing a fresh executor per job.
- **2026-07 (`hnsw.js` found while building `examples/agent-memory-hnsw`)**: real, severe core bug. `_selectNeighbors`/`_pruneNeighbors` used the naive "M closest by raw distance" heuristic — a well-documented HNSW weak point: with many duplicate/near-duplicate vectors (common in real memory content), they monopolize every neighbor slot around them, fragmenting the graph. Verified live with a controlled A/B: recall vs. a brute-force exact scan collapsed from `1.0` (no duplication) to `0.0` with just 2x exact-duplicate vectors, and stayed at `0.0` at ~9x duplication (5000 entries) — a near-total collapse, not gradual degradation. `examples/large-catalog-search` never hit this because its synthetic catalog embeds a unique index number inside every product's text, avoiding exact duplicates by construction. Fixed with your explicit approval via Plan Mode (algorithmic change) implementing the original HNSW paper's diversity-aware neighbor selection (`SELECT-NEIGHBORS-HEURISTIC`) — a candidate is only kept if it's closer to the query than to every already-selected neighbor. Verified live: 2x duplication recovered to `0.8-1.0` recall, ~9x recovered to `0.6` with the top result now exactly matching the true best score (previously it found a measurably worse cluster entirely). The pre-existing `hnsw.test.js` recall test (threshold ≥0.7) improved to `1.000` with the fix — it only helps the non-duplicate case too.
- **2026-07 (`examples/validated-webhooks` architectural finding)**: not a core bug — `createApp()`'s bundled `/api/workflows` webhook route working as designed, with no validation of its own, is documented, intentional behavior. But a real gotcha, verified live with a throwaway script: bolting a schema-validated route on top while still using `createApp()` leaves the original, unvalidated route fully reachable and bypasses validation entirely — a garbage payload the validated route rejects with `400` sailed through the built-in route with a real `200`, actually executing the workflow. Handled by not calling `createApp()` at all for this example (same à la carte spirit as `examples/doc-store-analytics`), so the validated route is the *only* webhook route that exists.
- **2026-07 (`examples/content-render-workflow` caveat)**: not a bug — `toHTML()` still escapes correctly (confirmed intact), and `toPlainText()` correctly does **not** HTML-escape, since it's plain text. But verified live through a real workflow: a downstream node that interpolates `{{render.excerpt}}` (derived from `toPlainText()`) carries an inline `<script>` tag through completely unescaped — a real consequence worth knowing for this specific combination, since embedding that value into an HTML context downstream (an HTML email, a rendered page) without escaping it yourself would reopen the exact XSS surface the 2026-07 audit closed for `toHTML()`.
- **2026-07 (`examples/hybrid-catalog-search` design detail)**: not a bug — `core/db.js`'s `$group` stage never claimed to preserve input order, and it doesn't. Worth documenting because it matters specifically for this combination: after using a real `$lookup`/`$group` join to enrich vector-ranked results with relational sales data, the join's own output order does not match the vector search's ranking — verified live and handled correctly by explicitly re-sorting the joined results back into the original semantic rank order, since that ranking is the entire point of doing the hybrid search in the first place. `hybridSearch()`'s results verified to match `semanticSearch()`'s ids/order/scores exactly.
- **2026-07 (`examples/rate-limited-queue` design detail)**: not a bug — `rateLimit()` counts requests per key in a time window and has no notion of a queue; `JobQueue` has no notion of HTTP at all. Worth documenting because it matters specifically for this combination: intake protection is a property of *how the router is wired* (the limiter guards the one endpoint that calls `enqueue()`), not something either module enforces on its own — a second, unguarded endpoint calling `enqueue()` for the same job type would bypass it entirely, and nothing in `core/queue.js` would catch that. Verified live: a burst of 4 requests against `max: 3` returns 3× `202` + one `429`, with queue stats confirming exactly 3 jobs ever ran.
- **2026-07 (`cms.js` found while building `examples/cms-semantic-search`)**: real core bug — `new CMS()` crashed on any restart against already-persisted `FileStorageAdapter` data, throwing `Index already exists on field: slug` before the server could even start. Root cause: `Collection._ensureLoaded()` restores persisted index definitions from disk *before* `CMS`'s constructor runs its own `createIndex()` calls for the same fields, so every restart against existing data collided with the index just restored. Not a novel flaw — `core/credentials.js`, `core/memory.js`, and `core/workflow.js` already guard their own constructor's `createIndex()` calls with `try {} catch {}` for exactly this reason; `core/cms.js` was the one module that never got the same treatment, meaning every example using `createApp()` + `FileStorageAdapter` had never actually been able to survive a real process restart — undetected because every prior live-verification pass in this project wiped `data/` between runs instead of restarting against existing data. Fixed with a 7-line change mirroring the existing pattern, verified live before/after with a real restart.
- **2026-07 (`examples/validated-workflow-nodes` finding)**: not a core bug — `core/nodes.js`'s `inputs` array was never meant to be enforced, it's documentation for ARDF export, and `NodeRegistry.execute()` calling the handler directly with no check is existing, correct behavior. But a real, worth-knowing consequence, verified live: without a `core/validate.js` schema gating the node, a naive handler doesn't crash on bad data — it silently proceeds with it. A `>100%` discount (a perfectly valid trigger payload by itself) produced a negative charge amount that an unvalidated node "successfully" charged — an unnoticed refund, not a visible failure. The validated version of the same node blocked it with `"Validation failed: amount must be >= 0.01"` before any charge logic ran.
- **2026-07 (`examples/mcp-job-queue` design detail)**: not a bug — `core/mcp.js`'s `tools/call` deliberately replaces any *thrown* tool-handler error with a generic, internals-hiding message, logging the real reason server-side only, confirmed by reading the code. Worth documenting because it shapes how a tool should be written: `job_status`'s "job not found" is an expected, actionable outcome, not a server fault, so it's designed to **return** `{ found: false }` as ordinary data instead of throwing — the agent gets a real, useful answer instead of an opaque failure. A genuinely missing required argument is a different path entirely (`tools/call`'s own `inputSchema` validation, checked before the handler runs) and does come back with the real, specific reason — verified live: `"Invalid arguments: jobId is required"`.
- **2026-07 (`examples/queue-access-control` design detail)**: not a bug — `core/queue.js` never claimed to have any notion of a caller, and `core/shell.js`'s built-in `AGENT_PROFILES` are generic on purpose. Worth documenting because it matters specifically for this combination: `AGENT_PROFILES.reader`'s wildcard verbs (`list`/`get`/`search`/`describe`/`count`/`status`) don't happen to include `stats` — verified live, even `reader` gets `Permission denied` for `queue:stats`, and `operator`'s wildcards (`list`/`get`/`create`/`update`/`delete`/`run`) don't cover it either. No built-in profile expresses "can enqueue and monitor this one namespace, but not its destructive ops" — this example builds an explicit custom `permissions` array for that role instead, exactly the override `core/shell.js` documents `profile` as losing to.
- **2026-07 (`examples/vault-access-control` design detail)**: not a bug — `core/credentials.js` never claimed to enforce access control; `vault.get(name)` returning the fully decrypted secret to any code holding a reference is documented, intentional behavior, and `list()` withholding decrypted values is a return-shape choice, not access control. Worth documenting because it's genuinely security-relevant: every guarantee this example makes (an `integration-runner` role can *use* a secret via `vault:use` but never see it) is enforced entirely by which `Shell` instance a caller is routed to and which verbs its permission list happens to cover. Verified live: `vault:use`'s response never contains the raw secret string even though it decrypted the credential server-side to confirm it's usable; `vault:reveal` (admin-only by construction) is the only command that ever returns one.
- **2026-07 (`db.js` found while building `examples/trigger-driven-a2e`)**: real core bug, low severity. `Auth.init()` already guards its 3 `createIndex()` calls with `try {} catch {}` (same pattern as `credentials.js`/`memory.js`/`workflow.js`), so a restart against already-persisted data never crashes — but it logged the **whole caught `Error` object**, not `err.message`, which Bun renders with a full stack trace and source-code snippet on stderr on every single normal restart, reading like a crash when it isn't. Fixed to log `err.message` only, verified live with a real `FileStorageAdapter` restart before/after.
- **2026-07 (`examples/trigger-driven-a2e` finding)**: not a new core bug — the same DAG-dispatch-doesn't-stop-on-failure behavior already documented for `examples/a2e-vault-api`, reproduced in a different domain. A custom op throwing on bad data left its output undefined; the downstream `Conditional` read that as `false` and silently picked the exact same branch as a genuine negative classification. Verified live before the fix: a payload with no email came back routed to "personal" with no visible sign anything failed except a buried `errors` field. Fixed entirely at the example level (not core), matching `a2e-vault-api`'s own precedent — the bridge now stores an explicit `decision: null` / `status: "failed"` instead of trusting a Conditional computed from a failed op's undefined output.
- **2026-07-31 (`a2e.js` concurrent `execute()` fixed properly in core)**: closes the gap first documented while building `examples/a2e-background` (2026-07, above) — `WorkflowExecutor.state`/`.results`/`.errors` lived on `this`, so two `execute()` calls on the same instance running concurrently corrupted each other's results; the only fix at the time was a per-job workaround (construct a fresh executor). Moved `state`/`results`/`errors` into a context object local to each `execute()` call, threaded through `_executeOp`/`_executeLoop`; public API (`constructor`/`load`/`execute`/`registerHandler`) is unchanged, and `executor.state`/`.results`/`.errors` are preserved as an informational snapshot of the last completed run (needed by `examples/a2e-pipeline`), written once at the end, never during execution. 2 new regression tests verified against the old code (both fail with corrupted/cross-contaminated results) and the fix (both pass); full suite green twice after. The fresh-executor-per-job pattern in `a2e-background`/`trigger-driven-a2e` is no longer required, though it remains valid.
- **2026-08-01 (`http.js` found while building `core/log.js`/`core/metrics.js`)**: real bug, previously untested. `logger()` measured request duration via `await next()`, but global middleware (registered via `router.use(...)`) runs through `_runMiddleware`, whose `next()` is a no-op continuation signal — routing happens separately, afterward, only if no middleware short-circuited with a Response. So `next()` could never observe the real route's duration. Verified live: a route that genuinely took 200ms was logged as `"0.0ms"`, every time, regardless of actual duration — for every request, in any app using `opts.logger` in `createApp()` or `examples/api-gateway`. Fixed by stashing the start time on `ctx.state` when `logger()` runs, read back by `Router.handle()` once the real `response` is known (after routing/CORS/rate-limit) — no restructuring of the middleware chain, verified before/after with a controlled-delay route. `logger()` now optionally emits structured entries via `core/log.js` and records `http_requests_total`/`http_request_duration_ms` into a `core/metrics.js` `MetricsRegistry`.
- **2026-08-01 (`cms.js` found while building `examples/csv-bulk-import`)**: real bug, previously untested — zero prior test coverage for number-typed content-type fields at all. `validateContent()` checked `typeof value !== 'number'` for a `number` field, but `typeof NaN === 'number'` is `true` in JavaScript, so `Number('not-a-number')` (`NaN`) sailed through validation as a "valid" number, silently creating an entry with a broken value. Verified live before the fix: an entry with `price: NaN` was created without error. Fixed to also require `Number.isFinite(value)`, with your explicit approval; new regression test in `tests/cms.test.js`, verified live before/after.
- **2026-08-01 (`workflow.js` Switch node + `runIf`)**: closes a real gap from this session's n8n comparison that was never actually attempted — only the 4 "hard infra" items (queue scaling, `db.js`/`Collection`, `a2e.js` concurrency, observability) got tracked and closed at the time. `workflow.js` only had the binary `if` node plus a global `onFalse: 'skip'` barrier that aborts everything after it; there was no way to route to one of several distinct branches while leaving unrelated nodes unaffected. Added the `switch` node (`core/nodes.js`, first `==` match against an ordered `cases` list wins, falls back to `default`) and a per-node `runIf: { equals: [a, b] }` guard (`core/workflow.js`) — a node whose guard evaluates false is marked `skipped`, not run, not an error, and critically not a global abort. `_buildWorkflowDAG`'s dependency scan now also covers `runIf`, so a node gated on a switch's output is correctly scheduled into a later DAG level and never races the switch it depends on. 3 new regression tests in `tests/workflow.test.js`. Verified: 30+ full-suite runs post-change and 8 baseline runs, all clean except one early run whose failure output wasn't captured and never recurred across everything that followed — noted rather than silently dropped, since it couldn't be conclusively ruled in or out as caused by this change.
- **2026-08-01 (`workflow.js` global/per-workflow error workflow)**: closes another gap from this session's n8n comparison — no way to react to a failed execution except polling execution history after the fact. A workflow can now declare `errorWorkflow: <id>`; the engine constructor accepts `opts.defaultErrorWorkflow` as a fallback for workflows with none of their own. When `execute()` finishes with `status: 'failed'`, `_maybeTriggerErrorWorkflow` fires that workflow fire-and-forget — the same pattern webhook/cron/poll triggers already use, so the original caller's own `execute()`/`run()` still returns immediately with its own result. The error workflow receives context as its trigger data: `{{_trigger.workflow.name}}`, `{{_trigger.error.message}}`, `{{_trigger.execution.id}}`, `{{_trigger.trigger}}` (the original trigger data that started the failed run). Loop safety kept intentionally simple: a workflow set as its own `errorWorkflow` is refused outright, and any longer chain (`A -> B -> A -> ...`) is bounded by a depth counter smuggled through the error trigger data, capped at 5. 5 new regression tests in `tests/workflow.test.js` (correct error context, `defaultErrorWorkflow` fallback via a second real `WorkflowEngine` instance sharing the same db/registry, success never triggers it, self-reference doesn't self-trigger, an A↔B cycle stays bounded). Verified: 20 isolated runs of `workflow.test.js` and 4 full-suite runs, all clean.
- **2026-08-01 (`workflow.js` sub-workflow support)**: closes another gap from this session's n8n comparison — no way to compose workflows by calling one from another. New `workflow.execute` node, registered per-instance in `WorkflowEngine`'s constructor (not `core/nodes.js`'s engine-agnostic `BUILTIN_NODES`, since it needs a live engine to call back into): runs another workflow by id, passes `data` as the sub-workflow's `{{_trigger...}}`, returns `{ executionId, status, nodeResults }`. A failed sub-workflow throws, failing the calling node the same way any other node error does — composes for free with `continueOnError` and `errorWorkflow`, no special-casing needed. Cycle detection required no new plumbing beyond one small, generic extension: `NodeRegistry.execute()` now accepts an optional 4th `ctx` argument passed through as the handler's 3rd parameter (existing 2-arg handlers are unaffected), used to thread a call chain through `triggerData._subWorkflowChain` — local to each `execute()` call's own closure, not instance state, so concurrent unrelated executions never share or corrupt it. Re-entering a workflow id already in the chain throws `Circular sub-workflow reference` instead of recursing forever, catching both direct self-calls and indirect cycles (`A -> B -> A`). 5 new regression tests in `tests/workflow.test.js`. Verified: 20 isolated runs of `workflow.test.js`/`nodes.test.js` and 3 full-suite runs, all clean.
- **2026-08-01 (`workflow.js` persisted Wait)**: closes the last small, genuinely-buildable gap from this session's n8n comparison. The existing `wait` node is a bare `setTimeout` — the whole `execute()` call blocks in memory, so a process restart mid-wait loses all progress. Scoped explicitly to time-based waiting only; webhook-based resume (the other half of n8n's Wait node) is a separate feature, not built here. New `wait.until` node (`core/nodes.js`, existing `wait` untouched); `execute()` split into resumable pieces (`_runLevels`/`_finalizeExecution`/`_resumeExecution`/`_pollWaitingExecutions`) so a fresh run and a resume share identical dispatch logic. A paused execution's `waitState` (`{ resumeAt, remainingLevelIndex, subWorkflowChain }`) is the only extra state persisted — `context` is reconstructed from the execution's own already-stored `nodeResults`/`trigger` at resume time, no separate serialized blob. A timer (`start()`/`stop()`, `opts.waitPollInterval`, mirrors `core/cron.js`'s `CronScheduler`) scans for due waits and resumes them, atomically claiming each via a conditional `{_id, status:'waiting'} -> 'resuming'` update first. 6 new regression tests; verified: 20 isolated runs and 2 full-suite runs, all clean. Also verified live over two genuinely separate OS processes with a real `FileStorageAdapter` directory — process A paused a workflow and exited completely (`process.exit`), process B (a fresh Bun process, fresh `WorkflowEngine` instance) resumed it purely from disk and completed correctly.
- **2026-08-01 (`workflow.js` webhook-based Wait resume)**: completes persisted Wait (previously time-based only). New `wait.forWebhook` node (optional per-node `secret`) never auto-resumes — unlike `wait.until`, `_pollWaitingExecutions`'s query now filters to `waitState.mode === 'time'` specifically, leaving webhook-mode pauses untouched by the timer. New public `resumeWebhook(executionId, data, providedSecret)` — the counterpart to `webhookTrigger()` for resuming an already-running execution instead of starting a new one, same "don't leak which case" secret-check shape. New route `POST /api/workflows/resume/:execId` (`routes/workflows.js`), mirroring the existing trigger webhook's `X-Webhook-Secret` convention with its own `X-Resume-Secret` header. `_resumeExecution` now accepts optional resume data and, for a webhook-mode wait, replaces the paused node's placeholder result with the real resume time and caller-provided data, so downstream nodes can reference `{{waitNodeId.resumeData}}`. 10 new regression tests (5 engine-level, 5 over real HTTP via `app.handle()` covering secret enforcement end to end). Verified: 20 isolated runs and 2 full-suite runs, all clean. Also verified live over a real spawned HTTP server with real `curl` calls: missing/wrong secret both 404, correct secret resumes and completes with resume data correctly threaded through.
- **2026-08-01 (a real intermittent flaky test, finally caught and fixed)**: root cause of an elusive full-suite flake that had surfaced repeatedly across this session, previously uncaptured (confirmed unrelated to the day's actual code changes — it recurred even on a docs-only diff, which is why). `tests/examples-content-render-workflow.test.js`'s `waitForExecution` polled `getExecutions()` (sorted `startedAt` DESC) and trusted `list[0]` to always be the newest execution, gated only by a length check. `Array.sort` is stable but has no tie-breaker for EQUAL `startedAt` values (a `Date.now()` millisecond) — when two consecutive tests' executions started within the same millisecond (common at in-memory speed), the stable sort left the OLDER one first, so a later test picked up an EARLIER test's execution and its content instead of its own. Caught live: the "escapes an inline script tag" test received the previous test's "Launch Day" HTML instead of its own "Security Note" markdown's render. Same bug class already diagnosed and fixed in `examples/scheduled-sync` earlier this session (`updatedAt` ties) — just never caught in this file until now. Fixed the same way `tests/examples-workflow-observability.test.js` already does it correctly: track which execution ids existed BEFORE triggering and wait for one NOT in that set, independent of sort order. Verified: 30 isolated runs of the fixed file and 7 full-suite runs, all clean — the flake that appeared roughly 1-in-15 to 1-in-30 runs all session has not recurred once.
- **2026-08-01 (`credentials.js` OAuth2 support added; a real route-shadowing bug found and fixed)**: closes the last big open item from this session's n8n comparison. `CredentialVault` was a plain encrypted key-value store with no way to acquire or refresh an OAuth2 access token. Extended (not replaced) with a generic authorization-code + PKCE + refresh flow: `startOAuth2()`/`completeOAuth2()` (state-verified, PKCE `code_verifier` included in the real token exchange) and a `get()` that transparently refreshes an expiring token before returning it. A credential acquired this way ends up holding a plain `token` field, identical in shape to any hand-entered bearer token — zero changes needed to `core/nodes.js`'s bearer-auth path. Deliberate scoping decision, documented in the code: OAuth2 config URLs are **not** run through `net-guard.js`'s `assertPublicUrl` — that SSRF guard is for untrusted workflow-driven requests, not authenticated-admin-supplied config, and would block legitimate internal/on-prem providers with no way to opt out. New routes `POST /oauth2/:name/start` (admin-only) and `GET /oauth2/:name/callback` (no auth by design — the provider calls it, `state` is the real CSRF protection). Real bug found and fixed while writing the HTTP-level tests: `GET /api/workflows/credentials` had been shadowed by the earlier-registered `GET /:id` catch-all since it was first written (Router matches in registration order; `/:id`, a single path segment, swallowed `/credentials`, returning 404 "Workflow not found" instead of the list) — never caught before because that route had never been exercised over real HTTP in a test, same route-shadowing bug class already found once this session in an example's webhook path. Fixed by moving the route's registration before `/:id`. 17 new regression tests (7 at the vault level against a real mock OAuth2 token endpoint — `Bun.serve()` on a real port, the normal way to test OAuth2 client code without a real Google/GitHub app — 10 more over real HTTP covering the routes and the shadowing fix). Verified: 20 isolated runs and 2 full-suite runs, all clean. Also verified live over two genuinely separate OS processes — a real app server and a real mock OAuth2 provider communicating over real `curl` calls: wrong state rejected (400), correct state completes a real PKCE code exchange confirmed in the mock provider's own independent log.
- **2026-08-01 (`workflow.js` `loop.forEach` added)**: closes the last item from this session's n8n comparison — the biggest one on the list. n8n's execution model passes an array of items through every node; `workflow.js` is "one value per node" everywhere, and there was no per-item iteration construct at all. A real items-array rewrite means changing what every node receives and what `{{ref}}` resolution means, engine-wide — the same scale as the `db.js`/`Collection` redesign this session already scoped down rather than attempted directly. This does NOT attempt that rewrite. New `loop.forEach` node (registered per-instance, same reason `workflow.execute` is, and built entirely on top of it): runs an already-defined sub-workflow once per item in an input array via the exact `execute()`/sub-workflow mechanism, chunked to `concurrency` (default 5) items at a time (`Promise.allSettled` per chunk, not unbounded `Promise.all`). Each item arrives as `{{_trigger.item}}` — no new template syntax. Collects `{ item, status, nodeResults }` (or `{ item, status: 'error', error }`) per item into `results`; `continueOnItemError` (default `true`) controls whether one item failing stops queuing further chunks. Cycle detection is free — same `_subWorkflowChain` check `execute()` already has, no new code. `context[nodeId]` is still a single value everywhere else in the engine; none of the 21 built-in nodes gain implicit per-item behavior — this is the one additive, opt-in place per-item processing exists. 5 new regression tests (result shape/ordering, real bounded concurrency measured via actual overlapping in-flight calls, partial failure doesn't abort the batch by default, `continueOnItemError: false` stops queuing further chunks, induced cycles caught by the existing detection). Verified: 20 isolated runs and 2 full-suite runs, all clean.
- **2026-08-01 (`workflow.js` generic per-node retry/backoff)**: closes the last real gap found in a final sweep re-reading the full original n8n comparison (both research passes, not just the 4-item "hard infra" consolidation this session had been tracking). n8n retries any node natively; `workflow.js` only had retry at the `queue.js` job level or HTTP-connector-specific, nothing generic in the workflow engine's own dispatch loop — never previously tracked or addressed. A node can carry `retries: N` (default `0` — zero behavior change for any existing workflow) and `retryBackoffMs` (default `1000`, doubled per attempt, same exponential formula `core/queue.js` already uses). New `_executeNodeWithRetry` wraps just the node's own operation — credential resolution and `runIf` evaluation happen before it and are never retried, since a missing credential is a config error, not a transient one. A successful retry records `nodeResults[id].attempts`; an exhausted one does too, on the error result. 5 new regression tests (default behavior completely unaffected, a node recovers on a later attempt, a node exhausts all retries and fails, backoff is real and exponential — measured via actual elapsed time between attempts, not simulated — and retry does NOT apply to a missing-credential error). Verified: 20 isolated runs and 2 full-suite runs, all clean. With this, the full n8n-comparison sweep — both research passes, every front, not just workflow.js features — is closed.
- **2026-08-02 (Projects -> Folders -> Workflows)**: closes the platform-level gap found comparing against n8n at the platform (not engine) level — roles were global to the whole instance (`core/cms.js`'s `ROLE_PERMISSIONS`), no isolated "project" concept with its own membership. New `core/projects.js` (`ProjectManager`, mirrors the existing module style): 3 ranked project roles (`owner` > `editor` > `viewer`, separate from CMS's global roles), flat Folders (no nesting), creating a project auto-owns the creator, `removeMember` refuses to strip the last remaining owner, `removeFolder`/`removeProject` unassign (never delete) affected workflows via a direct update on the shared `_workflows` collection — kept decoupled from `WorkflowEngine`'s class. `core/workflow.js` gains `projectId`/`folderId` on `create()`/`update()` (opaque, unvalidated, same pattern `errorWorkflow` uses) and `list()` filtering. New `routes/projects.js` at `/api/projects`; deliberate scoping decision: the existing `/api/workflows/:id` CRUD stays gated only by the global CMS role, untouched — the new `POST /:id/folders/:folderId/workflows` is the real project-role-gated path for filing a workflow into a project. 19 new regression tests (15 at the `ProjectManager` level, 4 over real HTTP with two real registered users). Verified: 20 isolated runs and 2 full-suite runs, all clean. Also verified live over a real spawned server with real `curl` calls and two real user accounts: a genuine non-member gets a real 403, an editor creates a folder and assigns a real workflow into it, demoting to viewer correctly blocks folder creation, and attempting workflow creation through the existing global route without a CMS role is correctly rejected — proving the scoping decision works as designed.
- **2026-08-02 (credential project-tagging and admin-wide project listing)**: two small gaps found on a re-review of the "gestión de proyectos y roles" pillar after Projects/Folders landed: credentials had no relationship to projects at all, and there was no way for an instance admin to see projects they don't belong to. `core/credentials.js`'s `store(name, values, { projectId })` tags a credential with a project id; `list({ projectId })` returns that project's tagged credentials plus every global (untagged) one. Deliberately organizational only, not an access boundary — `get()` is unchanged and enforces nothing, same "existing execution path stays untouched" scoping philosophy used elsewhere this session. `routes/workflows.js`'s `POST`/`GET /credentials` gain `projectId` support. `routes/projects.js` gains `GET /all` (admin-only), registered BEFORE the generic `/:id` catch-all for the same route-shadowing reason `/api/workflows/credentials` had to move earlier this session. 6 new regression tests (4 at the vault level, 2 over real HTTP). Verified: 20 isolated runs and 2 full-suite runs, all clean. Also verified live over a real spawned server: a non-admin correctly gets 403 on `/all`, an admin sees a project they don't belong to, and credential filtering by project returns exactly the tagged + global set, confirmed with three real credentials (project-scoped, differently-project-scoped, and global).
- **2026-08-02 (full live system test, zero bugs found)**: an end-to-end pass driving a real running server (`FileStorageAdapter`, real disk) through auth, CMS, data tables, agent shell, a single real workflow combining Switch/sub-workflow/retry/wait.forWebhook/error-workflow, Projects/Folders, credentials + a full live OAuth2 exchange against a real mock provider, and the MCP server over a real stdio process. No bugs found — everything that initially "failed" was a wrong request shape on the caller's (agent's) side, not incorrect system behavior. That experience is written up as 5 prioritized agent-UX friction points in [AGENTS.md's "Known Agent-UX Friction Points"](AGENTS.md#known-agent-ux-friction-points) — most notably that the REST API had no self-describing schema endpoint the way the MCP surface's `tools/list` does, and that the DAG-ordering gotcha (nodes need an explicit `{{ref}}` to be scheduled after another) has no validation/lint endpoint to catch it before a real run silently does the wrong thing.
- **2026-08-02 (`GET /api/schema` — REST API discovery catalog)**: closes friction point #1 above. `/api/schema` previously only handled per-content-type field management (`/:slug/fields`); its unused root path now returns a full catalog of every resource group's endpoints — method, path, auth requirement, and body schema. Body schemas are the exact objects each route already passes to `validateBody()` (imported, not re-transcribed), so the catalog can't drift from real request validation; routes with no formal schema (`projects`, `shell`, `a2e`, `db`, some of `workflows`) are described by hand and explicitly flagged (`bodyDescription` vs `bodySchema`) rather than presented with false precision. 4 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live over a real spawned server with real `curl`: 13 resource groups, 88 endpoints, and confirmed the pre-existing `/:slug/fields` routes are still reachable (not shadowed by the new root route).
- **2026-08-02 (disambiguate `content.title` from top-level entry `title`)**: closes friction point #2. A content type's own required `title` field and the entry's top-level `title` share a name; `"Field 'title' is required"` didn't say which one was missing. `validateContent()` (`core/cms.js`) now prefixes every content-validation error with `content.` — e.g. `"Field 'content.title' is required"`. 1 new regression test. Verified: 2 full-suite runs + 20 isolated runs of `cms.test.js`, all clean. Also verified live over a real spawned server, reproducing the exact scenario from the friction report.
- **2026-08-02 (authoring-time DAG lint for workflows)**: closes friction point #3, the biggest one on the list. `_buildWorkflowDAG` infers node ordering purely from literal `{{ref}}` occurrences, silently tolerating mistakes that only surface mid-run. New pure `validateWorkflowDefinition(nodes)` (`core/workflow.js`, shares its `{{ref}}` extraction with `_buildWorkflowDAG` via a new `_extractNodeRefs` helper) catches dangling `{{ref}}`s (typos pointing at a nonexistent node id), duplicate node ids, the reserved `_trigger` id, and dependency cycles (previously a silent fallback to array order) as errors, and returns the actual computed DAG level breakdown with a warning for any `wait.*` node whose pause point will block a later level regardless of relation — the exact scenario from the live system test. New `POST /api/workflows/validate` (raw, unsaved node list) and `GET /api/workflows/:id/validate` (an already-stored workflow), both registered in the `GET /api/schema` catalog too. 14 new regression tests (10 unit-level, 4 over real HTTP). Verified: 2 full-suite runs + 20 isolated runs each of `workflow.test.js`/`integration.test.js`, all clean. Also verified live: reproduced the exact switch + unrelated `wait.forWebhook` scenario over a real spawned server and confirmed the warning fires.
- **2026-08-02 (error message specificity pass)**: closes friction point #4. Audited every `throw`/`error()` call in `core/*.js` and `routes/*.js`; found 9 genuinely vague messages across 3 files (the rest were already specific — this codebase's error messages were mostly good already). `routes/middleware.js`'s `requireRole`/`requirePermission`/`requireProjectRole` now name the required role/permission and the caller's actual one instead of a bare `"Insufficient permissions"`; `routes/collections.js`'s generic `/api/db` CRUD routes now name the collection + id on a 404 and the method/path on a missing-body 400 instead of bare `"Not found"`/`"Body required"`; `core/http.js`'s router `"Bad Request"` (malformed percent-encoding in a path param) now says so explicitly, at all 3 call sites sharing that string. 6 new regression tests (plus one existing `http.test.js` assertion updated to match the new message). Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`/`http.test.js`, all clean. Also verified live over a real spawned server with real `curl` for all four message classes.
- **2026-08-03 (`GET /api/help`, generalizing `/api/shell/help`'s pattern)**: closes friction point #5, the last of the five. `/api/shell/help`'s dense, single-read, agent-oriented walkthrough had no equivalent for the rest of the REST API. New `apiHelp()` (`index.js`) covers the auth flow, where to discover the rest of the API, and the concrete gotchas already fixed above (`content.title` ambiguity, DAG ordering + the new `/validate` endpoints) — prose, complementing rather than duplicating `GET /api/schema`'s structured data catalog. Registered in that catalog too. 1 new regression test. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live over a real spawned server. With this, all 5 Known Agent-UX Friction Points from the 2026-08-02 live system test are closed.
- **2026-08-03 (`data.table` workflow node)**: a fresh re-review of the "ejecución de flujos" × "data tables" pillars found that a workflow had no way to read/write a data table (any DB collection, the same data exposed at `/api/db/:col`) without looping back through its own HTTP API via an `http.request` node. New `data.table` node, registered per-instance in `WorkflowEngine` (needs live DB access, same reason `workflow.execute`/`loop.forEach` are registered there instead of `core/nodes.js`'s engine-agnostic `BUILTIN_NODES`): `find`/`insert`/`update`/`delete`/`count`, mirroring `/api/db/:col`'s filter/sort/limit/offset shape and `$`-operator filter convention. Output design deliberately respects the engine's existing `data`-key auto-unwrap convention: `find`/`insert` return `{ data }` so `{{nodeId}}` resolves directly to the doc(s); `update`/`delete`/`count` return `{ count }` with no `data` key so it survives intact instead of being silently discarded by that same unwrap. 9 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `workflow.test.js`, all clean. Also verified live over a real spawned server: seeded rows via the REST route, then a workflow queried them natively and a downstream node correctly referenced the unwrapped result.
- **2026-08-03 (execution retry + credential test)**: two more gaps found on the "ejecución de flujos" / "vault de credenciales" pillars. A FAILED execution had no way to be retried except re-triggering the whole workflow from scratch, despite the engine already having the resumability machinery (`waitState`, `_resumeExecution`) for a paused one — `_runLevels` now records `execution.failedAt = { levelIndex, subWorkflowChain }` at the point of failure; new `retryExecution()` (`core/workflow.js`) re-dispatches from that level, reconstructing context from already-successful results and preserving unrelated `continueOnError` errors from earlier levels. New `POST /api/workflows/executions/:execId/retry`. There was also no way to verify a credential is usable without running a workflow — `get()` deliberately swallows an OAuth2 refresh failure (falls back to the stale token); new `CredentialVault.testCredential()` forces a refresh when a token is genuinely near expiry and reports whether it actually succeeded. New `POST /api/workflows/credentials/:name/test`. Both registered in the `GET /api/schema` catalog. 18 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of each touched test file, all clean. Also verified live over a real spawned server for both endpoints.
- **2026-08-03 (`outputs` metadata corrected on 20 nodes, found via a full live system test)**: a node's declared `outputs[].name` looked like a real, addressable sub-field (`{{nodeId.name}}`), but `_runLevels` only unwraps a handler's return value when it's an object with a literal `data` key — otherwise the whole value becomes `{{nodeId}}` directly. Hit this firsthand: `switch`'s declared `matched` output led to `{{sw.matched}}`, silently `undefined`, so a `runIf` built on it always evaluated false with no error. 18 bare-value nodes gain an additive `note` field stating the real reference is `{{nodeId}}`; the 6 HTTP-executor nodes (`http.request`, `slack.send`, etc.) get a sharper note since `ok`/`status`/`headers` are genuinely unreachable, not just misnamed. `workflow.execute`'s outputs previously declared a `result` field that never existed; corrected to the real keys. 14 new regression tests. Verified: 2 full-suite runs + 20 isolated runs, all clean. Also verified live via `GET /api/workflows/nodes/list`.
- **2026-08-03 (`text.template`'s own substitution documented as dead inside a workflow, found on a follow-up live system test)**: `text.template`'s own `{{variable}}` substitution (via `data`) and a `WorkflowEngine`'s `{{ref}}` resolution use the identical delimiter, and the engine always resolves `template` first. Reproduced live: a template with two `data`-driven placeholders rendered with both silently blanked. Documentation-only fix (over changing the node's own delimiter, to avoid a public-behavior change for standalone use via `NodeRegistry.execute()`, where `data` genuinely works). 2 new regression tests. Verified: 2 full-suite runs + 20 isolated runs, all clean.
- **2026-08-03 (independent second-opinion audit — 2 security gaps found, not fixed yet at the time)**: delegated a fresh, no-prior-context audit (a separate model instance given only a clean clone of the repo, no knowledge of any work done building the features it was auditing) to independently re-run the test suite, live-test the platform, and redo the n8n comparison from scratch. Test suite: 1154 pass / 5 skip / 0 fail, stable across 2 runs. Live testing (real server, real curl, real MCP stdio): 0 bugs in the core flows tested. Two real findings, independently re-verified by reading the exact source afterward — documented in [AGENTS.md's "Known Security Gaps"](AGENTS.md#known-security-gaps-items-1-29-resolved-open-items-listed-at-the-end), fixed shortly after (see the next two entries): (1) `POST /api/auth/register` let an unauthenticated caller set `role: 'admin'` directly, no gate anywhere between the route and `UserService.register()`; (2) `GET /api/workflows/:id` and `POST /api/workflows/:id/run` required only `auth`, no project-membership check, so any authenticated instance user could read or run any workflow regardless of project.
- **2026-08-03 (H1 fixed — unauthenticated privilege escalation via registration)**: `POST /api/auth/register` now rejects any `role` other than `'viewer'` with a clear 400, before `register()` ever runs — no orphaned account left behind. `UserService.register()` itself is untouched and still accepts a role for trusted, server-side/programmatic callers (seed scripts, etc.); only the public HTTP surface is closed. Defense in depth: even if the route-level check were bypassed, `register()`'s own default is already `'viewer'`. 7 new regression tests, including one reproducing the exact exploit and confirming no account is created, and one confirming the self-registered account genuinely has no admin access. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live over a real spawned server reproducing the exact reported exploit.
- **2026-08-03 (H2 fixed — workflow read/run gated by project membership)**: new `requireWorkflowProjectRole(engine, projectManager, minRole)` middleware (`routes/middleware.js`) resolves a route's `:id` as a workflow and gates on that workflow's own `projectId` — a workflow with no `projectId` (unassigned/global) stays open to any authenticated user, unchanged. Applied to `GET /api/workflows/:id` (viewer+) and `POST /api/workflows/:id/run` (editor+ — running has real side effects, matching the existing view=viewer/act=editor convention already used by the project routes). `PUT /api/workflows/:id` is left untouched — a separate, already-documented intentional escape hatch (global CMS role can edit any workflow). `DELETE`/`toggle`/`executions` share the same underlying gap but weren't part of this finding; noted, not bundled into this fix. 8 new regression tests covering non-member/viewer/editor/owner access levels, the unassigned-workflow no-regression case, and confirming the `PUT` escape hatch stays intact. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live over a real spawned server reproducing the exact cross-project exploit.
- **2026-08-03 (second independent audit, right after H1/H2 shipped — 2 more security gaps found and fixed)**: delegated another fresh, no-prior-context audit (a separate model instance, clean clone, no knowledge H1/H2 had just landed) with an explicitly adversarial "find bugs" brief this time, not a feature comparison. Test suite: 1165 pass / 5 skip / 0 fail, stable across 2 runs. Confirmed H1/H2 work correctly under live adversarial testing, and confirmed most of the platform (typed CMS validation, combined workflows, sub-workflows, retry, hierarchical taxonomies, vault, MCP, generic `/api/db`) holds up (correction, 2026-08-03: this audit verified generic `/api/db`'s CRUD mechanics worked correctly — it never tested whether its authorization boundary existed at all. It didn't; see the critical fix below). Found 2 more real gaps in the exact follow-up area H2's own doc comments had already flagged as "not bundled in" — **BUG 1**: `POST /api/workflows/:id/toggle` required only `auth`, letting a non-member flip a project-owned workflow's active state despite getting 403 just reading it; **BUG 2**: `GET /api/workflows/:id/executions` and `GET /api/workflows/executions/:execId` required only `auth`, letting a non-member read a project-owned workflow's full execution history (real processed data, `nodeResults`) despite the definition itself being gated. Also found (not fixed, informational only): the MCP stdio server (`core/mcp.js`) processes pipelined requests concurrently rather than sequentially (`readline`'s `'line'` event doesn't await an async handler), so a client that pipelines requests without waiting for each response can see out-of-order responses and read-your-writes races — verified reproducible, but real MCP clients (Claude Code etc.) don't pipeline, so it's a latent risk, not an active one, and out of scope for the two security fixes below. Both bugs fixed the same way H2 was: `POST /:id/toggle` gated editor+ (reusing `requireWorkflowProjectRole`), `GET /:id/executions`/`GET /executions/:execId` gated viewer+ (the latter via new `requireExecutionProjectRole`, resolving an execution id to its owning workflow's `projectId`). 10 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live over a real spawned server reproducing all three originally-reported exploits.
- **2026-08-03 (MCP stdio out-of-order responses fixed)**: the 3rd finding from the second independent audit above (documented there as informational-only, not fixed at the time) — `createMCPServer`'s (`core/mcp.js`) `readline` `'line'` handler was `async` but `readline` doesn't await it, so pipelined requests could be processed and answered out of order, with no ordering guarantee for two requests touching the same state. Real MCP clients (Claude Code included) don't pipeline in practice, so this was latent, not active — fixed anyway since pipelining is legitimate JSON-RPC 2.0-over-stdio usage. New `createLineProcessor(allTools, send)` chains each line strictly (`queue = queue.then(() => processLine(line))`) before responding to the next. 3 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `mcp.test.js`, all clean. Also verified live over a real spawned MCP stdio subprocess: out-of-order responses reproduced before the fix, strictly in-order after.
- **2026-08-04 (instance-wide concurrency cap — a burst now degrades instead of collapsing)**: found continuing the n8n comparison on the load pillar. Nothing limited how many executions ran at once: `_dispatchExecution` called `execute()` fire-and-forget for every webhook/cron/poll firing, so N simultaneous triggers meant N simultaneous executions — each resolving credentials, issuing outbound fetches and writing to the DB — with no queue and no ceiling. n8n caps this (`EXECUTIONS_CONCURRENCY_PRODUCTION_LIMIT`); the optional execution queue below had a cap but needs Postgres and is opt-in, so the default path every `createApp()` gets had none. **Where the cap goes was the design decision**: it sits on `_dispatchExecution` and deliberately NOT on `execute()`, because `execute()` is also how a `workflow.execute`/`loop.forEach` node runs a SUB-workflow from inside a running execution, and how `run()`/`retryExecution()`/`resumeWebhook()`/a `whenFinished` webhook run with a caller awaiting the result — gating it would let a parent hold a slot waiting for a child that can never get one, a self-inflicted deadlock. A regression test at cap 1, the most hostile setting, fails by timing out if that ever moves. Defaults are 100 concurrent / 1000 queued rather than unlimited: an unlimited default would leave the hole open for everyone who does not opt in, and below the cap nothing changes. Overflow queues rather than being dropped; only past the backlog cap does dispatch reject, loudly, since shed load should be visible rather than a silent OOM. `executionStats()` reports `running`/`queued` so backpressure is observable instead of inferred from latency. Set 0 to disable. 5 new regression tests. Verified: 30 simultaneous dispatches at cap 5 peak at 5 with all 30 completing, a parent with a sub-workflow completes at cap 1, a full backlog sheds the excess with a clear error.
- **2026-08-03 (optional execution queue for horizontal scaling)**: closes the gap found reasoning explicitly about what a real n8n-self-hosted alternative needs on execution power/load (not node count or UI) — `WorkflowEngine` ran every triggered execution in-process with no path to distributing load across worker processes, even though `integrations/postgres-queue.js`'s `PostgresJobQueue` (real, multi-process-safe via Postgres `FOR UPDATE SKIP LOCKED`) already existed, unwired. New `opts.executionQueue` on `WorkflowEngine` (duck-typed against `core/queue.js`'s `JobQueue` or `PostgresJobQueue` — same shape, either works), a shared `_dispatchExecution()` enqueues trigger-fired (webhook/cron/poll) and error-workflow executions when set; `run()`/`retryExecution()`/`resumeWebhook()`/sub-workflow calls stay direct and in-process always, since they have an explicit caller awaiting a synchronous result. Unset by default: zero behavior change. `createApp()` gains `opts.workflowExecutionQueue` to thread it through. Honest scope: distributes execution *dispatch* only — real multi-machine deployment also needs the underlying `db` shared (`integrations/postgres-collection.js` exists for that, not wired in here, a separate effort). 9 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `workflow.test.js`, all clean. Also verified live end-to-end over a real spawned server: webhook → enqueue → queue processes → real execution recorded with the correct trigger data.
- **2026-08-03 (workflow static data + API keys)**: two more gaps closed on the execution/roles pillars. Workflows had no persistent scratch space across executions (n8n's `getWorkflowStaticData` equivalent) — new `WorkflowEngine.getStaticData`/`setStaticData`/`mergeStaticData` plus a `workflow.staticData` node (`get`/`set`/`merge`), stored on the workflow document, always operating on the currently-executing workflow with no id input needed. Auth had no way to issue a token for a script/CI caller without holding a real user's password — new `Auth.createApiKey`/`listApiKeys`/`revokeApiKey` (`core/db.js`), long-lived `akit_...` tokens (only a SHA-256 hash persisted, raw key shown once), accepted by `verify()` transparently alongside JWTs so every existing auth-middleware caller works unchanged. New routes `POST`/`GET`/`DELETE /api/auth/api-keys`. 22 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `db.test.js`/`workflow.test.js`/`integration.test.js`, all clean. Also verified live over a real spawned server: an API key authenticates like a JWT, a revoked key is rejected, and static data survives across two separate executions.
- **2026-08-03 (predictable default workflow credential-vault master key, found verifying this very Security section's own claims)**: this section previously claimed "replaced predictable default secrets (CMS JWT, workflow vault key, credential-vault PBKDF2 salt) with per-instance random values" — true for the CMS JWT secret and the PBKDF2 salt, but NOT true for the workflow vault key reached through `createApp()` (`index.js`, the documented main entry point). `WorkflowEngine` itself already falls back to a correct random master key when none is given — but `createApp()` pre-empted that safe fallback with `masterKey: opts.secret || 'akit-dev-secret'`, the exact same hardcoded string already banned for the CMS JWT secret specifically for being public in source, reintroduced here for a different purpose. Verified live before the fix: two separate no-secret `createApp()` instances had an IDENTICAL vault master key — any credential encrypted under it was trivially decryptable by anyone with the source. Fixed by passing `opts.secret` through as-is, letting `WorkflowEngine`'s own already-correct fallback apply; an explicit `opts.secret` still works as the vault key unchanged. 4 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live: two no-secret instances now get distinct random keys.
- **2026-08-03 (synchronous webhook response + createdBy/updatedBy attribution)**: two more gaps closed on the execution/roles pillars. A webhook trigger could only ever fire-and-forget — new `trigger.config.respond: 'whenFinished'` makes `POST/GET/.../DELETE /api/workflows/webhook/:path` instead wait for the workflow to stop progressing (success, failure, or a `wait.*` pause) and respond with `{ execution }`, always dispatched directly (never through the execution queue, since an HTTP caller can't be handed off to an out-of-process worker). Default unset: zero behavior change. Also, nothing recorded who created or last touched a workflow, project, or credential — new `createdBy`/`updatedBy` on all three, always stamped server-side from the authenticated caller, never trusted from the request body (a client-supplied `createdBy` is silently ignored). 17 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `workflow.test.js`/`triggers.test.js`/`integration.test.js`, all clean. Also verified live over a real spawned server: a synchronous webhook returned the real node output in the same response, and a freshly created workflow correctly carried the creator's id.
- **2026-08-03 (last-admin lockout protection)**: found comparing directly against n8n's protected instance-owner concept rather than an audit — `UserService.update()`/`delete()` (`core/cms.js`) let a caller demote, deactivate, or delete ANY user with zero guard, including the instance's own admin. An accidental self-demotion/deactivation/deletion of the sole admin permanently locked the instance out of every admin action (public registration always creates `viewer`; only an admin can promote anyone), with no recovery path through the API. Fixed: both methods now refuse any change that would leave zero active admins, mirroring `ProjectManager.removeMember`'s existing "refuse to strip the last owner" guard at the instance level; an already-inactive admin doesn't count as a safety net. 7 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `cms.test.js`, all clean. Also verified live over a real spawned server: self-demotion/self-deletion of the sole admin both correctly rejected, and the guard releases once a second active admin exists.
- **2026-08-03 (CRITICAL — generic `/api/db` had no authorization boundary at all)**: the most severe finding across every security pass this session. `/api/db/:col` required only `auth` — ANY authenticated user, zero role check — and `:col` accepted any collection name, including every collection this codebase manages internally (`_users`, `_sessions`, `_api_keys`, `_workflows`, `_executions`, `_projects`, `_folders`, `_credentials`, and more). Reproduced live from a freshly self-registered `'viewer'` account: `GET /api/db/_users` returned every user's `passwordHash`; `PUT /api/db/_users/:id` with `{ role: 'admin' }` self-promoted that same account to admin immediately. Worse than any single prior finding because it's not a gap in one feature — it's a raw path to the collections underneath EVERY access-control fix built this session (H1, H2/BUG1/BUG2, the last-admin-lockout guard), none of which run when a caller reaches a collection directly through this route. Notably, the second independent audit above had explicitly verified generic `/api/db` "holds up" — it tested the CRUD mechanics, never the (nonexistent) authorization boundary. Found reasoning about a small, unrelated feature (a "list data-table collection names" endpoint) and stress-testing what it would reveal. Fixed: every `:col`-based route now rejects any collection name starting with `_` (the consistent internal-collection naming convention across the whole codebase) with a 403; a new discovery endpoint (`GET /api/db/`) filters internal names out of its list too. Deliberately does not also block CMS content collections (`contentTypes`/`entries`/`taxonomies`/`terms`) — a separate, narrower scope decision, noted but not bundled in. 7 new regression tests. Verified: 2 full-suite runs + 20 isolated runs of `integration.test.js`, all clean. Also verified live reproducing both exploits exactly: both now return 403, the account stays a `'viewer'`.
- **2026-08-03 (full-codebase audit — 7 findings fixed, 4 of them critical)**: ~18.6k lines audited by six auditors in parallel, split by slice (the whole HTTP boundary; `core/db.js`; the workflow engine; CMS + agent surfaces; the data/AI modules; wiring + utilities). Each was required to give `file:line`, a concrete exploit scenario, and an honest "verified by running" vs "inferred by reading" tag. ~80 raw findings came back; **every one acted on was re-verified from source and reproduced directly before being fixed** — which caught two overclaims (one auditor's CRITICAL shell privilege-escalation used a command it had registered itself; a stock shell has only benign builtins, so the real issue is a footgun, not shipped escalation; another's sorted-index bug didn't reproduce). Also notable: the previous audit had verified generic `/api/db` "holds up" — it tested the CRUD mechanics, never the nonexistent authorization boundary. Fixed below.
- **2026-08-03 (CRITICAL — the previous `/api/db` fix was bypassable, and had a second door)**: (a) the guard string-matched a leading `_` on `ctx.params.col`, but `core/http.js` `decodeURIComponent`s path params, so `GET /api/db/x%2F..%2F_users` arrived as `x/../_users` — past the check — and collapsed back to `_users.docs.json` inside `FileStorageAdapter`'s `join()`. Reproduced live from a self-registered `viewer`: every `passwordHash` returned, and the `PUT` wrote `role: 'admin'` to disk, surviving a restart. (b) The `data.table` workflow node had no filter at all despite being documented as "the same data exposed at `/api/db/:col`" — a global `editor` read every `passwordHash` into the execution record and self-promoted. Fixed at the chokepoint instead of per-route: `assertSafeCollectionName()` inside `DocStore.collection()` (which every collection access funnels through) with a positive allowlist rather than a denylist, plus a shared `isInternalCollectionName()` used by both untrusted surfaces so they can't drift apart again — that drift is what made the node a second door. 18 new regression tests.
- **2026-08-03 (CRITICAL — prototype pollution in `a2e.js`)**: `setPath` walked path segments taken from the workflow definition (`outputPath`, a `StoreData` key, an inline `{/ref}`) straight onto a live object, so `outputPath: '/__proto__/isAdmin'` wrote to `Object.prototype` for the whole process — confirmed live with `({}).isAdmin === 'PWNED'` after one `execute()`. The module already treats definitions as untrusted (it SSRF-guards `config.url`), so this was inside the stated threat model. Now refuses `__proto__`/`constructor`/`prototype` — the same three segments `db.js`, `workflow.js` and `shell.js` already refuse, closing the one module that had been missed. 5 new regression tests.
- **2026-08-03 (CRITICAL — `fromMarkdown` infinite loop)**: a single-string denial of service on any surface parsing user-submitted Markdown. The heading branch requires `#{1,6}\s+(.+)` while the paragraph collector excludes anything starting with `#`, so `#hashtag` (or `####### deep`, or a bare `#`) matched neither, left the index un-advanced, and wedged the event loop. Fixed as a class rather than by special-casing `#`: an unconsumable line is emitted as a paragraph and the index advances unconditionally, so termination no longer depends on each branch agreeing with the collector's exclusion list. 8 new regression tests (they fail by timing out the suite if the guarantee regresses — the only honest way to test "does not hang").
- **2026-08-03 (HIGH — SSRF guard let every IPv6 internal destination through)**: the IPv6 branch read `host.split(':')[0]`, which is the empty string for any `::`-compressed address, so `parseInt('')` was `NaN` and every range check was skipped. Verified ALLOWED before the fix: `[::ffff:169.254.169.254]` — the cloud-metadata endpoint this guard exists to block — plus `[::ffff:127.0.0.1]`, `[fd00::1]`, `[fc00::1]`. Matching the dotted form alone wouldn't have sufficed either, since `new URL()` normalizes it to `[::ffff:7f00:1]`. Now expands the literal to its 8 hextets and runs IPv4-mapped/compatible forms through the same checks a literal IPv4 gets, plus unique-local `fc00::/7` (previously unchecked) and CGNAT `100.64/10`. Public IPv6 still passes. 9 new tests in a new `tests/net-guard.test.js` (the module had none). (That entry originally noted redirect-following as still open; it was closed the same day — see the next entry.)
- **2026-08-03 (HIGH — cross-tenant IDOR on project folder/workflow routes)**: three routes take both a project id and a folder/workflow id and gated on the project alone, never checking the target belonged to it. Since any user can create their own project and become its owner, passing their own project id sufficed. All three reproduced live: deleted a folder in someone else's project; stole their workflow (locking the real owner out with a 403 on their own workflow); and unassigned a workflow, which per the documented "unassigned is open to any authenticated user" rule strips its protection entirely. Now the folder must belong to the project, moving a workflow out of another project requires `editor` there, and unassigning requires it to currently belong to the project in the URL. 5 new regression tests.
- **2026-08-03 (HIGH — the `author` role was dead and `:own` enforcement was dead code)**: `hasPermission` collapsed `X:Y:Z` to `X:Y` but not the reverse, and every route asks for the base permission — so a role holding only `entries:write:own`/`entries:delete:own` got 403 on its own entries and could do nothing. Granting the base is only half the fix and unsafe alone: the ownership comparison in `EntryService._enforceOwnScope` (FIX-30) short-circuits unless the route passes a caller, and no route did — so it had shipped as dead code. Both halves landed together: `hasPermission` accepts a `:own` holder for the base, and `routes/entries.js` passes `ctx.state.user` on every mutating entry route. `unpublish`, the one mutating method that never accepted a caller, is aligned with `publish`. 10 new regression tests.
- **2026-08-03 (MEDIUM — filters and schemas that silently accepted everything)**: three findings that all failed OPEN, i.e. the caller believed a constraint was in effect and it was not. (1) `matchFilter`'s operator switch ended in `default: break`, so an unrecognized operator counted as satisfied — `find({age: {$gtt: 100}})` returned every document, and in an access-control filter that inverts the intent with no error. Now gated by a `KNOWN_QUERY_OPERATORS` allowlist kept beside the switch; unknown operators throw, naming the operator and field. Fixing it surfaced two more: plain non-`$` objects reach the same branch and were also blanket-matching (now compared structurally), and `$nin` with a non-array target passed everything, asymmetric with `$in` (both now require an array). `$options` was reaching the default case and being dropped, so `{$regex:'admin', $options:'i'}` ran case-**sensitively** while reading as insensitive — implemented for real rather than left listed-but-ignored. (2) The HashIndex `$in` fast path concatenated per-value id lists without de-duplication, so the same query gave 1 row scanned and 3 rows (`count() === 3`) indexed. (3) `validate.js` evaluated `enum` only inside `case 'string'` and ran nothing at all for a rule with no `type`, so `{role: {enum: ['user','editor']}}` accepted `'superadmin'`; `enum` moved out of the type switch and typeless rules now apply `min`/`max` by the value's runtime type. 14 new regression tests. Also documented (not introduced here): `$elemMatch` never matched an array of primitives against an operator target — confirmed against the pre-change code with `git stash`, so it is recorded in an explicit test rather than asserted away.
- **2026-08-03 (HIGH — the SSRF guard applied to the first URL only, and `fetch` follows redirects)**: the last known open finding from the audit. `assertPublicUrl` validates the URL it is handed and nothing more, while `fetch` defaults to `redirect: 'follow'` — which every outbound call site used. A workflow pointing at an attacker-controlled PUBLIC host (allowed by the guard) therefore reached any internal destination the moment that host answered `302 Location: http://127.0.0.1/`. Verified live: the guard blocked the direct attempt and the redirect delivered the same internal body anyway, into the node result. New `safeFetch` follows redirects manually so every hop faces the same check as the original URL, wired into `nodes.js`, `a2e.js`, `triggers.js` and `connector.js` (the last only when `blockInternalHosts` is on — its `false` default is a documented decision, and changing redirect handling for everyone would alter behavior for callers who never asked for a guard). Two details handled deliberately: credential headers (`Authorization`/`Cookie`) are **dropped on a cross-origin hop**, since `nodes.js` fills `Authorization` from the credential vault and following a redirect would otherwise hand a workflow's credentials to whatever host the redirect names — turning an SSRF probe into credential exfiltration; and method/body rewriting matches what `fetch` itself does (303 → GET without body, 301/302 turn POST into GET, 307/308 preserve both), so manual following is not a behavior change for ordinary traffic. Loops capped at 5 hops. 10 new regression tests. Still exempt by existing decision: `credentials.js` (OAuth2) and `vector.js` (Reranker) take operator-supplied config, not workflow input.
- **2026-08-03 (three audit leads verified and fixed — 3 for 3)**: the audit's unreproduced leads were checked rather than assumed noise, and all three checked so far were real. (1) **Jobs re-executed when the handler outran the lease.** `_poll`'s reclaim arm ("stuck in processing, lease expired -> the worker died") couldn't tell a DEAD worker from a SLOW one, because `updatedAt` was stamped once at claim time and never renewed. Any handler outrunning `leaseMs` — default **five minutes** — was re-claimed and re-executed every lease period. Reproduced: one job, a 1000ms handler, `leaseMs: 300` → the handler ran **4 times** while the queue reported `completed: 1`. For a charge or an email that is N side effects, invisibly; it also leaked the `_running` counter, shrinking effective concurrency. `core/queue.js` is single-process by design, so an `_inFlight` set stops self-reclaim while a restarted process still recovers — the only case the reclaim arm was for — plus a heartbeat so the persisted row stops looking abandoned. `integrations/postgres-queue.js` is worse (multi-process: the second run lands in another worker in real parallel) and got a heartbeat plus a `lease_token` fencing column; fencing surfaced a second bug where a worker that lost its lease would dead-letter the job while the fenced DELETE no-opped, leaving it alive *and* recorded dead. **(Follow-up 2026-08-04: that Postgres half was later executed against a real database and turned out to be BROKEN — see the entry below.)** (2) **`cron` ANDed day-of-month with day-of-week** where POSIX ORs them when both are restricted: `0 0 1 * 1` fired **once in 2026 instead of 63 times**, so a standard crontab line pasted in almost never ran. Not "always OR" — with one field restricted an OR would match every day — and the distinction isn't recoverable from the parsed Sets, so `parseCron` now records which fields were restricted. (3) **A workflow node with no `id`** made one node never run and another run twice, reported as `success`: id-less nodes all collapsed to the key `undefined` and results were matched positionally. `create()`/`update()` now refuse. 15 new regression tests.
- **2026-08-03 (three more audit leads verified and fixed — 8 for 8)**: (1) **`connector`'s timeout did not cover reading the body.** `clearTimeout` ran right after `fetch` resolved, which is when the response HEADERS arrive — before a byte of the body is read — leaving the `AbortController` inert for the read. Measured: `timeout: 500` still hanging at **3011ms** against a server that sent `{"a":` and never closed. One slowloris-style upstream could hold a worker indefinitely. The timer now spans both phases and clears in `finally`, which also covers a rejected `fetch` (the old placement was success-path only). Now aborts at 511ms. (2) **`searchAcross` ranked on per-collection rank, not similarity.** It min-max normalized each collection independently before merging, destroying the very thing that made the scores comparable — same query, same metric, already one scale. Querying `[1,0,0]` over a good collection (cosines 1.000/0.990/0.980) and a junk one (0.000/0.000/-1.000) returned `junk=1.0, good=1.0, junk=1.0` as the top 3: two orthogonal vectors tied with the perfect match while the 0.99 and 0.98 hits were dropped. A collection returning a single result got `1.0` unconditionally, so a near-opposite vector (cosine **-0.9987**) tied a perfect match. Now merges on the raw score. (3) **The IVF index returned confidently wrong results after any deletion.** `assignments` is positional, but `remove()` renumbers every later position and nothing invalidated the index. Deleting one cluster made a query sitting squarely inside another return the wrong cluster entirely — **recall 0/4**, cosines 0.000-0.003 where the exact scan returned 1.000. `build()` now snapshots ids and lookups resolve through the current idMap. That surfaced a second case with the same root: vectors added after `build()` were invisible to every search, so they are now included in the sweep — results stay correct and the cost is speed, not accuracy. `indexStats()` reports drift (`stale`, `addedSinceBuild`, `removedSinceBuild`) so a due rebuild is observable rather than guesswork. 12 new regression tests across the three.
- **2026-08-03 (the last verifiable lead — error-workflow cascades were unbounded, 9 for 9)**: the `depth >= 5` cap meant to stop a runaway error-workflow chain never engaged. Two independent leaks: `_errorDepth` did not survive a hop through a sub-workflow (the `workflow.execute` node built its trigger data without it, so every lap reset the depth to 0), and the error-workflow dispatch passed no call chain, so the cycle detection the engine already has could not see the hop. With `A` failing into error workflow `B` and `B` calling `A` back, that is unbounded — measured **6720 executions of A in 20 seconds**, ended only by killing the process from outside. Both fixed, because they defend different shapes: the chain refuses an `A -> B -> A` cycle on the first lap (the likely misconfiguration), while the depth cap still bounds a long chain of *distinct* error workflows, where there is no cycle to detect. Now: `A -> B -> A` runs A once, a normal error workflow still runs exactly once, a chain of ten distinct workflows stops at six. **Method note:** this cannot be verified in-process — the cascade starves the event loop, so a `setTimeout` watchdog never fires (it killed the original auditor's process twice). It needs an out-of-process timeout, and the regression tests assert on execution counts after a bounded sleep rather than with a timer. 3 new tests.
- **2026-08-04 (data tables gain optional typed columns)**: the second gap from the n8n comparison. Both data-table surfaces — the `data.table` workflow node and `/api/db/:col` — operated on a raw `Collection`, so any workflow could write any shape into any field, while `core/db.js`'s `Table` class (typed columns, `required`, `unique`, validation), exported from `index.js`, was used by **nothing**: `new Table(` appeared only in its own definition and its tests. **`Table` itself was fixed first**: an audit lead said `update()` validated only `$set`, and verifying it showed worse — `$inc` with a string produced `Age: "30bad"` (string concatenation) and a whole-document replacement wrote `Name: 12345` into a text column. Wiring it in as-is would have made the typed guarantee a lie on those paths, so it now validates the RESULTING document (computed with the same `applyUpdate` the collection uses), covering every operator uniformly instead of enumerating them. A schema registry is the single decision point used by BOTH surfaces, so a collection is typed for both or for neither — two surfaces disagreeing about one collection is exactly what made the `data.table` node a second path to a privilege escalation earlier in this audit. Schemas live in `_table_schemas`, which the underscore convention already keeps out of `/api/db` and the node, so the registry cannot be rewritten through the API it constrains. Additive throughout: no schema means the previous behavior exactly, defining one leaves existing rows untouched rather than retroactively rejecting them, and removing one returns the table to schemaless with rows intact. New routes `GET /api/db/_schemas` and `GET`/`PUT`/`DELETE /api/db/:col/_schema` (admin to define), registered before the `/:col/:id` catch-all since they share a segment count — with a test for that shadowing. 20 new regression tests; `/api/schema` catalog synced.
- **2026-08-04 (the Postgres queue fix was broken, and only running it found that)**: the queue lease fix above shipped marked "parses and is reasoned line by line but was never executed", because `pg` isn't installed in the dev environment. Standing up a throwaway Postgres 16 to finally run it: **the handler executed SEVEN times for one job** — precisely the bug the heartbeat was added to prevent. Cause: `core/queue.js` floors the heartbeat interval at 50ms, but `integrations/postgres-queue.js` used **1000ms** to avoid hammering the DB. The interval is `leaseMs/3` subject to that floor, so for any `leaseMs` under 3000 the heartbeat beat *less often than the lease expired* — the row went stale before the first beat and the job was re-claimed anyway, defeating the mechanism exactly where it mattered most. Now clamped on both ends: never slower than a third of the lease, never faster than 50ms, capped at 30s. Verified against the real database: `lease_token` created; the `ALTER` path adds it to a pre-existing table; a handler outrunning the lease runs **once** (was 7); `updated_at` stays 191ms fresh against a 600ms lease; **two independent worker processes over one shared table execute 20 jobs with zero duplicates** — the multi-process case that could never be tested before, and where the original bug was worst; a stale fencing token affects 0 rows; a failed job dead-letters exactly once with no ghost row. One wrong constant silently disabled a three-part mechanism that read as correct: reasoning is not verification. Still unexecuted: `postgres-collection.js` and `postgres-execution-log.js`.
- **2026-08-04 (SQL injection and a lost update in `PostgresCollection`)**: two more unevidenced audit leads, both confirmed by standing up a real Postgres — and the injection was worse than it read. **(1) SQL injection via the table name (CRITICAL).** The name is interpolated into DDL/DML and, decisively, into `LISTEN ${channel}`, which *cannot* take a bind parameter and so went in completely raw. Verified: a collection named `x; DROP TABLE canary; --` **dropped the canary table** on `init()`. The `"${table}"` quoting used elsewhere in the file is no defence either, since a name containing a double quote breaks out of it. Fixed with a Postgres identifier allowlist, stricter than the collection-name one because an unquoted identifier — which `LISTEN` requires — may not contain a hyphen or start with a digit; refused rather than escaped, since escaping invites a second bug the first time someone edits it. Only reachable by a caller that derives table names from request data, which is exactly the shape this repo's own `/api/db/:col` has. **(2) Lost update (HIGH).** `update()` read the target from the *local cache*, computed the result in JS and blind-wrote the whole document, so two processes updating one row both read the same starting value and both wrote their own. Verified: two concurrent `$inc: { views: 1 }` from separate processes left `views = 1`, not 2 — and the `NOTIFY` that followed made both caches agree on the *wrong* value, so nothing surfaced the loss. The row is now re-read inside a transaction holding `FOR UPDATE`. Checked unchanged in the same run: the full CRUD round-trip, and the module's core claim that a second process sees another's insert/update/delete through LISTEN/NOTIFY. `postgres-execution-log.js` was verified in the same session and needed **no changes**. With this, all three Postgres integrations have been executed; 2 of the 3 were broken.
- **2026-08-04 (execution-history retention — and a data-loss bug found while adding it)**: continuing the n8n comparison. Every execution persists its full `nodeResults` — the actual data the workflow processed, not a summary — and **nothing ever trimmed them**. `purgeExecutions()` existed in both `WorkflowEngine` and `PostgresExecutionLog`, and had no caller anywhere in the repo: no timer, no route, no option. n8n prunes by default. New `executionRetentionMs` (age) and `maxStoredExecutions` (count, newest first) with an hourly pass, plus `pruneExecutions()` and `retentionStats()`. Both bounds are needed: age alone cannot cap a burst, since a workflow firing every second fills the store long before anything is old enough to expire. **Automating it surfaced a data-loss bug in the function itself**: `purgeExecutions` filtered on age alone and ignored status, so it deleted `waiting` executions — a `wait.forWebhook` parked for an external callback, along with the `waitState` holding its resume secret — plus `running` and `resuming` ones. Verified: five executions, one per status, **all five deleted**; a workflow parked longer than the window was destroyed mid-flight and could never resume. Only terminal statuses are eligible now. **Both bounds default OFF**, unlike the concurrency cap, deliberately: backpressure only delays work, retention deletes it irreversibly, and enabling that silently at upgrade could destroy history someone depends on. Growth is made observable instead — `retentionStats()` separates what retention may touch from what it may not. 8 new regression tests.
- **2026-08-04 (Prometheus `/metrics` endpoint — and two bugs in the instrumentation it exposed)**: the fifth gap in a row of the same shape. `MetricsRegistry` with a Prometheus renderer, `metricsHandler()` in `core/http.js` (whose own doc comment shows exactly this mounting), and `logger()`'s instrumentation were all written, and **nothing assembled them**: `createApp()` called `logger()` with no registry, so it wrote to `null`, and no `/metrics` route existed. `createApp({ metrics: true })` now mounts it. Wiring it surfaced two real bugs. **(1) Unbounded cardinality and an id leak.** Labels used `ctx.path`, the concrete path, so every distinct id became its own time series — the classic way to take a Prometheus down — and entry/user/workflow ids were written into an endpoint conventionally scraped *without* authentication. Now labelled by route pattern: three distinct ids on one route produce **one** series, and no ids appear. **(2) Sub-routers dropped the pattern.** `{ ...ctx, path: subPath }` is a shallow copy, so what the inner router recorded never came back; since nearly every route is mounted under a prefix, almost all real traffic reported as `<unmatched>`, lumped in with genuine 404s. Both dispatch sites needed the fix, not one. An existing test asserted the old label using `/ping`, a literal route where path and pattern coincide — which is exactly why it could never catch the cardinality problem; the assertion was corrected and a parameterised-route test added beside it. The endpoint also samples `executionStats()`/`retentionStats()` as gauges at scrape time, so the concurrency cap and retention added earlier finally have a surface to be observed through. Unauthenticated by design like n8n's own, carrying no ids; restrict at the network layer. 9 new regression tests.
- 2 earlier audits, 26 fixes applied

Current security posture:
- Timing-safe password comparison (byte-level XOR)
- AES-256-GCM encryption (database, field-level, credential vault) with random per-installation PBKDF2 salts
- JWT auth via Web Crypto API (PBKDF2 + HMAC-SHA256), random per-instance secret unless configured explicitly
- SSRF guard (`net-guard.js`) on all outbound fetches driven by workflow/trigger definitions, covering IPv4 and IPv6 (including IPv4-mapped forms and unique-local `fc00::/7`) and re-validating every redirect hop; does not cover DNS resolution
- RBAC: 4 CMS roles + 4 agent profiles, enforced on shell built-ins and `:own`-scoped entry operations (the `:own` comparison is genuinely wired through the entry routes)
- Collection names validated at the `DocStore.collection()` chokepoint; internal (`_`-prefixed) collections unreachable from `/api/db/:col` and the `data.table` node via one shared check
- Plugin capability manifest, gated `database`/collection access, path-traversal guard on local plugin loading
- Content size limits, bounded queries, ReDoS guards on user-supplied `$regex`/pattern input
- Query filters and schemas fail CLOSED: an unknown query operator throws instead of matching everything, and `validate.js` applies `enum`/`min`/`max` regardless of whether a `type` is declared
- HMAC-SHA256 webhook signing + optional per-webhook secret

## Documentation

See [AGENTS.md](AGENTS.md) for complete API reference, all endpoints, and AI agent integration guide.

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera) / [automators.work](https://automators.work)
