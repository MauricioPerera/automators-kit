# AGENTS.md - Automators Kit

Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.
By automators.work | 763 tests | 0 deps | 23 core modules

## Architecture

```
Core (23 modules, zero deps, vanilla JS, Bun/Deno/Node.js)

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
```

**Similar-sounding modules, when to reach for which:**
- `memory.js` (keyword/term recall, time decay, zero ML dependency — see `examples/agent-memory-backend/`) vs `vector.js` (real cosine-similarity over embeddings YOU provide, never calls an embedding API itself — see `examples/vector-memory/`). Default to `memory.js`; move to `vector.js` when word-overlap recall isn't good enough.
- `workflow.js` (n8n-style: named nodes wired by `{{ref}}` templates, webhook/cron/poll/manual triggers, DAG-parallel) vs `a2e.js` (smaller declarative multi-step executor: `SetData`/`FilterData`/`ApiCall`/`Conditional`/`Loop`/..., its own separate DAG + middleware). These are two independent engines, not layers. They now share the actual DAG level-scheduling algorithm (`dag.js`'s `buildLevels`, Kahn's algorithm) since it was byte-for-byte duplicated code, but each keeps its own dependency-detection convention (`{{ref}}` template scanning vs `/workflow/<opId>` + `onError` + `Conditional` branch edges) — an engine-specific improvement still doesn't automatically apply to the other.
- `mcp.js` (one MCP tool per capability, real JSON schema per tool, `tools/list` gives full discovery — context cost grows with tool count) vs `shell-mcp.js` (`shell.js`'s entire command registry through exactly 2 fixed tools, `shell_help`/`shell_exec` — constant ~600-token cost no matter the registry size; discovery happens at runtime via `shell_exec("search ...")`/`("describe ...")` instead of `tools/list`). Port of [Agent-Shell](https://github.com/MauricioPerera/Agent-Shell)'s `McpServer`; verified end-to-end against a real external MCP client (poolside.ai's `pool exec`), which correctly called help, searched, described, then executed with no schema handed to it upfront.

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
path for real.

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
