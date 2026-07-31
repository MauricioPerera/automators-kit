/**
 * Shared handlers for the hybrid-catalog-search example: core/vector.js's
 * VectorStore ranks products by semantic similarity, then a REAL
 * core/db.js `$lookup`/`$group` aggregation joins in relational sales
 * data (units sold, order count) that has nothing to do with vector
 * similarity — the kind of query neither module can answer alone.
 * core/vector.js never calls a database; core/db.js's aggregation has no
 * notion of semantic ranking.
 */

import { embed } from '../vector-memory/embed.js';

const VECTOR_COLLECTION = 'products';
const DIM = 64;

/**
 * @param {import('../../core/db.js').DocStore} db
 * @param {import('../../core/vector.js').VectorStore} store
 */
export function buildHybridCatalogTools(db, store) {
  function indexCatalog(products) {
    for (const p of products) {
      store.set(VECTOR_COLLECTION, p._id, embed(p.name, DIM), { title: p.name, sku: p.sku, category: p.category });
    }
    return { indexed: products.length, total: store.count(VECTOR_COLLECTION) };
  }

  /** Semantic ranking only — no relational data. Shows what the join in hybridSearch() adds. */
  function semanticSearch(query, k = 5) {
    const hits = store.search(VECTOR_COLLECTION, embed(query, DIM), k);
    return hits.map((h) => ({ id: h.id, title: h.metadata.title, sku: h.metadata.sku, score: Number(h.score.toFixed(4)) }));
  }

  /**
   * Semantic ranking, THEN a real $lookup/$group join over `orders`
   * (core/db.js's AggregationPipeline) to enrich each hit with real sales
   * data. The join is scoped to exactly the semantic top-k via a $match
   * on their ids -- not a full-table scan for every search.
   *
   * $group's output order is not guaranteed to match the vector search's
   * ranking (it's not even trying to), so results are explicitly
   * re-sorted back into the ORIGINAL semantic rank order after the join —
   * that ranking is the entire point of doing this hybrid in the first
   * place, not an aggregation implementation detail to lose.
   */
  function hybridSearch(query, k = 5) {
    const hits = store.search(VECTOR_COLLECTION, embed(query, DIM), k);
    const ids = hits.map((h) => h.id);

    const sales = db.orders.aggregate()
      .match({ productId: { $in: ids } })
      .group('productId', { unitsSold: { $sum: 'qty' }, orderCount: { $count: 1 } })
      .lookup({ from: 'products', localField: '_id', foreignField: '_id', as: 'product', single: true })
      .toArray();
    const salesById = new Map(sales.map((s) => [s._id, s]));

    return hits.map((h) => {
      const s = salesById.get(h.id);
      return {
        id: h.id,
        title: h.metadata.title,
        sku: h.metadata.sku,
        score: Number(h.score.toFixed(4)),
        unitsSold: s?.unitsSold ?? 0,
        orderCount: s?.orderCount ?? 0,
      };
    });
  }

  function stats() {
    return { vectors: store.count(VECTOR_COLLECTION), products: db.products.count(), orders: db.orders.count() };
  }

  return { indexCatalog, semanticSearch, hybridSearch, stats };
}
