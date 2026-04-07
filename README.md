# Automators Kit

**Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.**

263 tests | 0 deps | 16K lines | Bun + Deno + Node.js

By [automators.work](https://automators.work)

## What it is

A full-stack automation toolkit in vanilla JavaScript with zero npm dependencies. 19 core modules covering: document database, vector search (HNSW), HTTP router, CMS, n8n-style workflow engine, A2E executor, agent shell (command gateway), job queue, cron scheduler, agent memory, and more.

Born from merging 6 repos (lokiCMS, js-doc-store, js-vector-store, a2e, minimemory, Agent-Shell) into a single portable project.

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
| **db.js** | Document DB: MongoDB queries, indices, JWT auth, AES-256-GCM encryption |
| **vector.js** | Vector DB: Float32/Int8/Polar/Binary, IVF, Matryoshka, BM25 |
| **hnsw.js** | HNSW index: O(log n) approximate nearest neighbor search |
| **http.js** | HTTP router: Request/Response, middleware, params, CORS |
| **validate.js** | Schema validation: types, formats, defaults |
| **cms.js** | CMS: content types, entries, taxonomies, terms, users, roles |
| **plugins.js** | Plugin system: hooks, capabilities, registry |
| **portable-text.js** | Rich content: JSON blocks to HTML/Markdown/PlainText |
| **mcp.js** | MCP server: JSON-RPC 2.0 stdio, 20 tools for AI agents |
| **a2e.js** | A2E executor: 19 operations, DAG parallel, middleware |
| **workflow.js** | Workflow engine: n8n-style nodes, triggers, credentials, execution history |
| **nodes.js** | Node registry: 20 built-in nodes + custom handlers |
| **triggers.js** | Trigger system: manual, webhook, cron, polling |
| **credentials.js** | Credential vault: AES-256-GCM encrypted API keys |
| **shell.js** | Agent shell: command gateway, 2 MCP tools, ~600 constant tokens |
| **queue.js** | Job queue: async, retries, backoff, dead letter |
| **cron.js** | Cron scheduler: 5-field expressions, enable/disable |
| **connector.js** | HTTP client: auth presets, retries, timeout |
| **memory.js** | Agent memory: semantic + episodic + working, recall with decay |

## Usage

### As a CMS
```bash
bun seed.js && bun server-bun.js
# POST /api/auth/login → GET /api/entries → POST /api/entries
```

### As a workflow engine (n8n-style)
```bash
# POST /api/workflows — create workflow with nodes + triggers
# POST /api/workflows/:id/run — execute
# POST /api/workflows/webhook/:path — trigger via webhook
```

### As an agent shell (command gateway)
```bash
# POST /api/shell/exec — { cmd: "users:list --limit 10 | .[0].name" }
# GET /api/shell/help — interaction protocol (~600 tokens)
```

### As an MCP server
```json
{ "mcpServers": { "automators-kit": { "command": "bun", "args": ["mcp.js"] } } }
```

### As a CLI
```bash
bun cli.js entries list --type post
bun cli.js entries create --type post --title "Hello" --json '{"body":"World"}'
```

### As a framework
```javascript
import { DocStore, Router, VectorStore, WorkflowEngine, Shell } from './index.js';
```

## Multi-runtime

```bash
bun server-bun.js      # Bun (fastest)
node server-node.js    # Node.js 20+
deno run --allow-net --allow-read --allow-write --allow-env server-deno.js
```

## Documentation

See [AGENTS.md](AGENTS.md) for complete API reference and AI agent integration guide.

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera) / [automators.work](https://automators.work)
