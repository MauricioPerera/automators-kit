/**
 * Agent Memory HNSW — HTTP/shell demo.
 *
 *   bun examples/agent-memory-hnsw/setup.js
 *
 * Combines core/memory.js's AgentMemory with core/hnsw.js's standalone
 * HNSWIndex: as an agent's memory grows, index the SAME real memory
 * content (not synthetic product data, unlike examples/large-catalog-search)
 * into HNSW too, and compare 3 recall strategies over it: memory.js's own
 * keyword recall, HNSW approximate semantic search, and a brute-force
 * exact cosine scan (the ANN recall-quality ground truth). Different
 * angle than examples/hybrid-recall (linear core/vector.js VectorStore,
 * keyword-first/vector-fallback) — this is about what happens to a
 * FLAT/linear scan as memory genuinely scales up.
 *
 * Memory size is configurable (MEMORY_SIZE env var, default 5000 — big
 * enough to show a real timing gap; the regression test uses a much
 * smaller one for speed). Same zero-dependency offline hashing-trick
 * embedding as examples/vector-memory (no API key, deterministic).
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { AgentMemory } from '../../core/memory.js';
import { HNSWIndex } from '../../core/hnsw.js';
import { generateEpisodes } from './episodes.js';
import { buildHnswMemoryTools } from './tools.js';

const PORT = +(process.env.PORT || 3025);
const DB_PATH = process.env.DB_PATH || './examples/agent-memory-hnsw/data';
const MEMORY_SIZE = +(process.env.MEMORY_SIZE || 5000);
const AGENT_ID = process.env.AGENT_ID || 'ops-bot';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'agent-memory-hnsw-demo-secret',
  logger: true,
});

const memory = new AgentMemory(app.cms.db, { agentId: AGENT_ID });
const hnsw = new HNSWIndex({ m: 16, efConstruction: 100, efSearch: 40 });
const tools = buildHnswMemoryTools(memory, hnsw, app.cms.db, AGENT_ID);

console.log(`Seeding ${MEMORY_SIZE} synthetic troubleshooting memories...`);
const buildStart = performance.now();
tools.seed(generateEpisodes(MEMORY_SIZE));
console.log(`Indexed in ${Math.round(performance.now() - buildStart)}ms.`);

app.shell.registry.register('memory', 'learn', {
  description: 'Store a memory entry, indexed in both AgentMemory and HNSWIndex',
  params: [{ name: 'title', type: 'string', required: true }, { name: 'text', type: 'string', required: true }],
}, async (args) => tools.learn(args.title, args.text));

app.shell.registry.register('memory', 'recall-semantic', {
  description: 'Approximate nearest-neighbor recall via HNSWIndex (fast)',
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.recallSemantic(args.query || args._0, args.k || 5));

app.shell.registry.register('memory', 'recall-exact', {
  description: 'Brute-force exact cosine scan over every indexed vector (slow, ground truth)',
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.recallExact(args.query || args._0, args.k || 5));

app.shell.registry.register('memory', 'recall-keyword', {
  description: "memory.js's own keyword recall (no vectors)",
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.recallKeyword(args.query || args._0, args.k || 5));

app.shell.registry.register('memory', 'benchmark', {
  description: 'Run all 3 recall strategies for the same query, report timing + recall',
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.benchmark(args.query || args._0, args.k || 5));

app.shell.registry.register('memory', 'stats', { description: 'Memory + index stats' }, async () => tools.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Agent memory HNSW demo running at http://localhost:${PORT}
  commands: memory:learn, memory:recall-semantic, memory:recall-exact,
            memory:recall-keyword, memory:benchmark, memory:stats

Try:
  POST /api/shell/exec {"cmd":"memory:benchmark --query \\"database connection timeout\\""}
  POST /api/shell/exec {"cmd":"memory:stats"}
See examples/agent-memory-hnsw/README.md for the full walkthrough.
`);
