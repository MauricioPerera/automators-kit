# Automators Kit

**Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.**

404 tests | 0 deps | 18K lines | 19 modules | Bun + Deno + Node.js

By [automators.work](https://automators.work)

## What it is

A full-stack automation toolkit in vanilla JavaScript with zero npm dependencies. 19 core modules covering: document database, vector search (HNSW), HTTP router, CMS, n8n-style workflow engine, A2E executor, agent shell (command gateway), job queue, cron scheduler, agent memory, and more.

Born from merging and distilling ideas from 10+ repos (lokiCMS, js-doc-store, js-vector-store, a2e, minimemory, Agent-Shell, php-agent-memory, EasyDB, RepoMemory, EmDash, ATDF) into a single portable project.

## Install

```bash
git clone https://github.com/MauricioPerera/automators-kit.git
cd automators-kit
bun seed.js        # create admin + default content types
bun server-bun.js  # start at http://localhost:3000
```

No `npm install`. Zero dependencies.

## 19 Core Modules

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
| **workflow.js** | Workflow engine: n8n-style nodes, triggers, credentials, execution history |
| **nodes.js** | Node registry: 20 built-in nodes (core, communication, data, AI) + ARDF export |
| **triggers.js** | Trigger system: manual, webhook, cron, polling with change detection |
| **credentials.js** | Credential vault: AES-256-GCM encrypted API keys and tokens |
| **shell.js** | Agent shell: command gateway, 2 MCP tools (~600 constant tokens), pipeline, JQ filter, RBAC |
| **queue.js** | Job queue: async processing, retries with exponential backoff, dead letter |
| **cron.js** | Cron scheduler: 5-field expressions, enable/disable, manual run |
| **connector.js** | HTTP client: auth presets (bearer/basic/apikey), retries, timeout |
| **memory.js** | Agent memory: semantic + episodic + working, scoping, dedup, dream cycle, correction boost |

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

## Testing

```bash
bun test tests/    # 404 tests, 0 failures, ~8 seconds
```

19 test files covering all core modules:

| Category | Files | Tests |
|----------|-------|-------|
| Database + Auth | db.test.js | 38 |
| Vector Search | vector.test.js, hnsw.test.js | 31 |
| HTTP + Validation | http.test.js, validate.test.js | 29 |
| CMS + Plugins | cms.test.js, plugins.test.js | 33 |
| A2E + Workflow | a2e.test.js, workflow.test.js | 63 |
| Shell + Nodes | shell.test.js, nodes.test.js | 63 |
| Memory | memory.test.js | 29 |
| Infrastructure | cron.test.js, queue.test.js, connector.test.js, credentials.test.js, triggers.test.js, portable-text.test.js | 84 |
| Integration | integration.test.js | 29 |
| **Total** | **19 files** | **404** |

## Multi-runtime

```bash
bun server-bun.js      # Bun (fastest)
node server-node.js    # Node.js 20+
deno run --allow-net --allow-read --allow-write --allow-env server-deno.js
```

## Security

- 2 full security audits, 26 fixes applied
- Timing-safe password comparison (byte-level XOR)
- AES-256-GCM encryption (database, field-level, credential vault)
- JWT auth via Web Crypto API (PBKDF2 + HMAC-SHA256)
- RBAC: 4 CMS roles + 4 agent profiles
- Plugin capability manifest
- Content size limits, bounded queries
- HMAC-SHA256 webhook signing
- code.run keyword blocklist

## Documentation

See [AGENTS.md](AGENTS.md) for complete API reference, all endpoints, and AI agent integration guide.

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera) / [automators.work](https://automators.work)
