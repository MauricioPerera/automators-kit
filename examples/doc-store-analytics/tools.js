/**
 * Shared handlers for the doc-store-analytics example: core/db.js's
 * DocStore used directly, with no CMS layer at all — query operators,
 * indices, aggregation ($group/$lookup), and export/import (backup).
 */

import { generateProducts, generateOrders } from './data.js';

export function buildAnalyticsTools(db) {
  return {
    seed(n = 500) {
      const products = generateProducts(n).map((p) => db.products.insert(p));
      const orders = generateOrders(products, Math.round(n * 3)).map((o) => db.orders.insert(o));
      return { products: products.length, orders: orders.length };
    },

    /** Raw MongoDB-style filter, straight through to find(). */
    queryProducts(filter, opts = {}) {
      let cursor = db.products.find(filter || {});
      if (opts.sort) cursor = cursor.sort(opts.sort);
      if (opts.limit) cursor = cursor.limit(opts.limit);
      return cursor.toArray();
    },

    lowStock(threshold = 5) {
      return db.products.find({ stock: { $lt: threshold } }).sort({ stock: 1 }).toArray();
    },

    /** $group by category: count, average price, total stock on hand. */
    byCategory() {
      return db.products.aggregate()
        .group('category', {
          count: { $count: 1 },
          avgPrice: { $avg: 'price' },
          totalStock: { $sum: 'stock' },
        })
        .sort({ count: -1 })
        .toArray();
    },

    /** $group orders by product, $lookup the product name/category (a real JOIN). */
    topSellers(limit = 5) {
      return db.orders.aggregate()
        .group('productId', { unitsSold: { $sum: 'qty' } })
        .sort({ unitsSold: -1 })
        .limit(limit)
        .lookup({ from: 'products', localField: '_id', foreignField: '_id', as: 'product', single: true })
        .toArray();
    },

    /** Indexed vs non-indexed lookup on the same field, measured. */
    benchmarkLookup(sku) {
      const t1 = performance.now();
      const withoutIndex = db.products.find({ sku }).toArray();
      const unindexedMs = performance.now() - t1;

      if (!db.products.getIndexes().some((i) => i.field === 'sku')) {
        db.products.createIndex('sku', { unique: true });
      }

      const t2 = performance.now();
      const withIndex = db.products.find({ sku }).toArray();
      const indexedMs = performance.now() - t2;

      return {
        found: withIndex.length === 1,
        unindexedMs: Math.round(unindexedMs * 1000) / 1000,
        indexedMs: Math.round(indexedMs * 1000) / 1000,
        matchesWithoutIndex: withoutIndex.length,
        matchesWithIndex: withIndex.length,
      };
    },

    backup() {
      return { products: db.products.export(), orders: db.orders.export() };
    },

    restore(backup) {
      return {
        products: db.products.import(backup.products || []),
        orders: db.orders.import(backup.orders || []),
      };
    },
  };
}
