# AGENTS.md - Automators Kit

Zero-dependency hackeable toolkit: CMS + automation engine + A2E workflow executor + agent memory.
By automators.work | 189 tests | 0 deps | 13.6K lines

## Architecture

```
Core (14 modules, zero deps, vanilla JS, multi-runtime: Bun/Deno/Node.js)

db.js              Document DB: MongoDB queries, indices, auth (JWT), encryption (AES-256-GCM)
vector.js          Vector DB: Float32/Int8/Polar3bit/Binary, IVF, Matryoshka, BM25
hnsw.js            HNSW index: O(log n) approximate nearest neighbor search
http.js            HTTP router: Request/Response, middleware, params, sub-routers, CORS
validate.js        Schema validation: types, formats, defaults, middleware
cms.js             CMS: content types, entries, taxonomies, terms, users, roles
plugins.js         Plugins: hooks, capabilities, registry, loader
portable-text.js   Rich content: JSON blocks to HTML/Markdown/PlainText
mcp.js             MCP server: JSON-RPC 2.0 stdio, 20 tools
a2e.js             A2E executor: 19 operations, DAG parallel, middleware, onError
queue.js           Job queue: async, retries, backoff, dead letter, concurrency
cron.js            Cron scheduler: 5-field expressions, tick, enable/disable
connector.js       HTTP client: auth presets, retries, timeout (Slack/Discord/REST)
memory.js          Agent memory: semantic + episodic + working, recall with decay
```

## Quick Start

```bash
bun seed.js              # create admin + default content types
bun server-bun.js        # start API server
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
bun cli.js content-types create --name Product --slug product --fields-json '[{"name":"price","type":"number"}]'
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
- POST /api/a2e/execute - execute workflow
- POST /api/a2e/validate - validate without executing
- GET /api/a2e/operations - list 19 operations

## A2E Workflow Executor

Agent-to-Execution protocol. Agents describe WHAT, executor handles HOW.

### Compact JSON format

```json
{
  "operations": [
    { "id": "data", "op": "SetData", "value": [{"name":"Alice","age":30}] },
    { "id": "adults", "op": "FilterData", "input": "data", "conditions": [{"field":"age","operator":">=","value":18}] },
    { "id": "sorted", "op": "TransformData", "input": "adults", "transform": "sort", "field": "age" }
  ],
  "execute": "data"
}
```

### 19 Operations

API: ApiCall, ExecuteN8nWorkflow
Data: SetData, FilterData, TransformData, MergeData, StoreData
DateTime: DateTime (now/convert/calculate), GetCurrentDateTime, ConvertTimezone, DateCalculation
Text: FormatText (upper/lower/title/template/replace), ExtractText (regex)
Validation: ValidateData (email/url/number/phone/date/custom)
Math: Calculate (add/subtract/multiply/divide/sum/average/round/ceil/floor/abs/max/min)
Encoding: EncodeDecode (base64/url/html)
Flow: Conditional (if/else), Loop (iterate), Wait (delay)

### Execution model

- DAG parallel: dependency levels run via Promise.all
- Sequential fallback on cycles
- onError fallback: transparent to downstream
- Data model: /workflow/key, /store/key, /loop/current
- Middleware: AuditMiddleware, CacheMiddleware
- Custom handlers: executor.registerHandler('MyOp', fn)

```javascript
import { WorkflowExecutor } from './core/a2e.js';
const ex = new WorkflowExecutor();
ex.load({ operations: [...], execute: 'first' });
const result = await ex.execute();
```

## HNSW Index

Approximate nearest neighbor search in O(log n). Ported from minimemory (Rust).

```javascript
import { HNSWIndex } from './core/hnsw.js';

const hnsw = new HNSWIndex({ m: 16, efConstruction: 200, efSearch: 50, metric: 'cosine' });
hnsw.add('doc-1', embedding);
hnsw.add('doc-2', embedding2);

const results = hnsw.search(queryVector, 10);
// [{ id: 'doc-1', score: 0.95, distance: 0.05 }, ...]

hnsw.remove('doc-1');
hnsw.setEfSearch(100); // higher = better recall, slower
hnsw.stats(); // { count, levels, m, efSearch, entryPoint }
```

Parameters:
- m: connections per node (default 16). Higher = better recall, more memory
- efConstruction: beam width during build (default 200). Higher = better graph
- efSearch: beam width during search (default 50). Tunable at runtime
- metric: 'cosine' or 'euclidean'

## Agent Memory

Semantic + episodic + working memory for AI agents. Ported from minimemory (Rust).

```javascript
import { AgentMemory, TaskOutcome } from './core/memory.js';
import { DocStore, MemoryStorageAdapter } from './core/db.js';

const db = new DocStore(new MemoryStorageAdapter());
const mem = new AgentMemory(db);
```

### Episodic (task experiences)

```javascript
mem.learnTask({
  task: 'Implement JWT auth',
  outcome: TaskOutcome.SUCCESS,
  learnings: ['Use Web Crypto API', 'HMAC-SHA256 for signing'],
  code: 'async function sign(payload) { ... }',
  language: 'javascript',
  project: 'automators-kit',
  tags: ['auth', 'security'],
});

mem.getEpisodes('success');
mem.getProjectEpisodes('automators-kit');
```

### Semantic (knowledge)

```javascript
mem.storeSnippet({ code: '...', description: 'SHA-256 hashing', language: 'javascript' });
mem.storeApiKnowledge({ library: 'Web Crypto', function: 'subtle.sign', description: '...' });
mem.storeError({ error: 'Token expired', solution: 'Check exp claim', language: 'javascript' });
mem.storePattern({ name: 'Builder', description: 'Fluent API', language: 'javascript' });
mem.storeDoc({ title: 'HNSW Algorithm', content: '...' });
```

### Recall (search with time decay)

```javascript
mem.recall('authentication JWT');           // search all memories
mem.recallError('token expired');           // find similar errors
mem.recallSnippets('hashing', 'javascript'); // find code snippets
mem.recallExperiences('build auth system');  // find past tasks
```

Recall features:
- Keyword matching across all memory fields
- Time decay: older memories score lower (configurable rate)
- Access boost: frequently accessed memories rank higher
- Filters: type, language, project, outcome

### Working memory (ephemeral context)

```javascript
mem.setProject('automators-kit');
mem.setTask('Implement vector search');
mem.openFile('core/hnsw.js');
mem.addGoal('Pass all tests');
mem.logAction('Created HNSWIndex class');
mem.setNote('approach', 'Port from Rust minimemory');

mem.getWorkingContext();
// { currentProject, currentTask, openFiles, goals, recentActions, notes }

mem.clearWorkingMemory();
```

### Maintenance

```javascript
mem.stats();          // counts by type
mem.prune(30*24*3600*1000); // remove old low-value memories
mem.export();         // JSON dump
mem.import(data);     // restore
```

## Automation Engine

### Job Queue

```javascript
import { JobQueue } from './core/queue.js';
const queue = new JobQueue(db, { concurrency: 5, maxRetries: 3 });
queue.register('send-email', async (data) => { /* ... */ });
queue.enqueue('send-email', { to: 'a@b.com' });
queue.delay('send-email', data, 60000);
queue.start();
queue.stats(); // { pending, processing, completed, failed, dead, running }
queue.deadLetter(); // failed jobs
queue.retry(jobId);  // retry dead letter job
queue.purge();       // clean old completed
```

### Cron Scheduler

```javascript
import { CronScheduler } from './core/cron.js';
const cron = new CronScheduler();
cron.add('cleanup', '0 * * * *', async () => { /* hourly */ });
cron.add('report', '0 9 * * 1', async () => { /* Mon 9am */ });
cron.start();
cron.list();  // all jobs with stats
cron.run('cleanup'); // manual trigger
cron.toggle('report', false); // disable
```

### Connectors (HTTP client)

```javascript
import { Connector, slack, restApi, apiKey } from './core/connector.js';

const api = new Connector('https://api.example.com', {
  auth: { type: 'bearer', token: 'sk_...' },
  retries: 3, timeout: 10000,
});
await api.get('/users');
await api.post('/data', { key: 'value' });

await slack('https://hooks.slack.com/...').post('', { text: 'Hello!' });
await restApi('https://api.github.com', 'ghp_...').get('/user');
await apiKey('https://api.openai.com', 'sk-...', 'Authorization').post('/v1/chat/completions', body);
```

### Webhooks (plugin)

- POST /api/plugins/webhooks - register outbound webhook
- GET /api/plugins/webhooks - list
- POST /api/plugins/webhooks/in/:name - receive inbound
- GET /api/plugins/webhooks/deliveries - delivery log
- GET /api/plugins/webhooks/events - available events

Outbound: HMAC-SHA256 signed, retries with backoff, delivery tracking.
Inbound: receive POST from external services, trigger custom handlers.

### Automations (plugin)

- POST /api/plugins/automations - create workflow
- GET /api/plugins/automations - list
- GET /api/plugins/automations/templates/list - templates
- POST /api/plugins/automations/templates/:name - create from template

Templates: content-notify, lead-capture, data-sync

## Portable Text

Block types: heading, paragraph, image, code, list, quote, divider, embed, table, custom
Render: toHTML(blocks), toMarkdown(blocks), toPlainText(blocks)
Parse: fromMarkdown(md)
Helpers: extractText(blocks), findBlocks(blocks, type), wordCount(blocks), validateBlocks(blocks)

## Vector Search

VectorStore (Float32), QuantizedStore (Int8), PolarQuantizedStore (3-bit 21x), BinaryQuantizedStore (1-bit 32x)
IVF index, Matryoshka search, cross-collection search, BM25 full-text, HybridSearch, Reranker

For large datasets use HNSWIndex (core/hnsw.js) for O(log n) approximate search.

## Query Operators

$eq $ne $gt $gte $lt $lte $in $nin $between $exists $regex $contains $containsAny $containsNone $size $len $type $finite $elemMatch $and $or $not
Dot notation: { 'address.city': 'Madrid' }

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
