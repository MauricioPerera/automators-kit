/**
 * DocStore Analytics — HTTP/shell demo.
 *
 *   bun examples/doc-store-analytics/setup.js
 *
 * "You don't need the whole CMS to get a document database + HTTP API" —
 * unlike every other example in this repo, this one does NOT call
 * createApp(). It's core/db.js's DocStore (MongoDB-style queries, 26
 * operators, indices, aggregation with $group/$lookup) wired directly to
 * core/http.js's Router and core/shell.js's Shell — 3 à la carte modules,
 * zero CMS.
 */

import { Router, json, error, cors } from '../../core/http.js';
import { DocStore, FileStorageAdapter } from '../../core/db.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { buildAnalyticsTools } from './tools.js';

const PORT = +(process.env.PORT || 3013);
const DB_PATH = process.env.DB_PATH || './examples/doc-store-analytics/data';

const db = new DocStore(new FileStorageAdapter(DB_PATH));
const tools = buildAnalyticsTools(db);

const shell = new Shell({ profile: 'admin' });
shell.registry.register('db', 'seed', {
  description: 'Seed n products + 3n orders (deterministic — same n, same data)',
  params: [{ name: 'n', type: 'number' }],
}, async (args) => tools.seed(args.n));
shell.registry.register('db', 'low-stock', {
  description: 'Products below a stock threshold',
  params: [{ name: 'threshold', type: 'number' }],
}, async (args) => tools.lowStock(args.threshold));
shell.registry.register('db', 'by-category', { description: 'Aggregated report: count/avgPrice/totalStock per category' }, async () => tools.byCategory());
shell.registry.register('db', 'top-sellers', {
  description: 'Top-selling products by units sold, joined with product details ($lookup)',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => tools.topSellers(args.limit));
shell.registry.register('db', 'benchmark', {
  description: 'Compare an indexed vs non-indexed lookup by sku, measured',
  params: [{ name: 'sku', type: 'string', required: true }],
}, async (args) => tools.benchmarkLookup(args.sku));
shell.registry.register('db', 'backup', { description: 'Export all collections' }, async () => tools.backup());

const router = new Router();
router.use(cors());

router.get('/products', async (ctx) => {
  const filter = {};
  if (ctx.query.category) filter.category = ctx.query.category;
  const limit = ctx.query.limit ? +ctx.query.limit : undefined;
  return json({ products: tools.queryProducts(filter, { limit, sort: { price: 1 } }) });
});

router.get('/products/:sku', async (ctx) => {
  const [product] = tools.queryProducts({ sku: ctx.params.sku });
  return product ? json({ product }) : error('Not found', 404);
});

router.get('/reports/by-category', async () => json({ report: tools.byCategory() }));
router.get('/reports/top-sellers', async (ctx) => json({ report: tools.topSellers(ctx.query.limit ? +ctx.query.limit : 5) }));

router.route('/api/shell', shellRoutes(shell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
DocStore analytics demo running at http://localhost:${PORT}
  REST:  GET /products, GET /products/:sku, GET /reports/by-category, GET /reports/top-sellers
  shell: db:seed, db:low-stock, db:by-category, db:top-sellers, db:benchmark, db:backup

Try:
  POST /api/shell/exec {"cmd":"db:seed --n 500"}
  GET  /reports/by-category
  POST /api/shell/exec {"cmd":"db:benchmark --sku SKU-1042"}
See examples/doc-store-analytics/README.md for the full walkthrough.
`);
