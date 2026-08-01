# AGENTS.md - Automators Kit

Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.
By automators.work | 781 tests | 0 deps | 23 core modules

## Architecture

```
Core (26 modules, zero deps, vanilla JS, Bun/Deno/Node.js)

db.js              Document DB: MongoDB queries, indices, JWT auth, AES-256-GCM encryption
vector.js          Vector DB: Float32/Int8/Polar3bit/Binary, IVF, Matryoshka, BM25
hnsw.js            HNSW index: O(log n) approximate nearest neighbor search
http.js            HTTP router: Request/Response, middleware, params, sub-routers, CORS
validate.js        Schema validation: types, formats, defaults, middleware
cms.js             CMS: content types, entries, taxonomies, terms, users, roles
plugins.js         Plugins: hooks, capabilities, registry, loader
portable-text.js   Rich content: JSON blocks to HTML/Markdown/PlainText
mcp.js             MCP server: JSON-RPC 2.0 stdio, 20 tools
a2e.js             A2E executor: 19 operations, DAG parallel, middleware, onError
workflow.js        Workflow engine: n8n-style nodes, triggers, credentials, history, DAG-parallel execution
dag.js             Shared DAG level-scheduling (Kahn's algorithm), used by workflow.js + a2e.js
nodes.js           Node registry: 20 built-in nodes (core, communication, data, AI)
triggers.js        Trigger system: manual, webhook, cron, polling with change detection
credentials.js     Credential vault: AES-256-GCM encrypted storage
shell.js           Agent shell: command gateway, parser, pipeline, JQ filter, RBAC
shell-mcp.js       Exposes shell.js over MCP as 2 fixed tools (shell_help/shell_exec)
queue.js           Job queue: async, retries, backoff, dead letter, concurrency
cron.js            Cron scheduler: 5-field expressions, tick, enable/disable
connector.js       HTTP client: auth presets, retries, timeout (Slack/Discord/REST)
memory.js          Agent memory: semantic + episodic + working, recall with decay
parallel.js        Task orchestration: race/merge/all strategies, timeout, weighted scoring
net-guard.js       SSRF guard: blocks loopback/RFC1918/link-local/cloud-metadata destinations
log.js             Structured logging: leveled, JSON-per-line entries, pluggable sink
metrics.js         In-process metrics: counters/gauges/histograms, Prometheus text exposition format
csv.js             CSV parsing: RFC-4180 quoted fields, embedded delimiters/newlines, escaped quotes
```

**Similar-sounding modules, when to reach for which:**
- `memory.js` (keyword/term recall, time decay, zero ML dependency — see `examples/agent-memory-backend/`) vs `vector.js` (real cosine-similarity over embeddings YOU provide, never calls an embedding API itself — see `examples/vector-memory/`). Default to `memory.js`; move to `vector.js` when word-overlap recall isn't good enough. Combining them as keyword-first/vector-fallback is NOT a semantic upgrade with the zero-dependency offline embedding either ships with — see `examples/hybrid-recall/` for the verified, honest value the combination actually has (coverage, not paraphrase understanding).
- `workflow.js` (n8n-style: named nodes wired by `{{ref}}` templates, webhook/cron/poll/manual triggers, DAG-parallel) vs `a2e.js` (smaller declarative multi-step executor: `SetData`/`FilterData`/`ApiCall`/`Conditional`/`Loop`/..., its own separate DAG + middleware). These are two independent engines, not layers. They now share the actual DAG level-scheduling algorithm (`dag.js`'s `buildLevels`, Kahn's algorithm) since it was byte-for-byte duplicated code, but each keeps its own dependency-detection convention (`{{ref}}` template scanning vs `/workflow/<opId>` + `onError` + `Conditional` branch edges) — an engine-specific improvement still doesn't automatically apply to the other. Two more real differences, verified while building `examples/a2e-vault-api/`: `WorkflowExecutor.execute()` takes no per-call input at all (unlike `workflow.js`'s `execute(id, triggerData)`) — reuse means reloading the pipeline definition, not injecting data into an already-loaded run; and `execute()`'s DAG-level dispatch does NOT stop on a failed op (`workflow.js`'s does, unless `continueOnError`), so a downstream `Conditional` reading a failed op's never-written output silently gets `undefined` unless an explicit `onError` fallback is used.
- `mcp.js` (one MCP tool per capability, real JSON schema per tool, `tools/list` gives full discovery — context cost grows with tool count; see `examples/mcp-cms/`) vs `shell-mcp.js` (`shell.js`'s entire command registry through exactly 2 fixed tools, `shell_help`/`shell_exec` — constant ~600-token cost no matter the registry size; discovery happens at runtime via `shell_exec("search ...")`/`("describe ...")` instead of `tools/list`; see `examples/shell-mcp/`). Port of [Agent-Shell](https://github.com/MauricioPerera/Agent-Shell)'s `McpServer`; verified end-to-end against a real external MCP client (poolside.ai's `pool exec`), which correctly called help, searched, described, then executed with no schema handed to it upfront.

**Known limit — `db.js` is single-process by design.** `Collection`
loads the adapter's data into an in-memory `Map` once (`_ensureLoaded()`)
and never re-reads it; `flush()` is the only path back to disk, with no
invalidation/coherency protocol. Two processes sharing the same underlying
data would silently diverge, not error. Applies to everything built on
`DocStore` (`cms.js`, `credentials.js`, `memory.js`). `integrations/`
sidesteps this for two specific pieces by never caching state at all
(every operation is a fresh round trip): `postgres-queue.js` for job
queueing, `postgres-execution-log.js` for workflow execution history.
Neither touches `core/db.js`/`core/workflow.js` — standalone sidecars,
not a fix to `Collection`. Could extend case by case to
`cms.js`/`credentials.js`/`memory.js`, but doesn't generalize into one
fix — `Collection`'s caching model itself would need a redesign from
scratch, out of scope for now.

## Quick Start

```bash
bun seed.js              # create admin + default content types
bun server-bun.js        # start API at http://localhost:3000
bun mcp.js               # start MCP server (stdio)
bun cli.js help          # CLI reference
```

## Examples

`examples/content-pipeline/` — end-to-end worked example combining CMS +
workflow engine + custom nodes + agent shell: authenticated webhook intake →
markdown→HTML → CMS draft → publish → shell inspection with RBAC. Shared
setup in `pipeline.js`, runnable demo in `setup.js`
(`bun examples/content-pipeline/setup.js`), regression test in
`tests/examples-content-pipeline.test.js`. Good reference for wiring custom
nodes (`workflowEngine.nodes.add(...)`) and shell commands
(`shell.registry.register(...)`) on top of `createApp()`.

`examples/command-gateway/` — scoped-RBAC command gateway prototype: one
`CommandRegistry` (`registry.js` — the entire command surface an agent can
reach, no raw DB access) mounted at 4 HTTP endpoints
(`/api/gateway/{admin,editor,support,public}`), each backed by its own
`Shell` instance with a different `profile`/`permissions` scope — including
a custom scope not among the 4 built-in `AGENT_PROFILES`. Demonstrates
per-persona command history isolation too (`GET /api/gateway/:persona/history`).
Run with `bun examples/command-gateway/setup.js`; regression test in
`tests/examples-command-gateway.test.js`.

`examples/agent-memory-backend/` — an agent with persistent state
(`core/memory.js`'s `AgentMemory`: semantic + episodic, keyword-matched
`recall()`, no embeddings provider required) reachable two ways from one
shared set of handlers (`tools.js`): `setup.js` exposes
`memory:learn/remember-error/recall/stats/dream` as agent-shell commands
plus an hourly `core/cron.js` job running the heuristic dedup cycle;
`mcp-server.js` exposes the SAME operations as MCP tools
(`learn_task`/`remember_error`/`recall_memory`/`memory_stats`/`dream`)
alongside the base CMS tools `createMCPServer` always includes — point a
real MCP client at it to give an agent memory that survives across
sessions. Memory is isolated per `agentId` on the same underlying db.
Regression test in `tests/examples-agent-memory-backend.test.js` covers
both surfaces, using `handleMCPRequest()` directly for MCP (no stdio
needed for testing).

`examples/vector-memory/` — real cosine-similarity semantic search
(`core/vector.js`'s `VectorStore`) over notes, not keyword recall like
`agent-memory-backend` above. `embed.js` is a zero-dependency offline
embedding (hashing trick, deterministic, no API key) explicitly designed
to be swapped for a real embeddings API — same `(text) => number[]`
signature `core/vector.js`'s `Reranker.autoSearch` already expects via its
`embedFn` param. Run with `bun examples/vector-memory/setup.js`; regression
test in `tests/examples-vector-memory.test.js`. Building this found a real
bug in `core/shell.js`: the builtin command dispatch matched
`search`/`describe`/`help` by name alone regardless of namespace, silently
shadowing any registered `<namespace>:search`/`:describe`/`:help` command
(this had already broken `content:search` in `command-gateway`, unnoticed
until this example's test exercised it) — fixed, with regression tests in
`tests/shell.test.js`.

`examples/integrations/` — wire up Slack + Discord + a REST API with
`core/connector.js` (auth presets `slack()`/`discord()`/`restApi()`/
`apiKey()`, retry/backoff, optional `blockInternalHosts` SSRF guard) +
`core/credentials.js` (encrypted vault) — no infra to stand up. Runs fully
offline: `mocks.js` stands in for Slack/Discord/a flaky third-party API on
the same server, so retries and delivery are visible end-to-end with zero
real webhook URLs. Run with `bun examples/integrations/setup.js`; regression
test in `tests/examples-integrations.test.js` starts a real `Bun.serve()`
(not just `app.handle()`) since `Connector` uses real `fetch()`. Found a
real gotcha: `connector.js` only throws `ConnectorError` when retries are
exhausted by a network/timeout failure — exhausting retries on repeated 5xx
returns the last response normally (`{ok:false, status:503}`), no
exception; callers must check `.ok`, not only catch.

`examples/scheduled-sync/` — the reverse of `integrations` above: pushes
published CMS entries OUT to an external system on a `core/cron.js`
schedule (every 5 min) via `core/connector.js`, tracked with a cursor
(`_sync_state` collection) so re-runs never resend what already synced.
`tools.js`'s `runSync` documents the trade-off: the cursor only advances
past entries that pushed successfully, in order — a failure stops the run
there (gap-free, at-least-once) rather than tracking individually-failed
ids and continuing past them. Run with `bun examples/scheduled-sync/setup.js`;
regression test in `tests/examples-scheduled-sync.test.js` (also a real
`Bun.serve()`, same reason as `integrations`). Found that a single
simulated mock failure gets silently absorbed by `core/connector.js`'s own
retry logic before `tools.js`'s failure handling ever sees it — the mock
must fail more times than `runSync`'s own retry budget to exercise that
path for real. Also found (root-causing an intermittent test failure) that
`runSync` relied on a client-side re-sort by `updatedAt` that silently
no-oped whenever two entries' timestamps tied — see Security section
below for the fix.

`examples/provider-fanout/` — "ask 3 redundant suppliers for the same
quote and take the best or fastest answer": `core/parallel.js`'s
`parallelRace` (first supplier to answer wins, ignores failures unless
all fail) and `parallelMerge` (all suppliers answer, then a strategy
picks the winner — highest confidence, or a custom cheapest-price
scorer) fanned out over `core/connector.js` calls to 3 mock suppliers, so
one slow/dead supplier never blocks the others. Run with
`bun examples/provider-fanout/setup.js`; regression test in
`tests/examples-provider-fanout.test.js` (also a real `Bun.serve()`, same
reason as `integrations`/`scheduled-sync`). Found a real gotcha:
`parallelMerge`'s `highest-confidence` strategy has a `minConfidence`
option defaulting to 0, which silently discards a winner whose custom
scorer returns a negative value — a naive `-price` "cheapest wins" scorer
must be `1/price` instead (same ordering, always positive).

`examples/large-catalog-search/` — "when does `vector.js`'s linear scan
stop being good enough?", answered with real measured numbers. Indexes
8000 synthetic products into `core/hnsw.js`'s standalone `HNSWIndex`
(not integrated with `vector.js`/`DocStore` — its own thing), then runs
every query both ways: approximate HNSW graph search vs. a brute-force
exact cosine scan over the same vectors. Measured live: 4.9x-8.5x
speedup, recall 0.7-1.0 depending on the query (ANN is genuinely
approximate — ties at the top-k cutoff can make HNSW surface a different,
equally-valid subset than the exact linear sort). Run with
`bun examples/large-catalog-search/setup.js`; regression test in
`tests/examples-large-catalog-search.test.js` (a 200-product catalog
instead of the demo's 8000, for speed — `HNSWIndex` is pure in-process,
no real server/`fetch()` needed here, unlike the `Connector`-based
examples). Found a real gotcha: `HNSWIndex` has no persistence of its
own — no `save()`/`load()`, confirmed by reading the whole module — so a
real deployment must rebuild the index from a source of truth at boot or
write its own serialization layer.

`examples/job-queue/` — "kick off slow work, return immediately, poll for
status": `core/queue.js`'s `JobQueue` doing retries with exponential
backoff and dead-letter handling off the HTTP request/response path
entirely (same "kick off + poll" shape as the MCP Tasks extension
formalizes for long-running tool calls). Verified live end-to-end: a job
exhausts its retries into the dead letter, gets retried, and completes.
Run with `bun examples/job-queue/setup.js`; regression test in
`tests/examples-job-queue.test.js` (`MemoryStorageAdapter`, fast
poll/backoff — job processing is inherently async on a real timer, so the
test polls for status like a real client would, no fake timers). Found 2
real gaps while building: `JobQueue` has no `getById()` of its own (only
`list()`/`deadLetter()`, both filtered-list views) — `tools.js` reaches
the internal `_queue_jobs` collection directly via `DocStore`'s public
API instead; and `queue.retry()` returns the raw new job document, not
the `{jobId, status}` shape `enqueue()`'s other callers get — `tools.js`
normalizes it.

`examples/plugin-system/` — "extend the CMS with third-party modules
without giving them raw DB access": `core/plugins.js`'s capability-gated
`createPluginAPI` + `loadPlugins`. 3 real local plugin files
(`audit-log.js`: `entries:read`+`database:write`; `webhook-notifier.js`
and `blocking-validator.js`: `entries:read` only), loaded through
`loadPlugins()` against a real `createApp()` + `cms.entries.create/publish`
flow. Verified live: `webhook-notifier` genuinely has no `api.database`
property at all (not a stub, absent) since it wasn't granted
`database:write`. Run with `bun examples/plugin-system/setup.js`;
regression test in `tests/examples-plugin-system.test.js`. Found a real
gotcha: `core/cms.js`'s ~30 `this.cms.hook(name, payload)` call sites
never pass `{ throwOnHookError: true }`, so a plugin hook can observe and
mutate an operation's payload but can never veto it — `blocking-validator`
throws from `entry:beforeCreate` to try to block a banned word, the throw
is logged, and the entry is created anyway. Confirmed live before writing
it up, not assumed from reading the code.

`examples/workflow-engine/` — the n8n-style engine itself, front and
center (`content-pipeline` only touches it in passing): a
webhook-triggered order workflow with 3 independent enrichment nodes,
`{{ref}}`-wired summary/notify nodes, and vault-backed credentials.
Verified live: the 3 parallel nodes start within 0.15ms of each other
(186ms total execution vs. ~450ms sequential). Run with
`bun examples/workflow-engine/setup.js`; regression test in
`tests/examples-workflow-engine.test.js` (real `Bun.serve()`, drives the
actual `/api/workflows/webhook/:path` route, not a direct `execute()`
call). Found a real gotcha: `core/nodes.js`'s generic HTTP node path
(`_executeApi`, used by any node without a custom `handler`, e.g.
`email.send`) always calls net-guard's `assertPublicUrl` with **no
opt-out** — unlike `core/connector.js`'s opt-in `blockInternalHosts` — so
it correctly rejects this example's own local mock API. Rather than work
around it, the demo keeps `email.send` failing as designed
(`continueOnError: true`) and adds a custom-handler node
(`notify.email`) using the same vault credential to show the working,
offline-safe alternative.

`examples/a2e-pipeline/` — `a2e.js`'s own distinctive shape: a declarative
compact-JSON signup-batch pipeline using `Loop`, `Conditional`,
`StoreData`, and both middleware classes (`AuditMiddleware`,
`CacheMiddleware`). Verified live: a repeated slow lookup (150ms
simulated) drops to 0.2ms on the second run via `CacheMiddleware`
(~770x). Run with `bun examples/a2e-pipeline/setup.js`; regression test
in `tests/examples-a2e-pipeline.test.js` (pure in-process). Found and
fixed **2 real bugs in `core/a2e.js` itself**, not example-specific:
`Loop` with sub-operations threw `ReferenceError: depth is not defined`
on its very first item (a `depth` variable referenced outside its own
scope — zero prior test coverage); and `Conditional` always executed
**both** branches, with the taken one running **twice**
(`execute()`'s DAG-level loop blanket-dispatched every declared
operation regardless of which branch was chosen, on top of
`Conditional`'s own dynamic dispatch of the taken one) — fixed via a new
`conditionalBranchTargets()` helper that excludes branch-target ids from
blanket dispatch, with a self-referencing-branch edge case (the existing
recursion-depth-guard test) explicitly preserved. Also confirmed (not
fixed, documented as a related, out-of-scope finding): `Loop` sub-op ids
are similarly blanket-dispatched standalone at the top level (same shape
of bug, but `buildDAG` has no edge-modeling for `Loop.config.operations`
the way it does for `Conditional` branches), and the workflow
definition's `execute` field is a no-op — every declared operation always
runs regardless of it.

`examples/content-formats/` — "author once in Markdown, publish
everywhere," using `core/portable-text.js` to store content as structured
JSON blocks and render the same article to HTML, Markdown, and plain text
for different channels, plus a custom `callout` block type via `toHTML`'s
`customRenderers` hook. Run with `bun examples/content-formats/setup.js`;
regression test in `tests/examples-content-formats.test.js` (pure
in-process, no I/O in `portable-text.js`). No bug found, but 2 things
confirmed live rather than assumed: the 2026-07 audit's stored-XSS fix in
the built-in HTML renderers is still intact (`<script>` typed as plain
text renders as `&lt;script&gt;`); and `customRenderers` itself does
**not** auto-escape — an intentionally unsafe custom renderer let a
`<script>` tag through raw, confirming that escaping a custom renderer's
own interpolated values is the implementer's own responsibility. Also
confirmed a custom block only renders where you gave it a renderer:
`toMarkdown`/`toPlainText` have no equivalent hook and silently drop it.

`examples/doc-store-analytics/` — "you don't need the whole CMS to get a
document database + HTTP API." Unlike every other example, this one never
calls `createApp()`: `core/db.js`'s `DocStore` wired directly to
`core/http.js`'s `Router` and `core/shell.js`'s `Shell` — 3 à la carte
modules, zero CMS/content-types/auth. An inventory + orders analytics
service demonstrating real MongoDB-style operators, `$group` aggregation
(category report), `$lookup` (a real join — top sellers joined to product
details), and export/import backup. Run with
`bun examples/doc-store-analytics/setup.js`; regression test in
`tests/examples-doc-store-analytics.test.js` (pure in-process, no real
`Bun.serve()` needed). Measured live: an indexed `find({sku})` lookup is
~21x faster than the same query before `createIndex('sku', {unique:true})`
(1.334ms → 0.062ms on an 8000-product seed).

`examples/api-validation/` — `core/validate.js` standalone, no CMS: a
signup API using `validateBody`/`validateQuery` middleware, covering
required/type/min-max, `format` validators, a `pattern` RegExp, `enum`,
nested `object.properties`, typed `array` `items`, static/function
`default`s, `opts.partial`, and a cross-field `$refine` rule. Run with
`bun examples/api-validation/setup.js`; regression test in
`tests/examples-api-validation.test.js` (pure in-process, `Router.handle`
directly). Found and fixed a real gotcha: `validate()` applies a schema's
**function** defaults (e.g. `createdAt: () => new Date().toISOString()`)
on every call, `opts.partial` included, for any field missing from the
input — a naive `PATCH` handler merging the whole validated result back
onto the existing record silently regenerated `createdAt` on every
partial update, verified live before and after the fix (only applying
the keys present in the caller's own request body).

`examples/mcp-cms/` — the CMS's own MCP server (`core/mcp.js`), front and
center: 20 base tools, one per capability, each with a real JSON schema
seen up front via `tools/list` — the complementary pattern to
`core/shell-mcp.js`'s 2-tool gateway (see "Similar-sounding modules"
above). Plus 1 custom tool (`publish_with_stats`, composing `mcp.js` +
`portable-text.js` in one call) via `buildAllTools`'s `extraTools`. Run
with `bun examples/mcp-cms/setup.js`; regression test in
`tests/examples-mcp-cms.test.js` (drives a REAL `createApp()` cms through
the pure `handleMCPRequest` dispatcher — `tests/mcp.test.js` uses a fake
cms with spies to test the dispatcher in isolation, this is genuine
end-to-end coverage). Verified against a real external MCP client
(poolside.ai's `pool exec`): given only the schemas, it created an entry,
confirmed `draft` status, called the custom tool, and correctly reported
the word count/excerpt it returned — no guessed field names, no
`search`/`describe` round-trip needed first (unlike `shell-mcp.js`).

`examples/shell-mcp/` — `core/shell-mcp.js`'s 2-tool MCP gateway (see
"Similar-sounding modules" above), wired to a real task-management
command registry (`tasks:create`/`list`/`complete`/`delete`,
`registry.js`) — this module had unit tests (`tests/shell-mcp.test.js`)
but no worked example until now. JSON-RPC 2.0 over stdio, not HTTP: run
with `bun examples/shell-mcp/setup.js`, or configure it in a real MCP
client (Claude Desktop, `pool mcp add`, ...). Verified live by spawning
the real `setup.js` process and piping actual JSON-RPC lines to its
stdin/stdout: `tools/list` stays at exactly 2 regardless of the 4
registered commands, and `shell_exec("search task")`/`("describe
tasks:create")` discover them with zero schema handed to the client
upfront. Verifying it live found and fixed a real bug in `core/shell.js`
itself: `--confirm` was advertised (`help()`, and `shell_exec`'s own MCP
tool description) as "Preview before execute," but the flag was parsed
and never checked in `_execSingle` — a command carrying `--confirm`
executed for real, immediately, same as omitting it (verified live:
deleting a record "with confirm" deleted it for real). Fixed by
mirroring the existing `--dry-run` branch: `--confirm` now previews
(`mode: "confirm"`, `requiresConfirmation: true`) without running the
handler; re-issuing the same command without it executes for real —
verified end-to-end through this exact MCP server. Regression test in
`tests/examples-shell-mcp.test.js` (pure `handleShellMCPRequest`
dispatcher, drives the real `registerTaskCommands` registry so the demo
and test can't drift apart).

`examples/api-gateway/` — `core/http.js`'s `Router` as the star: global
middleware (`cors`, `logger`), per-route-group rate limiting via mounted
sub-routers (`/api/public` vs `/api/admin` get genuinely different
limits — each `Router` instance has its own middleware stack), and a
custom `keyFn` (rate limit by an API key header instead of client IP).
Run with `bun examples/api-gateway/setup.js`; regression test in
`tests/examples-api-gateway.test.js` (pure in-process, `Router.handle`
directly). Found and fixed a real bug: `rateLimit()` computed
`X-RateLimit-*` headers for an allowed request, but nothing ever merged
them into the response — only the 429-blocked path (built inline)
carried real ones. Measured live: `/api/public/ping`'s `Remaining` steps
4,3,2,1,0 then a real 429 with `Retry-After` on the 6th request.

`examples/trigger-hub/` — `core/triggers.js`'s `TriggerManager`, front and
center: all 4 trigger types (manual, webhook, cron, poll) feeding one
unified `onTrigger` callback. No CMS, no `WorkflowEngine` — same à la
carte spirit as `examples/doc-store-analytics`. Run with
`bun examples/trigger-hub/setup.js`; regression test in
`tests/examples-trigger-hub.test.js` (real `Bun.serve()`, real 1s poll
interval — poll behavior is fundamentally about real elapsed time, not
something a pure-dispatch test can fake). Found and fixed 2 real bugs in
`core/triggers.js`: `list()` never surfaced a poll trigger's
circuit-breaker error state (only a **private** `_pollerErrors` map
recorded it — confirmed by the module's own unit tests reaching into it
directly), so a dead poller kept showing as an ordinary, still-running
registration; and `_pollOnce` never checked `res.ok`, so an HTTP error
(503) with a valid JSON body was silently treated as **changed data**,
firing the trigger with the error body as its payload and **resetting**
the failure counter instead of tripping the breaker. Verified live
before/after both fixes over a real HTTP round trip. Also documents a
hard, verified-live constraint: poll triggers can't target `localhost` at
all — `register()` calls net-guard's `assertPublicUrl` with no opt-out
(unlike `connector.js`'s `blockInternalHosts`).

### Combined examples

`examples/resilient-notify/` — every example above demonstrates ONE
module; this one composes 3 into a pattern none covers alone:
`examples/job-queue` (background, retryable, dead letter) +
`examples/provider-fanout` (`parallelRace` over all configured channels —
reach *someone* fast, don't care which) + `examples/integrations`
(vault-backed `Connector`s per channel). Run with
`bun examples/resilient-notify/setup.js`; regression test in
`tests/examples-resilient-notify.test.js` (real `Bun.serve()`, `Connector`
uses real `fetch()`). Verified live end-to-end: happy path, one channel
down not slowing anything, and the full all-channels-down → dead letter →
retry → recovery cycle. Documents an honest, verified-not-assumed
gotcha: `parallelRace` doesn't cancel losing tasks — when two channels
answer with similar latency, both actually deliver the message, not just
the one whose result the job returns.

`examples/mcp-workflows/` — `examples/shell-mcp` + `examples/workflow-engine`:
`core/shell-mcp.js`'s 2-tool MCP gateway driving **real**
`core/workflow.js` executions — an agent runs and inspects a real
workflow (Ticket Triage) via `shell_exec`, something neither `mcp-cms`
(CMS ops, not workflows) nor `workflow-engine` (HTTP/webhook-driven, no
MCP) demonstrates. One small workflow is registered at setup time
(`triage-workflow.js`); an agent only ever runs/inspects it via
`workflows:*` shell commands (`registry.js`) — authoring the DAG stays a
setup-time concern. Run with `bun examples/mcp-workflows/setup.js`;
regression test in `tests/examples-mcp-workflows.test.js` (pure
`handleShellMCPRequest` dispatcher, real `WorkflowEngine`). Found and
fixed a real bug: `WorkflowEngine.execute()`/`run()` discarded the return
value of `insert()` (which clones with `_id` assigned, doesn't mutate the
input) and returned an execution with no `_id` at all — unlike
`core/cms.js`'s `EntryService.create()`, which already captures it
correctly. Verified live before/after: the same execution, fetched right
after the fix by the id `run()` itself returned. Also documents a gotcha
in this example's own workflow definition (not core): the
`if`/`onFalse: 'skip'` barrier needs an explicit `{{ref}}` dependency to
land a downstream node in a later DAG level, since `workflow.js` infers
ordering only from literal `{{ref}}` occurrences in a node's inputs.

`examples/plugin-workflow-nodes/` — `examples/plugin-system` +
`examples/workflow-engine`: a third-party plugin extending
`core/workflow.js`'s `NodeRegistry` with a real new node type,
capability-gated by `core/plugins.js` — neither `plugin-system` (never
touches workflows) nor `workflow-engine` (nodes are all built-in or
wired by `setup.js`, never a plugin) demonstrates this. Found a real
gap: `createPluginAPI` had no way to reach the workflow engine's
`NodeRegistry` at all, so a new `nodes:register` capability was added
(gated exactly like `database:write`, threaded through
`loadPlugins()`/`createApp()` automatically). Designing it surfaced a
real security gap: `NodeRegistry.add()` has no collision guard —
verified live that it silently lets any caller overwrite `http.request`,
including its net-guard SSRF check, for every workflow in the system.
The new capability's wrapper rejects overwriting an existing node type;
a second plugin in the example demonstrates the rejection live, not just
in a unit test. Run with `bun examples/plugin-workflow-nodes/setup.js`;
regression test in `tests/examples-plugin-workflow-nodes.test.js` (real
`createApp()` + `loadPlugins()` boot path, real plugin files, not a
hand-built API).

`examples/hybrid-recall/` — `examples/agent-memory-backend` +
`examples/vector-memory`: `core/memory.js`'s keyword recall tried first,
falling back to `core/vector.js`'s cosine search only on a true empty.
The original plan ("semantic fallback for paraphrases") was verified
empirically before writing any code and doesn't hold — the shared
offline hashing-trick embedding has no synonym understanding, and a
genuine paraphrase can rank an unrelated stored doc above the real match
(verified live). Built around what's actually true instead:
`memory.recall()` hard-empties on zero shared vocabulary, `store.search()`
never does — the fallback adds coverage, not intelligence, and results
are honestly labeled `source: "keyword"`/`"vector"` plus a
`lowConfidence` flag. That threshold was itself miscalibrated on the
first pass (0.3 mislabeled a clearly unrelated query as confident at
0.429, verified live) and corrected to 0.5 against a 10-query empirical
sample. No core changes — entirely example-scoped. Run with
`bun examples/hybrid-recall/setup.js`; regression test in
`tests/examples-hybrid-recall.test.js`.

`examples/poll-to-queue/` — `examples/trigger-hub` + `examples/job-queue`:
a poll trigger watching an external feed, enqueueing one durable,
independently retryable job per genuinely new item instead of one
all-or-nothing event per poll cycle — a real production ingestion
pattern neither example covers alone (`trigger-hub` only logs fired
events; `job-queue` has no poll source). Found a real gotcha, no core
changes needed — fixed entirely in the example's own bridge logic
(`hub.js`): `TriggerManager`'s poll never fires `onTrigger` on its first
cycle (that cycle only establishes the baseline hash), so without an
explicit baseline fetch before the poll trigger starts, the first real
fire would treat every pre-existing feed item as new and enqueue it —
verified live, then fixed by seeding a `seenIds` set from an initial
fetch first, same cursor philosophy as `examples/scheduled-sync` applied
to inbound polling. Verified live end-to-end: baseline seeding, a new
item becoming a processed job within one poll cycle, a persistently
failing item reaching the dead letter isolated from others, and the poll
circuit-breaker (the `triggers.js` fix from `trigger-hub`) tripping on 3
real HTTP 503s with zero spurious enqueues. Run with
`bun examples/poll-to-queue/setup.js`; regression test in
`tests/examples-poll-to-queue.test.js`.

`examples/a2e-vault-api/` — combines `core/a2e.js`'s declarative executor
with `core/credentials.js`'s vault + `core/connector.js`'s retrying HTTP
client, calling a REAL external API from a pipeline step — something
`examples/a2e-pipeline` doesn't cover (fully offline). Uses the
custom-handler extension point `a2e.js` already has
(`WorkflowExecutor.registerHandler()`) but never demonstrated with a real
network call; `a2e.js`'s own built-in `ApiCall` op has no credential
injection at all. No core changes — composition, not a new capability.
Found 2 real, verified differences from `workflow.js` (see "Similar-
sounding modules" above): no per-call input on `execute()`, and no
stop-on-error across DAG levels — a failed lookup silently routed into
the same path as a genuine standard-tier lead until an explicit
`onError` fallback made the failure state distinguishable, verified live
before and after. Run with `bun examples/a2e-vault-api/setup.js`;
regression test in `tests/examples-a2e-vault-api.test.js`.

`examples/a2e-background/` — combines `core/queue.js`'s kick-off + poll
pattern with `core/a2e.js`'s declarative executor: a batch enrichment
pipeline runs as a durable background job instead of blocking the HTTP
request — neither `examples/job-queue` nor `examples/a2e-pipeline`
demonstrates this. Found and fixed a real, serious core bug, same class
as the earlier `Conditional` both-branches bug (its own fix plan
explicitly flagged this Loop case as deferred): a `Loop`'s
sub-operations were dispatched TWICE — once spuriously at the top level
(`state.loop === {}`, before the loop even starts), once correctly per
iteration. Every prior `Loop` test tolerated garbage input silently, so
this was invisible until a realistic handler threw on it (verified live:
called 3 times for a 2-item loop, not 2). Fixed via Plan Mode approval
with `loopSubOperationTargets()`, mirroring `conditionalBranchTargets()`
exactly. Also found (at the time, only handled at the example level): a
single `WorkflowExecutor` instance was unsafe for concurrent `execute()`
calls — verified live that two concurrent runs sharing one instance
corrupted each other's results; worked around here by constructing a
fresh executor per job. **Fixed properly in `core/a2e.js` since** — see
the [A2E Workflow Executor](#a2e-workflow-executor) section below — the
workaround shown here is no longer required, though it remains valid.
Verified live: a single background run completes
correctly, and 3 concurrent jobs each land their own correct, isolated
result. Run with `bun examples/a2e-background/setup.js`; regression test
in `tests/examples-a2e-background.test.js`.

`examples/agent-memory-hnsw/` — combines `core/memory.js`'s `AgentMemory`
with `core/hnsw.js`'s standalone `HNSWIndex`: real memory content indexed
into both, comparing 3 recall strategies as memory scales (keyword, HNSW
approximate, brute-force exact) — same benchmark methodology as
`examples/large-catalog-search`, applied to real agent memory instead of
a synthetic catalog. Found and fixed a real, SEVERE core bug: HNSW's
neighbor selection used the naive "M closest by raw distance" heuristic
— with duplicate/near-duplicate vectors (common in real memory content,
unlike `large-catalog-search`'s catalog which embeds a unique index
number per product avoiding this), recall vs. a brute-force exact scan
collapsed from 1.0 to 0.0 with just 2x exact duplication, verified live.
Fixed via Plan Mode approval (algorithmic change) implementing the
original HNSW paper's diversity-aware neighbor selection; verified live:
2x duplication recovered to 0.8-1.0 recall, ~9x (the real 5000-entry demo
scale) recovered to 0.6 with the top result now exactly matching the
true best (previously it found a measurably worse cluster entirely). The
pre-existing `hnsw.test.js` recall test improved to 1.000 with the fix.
Measured: HNSW is ~7.4x faster than the brute-force exact scan and ~60x
faster than `memory.js`'s own keyword recall over 5000 entries. Run with
`bun examples/agent-memory-hnsw/setup.js`; regression test in
`tests/examples-agent-memory-hnsw.test.js`.

`examples/validated-webhooks/` — combines `core/validate.js`'s real
schema engine with `core/workflow.js`'s webhook trigger: a malformed
payload is rejected with a clear 400 BEFORE the workflow ever runs,
instead of a partial/garbage execution. Found a real architectural
gotcha, verified live: `createApp()` always mounts its own bundled
`/api/workflows` router with an UNVALIDATED webhook route at
`/api/workflows/webhook/:path`, unconditionally — bolting a validated
route on top while using `createApp()` would leave that route reachable,
bypassing validation entirely. Confirmed with a throwaway script: a
garbage payload the validated route rejects with 400 sailed through the
built-in route with a real 200, actually executing the workflow. This
example does NOT call `createApp()` at all (same à la carte spirit as
`examples/doc-store-analytics`) specifically so the validated route is
the only webhook route that exists. Run with
`bun examples/validated-webhooks/setup.js`; regression test in
`tests/examples-validated-webhooks.test.js`.

`examples/content-render-workflow/` — combines `core/portable-text.js`
with `core/workflow.js`: "author in markdown, a webhook-triggered
workflow renders and distributes it." A real custom node
(`content.render`, registered via `WorkflowEngine.nodes.add()` — the same
extension point `examples/plugin-workflow-nodes` already uses, no core
changes needed) parses markdown once and derives HTML, plain text, and
word count from the same parsed blocks; a downstream built-in
`set.value` node correctly interpolates the custom node's outputs via
`workflow.js`'s own `{{ref}}` templating. Found and documented a real,
honest caveat, verified live end-to-end: `toHTML()` escapes an inline
`<script>` tag (the 2026-07 audit's XSS fix, confirmed still intact), but
`toPlainText()`/`excerpt` correctly does NOT — a real consequence for
this specific combination: a future step embedding `{{render.excerpt}}`
into an HTML context without escaping it itself would reopen the exact
XSS surface the audit closed for `toHTML()`. Run with
`bun examples/content-render-workflow/setup.js`; regression test in
`tests/examples-content-render-workflow.test.js`.

`examples/hybrid-catalog-search/` — combines `core/vector.js`'s
cosine-similarity ranking with a REAL `core/db.js` `$lookup`/`$group`
aggregation, scoped to exactly the semantic top-K via `$match: {$in}` —
a query neither module can answer alone. `core/vector.js` has no notion
of a database; `examples/doc-store-analytics`'s `topSellers()` joins
sales data via a real `$lookup`, but as an unscoped `$group` over every
order, no semantic ranking. Verified live: `hybridSearch()` returns the
exact same ids/order/scores as ranking alone, proving the join never
reorders results — it only adds `unitsSold`/`orderCount` on top,
correctly `0`/`0` for products with no real order history rather than
dropping them or leaving fields undefined. A real design detail handled
correctly (not a bug): `$group`'s output order isn't guaranteed to match
the vector search's ranking, so results are explicitly re-sorted back
into the original semantic rank order after the join. Run with
`bun examples/hybrid-catalog-search/setup.js`; regression test in
`tests/examples-hybrid-catalog-search.test.js`.

`examples/rate-limited-queue/` — combines `core/http.js`'s `rateLimit()`
with `core/queue.js`'s `JobQueue`, guarding intake instead of just the
HTTP response. `examples/api-gateway`'s `rateLimit()` only ever protects
fast inline handlers, never a queue; `examples/job-queue` has no limiter
on `enqueue()` at all — any caller can flood it with unlimited jobs, and
a failing job's own retries with backoff multiply that flood further.
Here the limiter sits directly in front of `enqueue()`, so an over-limit
client gets 429 BEFORE a job is ever created. Verified live: a burst of
4 requests against `max: 3` returns 3x 202 (carrying real
`X-RateLimit-*` headers) then a 429, and queue stats confirm exactly 3
jobs completed — the 4th request never reached the queue. Not a bug, but
a design detail worth knowing: intake protection is a property of how
the router is wired, not something either module enforces on its own — a
second, unguarded endpoint calling `enqueue()` for the same job type
would bypass it entirely. Run with
`bun examples/rate-limited-queue/setup.js`; regression test in
`tests/examples-rate-limited-queue.test.js`.

`examples/cms-semantic-search/` — combines `core/cms.js`'s
`entry:afterCreate`/`afterUpdate`/`afterDelete` hooks with
`core/hnsw.js`'s `HNSWIndex`, kept in sync with a real content lifecycle.
`examples/hybrid-catalog-search`/`examples/agent-memory-hnsw` index
synthetic generated data — nothing gets created, edited, or deleted
through them; `examples/mcp-cms` exposes real CMS entries but its only
"search" is a title/slug substring filter, no ranking. Building this the
honest way — restarting the server against its own persisted data, like
a real deploy — found and fixed a real core bug (with explicit
approval): `new CMS()` crashed on any restart against existing
`FileStorageAdapter` data (`Index already exists on field: slug`) —
`core/credentials.js`/`core/memory.js`/`core/workflow.js` already guard
their constructor's `createIndex()` calls with try/catch for exactly
this reason, `core/cms.js` never got the same treatment, meaning every
example using `createApp()` + `FileStorageAdapter` had never actually
survived a real process restart. Fixed with a 7-line change mirroring
the existing pattern, verified live before/after. Also verified live:
create/update/delete stay correctly reflected in search results, and
`reindexAll()` catches the still-non-persistent `HNSWIndex` back up
after a restart. Run with `bun examples/cms-semantic-search/setup.js`;
regression test in `tests/examples-cms-semantic-search.test.js`.

`examples/validated-workflow-nodes/` — combines `core/validate.js` with
`core/workflow.js`: a schema gates a node's handler so it only ever runs
on data that already passed validation. `examples/api-validation`/
`examples/validated-webhooks` only validate the request body at the HTTP
boundary — the moment a workflow *starts*, never data a workflow
produces for itself mid-pipeline; `core/nodes.js`'s own `inputs` array is
documentation only, never enforced by `NodeRegistry.execute()`. No core
changes needed — `validatedNode()` is a node-definition-level wrapper,
the same extension point `examples/plugin-workflow-nodes`/
`examples/content-render-workflow` already use. Verified live: a
`discountPercent: 150` trigger payload is perfectly valid by itself, but
silently produces a negative amount inside the pipeline; the validated
`charge` node blocks it with `"Validation failed: amount must be >=
0.01"`, while the identical unvalidated node succeeds while charging
`-50` — an unnoticed refund, not a crash. Run with
`bun examples/validated-workflow-nodes/setup.js`; regression test in
`tests/examples-validated-workflow-nodes.test.js`.

`examples/mcp-job-queue/` — combines `core/mcp.js` with `core/queue.js`:
an AI agent enqueues background work and polls for its result using
only MCP tool calls, no HTTP/shell. `examples/job-queue` only ever
exposes this over HTTP/shell — no MCP transport exists for it;
`examples/mcp-cms`/`examples/agent-memory-backend` expose CMS entries and
agent memory over MCP, never a `JobQueue`. Reuses `examples/job-queue`'s
own `handlers.js`/`tools.js` directly — the only new code is the MCP
tool shape (3 tools: `enqueue_report`, `job_status`, `queue_stats`).
Verified live over a real spawned stdio process: a full enqueue →
background-completion → status-poll round trip, plus an unknown job id
returning `{ found: false }` as ordinary data instead of getting
swallowed by `core/mcp.js`'s generic error-masking for thrown errors (a
real, documented design detail: masking applies to thrown errors, not
to data a handler deliberately returns). Run with
`bun examples/mcp-job-queue/setup.js`; regression test in
`tests/examples-mcp-job-queue.test.js`.

`examples/queue-access-control/` — combines `core/shell.js`'s RBAC with
`core/queue.js`: 3 agent sessions (admin / reader / a custom
"queue-operator" permission set) share one `JobQueue`, gated
differently. `core/queue.js` itself has no notion of a caller at all;
`examples/job-queue` registers every queue command on `createApp()`'s
default `admin` shell, no restriction ever demonstrated. The exact same
commands are registered once on a shared `CommandRegistry`, and 3
`Shell` instances decide for themselves what their caller may run.
Verified live: reader can list/check status but is denied on
enqueue/stats/purge; the custom operator set can enqueue and read stats
but not retry/purge (no built-in profile fits "enqueue + monitor, no
destructive ops"); admin's `purge` removes jobs enqueued by all three
sessions, confirming RBAC lives in which `Shell` a caller is routed to,
not in the data. Run with `bun examples/queue-access-control/setup.js`;
regression test in `tests/examples-queue-access-control.test.js`.

`examples/vault-access-control/` — combines `core/shell.js`'s RBAC with
`core/credentials.js`: 3 agent sessions (admin / reader / a custom
"integration-runner" permission set) share one `CredentialVault`, gated
differently — a more security-sensitive extension of
`examples/queue-access-control`'s same pattern, applied to secrets
instead of jobs. `core/credentials.js` has no notion of a caller at all;
`vault.get(name)` returns the fully decrypted secret to any code holding
a reference. `vault:reveal` (the only command that ever returns a
decrypted value) is admin-only by construction — its verb matches no
built-in profile's wildcard set. Verified live: `integration-runner` can
`vault:use` a credential (decrypted server-side to confirm it's usable)
with zero secret material in the response, while `reveal`/`store`/
`remove` stay denied; `reader` sees safe metadata via `vault:list` with
no custom grant needed, since `vault.list()` itself never includes
decrypted values. Run with `bun examples/vault-access-control/setup.js`;
regression test in `tests/examples-vault-access-control.test.js`.

`examples/trigger-driven-a2e/` — combines `core/triggers.js` with
`core/a2e.js`: a webhook fires a real `WorkflowExecutor` pipeline, not a
`core/workflow.js` `WorkflowEngine`. `TriggerManager` is built directly
into `WorkflowEngine`, but has zero wiring to `core/a2e.js` — every
existing a2e.js example invokes pipelines manually. Works around a
documented a2e.js constraint: `execute()` takes no per-call input (a
fresh definition is built per fire with the trigger data baked in, same
pattern `examples/a2e-vault-api` used). Built before `execute()`'s
per-call state was fixed to be concurrency-safe in core (see
[A2E Workflow Executor](#a2e-workflow-executor)), so a fresh executor is
also constructed per fire here — no longer required, but harmless.
Building this reproduced the same `a2e-vault-api`-documented footgun — a failed op's
downstream `Conditional` silently picking the same branch as a genuine
negative result — fixed at the example level. Verified live: correct
business/personal routing, a failed enrichment correctly stored as
`decision: null` instead of a misleading fallback, and two concurrent
fires each getting their own uncorrupted decision. Run with
`bun examples/trigger-driven-a2e/setup.js`; regression test in
`tests/examples-trigger-driven-a2e.test.js`.

`examples/agent-authored-node/` — answers a real question from the n8n
comparison directly: n8n ships a CSV node, `core/nodes.js`'s 18
built-ins don't. Instead of waiting for the framework to grow one, this
demonstrates building it — an agent following a
[KDD](https://github.com/MauricioPerera/KDD) task contract for the
correctness-critical piece (RFC-4180 quoting/escaping, kept external per
this project's KDD-as-companion-methodology decision), validated against
a frozen-oracle suite (`tests/csv.test.js`) and the real CCDD gate before
use. `core/csv.js`'s `parseCsv` is a real, reusable core module, not
example-local throwaway code — the "created once, stored, reusable" half
of the thesis. `nodes.js`'s `csv.parse` wraps it via the same
`WorkflowEngine.nodes.add()` extension point every other custom node in
this repo already uses, and composes with the built-in `filter` node in
a real workflow. Verified live with curl against a running server: a
comma embedded inside a quoted field survives the whole pipeline intact.
Run with `bun examples/agent-authored-node/setup.js`; regression test in
`tests/examples-agent-authored-node.test.js`.

`examples/workflow-observability/` — combines `core/log.js` +
`core/metrics.js` (built to close the "no observability" gap for
running Automators Kit in production) with `core/workflow.js`: real
workflow-execution logging/metrics, complementing `core/http.js`'s own
request-level `logger()`/`metricsHandler()`. `observe.js`'s
`observeWorkflowEngine()` watches `_executions` via `DocStore.watch()`
rather than wrapping `execute()`/`run()` directly, since webhook/cron/
poll triggers call `execute()` fire-and-forget internally — a
caller-side "await execute() then log" wrapper (the pattern
`integrations/postgres-execution-log.js` uses) would silently miss every
trigger-fired run. No core changes needed. Found a real routing gotcha
while building this (not a bug, documented in the example's own
README): the demo's original webhook path `run` collided with the
protected `POST /:id/run` route registered earlier in
`routes/workflows.js` — `Router`'s first-match-wins semantics dispatched
to the wrong (401'ing) handler. Verified live: `/metrics` correctly
separates successful and failed executions by label. Run with
`bun examples/workflow-observability/setup.js`; regression test in
`tests/examples-workflow-observability.test.js`.

`examples/scheduled-report-queue/` — combines `core/cron.js` with
`core/queue.js`: a cron tick enqueues one durable, independently-
retryable job per report, instead of doing the work directly inline.
Neither existing example covers this — `examples/scheduled-sync`'s cron
job performs its sync action directly (no queue; a single failure
blocks the cursor there until retried); `examples/job-queue` has no
scheduling trigger at all, only manual enqueue calls;
`examples/poll-to-queue` enqueues one job per new item detected by a
poll trigger (event-driven), not a fixed batch on a schedule. Real cron
ticks fire nightly — `reports:run-now` exposes the exact same enqueue
function for the live demo. Verified live: two `run-now` calls
back-to-back (simulating overlapping cron ticks) produce 6 distinct job
ids, all complete exactly once, zero lost or duplicated; a deterministic
first-attempt failure for one report proves normal retry/backoff still
applies to jobs from a scheduled batch, not just manually-enqueued ones.
Run with `bun examples/scheduled-report-queue/setup.js`; regression test
in `tests/examples-scheduled-report-queue.test.js`.

## Optional Integrations

Standalone modules living outside `core/`, gated behind `optionalDependencies`
so the framework itself stays deps-free by default.

`integrations/postgres-queue.js` — `PostgresJobQueue`, an async-native job
queue mirroring `core/queue.js`'s `JobQueue` API/method names, built to close
a real gap: `core/queue.js`'s concurrency control (`this._running`, a plain
counter) only works within one process, and `core/db.js`'s storage-adapter
interface is fully synchronous (confirmed by reading the module — zero
`await` near any adapter call), so it can't back a Postgres-backed `DocStore`
without a much larger rewrite. This module talks to Postgres directly via
`pg` instead. The correctness-critical piece, `claimJobs(pool, opts)`'s
atomic `WITH ... FOR UPDATE SKIP LOCKED ... UPDATE ... RETURNING` claim, was
authored as a KDD task contract (methodology kept external — see
[KDD](https://github.com/MauricioPerera/KDD), never vendored into this repo)
and verified live against a real Postgres: two concurrent claimers racing 40
pending jobs never claim the same one, together claim all 40 exactly once.
Building it live found a real bug: Postgres's `UPDATE ... RETURNING` does not
preserve a CTE's `ORDER BY` — `claimJobs`'s priority-then-FIFO ordering was
silently lost until sorted client-side right after the atomic claim (see the
function's own comment). Requires the optional `pg` dependency (`bun add
pg`). Tests skip cleanly unless `POSTGRES_TEST_URL` is set:
```bash
POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-queue-claim.test.js tests/integrations-postgres-queue.test.js
```
`tests/integrations-postgres-queue-claim.test.js` is the KDD-contracted
frozen oracle for `claimJobs` specifically; `tests/integrations-postgres-queue.test.js`
covers the rest of the class (enqueue/stats/list/deadLetter/retry/purge)
with the same rigor, no separate formal contract.

`integrations/postgres-execution-log.js` — `PostgresExecutionLog`, a
shared, multi-process-readable workflow execution history. Closes the
last of the 3 infra gaps identified for running Automators Kit as an
n8n alternative under intense, own-server use (the other two: horizontal
job-queue scaling, above, and `a2e.js` concurrent `execute()` — see
[Security](#security)). No `core/workflow.js` change needed:
`WorkflowEngine.execute()` already returns the full execution object
once it's done, so a caller just does `await log.record(exec)` right
after `await engine.execute(...)` — multiple `WorkflowEngine` instances
(one per worker process, each with its own local `DocStore`) can funnel
into this one shared table instead of each staying trapped in its own
process's local `_executions` collection. Unlike `claimJobs()`, no
atomic/concurrency-critical operation here (record/read/purge are plain
INSERT/SELECT/DELETE) — no KDD contract, same test-first discipline
without the formal apparatus. Requires the optional `pg` dependency.
Tests skip cleanly unless `POSTGRES_TEST_URL` is set; run this file
alone, not stacked with the other `integrations-postgres-*.test.js`
files — 3+ concurrent `pg.Pool`s against the same session-mode pooler
tenant can exceed its connection limit (not a bug in the modules; each
passes cleanly alone, and the queue's own 2-file pair still passes
together):
```bash
POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-execution-log.test.js
```

## MCP Server

```json
{
  "mcpServers": {
    "automators-kit": {
      "command": "bun",
      "args": ["mcp.js"],
      "cwd": "/path/to/automators-kit",
      "env": { "DB_PATH": "./data" }
    }
  }
}
```

Tools: list_content_types, get_content_type, create_content_type, delete_content_type, list_entries, get_entry, create_entry, update_entry, delete_entry, publish_entry, unpublish_entry, list_taxonomies, create_taxonomy, delete_taxonomy, list_terms, create_term, list_users, get_user, get_structure

## CLI (JSON output)

```bash
bun cli.js entries list --type post
bun cli.js entries create --type post --title "Hello" --json '{"body":"Content"}'
bun cli.js entries publish --id ID
bun cli.js content-types list
bun cli.js taxonomies list
bun cli.js terms list --taxonomy category
bun cli.js users list
bun cli.js structure
bun cli.js seed --file seed.json
```

## REST API

### Auth
- POST /api/auth/register - { email, password, name }
- POST /api/auth/login - { email, password } returns { token, user }
- GET /api/auth/me - Bearer token

### Content Types
- GET/POST/PUT/DELETE /api/content-types[/:slug]

### Schema (field management)
- GET /api/schema/:slug/fields
- POST /api/schema/:slug/fields - add field
- PUT /api/schema/:slug/fields/:name - update field
- DELETE /api/schema/:slug/fields/:name - remove field
- PUT /api/schema/:slug/fields - reorder

### Entries
- GET /api/entries - ?contentType=post&status=published&search=hello&page=1&limit=10
- GET /api/entries/id/:id
- GET /api/entries/:contentType/:slug
- POST/PUT/DELETE /api/entries/id/:id
- POST /api/entries/id/:id/publish
- POST /api/entries/id/:id/unpublish

### Taxonomies and Terms
- GET/POST/PUT/DELETE /api/taxonomies[/:slug]
- GET /api/terms/taxonomy/:slug[/tree]
- GET/POST/PUT/DELETE /api/terms[/id/:id]

### Users (admin)
- GET/PUT/DELETE /api/users[/:id]

### A2E Workflows
- POST /api/a2e/execute - execute A2E workflow
- POST /api/a2e/validate - validate without executing
- GET /api/a2e/operations - list 19 operations

### Workflow Engine (n8n-style)
- POST /api/workflows - create workflow
- GET /api/workflows - list
- PUT /api/workflows/:id - update
- DELETE /api/workflows/:id - delete
- POST /api/workflows/:id/run - execute manually
- POST /api/workflows/:id/toggle - activate/deactivate
- GET /api/workflows/:id/executions - execution history
- POST /api/workflows/webhook/:path - trigger via webhook
- GET /api/workflows/nodes/list - available nodes
- POST /api/workflows/credentials - store encrypted credentials
- GET /api/workflows/credentials - list (no decryption)

### Agent Shell (command gateway)
- POST /api/shell/exec - execute command string
- GET /api/shell/help - interaction protocol
- GET /api/shell/commands - list registered commands
- GET /api/shell/signatures - AI-optimized format
- GET /api/shell/describe/:id - command definition
- GET /api/shell/history - command history
- GET/POST /api/shell/context - session context

## Agent Shell

AI-first command gateway. 2 MCP tools = ~600 constant tokens regardless of command count.

```javascript
import { Shell } from './core/shell.js';
const shell = new Shell();

shell.registry.register('users', 'list', {
  description: 'List users',
  params: [{ name: 'limit', type: 'number', default: 50 }],
}, async (args) => db.find({}).limit(args.limit).toArray());

await shell.exec('users:list --limit 10');           // execute
await shell.exec('users:list | .[0].name');           // JQ filter
await shell.exec('users:list >> json:filter --expression ".active"'); // pipeline
await shell.exec('batch [users:count, orders:count]'); // parallel
await shell.exec('users:list --dry-run');              // simulate
await shell.exec('search create user');                // discover
await shell.exec('describe users:list');               // definition
```

RBAC profiles: admin (full), operator (CRUD+shell+http), reader (read-only), restricted (public only)

## Workflow Engine (n8n-style)

```javascript
import { WorkflowEngine } from './core/workflow.js';
const engine = new WorkflowEngine(db, { masterKey: 'secret' });
await engine.init();

engine.create({
  name: 'Notify on publish',
  trigger: { type: 'webhook', config: { path: 'on-publish' } },
  nodes: [
    { id: 'msg', type: 'text.template', inputs: { template: 'Published: {{_trigger.title}}', data: '{{_trigger}}' } },
    { id: 'send', type: 'slack.send', inputs: { message: '{{msg}}' }, credentials: 'slack' },
  ],
});

await engine.run(workflowId, { title: 'My Post' });
```

### 18 Built-in Nodes

Core: http.request, set.value, filter, merge, wait, if
Communication: slack.send, discord.send, email.send
Data: json.parse, json.stringify, text.template, base64.encode, base64.decode, math.calc, datetime.now
AI: openai.chat, anthropic.chat

`code.run` was removed in the 2026-07 security audit: it ran arbitrary JS via `new Function`
behind a keyword denylist that was trivially bypassable (real RCE, not a sandbox). Register
your own `handler` on a custom node if you need to run trusted code — see below.

Custom nodes: `engine.nodes.add({ type: 'my.node', handler: async (inputs, creds) => ... })`

### Triggers
- manual: `engine.run(id, data)`
- webhook: `POST /api/workflows/webhook/:path`
- cron: `{ type: 'cron', config: { expression: '0 9 * * *' } }`
- poll: `{ type: 'poll', config: { url: '...', interval: 60000 } }`

### Credential Vault
```javascript
await engine.vault.store('slack', { webhookUrl: 'https://hooks.slack.com/...' });
// Encrypted with AES-256-GCM, decrypted only at execution time
```

## A2E Workflow Executor

19 operations: SetData, FilterData, TransformData, MergeData, StoreData, ApiCall, ExecuteN8nWorkflow, DateTime, GetCurrentDateTime, ConvertTimezone, DateCalculation, FormatText, ExtractText, ValidateData, Calculate, EncodeDecode, Conditional, Loop, Wait

DAG parallel execution, onError fallback, middleware (audit, cache), custom handlers.

```javascript
import { WorkflowExecutor } from './core/a2e.js';
const ex = new WorkflowExecutor();
ex.load({ operations: [...], execute: 'first' });
const result = await ex.execute();
```

Concurrent `execute()` calls on the same instance are safe (fixed
2026-07-31): `state`/`results`/`errors` live in a context local to each
call, not on `this`. `executor.state`/`.results`/`.errors` still exist as
an informational snapshot of the last completed run, but the return
value of `execute()` is the authoritative result. `load()`/
`registerHandler()` are not safe to call while an execution is still in
flight on the same instance.

## HNSW Index

```javascript
import { HNSWIndex } from './core/hnsw.js';
const hnsw = new HNSWIndex({ m: 16, efConstruction: 200, efSearch: 50 });
hnsw.add('doc-1', embedding);
const results = hnsw.search(queryVector, 10);
// [{ id, score, distance }]
```

## Agent Memory

```javascript
import { AgentMemory } from './core/memory.js';
const mem = new AgentMemory(db);

mem.learnTask({ task: 'Implement auth', outcome: 'success', learnings: ['Use Web Crypto'] });
mem.storeSnippet({ code: '...', description: 'JWT signing', language: 'javascript' });
mem.storeError({ error: 'Token expired', solution: 'Check exp claim' });

mem.recall('authentication JWT');        // search with time decay + access boost
mem.recallError('token expired');        // find similar errors
mem.recallSnippets('hashing', 'javascript');

mem.setProject('automators-kit');
mem.setTask('Add vector search');
mem.openFile('core/hnsw.js');
mem.getWorkingContext();
```

## Automation Engine

### Job Queue
```javascript
import { JobQueue } from './core/queue.js';
const queue = new JobQueue(db, { concurrency: 5, maxRetries: 3 });
queue.register('send-email', async (data) => { /* ... */ });
queue.enqueue('send-email', { to: 'a@b.com' });
queue.start();
```
In-process only. For multiple worker processes/machines sharing one queue,
see `integrations/postgres-queue.js`'s `PostgresJobQueue` under
[Optional Integrations](#optional-integrations).

### Cron Scheduler
```javascript
import { CronScheduler } from './core/cron.js';
const cron = new CronScheduler();
cron.add('cleanup', '0 * * * *', async () => { /* hourly */ });
cron.start();
```

### Connectors
```javascript
import { Connector, slack, restApi } from './core/connector.js';
await restApi('https://api.github.com', 'ghp_...').get('/user');
await slack('https://hooks.slack.com/...').post('', { text: 'Hello!' });
```

## Observability

```javascript
import { Router, logger, metricsHandler } from './core/http.js';
import { createLogger } from './core/log.js';
import { MetricsRegistry } from './core/metrics.js';

const log = createLogger('api');
const metrics = new MetricsRegistry();

const router = new Router();
router.use(logger({ log, metrics })); // records http_requests_total / http_request_duration_ms
router.get('/metrics', metricsHandler(metrics)); // Prometheus text exposition format
```

`log.js`'s `createLogger(module, opts)` returns `{debug, info, warn, error}`,
each `(msg, fields) => void`, emitting structured JSON-per-line entries
(pluggable via `opts.sink`). `metrics.js`'s `MetricsRegistry` exposes
`counter(name, help)`/`gauge(name, help)`/`histogram(name, help, buckets)`,
each supporting label objects (e.g. `.inc({method: 'GET'})`), and
`render()` for the Prometheus text format. No distributed tracing — not
honestly buildable zero-dependency without an external collector;
correlation IDs threaded through `log.js` entries are the practical
middle ground.

## Portable Text

Block types: heading, paragraph, image, code, list, quote, divider, embed, table, custom
Render: toHTML(blocks), toMarkdown(blocks), toPlainText(blocks)
Parse: fromMarkdown(md)

## Query Operators

$eq $ne $gt $gte $lt $lte $in $nin $between $exists $regex $contains $containsAny $containsNone $size $len $type $finite $elemMatch $and $or $not
Dot notation: { 'address.city': 'Madrid' }

## Vector Search

VectorStore (Float32), QuantizedStore (Int8), PolarQuantizedStore (3-bit 21x), BinaryQuantizedStore (1-bit 32x)
IVF index, Matryoshka search, cross-collection search, BM25 full-text, HybridSearch

## Roles

admin: full access | editor: content + taxonomies | author: own content | viewer: read only

## Plugin Hooks

entry:{before|after}{Create|Update|Delete|Publish|Unpublish}
contentType:{before|after}{Create|Update|Delete}
taxonomy:{before|after}{Create|Update|Delete}
term:{before|after}{Create|Update|Delete}
user:{afterCreate|beforeUpdate|afterUpdate|beforeDelete|afterDelete|afterLogin}
system:{ready|shutdown}

## Plugin Capabilities

Restrict plugin access: { "capabilities": ["entries:read", "entries:write"] }
Empty = unrestricted.

## Security

3 full security audits to date, all findings remediated. Latest (2026-07): full-repo audit of
all 21 core modules (4 parallel auditors) found 65 issues (7 critical, 13 high, 28 medium,
17 low) — RCE in `code.run` (removed), SSRF across HTTP nodes/triggers/a2e/connector (fixed via
new `net-guard.js`), prototype pollution (db.js, validate.js, shell.js, workflow.js), stored XSS
in `portable-text.js`, unbounded recursion in the a2e DAG executor, plugin capability bypasses,
predictable default secrets (CMS JWT, workflow vault key, credential-vault PBKDF2 salt), plus
assorted correctness/DoS bugs (HNSW memory leak, broken cache middleware, cron reentrancy,
`parallelRace([])` hang, non-atomic writes). All fixed and verified with regression tests — see
[`specs/`](specs/) for the full reports. 2 earlier audits, 26 fixes applied.

**Follow-up (2026-07):** building `examples/content-pipeline/` as a real end-to-end exercise —
running a live server and curling it, not just unit tests — surfaced 2 more gaps the audit
missed, both fixed: the FIX-10 webhook secret was enforced in `core/triggers.js` but never wired
through `routes/workflows.js`/`WorkflowEngine.webhookTrigger`, so no webhook could authenticate
over real HTTP; and `core/shell.js` exported `AGENT_PROFILES` but never consulted it —
`new Shell({ profile: 'restricted' })` alone enforced nothing unless `permissions` was *also*
passed explicitly. `permissions` now derives from `profile` when omitted (unrecognized profiles
fail closed to `restricted`).

**Line-by-line audit (2026-07), `core/shell.js`:** a manual read of the whole command-gateway
module (parser, RBAC, batch/pipeline execution) found 2 real correctness bugs, both fixed with
regression tests: `batch [...]` used `Promise.all` directly over each command, so one handler
*throwing* (vs returning a normal error) silently discarded every sibling command's
already-succeeded result instead of isolating the failure; and the `' | '`/`' >> '`/`','` split
points used plain `indexOf`/`split` with no quote-awareness — a quoted argument containing the
literal delimiter (e.g. `--template "a | b"`) was silently mis-parsed into a broken command plus
a garbage filter, succeeding with corrupted/`undefined` output instead of erroring.

**`core/a2e.js` (2026-07, found while building `examples/a2e-pipeline`):** 2 real correctness bugs
in `WorkflowExecutor`, both fixed with regression tests: `Loop` with sub-operations threw a
`ReferenceError` on its very first item (a `depth` variable referenced outside its own scope —
zero prior test coverage caught it); and `Conditional` always executed **both** branches, with the
taken one running **twice** (`execute()`'s DAG-level loop blanket-dispatched every declared
operation regardless of which branch was chosen, on top of `Conditional`'s own dynamic dispatch of
the taken one). For a branch with a real side effect (an API call, a payment) this meant unintended
executions, not a cosmetic mismatch.

**`core/portable-text.js` (2026-07, verified while building `examples/content-formats`):** no bug
found, but confirmed *live* rather than assumed — the 2026-07 audit's stored-XSS fix in the
built-in HTML renderers is still intact (`<script>` typed as plain text renders as
`&lt;script&gt;`). Also documented a real API contract clarification: `toHTML`'s `customRenderers`
escape hatch does **not** auto-escape — an intentionally unsafe custom renderer let a `<script>`
tag through raw in testing, confirming that escaping a custom renderer's own interpolated values is
the implementer's own responsibility, same as inside `core/portable-text.js` itself.

**`core/validate.js` (2026-07, found while building `examples/api-validation`):** not a bug — it does
what it's documented to do — but a real footgun confirmed live: `validate()` applies a schema's
**function** defaults (e.g. `createdAt: () => new Date().toISOString()`) on every call,
`opts.partial: true` included, for any field missing from the input. A naive partial-update handler
that merges the whole validated result back onto an existing record silently regenerates such fields
on every update the caller never mentioned them in.

**`core/http.js` (2026-07, found while building `examples/api-gateway`):** `rateLimit()` computed
`X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` for an **allowed** request, but
`Router`'s post-processing only ever merged CORS headers (`_applyCors`) into the final response —
nothing did the equivalent for rate-limit headers, so a successful request under the limit carried
none; only the 429-blocked path (built separately, inline) ever had real ones. Fixed by adding
`_applyRateLimit()`, mirroring the exact `_applyCors` pattern, verified live before and after
(including through a mounted sub-router).

**`core/parallel.js` (2026-07, confirmed while building `examples/resilient-notify`):** not a bug —
`parallel.js`'s own doc comments already say JS cannot truly cancel an in-flight promise — but a
real, easy-to-miss consequence confirmed live: `parallelRace` doesn't stop the "losing" tasks, so
for anything with a side effect (an HTTP POST to a notification channel, not a read-only lookup), a
losing task that finishes in time still fully executes — two channels with similar latency can
**both** deliver the same message, not just the one whose result the caller sees.

**`examples/scheduled-sync` flaky-test root cause (2026-07):** not a bug in `core/cms.js` —
`EntryService.findAll()` defaulting to `createdAt` DESCENDING when no sort is specified is
documented behavior — but a real ordering bug in the example's own `runSync()`: it called
`findAll()` with no explicit sort, then re-sorted client-side by `updatedAt` ascending. That
re-sort was a silent no-op whenever `updatedAt` ties between entries created in the same
millisecond (~85% of the time at in-memory speed), leaving `findAll()`'s descending order in
place uncorrected. Reproduced live end-to-end (~10% of runs synced entries out of order); fixed
by requesting `sortBy`/`sortOrder` directly from `findAll()` instead of re-sorting after the fact.

**`core/shell.js` (2026-07, found while building `examples/shell-mcp`):** `--confirm` was
advertised by `help()` (and `shell_exec`'s own MCP tool description) as "Preview before
execute," but the flag was parsed into `cmd.flags.confirm` and never checked anywhere in
`_execSingle` — a command carrying `--confirm` executed for real, immediately, identical to
not passing it. Verified live: deleting a record "with confirm" deleted it for real. For a
destructive command this meant an agent (or a human) trusting the shell's own documented
protocol would get a real side effect instead of a preview. Fixed by mirroring the existing
`--dry-run` branch: `--confirm` now returns a preview (`mode: "confirm"`,
`requiresConfirmation: true`) without running the handler; re-issuing the same command without
`--confirm` executes it for real — verified end-to-end through the real `shell-mcp` MCP server.

**`core/triggers.js` (2026-07, found while building `examples/trigger-hub`):** 2 real bugs, both
fixed with regression tests. `list()` never surfaced a poll trigger's circuit-breaker error
state — only a **private** `_pollerErrors` map recorded it (confirmed by the module's own unit
tests reaching into it directly), so a dead poller kept showing as an ordinary, still-running
registration; `list()` now merges in `pollerStatus`/`pollerError` for poll rows. `_pollOnce`
never checked `res.ok` — an HTTP error (503) with a valid JSON body parsed fine and fell into
the "success" path, firing the trigger with the error body as its payload and **resetting** the
consecutive-failure counter instead of incrementing it, so the circuit-breaker never tripped on
real HTTP errors, only network-level failures. Both verified live over a real HTTP round trip,
before and after. Also documented (not a bug): `register()` calls net-guard's `assertPublicUrl`
unconditionally for poll triggers, no opt-out unlike `connector.js`'s `blockInternalHosts` — a
poll trigger cannot target `localhost` at all, confirmed live.

**`core/workflow.js` (2026-07, found while building `examples/mcp-workflows`):** `Collection.insert(doc)`
clones the input and returns the clone with `_id` assigned — it does not mutate the object passed
in. `WorkflowEngine.execute()` called `this._executions.insert(execution)` and discarded the
return value, then returned the original `execution` local, which never got an `_id`. Any caller
using `run()`'s return value to later fetch the same execution via `getExecution(id)` got
`undefined` for the id — `getExecution()` only ever worked for executions already known through
`getExecutions()`. `core/cms.js`'s `EntryService.create()` already captures `insert()`'s return
value correctly; `workflow.js` just didn't follow its own codebase's existing pattern. Fixed with
a 2-line change: capture `insert()`'s return value and assign `_id` onto `execution` before
returning it. Verified live before/after through a real MCP server.

**`core/plugins.js` (2026-07, extended while building `examples/plugin-workflow-nodes`):** not a
bug — `createPluginAPI` had no way at all for a plugin to reach `workflow.js`'s `NodeRegistry`, a
missing capability, not broken behavior. Added a new `nodes:register` capability (gated exactly
like the existing `database:write`; threaded through `loadPlugins()`/`createApp()`
automatically) with explicit approval. Designing it surfaced a real security gap, verified live
before adding a guard: `NodeRegistry.add()` itself silently lets any caller overwrite an existing
node type — including `http.request`, replacing its net-guard SSRF check — for every workflow in
the system, not just the caller's own. The new capability's `api.nodes.register()` wrapper
rejects overwriting an existing type (built-in or registered by another plugin); a second plugin
in the example demonstrates the rejection live.

**`examples/hybrid-recall` premise correction (2026-07):** not a core bug — a caught-before-
shipping flaw in this example's own original design. The plan was "keyword recall first, vector
search as a semantic fallback for paraphrases." Verified empirically before writing the example:
the offline hashing-trick embedding shared with `examples/vector-memory` has no synonym
understanding, and a genuine paraphrase query ranked an unrelated stored doc above the real
match. Rebuilt around the honestly-verified value instead — `memory.recall()` hard-empties on
zero shared vocabulary, `vector.search()` never does — coverage, not intelligence. A first-pass
`lowConfidence` threshold (0.3) was also verified live to mislabel a clearly unrelated query as
confident (score 0.429); corrected to 0.5 against a 10-query empirical sample and documented as
approximate, not a statistical guarantee.

**`examples/poll-to-queue` bridge-logic gotcha (2026-07):** not a core bug — `TriggerManager`'s
poll never firing `onTrigger` on its first cycle (it only establishes the baseline hash) is
documented, intentional behavior. But it's a real footgun for exactly the pattern this example
builds: without an explicit baseline fetch before the poll trigger starts, the first real fire
would hand the whole current item list to a fresh, empty `seenIds` set, making every pre-existing
feed item look "new" and get (re)enqueued. Verified live, then fixed entirely in the example's
own bridge logic (`hub.js`) by seeding `seenIds` from an initial fetch first — same cursor
philosophy `examples/scheduled-sync` already uses for outbound sync, applied here to inbound
polling.

**`core/a2e.js` found while building `examples/a2e-vault-api` (2026-07):** not a core bug —
existing, documented behavior of `execute()`'s DAG-level dispatch. But a real, verified footgun:
when a custom operation handler throws, `execute()` does NOT stop subsequent DAG levels (unlike
`workflow.js`'s `execute()`, which does unless `continueOnError`). The failed op's default
`outputPath` never gets written, so a downstream `Conditional` reading it silently resolves to
`undefined` — which evaluated to `false` and routed a failed API lookup into the exact same
branch as a genuine negative result, indistinguishable without inspecting `errors`. Verified live
before and after; fixed entirely at the example level (not core) using `onError`, an existing
`a2e.js` mechanism, to write an explicit failure marker instead of leaving the state undefined.
Also documented: `WorkflowExecutor.execute()` takes no per-call input at all, unlike
`workflow.js`'s `execute(id, triggerData)`.

**`core/a2e.js` found while building `examples/a2e-background` (2026-07):** real core bug, same
class as the earlier `Conditional`-runs-both-branches fix (that fix's own plan explicitly
flagged this Loop case as a known, deliberately-deferred limitation). A `Loop`'s
sub-operations were dispatched TWICE: once spuriously at the top level (`state.loop === {}`,
before the loop even starts — `buildDAG()` models no dependency edge for Loop sub-ops, unlike
it does for `Conditional` branches), once correctly per iteration. Every prior `Loop` test used
a handler that silently tolerates garbage input, so this went undetected — surfaced by a
realistic handler that throws on unexpected input, verified live: called 3 times for a 2-item
loop, not 2. Fixed with explicit approval via Plan Mode (touches `execute()`'s core dispatch
logic) with `loopSubOperationTargets()`, mirroring `conditionalBranchTargets()` exactly;
hand-traced against all 4 pre-existing `Loop` tests (none broke) and covered by 3 new
regression tests using throwing handlers. Also found (not a core bug, handled at the example
level): a single `WorkflowExecutor` instance is unsafe for concurrent `execute()` calls —
verified live that two concurrent runs sharing one instance corrupt each other's results;
fixed by constructing a fresh executor per job.

**`core/hnsw.js` found while building `examples/agent-memory-hnsw` (2026-07):** real, severe
core bug. `_selectNeighbors`/`_pruneNeighbors` used the naive "M closest by raw distance"
heuristic — a well-documented HNSW weak point: with many duplicate/near-duplicate vectors
(common in real memory content), they monopolize every neighbor slot around them, fragmenting
the graph. Verified live with a controlled A/B: recall vs. a brute-force exact scan collapsed
from `1.0` (no duplication) to `0.0` with just 2x exact-duplicate vectors, and stayed at `0.0`
at ~9x duplication (5000 entries) — a near-total collapse, not gradual degradation.
`examples/large-catalog-search` never hit this because its synthetic catalog embeds a unique
index number inside every product's text, avoiding exact duplicates by construction. Fixed with
explicit approval via Plan Mode (algorithmic change) implementing the original HNSW paper's
diversity-aware neighbor selection (`SELECT-NEIGHBORS-HEURISTIC`) — a candidate is only kept if
it's closer to the query than to every already-selected neighbor. Verified live: 2x duplication
recovered to `0.8-1.0` recall, ~9x recovered to `0.6` with the top result now exactly matching
the true best score (previously it found a measurably worse cluster entirely). The pre-existing
`hnsw.test.js` recall test (threshold ≥0.7) improved to `1.000` with the fix — it only helps the
non-duplicate case too.

**`examples/validated-webhooks` architectural finding (2026-07):** not a core bug —
`createApp()`'s bundled `/api/workflows` webhook route working as designed, with no validation
of its own, is documented, intentional behavior. But a real gotcha, verified live with a
throwaway script: bolting a schema-validated route on top while still using `createApp()` leaves
the original, unvalidated route fully reachable and bypasses validation entirely — a garbage
payload the validated route rejects with `400` sailed through the built-in route with a real
`200`, actually executing the workflow. Handled by not calling `createApp()` at all for this
example (same à la carte spirit as `examples/doc-store-analytics`), so the validated route is the
only webhook route that exists.

**`examples/content-render-workflow` caveat (2026-07):** not a bug — `toHTML()` still escapes
correctly (confirmed intact), and `toPlainText()` correctly does NOT HTML-escape, since it's
plain text. But verified live through a real workflow: a downstream node that interpolates
`{{render.excerpt}}` (derived from `toPlainText()`) carries an inline `<script>` tag through
completely unescaped — a real consequence worth knowing for this specific combination, since
embedding that value into an HTML context downstream (an HTML email, a rendered page) without
escaping it yourself would reopen the exact XSS surface the 2026-07 audit closed for `toHTML()`.

**`examples/hybrid-catalog-search` design detail (2026-07):** not a bug — `core/db.js`'s `$group`
stage never claimed to preserve input order, and it doesn't. Worth documenting because it matters
specifically for this combination: after using a real `$lookup`/`$group` join to enrich
vector-ranked results with relational sales data, the join's own output order does not match the
vector search's ranking — verified live and handled correctly by explicitly re-sorting the joined
results back into the original semantic rank order, since that ranking is the entire point of
doing the hybrid search in the first place. `hybridSearch()`'s results verified to match
`semanticSearch()`'s ids/order/scores exactly.

**`examples/rate-limited-queue` design detail (2026-07):** not a bug — `rateLimit()` counts
requests per key in a time window and has no notion of a queue; `JobQueue` has no notion of HTTP
at all. Worth documenting because it matters specifically for this combination: intake protection
is a property of how the router is wired (the limiter guards the one endpoint that calls
`enqueue()`), not something either module enforces on its own — a second, unguarded endpoint
calling `enqueue()` for the same job type would bypass it entirely, and nothing in `core/queue.js`
would catch that. Verified live: a burst of 4 requests against `max: 3` returns 3x 202 + one 429,
with queue stats confirming exactly 3 jobs ever ran.

**`cms.js` found while building `examples/cms-semantic-search` (2026-07):** real core bug —
`new CMS()` crashed on any restart against already-persisted `FileStorageAdapter` data, throwing
`Index already exists on field: slug` before the server could even start. Root cause:
`Collection._ensureLoaded()` restores persisted index definitions from disk *before* `CMS`'s
constructor runs its own `createIndex()` calls for the same fields, so every restart against
existing data collided with the index just restored. Not a novel flaw — `core/credentials.js`,
`core/memory.js`, and `core/workflow.js` already guard their own constructor's `createIndex()`
calls with try/catch for exactly this reason; `core/cms.js` was the one module that never got the
same treatment, meaning every example using `createApp()` + `FileStorageAdapter` had never
actually been able to survive a real process restart — undetected because every prior
live-verification pass in this project wiped `data/` between runs instead of restarting against
existing data. Fixed with a 7-line change mirroring the existing pattern, verified live
before/after with a real restart.

**`examples/validated-workflow-nodes` finding (2026-07):** not a core bug — `core/nodes.js`'s
`inputs` array was never meant to be enforced, it's documentation for ARDF export, and
`NodeRegistry.execute()` calling the handler directly with no check is existing, correct behavior.
But a real, worth-knowing consequence, verified live: without a `core/validate.js` schema gating
the node, a naive handler doesn't crash on bad data — it silently proceeds with it. A `>100%`
discount (a perfectly valid trigger payload by itself) produced a negative charge amount that an
unvalidated node "successfully" charged — an unnoticed refund, not a visible failure. The validated
version of the same node blocked it with `"Validation failed: amount must be >= 0.01"` before any
charge logic ran.

**`examples/mcp-job-queue` design detail (2026-07):** not a bug — `core/mcp.js`'s `tools/call`
deliberately replaces any *thrown* tool-handler error with a generic, internals-hiding message,
logging the real reason server-side only, confirmed by reading the code. Worth documenting because
it shapes how a tool should be written: `job_status`'s "job not found" is an expected, actionable
outcome, not a server fault, so it's designed to return `{ found: false }` as ordinary data instead
of throwing — the agent gets a real, useful answer instead of an opaque failure. A genuinely
missing required argument is a different path entirely (`tools/call`'s own `inputSchema`
validation, checked before the handler runs) and does come back with the real, specific reason —
verified live: `"Invalid arguments: jobId is required"`.

**`examples/queue-access-control` design detail (2026-07):** not a bug — `core/queue.js` never
claimed to have any notion of a caller, and `core/shell.js`'s built-in `AGENT_PROFILES` are generic
on purpose. Worth documenting because it matters specifically for this combination:
`AGENT_PROFILES.reader`'s wildcard verbs (`list`/`get`/`search`/`describe`/`count`/`status`) don't
happen to include `stats` — verified live, even `reader` gets `Permission denied` for
`queue:stats`, and `operator`'s wildcards (`list`/`get`/`create`/`update`/`delete`/`run`) don't
cover it either. No built-in profile expresses "can enqueue and monitor this one namespace, but not
its destructive ops" — this example builds an explicit custom `permissions` array for that role
instead, exactly the override `core/shell.js` documents `profile` as losing to.

**`examples/vault-access-control` design detail (2026-07):** not a bug — `core/credentials.js`
never claimed to enforce access control; `vault.get(name)` returning the fully decrypted secret to
any code holding a reference is documented, intentional behavior, and `list()` withholding
decrypted values is a return-shape choice, not access control. Worth documenting because it's
genuinely security-relevant: every guarantee this example makes (an `integration-runner` role can
*use* a secret via `vault:use` but never see it) is enforced entirely by which `Shell` instance a
caller is routed to and which verbs its permission list happens to cover. Verified live: `vault:use`'s
response never contains the raw secret string even though it decrypted the credential server-side
to confirm it's usable; `vault:reveal` (admin-only by construction) is the only command that ever
returns one.

**`db.js` found while building `examples/trigger-driven-a2e` (2026-07):** real core bug, low
severity. `Auth.init()` already guards its 3 `createIndex()` calls with `try {} catch {}` (same
pattern as `credentials.js`/`memory.js`/`workflow.js`), so a restart against already-persisted data
never crashes — but it logged the whole caught `Error` object, not `err.message`, which Bun renders
with a full stack trace and source-code snippet on stderr on every single normal restart, reading
like a crash when it isn't. Fixed to log `err.message` only, verified live with a real
`FileStorageAdapter` restart before/after.

**`examples/trigger-driven-a2e` finding (2026-07):** not a new core bug — the same
DAG-dispatch-doesn't-stop-on-failure behavior already documented for `examples/a2e-vault-api`,
reproduced in a different domain. A custom op throwing on bad data left its output undefined; the
downstream `Conditional` read that as `false` and silently picked the exact same branch as a
genuine negative classification. Verified live before the fix: a payload with no email came back
routed to "personal" with no visible sign anything failed except a buried `errors` field. Fixed
entirely at the example level (not core), matching `a2e-vault-api`'s own precedent — the bridge now
stores an explicit `decision: null` / `status: "failed"` instead of trusting a Conditional computed
from a failed op's undefined output.

**`a2e.js` concurrent `execute()` fixed properly in core (2026-07-31):** closes the gap first
documented while building `examples/a2e-background` (above) — `WorkflowExecutor.state`/`.results`/
`.errors` lived on `this`, so two `execute()` calls on the same instance running concurrently
corrupted each other's results; the only fix at the time was a per-job workaround (construct a
fresh executor). Moved `state`/`results`/`errors` into a context object local to each `execute()`
call, threaded through `_executeOp`/`_executeLoop`; public API (`constructor`/`load`/`execute`/
`registerHandler`) is unchanged, and `executor.state`/`.results`/`.errors` are preserved as an
informational snapshot of the last completed run (needed by `examples/a2e-pipeline`), written once
at the end, never during execution. 2 new regression tests verified against the old code (both fail
with corrupted/cross-contaminated results) and the fix (both pass); full suite green twice after.
The fresh-executor-per-job pattern in `a2e-background`/`trigger-driven-a2e` is no longer required,
though it remains valid.

**`http.js` found while building `core/log.js`/`core/metrics.js` (2026-08-01):** real bug, previously
untested. `logger()` measured request duration via `await next()`, but global middleware (registered
via `router.use(...)`) runs through `_runMiddleware`, whose `next()` is a no-op continuation signal —
routing happens separately, afterward, only if no middleware short-circuited with a Response. So
`next()` could never observe the real route's duration. Verified live: a route that genuinely took
200ms was logged as `"0.0ms"`, every time, regardless of actual duration, for every request in any
app using `opts.logger` in `createApp()` or `examples/api-gateway`. Fixed by stashing the start time
on `ctx.state` when `logger()` runs, read back by `Router.handle()` once the real `response` is known
(after routing/CORS/rate-limit) — no restructuring of the middleware chain, verified before/after with
a controlled-delay route. `logger()` now optionally emits structured entries via `core/log.js` and
records `http_requests_total`/`http_request_duration_ms` into a `core/metrics.js` `MetricsRegistry`.
A double-counting bug in `metrics.js`'s own histogram `render()` (bucket counts are already cumulative
from `observe()`, don't re-accumulate) was also caught and fixed during verification.

Current posture:
- JWT auth with PBKDF2-SHA256 password hashing (Web Crypto), random per-instance secret unless configured explicitly
- AES-256-GCM encryption (database-level and field-level) with random per-installation PBKDF2 salts
- Timing-safe password comparison (byte-level XOR)
- Credential vault with encrypted storage, random per-installation PBKDF2 salt
- SSRF guard (`net-guard.js`) on outbound fetches driven by workflow/trigger definitions, plus a real, enforced HTTP header for webhook secrets
- RBAC: 4 roles (CMS, with `:own`-scope enforcement) + 4 agent profiles (Shell, fail-closed default, `profile` alone now actually restricts)
- Plugin capability manifest, gated `database`/collection access, path-traversal guard on local plugin loading
- ReDoS guards on user-supplied `$regex`/pattern input (db.js, vector.js, a2e.js)
- Session auto-cleanup
- Webhook HMAC-SHA256 signing + optional per-webhook secret
- Rate limiting in triggers
