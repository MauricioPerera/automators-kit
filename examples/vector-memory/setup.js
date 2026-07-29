/**
 * Vector Memory — semantic search for a personal assistant, HTTP/shell demo.
 *
 *   bun examples/vector-memory/setup.js
 *
 * core/vector.js's VectorStore does real cosine-similarity ranking over
 * embeddings YOU provide (it never calls any embedding API itself) — see
 * embed.js for the zero-dependency local embedding used here, and README.md
 * for how to swap in a real one. Different tool than
 * examples/agent-memory-backend (core/memory.js): that one is keyword
 * recall with no vectors; this one is actual vector search.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { VectorStore } from '../../core/vector.js';
import { buildVectorTools } from './tools.js';

const PORT = +(process.env.PORT || 3004);
const CMS_DB_PATH = process.env.DB_PATH || './examples/vector-memory/data/cms';
const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || './examples/vector-memory/data/vectors';

const app = await createApp({
  adapter: new FileStorageAdapter(CMS_DB_PATH),
  secret: process.env.JWT_SECRET || 'vector-memory-demo-secret',
  logger: true,
});

// VectorStore manages its own on-disk format (separate from the CMS's
// DocStore) — a plain directory path is enough, it builds its own adapter.
const store = new VectorStore(VECTOR_DB_PATH, 64);
const tools = buildVectorTools(store);

app.shell.registry.register('notes', 'index', {
  description: 'Embed and store a note for later semantic search',
  params: [
    { name: 'text', type: 'string', required: true },
    { name: 'tag', type: 'string' },
  ],
}, async (args) => tools.index(args));

app.shell.registry.register('notes', 'search', {
  description: 'Semantic search: find notes similar in meaning to the query',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'limit', type: 'number' },
    { name: 'tag', type: 'string' },
  ],
}, async (args) => tools.search({ query: args.query || args._0, limit: args.limit, tag: args.tag }));

app.shell.registry.register('notes', 'forget', {
  description: 'Remove a note by id',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.forget({ id: args.id || args._0 }));

app.shell.registry.register('notes', 'stats', {
  description: 'How many notes are indexed',
}, async () => tools.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Vector memory demo running at http://localhost:${PORT}
  commands: notes:index, notes:search, notes:forget, notes:stats

POST /api/shell/exec { "cmd": "notes:search --query \\"...\\"" }
See examples/vector-memory/README.md for the curl walkthrough.
`);
