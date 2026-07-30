/**
 * Hybrid Recall — HTTP/shell demo.
 *
 *   bun examples/hybrid-recall/setup.js
 *
 * Combines core/memory.js's keyword recall (examples/agent-memory-backend)
 * with core/vector.js's cosine search (examples/vector-memory) into one
 * recall() call: keyword first (fast, free, zero setup), vector search
 * only as a coverage fallback when keyword recall returns a true empty.
 *
 * IMPORTANT, verified empirically before building this (see README): the
 * offline embedding (reused from examples/vector-memory) has no notion of
 * synonyms — this is NOT a semantic paraphrase fallback. The real value is
 * coverage (vector search never hard-empties), not intelligence.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { AgentMemory } from '../../core/memory.js';
import { VectorStore } from '../../core/vector.js';
import { buildHybridRecall } from './tools.js';

const PORT = +(process.env.PORT || 3021);
const CMS_DB_PATH = process.env.DB_PATH || './examples/hybrid-recall/data/cms';
const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || './examples/hybrid-recall/data/vectors';
const AGENT_ID = process.env.AGENT_ID || 'hybrid-demo';

const app = await createApp({
  adapter: new FileStorageAdapter(CMS_DB_PATH),
  secret: process.env.JWT_SECRET || 'hybrid-recall-demo-secret',
  logger: true,
});

const memory = new AgentMemory(app.cms.db, { agentId: AGENT_ID });
const store = new VectorStore(VECTOR_DB_PATH, 64);
const hybrid = buildHybridRecall(memory, store);

app.shell.registry.register('knowledge', 'learn', {
  description: 'Store a piece of knowledge in both the keyword and vector layers',
  params: [
    { name: 'title', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
  ],
}, async (args) => hybrid.learn(args));

app.shell.registry.register('knowledge', 'recall', {
  description: 'Recall knowledge: keyword-first, vector fallback only on a true empty',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'limit', type: 'number' },
  ],
}, async (args) => hybrid.recall({ query: args.query || args._0, limit: args.limit }));

app.shell.registry.register('knowledge', 'stats', { description: 'Counts in both layers' }, async () => hybrid.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Hybrid recall demo running at http://localhost:${PORT}
  commands: knowledge:learn, knowledge:recall, knowledge:stats

Try:
  POST /api/shell/exec {"cmd":"knowledge:learn --title \\"OAuth\\" --text \\"OAuth token refresh fails after 24 hours, clock skew\\""}
  POST /api/shell/exec {"cmd":"knowledge:recall --query \\"oauth token clock skew\\""}
    -> source: keyword
  POST /api/shell/exec {"cmd":"knowledge:recall --query \\"kubernetes pod crashloop\\""}
    -> source: vector, lowConfidence: true (no stored doc is actually about this)
See examples/hybrid-recall/README.md for the full walkthrough.
`);
