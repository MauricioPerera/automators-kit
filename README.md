# Automators Kit

**Zero-dependency hackeable toolkit: CMS + automation engine + A2E workflows + agent memory.**

189 tests | 0 deps | 13.6K lines | Bun + Deno + Node.js

## What it is

Automators Kit is a full-stack toolkit in vanilla JavaScript with zero npm dependencies. It combines a document database, vector search, HTTP router, CMS, workflow executor, job queue, cron scheduler, and agent memory system in a single portable project.

## Install

```bash
git clone https://github.com/MauricioPerera/automators-kit.git
cd automators-kit
bun seed.js        # create admin user + default content types
bun server-bun.js  # start server at http://localhost:3000
```

No `npm install` needed. Zero dependencies.

## Core Modules (14)

| Module | What it does |
|--------|-------------|
| **db.js** | Document database: MongoDB-style queries, indices, JWT auth, AES-256-GCM encryption |
| **vector.js** | Vector database: Float32/Int8/Polar/Binary quantization, IVF, Matryoshka, BM25 |
| **hnsw.js** | HNSW index: O(log n) approximate nearest neighbor search |
| **http.js** | HTTP router: Web Standard Request/Response, middleware, params, CORS |
| **validate.js** | Schema validation: types, formats, defaults (replaces Zod) |
| **cms.js** | CMS services: content types, entries, taxonomies, terms, users, roles |
| **plugins.js** | Plugin system: hooks, capability-based access, registry |
| **portable-text.js** | Structured rich content: JSON blocks to HTML/Markdown/PlainText |
| **mcp.js** | MCP server: JSON-RPC 2.0 over stdio, 20 tools for AI agents |
| **a2e.js** | A2E workflow executor: 19 operations, DAG parallel execution |
| **queue.js** | Job queue: async processing, retries, backoff, dead letter |
| **cron.js** | Cron scheduler: 5-field expressions, enable/disable, manual run |
| **connector.js** | HTTP client: auth presets, retries, timeout (Slack/Discord/REST) |
| **memory.js** | Agent memory: semantic + episodic + working memory with recall |

## Usage

### As a CMS

```bash
bun seed.js
bun server-bun.js
# POST /api/auth/login, GET /api/entries, POST /api/entries, etc.
```

### As a framework

```javascript
import { DocStore, Router, VectorStore, Auth, validate } from './index.js';
// Build whatever you want
```

### As an MCP server (for AI agents)

```json
{
  "mcpServers": {
    "automators-kit": {
      "command": "bun",
      "args": ["mcp.js"],
      "cwd": "/path/to/automators-kit"
    }
  }
}
```

### As a CLI

```bash
bun cli.js entries list --type post
bun cli.js entries create --type post --title "Hello" --json '{"body":"World"}'
bun cli.js structure
```

### As a workflow engine (A2E)

```javascript
import { WorkflowExecutor } from './core/a2e.js';
const ex = new WorkflowExecutor();
ex.load({
  operations: [
    { id: "data", op: "SetData", value: [1, 2, 3, 4, 5] },
    { id: "sum", op: "Calculate", inputPath: "/workflow/data", operation: "sum" },
  ],
  execute: "data",
});
const result = await ex.execute();
// result.results.sum === 15
```

## Multi-runtime

```bash
bun server-bun.js     # Bun (primary, fastest)
node server-node.js   # Node.js 20+
deno run --allow-net --allow-read --allow-write --allow-env server-deno.js  # Deno
```

## Documentation

See [AGENTS.md](AGENTS.md) for complete API reference, examples, and AI agent integration guide.

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera) / [automators.work](https://automators.work)
