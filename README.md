# Automators Kit

**Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.**

674 tests | 0 deps | 22 modules | Bun + Deno + Node.js

By [automators.work](https://automators.work)

## What it is

A full-stack automation toolkit in vanilla JavaScript with zero npm dependencies. 22 core modules covering: document database, vector search (HNSW), HTTP router, CMS, n8n-style workflow engine, A2E executor, agent shell (command gateway), job queue, cron scheduler, agent memory, and more.

Born from merging and distilling ideas from 10+ repos (lokiCMS, js-doc-store, js-vector-store, a2e, minimemory, Agent-Shell, php-agent-memory, EasyDB, RepoMemory, EmDash, ATDF) into a single portable project.

## Install

```bash
git clone https://github.com/MauricioPerera/automators-kit.git
cd automators-kit
bun seed.js        # create admin + default content types
bun server-bun.js  # start at http://localhost:3000
```

No `npm install`. Zero dependencies.

## 22 Core Modules

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
| **shell.js** | Agent shell: command gateway, 2 MCP tools (~600 constant tokens), pipeline, JQ filter, RBAC |
| **queue.js** | Job queue: async processing, retries with exponential backoff, dead letter, stuck-job lease reclaim |
| **cron.js** | Cron scheduler: 5-field expressions, enable/disable, manual run, anti-reentrancy guard |
| **connector.js** | HTTP client: auth presets (bearer/basic/apikey), retries, timeout, optional SSRF guard |
| **memory.js** | Agent memory: semantic + episodic + working, scoping, dedup, dream cycle, correction boost |
| **parallel.js** | Task orchestration: race/merge/all strategies, timeout, weighted scoring |
| **net-guard.js** | SSRF guard: blocks fetches to loopback/RFC1918/link-local/cloud-metadata destinations |

**Picking between similar-sounding modules:**
- **`memory.js` vs `vector.js`** — `memory.js`'s `recall()` is keyword/term matching with time decay, zero ML dependency, works out of the box (see [`examples/agent-memory-backend`](examples/agent-memory-backend/)). `vector.js` does real cosine-similarity search over embeddings *you* provide — it never calls an embedding API itself (see [`examples/vector-memory`](examples/vector-memory/)). Reach for `memory.js` first; reach for `vector.js` when word-overlap isn't good enough and you're willing to bring an embedding function.
- **`workflow.js` vs `a2e.js`** — two separate execution engines, not layers of one system. `workflow.js` is the n8n-style engine: named nodes wired by `{{ref}}` templates, triggered by webhook/cron/poll/manual, DAG-parallel. `a2e.js` is a smaller, declarative multi-step executor (`SetData`/`FilterData`/`ApiCall`/`Conditional`/`Loop`/...) with its own DAG and middleware, generally used standalone or from an `a2e.js`-authored node. They share the DAG level-scheduling algorithm itself (`dag.js`) since it was byte-for-byte duplicated code, but each keeps its own dependency-detection convention — an engine-specific improvement (e.g. how deps are inferred) still has to be ported to the other by hand.

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

## Testing

```bash
bun test tests/    # 674 tests across 27 files, ~7 seconds
```

27 test files covering all core modules plus the `examples/content-pipeline`,
`examples/command-gateway`, `examples/agent-memory-backend`,
`examples/vector-memory`, `examples/integrations`, and
`examples/scheduled-sync` end-to-end scenarios (includes the regression tests
added by the 2026-07 security audit
— see [Security](#security) below).

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
