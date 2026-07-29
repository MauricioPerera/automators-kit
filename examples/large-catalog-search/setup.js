/**
 * Large Catalog Search — HTTP/shell demo.
 *
 *   bun examples/large-catalog-search/setup.js
 *
 * "When does vector.js's linear scan stop being good enough?" —
 * core/hnsw.js's standalone HNSWIndex answers with real numbers: index a
 * product catalog, then compare its O(log n)-ish approximate search against
 * a brute-force exact cosine scan over the same vectors, on the same data.
 *
 * Catalog size is configurable (CATALOG_SIZE env var, default 8000 — big
 * enough to show a real timing gap; the regression test uses a much smaller
 * one for speed). Same zero-dependency offline hashing-trick embedding as
 * examples/vector-memory (no API key, deterministic).
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { HNSWIndex } from '../../core/hnsw.js';
import { generateCatalog } from './catalog.js';
import { buildCatalogTools } from './tools.js';

const PORT = +(process.env.PORT || 3007);
const DB_PATH = process.env.DB_PATH || './examples/large-catalog-search/data';
const CATALOG_SIZE = +(process.env.CATALOG_SIZE || 8000);

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'large-catalog-search-demo-secret',
  logger: true,
});

const hnsw = new HNSWIndex({ m: 16, efConstruction: 100, efSearch: 40 });
const tools = buildCatalogTools(hnsw);

console.log(`Indexing ${CATALOG_SIZE} synthetic products into HNSWIndex...`);
const buildStart = performance.now();
tools.indexCatalog(generateCatalog(CATALOG_SIZE));
console.log(`Indexed in ${Math.round(performance.now() - buildStart)}ms.`);

app.shell.registry.register('catalog', 'search-ann', {
  description: 'Approximate nearest-neighbor search via HNSWIndex (fast)',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'k', type: 'number' },
  ],
}, async (args) => tools.searchAnn(args.query || args._0, args.k || 10));

app.shell.registry.register('catalog', 'search-exact', {
  description: 'Brute-force exact cosine scan over every vector (slow, ground truth)',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'k', type: 'number' },
  ],
}, async (args) => tools.searchExact(args.query || args._0, args.k || 10));

app.shell.registry.register('catalog', 'benchmark', {
  description: 'Run both searches for the same query and report timing + recall',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'k', type: 'number' },
  ],
}, async (args) => tools.benchmark(args.query || args._0, args.k || 10));

app.shell.registry.register('catalog', 'add', {
  description: 'Add a product to the live index',
  params: [
    { name: 'id', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
  ],
}, async (args) => tools.addProduct(args));

app.shell.registry.register('catalog', 'remove', {
  description: 'Remove a product from the live index',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.removeProduct(args.id || args._0));

app.shell.registry.register('catalog', 'stats', { description: 'Index stats' }, async () => tools.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Large catalog search demo running at http://localhost:${PORT}
  commands: catalog:search-ann, catalog:search-exact, catalog:benchmark,
            catalog:add, catalog:remove, catalog:stats

Try:
  POST /api/shell/exec {"cmd":"catalog:benchmark --query \\"wireless gaming laptop\\""}
  POST /api/shell/exec {"cmd":"catalog:stats"}
See examples/large-catalog-search/README.md for the full walkthrough.
`);
