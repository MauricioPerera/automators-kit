/**
 * Hybrid Catalog Search — HTTP/shell demo.
 *
 *   bun examples/hybrid-catalog-search/setup.js
 *
 * Combines core/vector.js's VectorStore (semantic ranking) with
 * core/db.js's real `$lookup`/`$group` aggregation (relational sales
 * data) — neither module's other example does both. examples/vector-memory
 * and examples/large-catalog-search rank by similarity only, with no
 * relational data at all; examples/doc-store-analytics's `topSellers()`
 * joins sales data but has no notion of semantic ranking (it's a raw
 * `$group` over ALL orders, unscoped to any query). Like
 * examples/doc-store-analytics, this does NOT call createApp() — no CMS
 * needed, core/db.js's DocStore + core/vector.js's VectorStore directly.
 *
 * Reuses examples/doc-store-analytics's own deterministic product/order
 * generators (data.js) instead of duplicating them.
 */

import { Router, json, error, cors } from '../../core/http.js';
import { DocStore, FileStorageAdapter } from '../../core/db.js';
import { VectorStore } from '../../core/vector.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { generateProducts, generateOrders } from '../doc-store-analytics/data.js';
import { buildHybridCatalogTools } from './tools.js';

const PORT = +(process.env.PORT || 3028);
const DB_PATH = process.env.DB_PATH || './examples/hybrid-catalog-search/data/cms';
const VECTOR_DB_PATH = process.env.VECTOR_DB_PATH || './examples/hybrid-catalog-search/data/vectors';
const CATALOG_SIZE = +(process.env.CATALOG_SIZE || 500);

const db = new DocStore(new FileStorageAdapter(DB_PATH));
const store = new VectorStore(VECTOR_DB_PATH, 64);
const tools = buildHybridCatalogTools(db, store);

const products = generateProducts(CATALOG_SIZE).map((p) => db.products.insert(p));
generateOrders(products, Math.round(CATALOG_SIZE * 3)).forEach((o) => db.orders.insert(o));
tools.indexCatalog(products);

const shell = new Shell({ profile: 'admin' });
shell.registry.register('catalog', 'semantic-search', {
  description: 'Semantic search only, no relational data',
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.semanticSearch(args.query || args._0, args.k || 5));

shell.registry.register('catalog', 'hybrid-search', {
  description: 'Semantic search, then a real $lookup/$group join adds units sold + order count',
  params: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number' }],
}, async (args) => tools.hybridSearch(args.query || args._0, args.k || 5));

shell.registry.register('catalog', 'stats', { description: 'Vector + product + order counts' }, async () => tools.stats());

const router = new Router();
router.use(cors());
router.route('/api/shell', shellRoutes(shell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Hybrid catalog search demo running at http://localhost:${PORT}
  commands: catalog:semantic-search, catalog:hybrid-search, catalog:stats

Try:
  POST /api/shell/exec {"cmd":"catalog:semantic-search --query \\"wireless electronics\\""}
  POST /api/shell/exec {"cmd":"catalog:hybrid-search --query \\"wireless electronics\\""}
    -> same ranking, PLUS unitsSold/orderCount from a real $lookup join
See examples/hybrid-catalog-search/README.md for the full walkthrough.
`);
