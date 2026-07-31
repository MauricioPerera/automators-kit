/**
 * Hybrid Catalog Search — end-to-end regression test.
 * Mirrors examples/hybrid-catalog-search/setup.js (reuses tools.js +
 * examples/doc-store-analytics/data.js's own generators).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { VectorStore } from '../core/vector.js';
import { generateProducts, generateOrders } from '../examples/doc-store-analytics/data.js';
import { buildHybridCatalogTools } from '../examples/hybrid-catalog-search/tools.js';

class InMemoryVectorAdapter {
  constructor() { this._bins = new Map(); this._jsons = new Map(); }
  readBin(k) { return this._bins.get(k) ?? null; }
  writeBin(k, v) { this._bins.set(k, v); }
  readJson(k) { return this._jsons.get(k) ?? null; }
  writeJson(k, v) { this._jsons.set(k, v); }
  delete(k) { this._bins.delete(k); this._jsons.delete(k); }
}

let tools, hotProductId;

beforeAll(() => {
  const db = new DocStore(new MemoryStorageAdapter());
  const store = new VectorStore(new InMemoryVectorAdapter(), 64);
  tools = buildHybridCatalogTools(db, store);

  const products = generateProducts(100).map((p) => db.products.insert(p));
  generateOrders(products, 300).forEach((o) => db.orders.insert(o));
  tools.indexCatalog(products);

  // generateOrders() skews toward the first 5 products -- products[0] is
  // guaranteed real sales history to assert the join against.
  hotProductId = products[0]._id;
});

describe('Hybrid catalog search: semantic ranking and the join agree on order', () => {
  it('hybridSearch() returns the exact same ranking (ids, in the same order) as semanticSearch()', () => {
    const semantic = tools.semanticSearch('compact electronics', 5);
    const hybrid = tools.hybridSearch('compact electronics', 5);
    expect(hybrid.map((r) => r.id)).toEqual(semantic.map((r) => r.id));
    expect(hybrid.map((r) => r.score)).toEqual(semantic.map((r) => r.score));
  });
});

describe('Hybrid catalog search: the $lookup/$group join adds real relational data', () => {
  it('a product with real order history gets its actual unitsSold/orderCount from a real join, not a guess', () => {
    // Query with the hot product's own real name so it's guaranteed the
    // top hit (avoids depending on the crude offline embedding's ranking
    // quality for products it wasn't specifically asked about).
    const hybrid = tools.hybridSearch('compact electronics item 0', 1);
    expect(hybrid[0].id).toBe(hotProductId);
    expect(hybrid[0].unitsSold).toBeGreaterThan(0);
    expect(hybrid[0].orderCount).toBeGreaterThan(0);
  });

  it('a product with zero order history correctly gets unitsSold: 0, orderCount: 0 -- not undefined, not missing from results', () => {
    // Build a standalone scenario with full control (the shared generator's
    // skew math doesn't guarantee a specific cold product at every
    // product/order ratio) -- one product, indexed for search, with no
    // orders inserted for it at all.
    const db = new DocStore(new MemoryStorageAdapter());
    const store = new VectorStore(new InMemoryVectorAdapter(), 64);
    const coldTools = buildHybridCatalogTools(db, store);
    const [cold] = generateProducts(1).map((p) => db.products.insert(p));
    coldTools.indexCatalog([cold]);

    const hybrid = coldTools.hybridSearch(cold.name, 1);
    expect(hybrid[0].id).toBe(cold._id);
    expect(hybrid[0].unitsSold).toBe(0);
    expect(hybrid[0].orderCount).toBe(0);
  });
});

describe('Hybrid catalog search: stats', () => {
  it('reports vector, product, and order counts', () => {
    const stats = tools.stats();
    expect(stats.vectors).toBe(100);
    expect(stats.products).toBe(100);
    expect(stats.orders).toBe(300);
  });
});
