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

## 23 Core Modules

| Module | What it does |
|--------|-------------|
| **db.js** | Document DB: MongoDB queries, 26 operators, indices, JWT auth, AES-256-GCM encryption, proxy access, watch |
| **vector.js** | Vector DB: Float32/Int8/Polar/Binary quantization, IVF, Matryoshka, BM25, hybrid search |
| **hnsw.js** | HNSW index: O(log n) approximate nearest neighbor search |
| **http.js** | HTTP router: Web Standard Request/Response, middleware chain, params, sub-routers, CORS |
| **validate.js** | Schema validation: types, formats, defaults (replaces Zod) |
| **cms.js** | CMS: content types, entries, taxonomies, terms, users, roles, autosave |
| **plugins.js** | Plugin system: hooks, capability-based access control, registry (see [`examples/plugin-workflow-nodes`](examples/plugin-workflow-nodes/)) |
| **portable-text.js** | Rich content: JSON blocks to HTML/Markdown/PlainText, fromMarkdown parser |
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

**Picking between similar-sounding modules:**
- **`memory.js` vs `vector.js`** — `memory.js`'s `recall()` is keyword/term matching with time decay, zero ML dependency, works out of the box (see [`examples/agent-memory-backend`](examples/agent-memory-backend/)). `vector.js` does real cosine-similarity search over embeddings *you* provide — it never calls an embedding API itself (see [`examples/vector-memory`](examples/vector-memory/)). Reach for `memory.js` first; reach for `vector.js` when word-overlap isn't good enough and you're willing to bring an embedding function.
- **`workflow.js` vs `a2e.js`** — two separate execution engines, not layers of one system. `workflow.js` is the n8n-style engine: named nodes wired by `{{ref}}` templates, triggered by webhook/cron/poll/manual, DAG-parallel. `a2e.js` is a smaller, declarative multi-step executor (`SetData`/`FilterData`/`ApiCall`/`Conditional`/`Loop`/...) with its own DAG and middleware, generally used standalone or from an `a2e.js`-authored node. They share the DAG level-scheduling algorithm itself (`dag.js`) since it was byte-for-byte duplicated code, but each keeps its own dependency-detection convention — an engine-specific improvement (e.g. how deps are inferred) still has to be ported to the other by hand.
- **`mcp.js` vs `shell-mcp.js`** — two different answers to "how many MCP tools should this expose." `mcp.js` gives each capability its own tool with a real JSON schema (`list_entries`, `create_entry`...) — the client sees full discovery via `tools/list`, but context cost grows with every tool added (see [`examples/mcp-cms`](examples/mcp-cms/)). `shell-mcp.js` exposes `shell.js`'s entire command registry through exactly 2 fixed tools (`shell_help`/`shell_exec`); the agent discovers commands at runtime via `shell_exec("search ...")`/`("describe ...")` instead of `tools/list`, so the tool-list cost stays constant no matter how large the registry gets (see [`examples/shell-mcp`](examples/shell-mcp/)). Verified against a real external MCP client (poolside.ai's `pool exec`): given only `shell_help`/`shell_exec`, it correctly called help first, searched for the right commands, described their params, then executed them — no schema handed to it upfront.

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

## Testing

```bash
bun test tests/    # 814 tests across 44 files, ~17 seconds
```

44 test files covering all core modules plus the `examples/content-pipeline`,
`examples/command-gateway`, `examples/agent-memory-backend`,
`examples/vector-memory`, `examples/integrations`, `examples/scheduled-sync`,
`examples/provider-fanout`, `examples/large-catalog-search`,
`examples/job-queue`, `examples/plugin-system`, `examples/workflow-engine`,
`examples/a2e-pipeline`, `examples/content-formats`,
`examples/doc-store-analytics`, `examples/api-validation`,
`examples/mcp-cms`, `examples/api-gateway`, `examples/resilient-notify`,
`examples/shell-mcp`, `examples/trigger-hub`, `examples/mcp-workflows`,
and `examples/plugin-workflow-nodes`
end-to-end scenarios (includes the regression tests added by the 2026-07 security audit
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
- **2026-07 (`validate.js` found while building `examples/api-validation`)**: not a bug in `core/validate.js` — it does what it's documented to do — but a real footgun confirmed live: `validate()` applies a schema's **function** defaults (e.g. `createdAt: () => new Date().toISOString()`) on every call, `opts.partial: true` included, for any field missing from the input. A naive partial-update handler that merges the whole validated result back onto an existing record silently regenerates such fields on every update the caller never mentioned them in. This example's own `PATCH` handler applies only the keys present in the caller's request body for exactly that reason.
- **2026-07 (`http.js` found while building `examples/api-gateway`)**: `rateLimit()` computed `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` for an **allowed** request, but `Router`'s post-processing only ever merged CORS headers (`_applyCors`) into the final response — nothing did the equivalent for rate-limit headers, so a successful request under the limit carried none; only the 429-blocked path (built separately, inline) ever had real ones. Fixed by adding `_applyRateLimit()`, mirroring the exact `_applyCors` pattern, verified live before and after (including through a mounted sub-router).
- **2026-07 (`parallel.js` confirmed while building `examples/resilient-notify`)**: not a bug — `parallel.js`'s own doc comments already say JS cannot truly cancel an in-flight promise — but a real, easy-to-miss consequence confirmed live: `parallelRace` doesn't stop the "losing" tasks, so for anything with a side effect (an HTTP POST to a notification channel, not a read-only lookup), a losing task that finishes in time still fully executes — two channels with similar latency can **both** deliver the same message, not just the one whose result the caller sees. Fine for redundant alerting; worth knowing before reusing the pattern for anything where a duplicate side effect (e.g. a charge) would matter.
- **2026-07 (`examples/scheduled-sync` flaky-test root cause)**: not a bug in `core/cms.js` — `EntryService.findAll()` defaulting to `createdAt` DESCENDING when no sort is specified is documented behavior — but a real ordering bug in the example's own `runSync()`: it called `findAll()` with no explicit sort, then re-sorted client-side by `updatedAt` ascending. That re-sort was a silent no-op whenever `updatedAt` ties between entries created in the same millisecond (~85% of the time at in-memory speed), leaving `findAll()`'s descending order in place uncorrected. Reproduced live end-to-end (~10% of runs synced entries out of order); fixed by requesting `sortBy`/`sortOrder` directly from `findAll()` instead of re-sorting after the fact.
- **2026-07 (`shell.js` found while building `examples/shell-mcp`)**: `--confirm` was advertised by `help()` (and `shell_exec`'s own MCP tool description) as "Preview before execute," but the flag was parsed into `cmd.flags.confirm` and never checked anywhere in `_execSingle` — a command carrying `--confirm` executed for real, immediately, identical to not passing it. Verified live: deleting a record "with confirm" deleted it for real. For a destructive command this meant an agent (or a human) trusting the shell's own documented protocol would get a real side effect instead of a preview. Fixed by mirroring the existing `--dry-run` branch: `--confirm` now returns a preview (`mode: "confirm"`, `requiresConfirmation: true`) without running the handler; re-issuing the same command without `--confirm` executes it for real.
- **2026-07 (`triggers.js` found while building `examples/trigger-hub`)**: 2 real bugs, both fixed with regression tests. `list()` never surfaced a poll trigger's circuit-breaker error state — only a **private** `_pollerErrors` map recorded it (confirmed by the module's own unit tests reaching into it directly), so a dead poller kept showing as an ordinary, still-running registration; `list()` now merges in `pollerStatus`/`pollerError` for poll rows. `_pollOnce` never checked `res.ok` — an HTTP error (503) with a valid JSON body parsed fine and fell into the "success" path, firing the trigger with the error body as its payload and **resetting** the consecutive-failure counter instead of incrementing it, so the circuit-breaker never tripped on real HTTP errors, only network-level failures. Both verified live over a real HTTP round trip, before and after. Also documented (not a bug): `register()` calls net-guard's `assertPublicUrl` unconditionally for poll triggers, no opt-out unlike `connector.js`'s `blockInternalHosts` — a poll trigger cannot target `localhost` at all, confirmed live.
- **2026-07 (`workflow.js` found while building `examples/mcp-workflows`)**: `Collection.insert(doc)` clones the input and returns the clone with `_id` assigned — it does not mutate the object passed in. `WorkflowEngine.execute()` called `this._executions.insert(execution)` and discarded the return value, then returned the original `execution` local, which never got an `_id`. Any caller using `run()`'s return value to later fetch the same execution via `getExecution(id)` got `undefined` for the id — `getExecution()` only ever worked for executions already known through `getExecutions()`. `core/cms.js`'s `EntryService.create()` already captures `insert()`'s return value correctly; `workflow.js` just didn't follow its own codebase's existing pattern. Fixed with a 2-line change: capture `insert()`'s return value and assign `_id` onto `execution` before returning it. Verified live before/after through a real MCP server.
- **2026-07 (`plugins.js` extended while building `examples/plugin-workflow-nodes`)**: not a bug — `createPluginAPI` had no way at all for a plugin to reach `workflow.js`'s `NodeRegistry`, a missing capability, not broken behavior. Added a new `nodes:register` capability (gated exactly like the existing `database:write`; threaded through `loadPlugins()`/`createApp()` automatically) with your explicit approval. Designing it surfaced a real security gap, verified live before adding a guard: `NodeRegistry.add()` itself silently lets **any** caller overwrite an existing node type — including `http.request`, replacing its net-guard SSRF check — for every workflow in the system, not just the caller's own. The new capability's `api.nodes.register()` wrapper rejects overwriting an existing type (built-in or registered by another plugin); a second plugin in the example demonstrates the rejection live.
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
