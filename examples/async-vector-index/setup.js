/**
 * Async Vector Index — HTTP/shell demo.
 *
 *   bun examples/async-vector-index/setup.js
 *
 * Combines core/vector.js with core/queue.js: embedding + indexing run
 * inside a background job, off the HTTP request path — a document
 * submitted via `docs:submit` is NOT immediately searchable, only once
 * its job actually completes. Every other vector search example
 * (examples/vector-memory, examples/large-catalog-search,
 * examples/hybrid-catalog-search, examples/cms-semantic-search) indexes
 * synchronously in the same call that submits the document; this is the
 * "kick off + poll" pattern (examples/job-queue) applied to indexing
 * specifically.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { VectorStore } from '../../core/vector.js';
import { JobQueue } from '../../core/queue.js';
import { buildAsyncVectorTools, buildIndexHandler } from './tools.js';

const PORT = +(process.env.PORT || 3032);
const CMS_DB_PATH = process.env.DB_PATH || './examples/async-vector-index/data/cms';
const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || './examples/async-vector-index/data/vectors';

const app = await createApp({
  adapter: new FileStorageAdapter(CMS_DB_PATH),
  secret: process.env.JWT_SECRET || 'async-vector-index-demo-secret',
  logger: true,
});

const store = new VectorStore(VECTOR_DB_PATH, 64);
const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 2 });
queue.register('index-document', buildIndexHandler(store));
queue.start();

const tools = buildAsyncVectorTools(store, queue);

app.shell.registry.register('docs', 'submit', {
  description: 'Enqueue a document for background indexing (NOT immediately searchable)',
  params: [
    { name: 'text', type: 'string', required: true },
    { name: 'tag', type: 'string' },
  ],
}, async (args) => tools.submit(args));

app.shell.registry.register('docs', 'search', {
  description: 'Semantic search over whatever has finished indexing so far',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'limit', type: 'number' },
    { name: 'tag', type: 'string' },
  ],
}, async (args) => tools.search({ query: args.query || args._0, limit: args.limit, tag: args.tag }));

app.shell.registry.register('docs', 'job', {
  description: "Check a document's indexing job status by id",
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.jobStatus(args.id || args._0));

app.shell.registry.register('docs', 'stats', {
  description: 'Indexed document count + queue stats',
}, async () => tools.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Async vector index demo running at http://localhost:${PORT}
  commands: docs:submit, docs:search, docs:job, docs:stats

Try (search right away -- not found yet; poll docs:job, then search again):
  POST /api/shell/exec {"cmd":"docs:submit --text \\"the quick brown fox\\""}
  POST /api/shell/exec {"cmd":"docs:job --id <jobId from above>"}
  POST /api/shell/exec {"cmd":"docs:search --query \\"quick fox\\""}
See examples/async-vector-index/README.md for the full walkthrough.
`);
