/**
 * Shared handlers for the large-catalog-search example: index a product
 * catalog into core/hnsw.js's standalone HNSWIndex, and compare it against
 * a brute-force exact cosine scan over the same vectors — the "when does
 * vector.js's linear scan stop being good enough" question, made concrete
 * with real timing and real recall numbers instead of just asserting it.
 */

import { embed } from './embed.js';

/**
 * @param {import('../../core/hnsw.js').HNSWIndex} hnsw
 */
export function buildCatalogTools(hnsw) {
  // HNSWIndex only stores vectors internally for graph traversal — it has
  // no id->vector lookup of its own, so the brute-force comparator (which
  // needs to scan every vector directly, not via the graph) keeps its own
  // copy here.
  const vectors = new Map();

  function indexCatalog(products) {
    for (const p of products) {
      const v = embed(p.text);
      vectors.set(p.id, v);
      hnsw.add(p.id, v);
    }
    return { indexed: products.length, total: hnsw.size };
  }

  function searchAnn(query, k = 10) {
    const qv = embed(query);
    const start = performance.now();
    const results = hnsw.search(qv, k);
    return { results, ms: performance.now() - start };
  }

  function searchExact(query, k = 10) {
    const qv = embed(query);
    const start = performance.now();
    const scored = [];
    for (const [id, v] of vectors) {
      scored.push({ id, score: 1 - _cosineDist(qv, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, k), ms: performance.now() - start };
  }

  /**
   * Run both searches for the same query and report the honest trade-off:
   * ANN is faster, but `recall` (how many of the exact top-k it actually
   * found) is not guaranteed to be 1 — that's the "approximate" in ANN.
   */
  function benchmark(query, k = 10) {
    const ann = searchAnn(query, k);
    const exact = searchExact(query, k);
    const exactIds = new Set(exact.results.map((r) => r.id));
    const overlap = ann.results.filter((r) => exactIds.has(r.id)).length;
    return {
      query,
      k,
      annMs: Math.round(ann.ms * 1000) / 1000,
      exactMs: Math.round(exact.ms * 1000) / 1000,
      speedup: exact.ms > 0 ? Math.round((exact.ms / Math.max(ann.ms, 0.001)) * 10) / 10 : null,
      recall: overlap / k,
      annResults: ann.results,
      exactResults: exact.results,
    };
  }

  function addProduct({ id, text }) {
    const v = embed(text);
    vectors.set(id, v);
    hnsw.add(id, v);
    return { added: id, total: hnsw.size };
  }

  function removeProduct(id) {
    const removed = hnsw.remove(id);
    if (removed) vectors.delete(id);
    return { removed, total: hnsw.size };
  }

  function stats() {
    return { ...hnsw.stats(), vectorsTracked: vectors.size };
  }

  return { indexCatalog, searchAnn, searchExact, benchmark, addProduct, removeProduct, stats };
}

function _cosineDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}
