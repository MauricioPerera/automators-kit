# Automators Kit

**Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.**

781 tests | 0 deps | 23 modules | Bun + Deno + Node.js

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

## 26 Core Modules

| Module | What it does |
|--------|-------------|
| **db.js** | Document DB: MongoDB queries, 26 operators, indices, JWT auth, AES-256-GCM encryption, proxy access, watch |
| **vector.js** | Vector DB: Float32/Int8/Polar/Binary quantization, IVF, Matryoshka, BM25, hybrid search |
| **hnsw.js** | HNSW index: O(log n) approximate nearest neighbor search (see [`examples/large-catalog-search`](examples/large-catalog-search/), [`examples/agent-memory-hnsw`](examples/agent-memory-hnsw/)) |
| **http.js** | HTTP router: Web Standard Request/Response, middleware chain, params, sub-routers, CORS |
| **validate.js** | Schema validation: types, formats, defaults (replaces Zod) |
| **cms.js** | CMS: content types, entries, taxonomies, terms, users, roles, autosave |
| **plugins.js** | Plugin system: hooks, capability-based access control, registry (see [`examples/plugin-workflow-nodes`](examples/plugin-workflow-nodes/)) |
| **portable-text.js** | Rich content: JSON blocks to HTML/Markdown/PlainText, fromMarkdown parser (see [`examples/content-render-workflow`](examples/content-render-workflow/)) |
| **mcp.js** | MCP server: JSON-RPC 2.0 over stdio, 20 tools for AI agents |
| **a2e.js** | A2E executor: 19 declarative operations, DAG parallel execution, middleware |
| **workflow.js** | Workflow engine: n8n-style nodes, triggers, credentials, execution history, DAG-parallel execution |
| **dag.js** | Shared DAG level-scheduling (Kahn's algorithm), used by both `workflow.js` and `a2e.js` |
| **nodes.js** | Node registry: 20 built-in nodes (core, communication, data, AI) + ARDF export |
| **triggers.js** | Trigger system: manual, webhook, cron, polling with change detection (see [`examples/trigger-hub`](examples/trigger-hub/)) |
| **credentials.js** | Credential vault: AES-256-GCM encrypted API keys and tokens |
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
just one module. [`integrations/`](#optional-integrations) sidesteps this
for two specific pieces by never caching state at all (every operation is
a fresh round trip): `postgres-queue.js`'s `PostgresJobQueue` for job
queueing, and `postgres-execution-log.js`'s `PostgresExecutionLog` for
workflow execution history. Neither touches `core/db.js` or
`core/workflow.js` — they're standalone sidecars, not a fix to
`Collection` itself. The same sidecar pattern could extend to
`cms.js`/`credentials.js`/`memory.js` case by case, but doesn't generalize
into one fix — `Collection`'s caching model itself would need a redesign
from scratch to be safe across processes, a project of a different scale
than async-ifying method signatures alone.

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
CSV node, `core/nodes.js`'s 18 built-ins don't. Instead of waiting for
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

## Testing

```bash
bun test tests/    # 947 tests across 70 files, ~31 seconds
```

70 test files covering all core modules (including `log.js`/`metrics.js`/
`csv.js`) plus the `examples/content-pipeline`,
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
`examples/scheduled-report-queue`, `examples/csv-bulk-import`, and
`examples/async-vector-index`
end-to-end scenarios (includes the regression tests added by the 2026-07 security audit
— see [Security](#security) below), plus 3 opt-in files for the
`integrations/` modules above (`tests/integrations-postgres-queue-claim.test.js`,
`tests/integrations-postgres-queue.test.js`,
`tests/integrations-postgres-execution-log.test.js`) that skip cleanly and
count as 0 tests unless `POSTGRES_TEST_URL` is set — the 917/64 numbers
above are the default, fully offline run. Deterministic except one known
flaky test (`examples-agent-memory-hnsw.test.js`'s benchmark assertion,
timing-sensitive under machine load — being tracked/fixed separately, not
a correctness issue in `core/hnsw.js` itself): `memory.test.js`'s dream-heuristic test used to assert
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
