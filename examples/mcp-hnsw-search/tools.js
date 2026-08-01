/**
 * MCP tools over examples/large-catalog-search's own `buildCatalogTools`
 * (reused directly, same precedent as examples/mcp-vector-search reusing
 * examples/vector-memory's tools.js) — "let an AI client search a large
 * catalog via approximate nearest-neighbor AND interrogate the honest
 * speed/recall trade-off itself." Distinct from
 * examples/mcp-vector-search: that one wraps core/vector.js's
 * `VectorStore` (linear scan, small demo scale, no benchmark tool at
 * all); this one wraps core/hnsw.js's standalone `HNSWIndex` at the
 * same scale examples/large-catalog-search uses (thousands of products)
 * and exposes `benchmark_search` — no other MCP example lets the client
 * itself measure and compare against ground truth, not just call search.
 */

/**
 * @param {ReturnType<typeof import('../large-catalog-search/tools.js').buildCatalogTools>} catalog
 *   The SAME `buildCatalogTools(hnsw)` instance the caller already used
 *   to index the catalog -- `buildCatalogTools` keeps its own internal
 *   id->vector map (needed for the brute-force comparator in
 *   `benchmark()`), so calling it a second time here would build a
 *   fresh, EMPTY map instead of reusing the populated one, silently
 *   breaking `benchmark_search`'s exact-scan side.
 */
export function buildMcpHnswTools(catalog) {
  return {
    search_products: {
      description: 'Approximate nearest-neighbor search over the product catalog (fast, not guaranteed exact).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      handler: async ({ query, limit }) => catalog.searchAnn(query, limit || 10),
    },
    benchmark_search: {
      description: 'Run the SAME query both approximately (HNSW) and exactly (brute-force cosine scan), and report real timing + recall -- how close the fast path actually is to ground truth, not just its results.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      handler: async ({ query, limit }) => {
        const result = catalog.benchmark(query, limit || 10);
        // Trim to what's useful for a client comparing the two paths --
        // the raw per-result arrays are already covered by search_products.
        return {
          query: result.query, k: result.k,
          annMs: result.annMs, exactMs: result.exactMs,
          speedup: result.speedup, recall: result.recall,
        };
      },
    },
    catalog_stats: {
      description: 'Indexed product count and HNSW graph stats. No persistence: the index is rebuilt from a deterministic synthetic catalog on every server start, not saved to disk.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => catalog.stats(),
    },
  };
}
