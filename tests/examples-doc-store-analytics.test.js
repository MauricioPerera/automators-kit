/**
 * DocStore Analytics — end-to-end regression test.
 * Mirrors examples/doc-store-analytics/setup.js (reuses buildAnalyticsTools
 * + data.js) so the demo and the test can't drift apart. No createApp()/CMS
 * involved — just core/db.js's DocStore, driven directly and via the raw
 * Router + Shell HTTP surface.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { Router, json, error } from '../core/http.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { Shell } from '../core/shell.js';
import { shellRoutes } from '../routes/shell.js';
import { buildAnalyticsTools } from '../examples/doc-store-analytics/tools.js';
import { generateProducts, generateOrders } from '../examples/doc-store-analytics/data.js';

let db;
let tools;
let router;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}
async function exec(cmd) { return (await router.handle(req(cmd))).json(); }

beforeAll(() => {
  db = new DocStore(new MemoryStorageAdapter());
  tools = buildAnalyticsTools(db);

  const shell = new Shell({ profile: 'admin' });
  shell.registry.register('db', 'seed', { description: 'seed' }, async (args) => tools.seed(args.n));
  shell.registry.register('db', 'low-stock', { description: 'low-stock' }, async (args) => tools.lowStock(args.threshold));
  shell.registry.register('db', 'by-category', { description: 'by-category' }, async () => tools.byCategory());
  shell.registry.register('db', 'top-sellers', { description: 'top-sellers' }, async (args) => tools.topSellers(args.limit));
  shell.registry.register('db', 'benchmark', { description: 'benchmark' }, async (args) => tools.benchmarkLookup(args.sku));
  shell.registry.register('db', 'backup', { description: 'backup' }, async () => tools.backup());

  router = new Router();
  router.get('/products/:sku', async (ctx) => {
    const [product] = tools.queryProducts({ sku: ctx.params.sku });
    return product ? json({ product }) : error('Not found', 404);
  });
  router.route('/api/shell', shellRoutes(shell));

  tools.seed(200);
});

describe('DocStore analytics: seed determinism', () => {
  it('generateProducts(n) is deterministic — same n, same catalog', () => {
    expect(generateProducts(50)).toEqual(generateProducts(50));
  });
});

describe('DocStore analytics: queries and operators', () => {
  it('finds a product by exact sku via the raw REST route', async () => {
    const res = await router.handle(new Request('http://localhost/products/SKU-1000'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.sku).toBe('SKU-1000');
  });

  it('a missing sku returns 404, not a thrown error', async () => {
    const res = await router.handle(new Request('http://localhost/products/SKU-nope'));
    expect(res.status).toBe(404);
  });

  it('$lt finds low-stock products, sorted ascending', () => {
    const results = tools.lowStock(5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.stock < 5)).toBe(true);
    const stocks = results.map((p) => p.stock);
    expect(stocks).toEqual([...stocks].sort((a, b) => a - b));
  });
});

describe('DocStore analytics: aggregation ($group, $lookup)', () => {
  it('byCategory groups and sums correctly', () => {
    const report = tools.byCategory();
    expect(report.length).toBe(5); // 5 categories in the seed data
    const total = report.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(200);
    for (const r of report) {
      expect(r.avgPrice).toBeGreaterThan(0);
      expect(r.totalStock).toBeGreaterThanOrEqual(0);
    }
  });

  it('topSellers joins each result with its product via $lookup', () => {
    const top = tools.topSellers(3);
    expect(top.length).toBe(3);
    for (const t of top) {
      expect(t.product).toBeDefined();
      expect(t.product.sku).toMatch(/^SKU-/);
      expect(t.unitsSold).toBeGreaterThan(0);
    }
    // Sorted descending by units sold.
    const sold = top.map((t) => t.unitsSold);
    expect(sold).toEqual([...sold].sort((a, b) => b - a));
  });
});

describe('DocStore analytics: index benchmark', () => {
  it('creates an index on first use and reports both timings', () => {
    const result = tools.benchmarkLookup('SKU-1099');
    expect(result.found).toBe(true);
    expect(typeof result.unindexedMs).toBe('number');
    expect(typeof result.indexedMs).toBe('number');
    expect(db.products.getIndexes().some((i) => i.field === 'sku')).toBe(true);
  });
});

describe('DocStore analytics: backup/restore', () => {
  it('export + import round-trips all documents into a fresh store', () => {
    const backup = tools.backup();
    expect(backup.products.length).toBe(200);
    expect(backup.orders.length).toBe(600);

    const freshDb = new DocStore(new MemoryStorageAdapter());
    const freshTools = buildAnalyticsTools(freshDb);
    const restored = freshTools.restore(backup);
    expect(restored.products).toBe(200);
    expect(restored.orders).toBe(600);
    expect(freshTools.byCategory()).toEqual(tools.byCategory());
  });
});

describe('DocStore analytics: via the agent shell', () => {
  it('db:by-category is reachable through /api/shell/exec, matching the direct call', async () => {
    const res = await exec('db:by-category');
    expect(res.code).toBe(0);
    expect(res.data).toEqual(tools.byCategory());
  });
});
