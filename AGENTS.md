# AGENTS.md - Automators Kit

Zero-dependency hackeable toolkit: CMS + workflow engine + agent shell + vector search + agent memory.
By automators.work | 263 tests | 0 deps | 16K lines | 19 core modules

## Architecture

```
Core (19 modules, zero deps, vanilla JS, Bun/Deno/Node.js)

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
workflow.js        Workflow engine: n8n-style nodes, triggers, credentials, history
nodes.js           Node registry: 20 built-in nodes (core, communication, data, AI)
triggers.js        Trigger system: manual, webhook, cron, polling with change detection
credentials.js     Credential vault: AES-256-GCM encrypted storage
shell.js           Agent shell: command gateway, parser, pipeline, JQ filter, RBAC
queue.js           Job queue: async, retries, backoff, dead letter, concurrency
cron.js            Cron scheduler: 5-field expressions, tick, enable/disable
connector.js       HTTP client: auth presets, retries, timeout (Slack/Discord/REST)
memory.js          Agent memory: semantic + episodic + working, recall with decay
```

## Quick Start

```bash
bun seed.js              # create admin + default content types
bun server-bun.js        # start API at http://localhost:3000
bun mcp.js               # start MCP server (stdio)
bun cli.js help          # CLI reference
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

### 20 Built-in Nodes

Core: http.request, code.run, set.value, filter, merge, wait, if
Communication: slack.send, discord.send, email.send
Data: json.parse, json.stringify, text.template, base64.encode, base64.decode, math.calc, datetime.now
AI: openai.chat, anthropic.chat

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

- JWT auth with PBKDF2-SHA256 password hashing (Web Crypto)
- AES-256-GCM encryption (database-level and field-level)
- Timing-safe password comparison (byte-level XOR)
- Credential vault with encrypted storage
- RBAC: 4 roles (CMS) + 4 agent profiles (Shell)
- Plugin capability manifest
- code.run keyword blocklist (process, require, eval, fetch)
- Session auto-cleanup
- Webhook HMAC-SHA256 signing
- Rate limiting in triggers
- 2 full security audits, 26 fixes applied
