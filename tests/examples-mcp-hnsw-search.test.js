/**
 * MCP HNSW Search — end-to-end regression test.
 * Mirrors mcp-server.js's tool wiring via handleMCPRequest() directly
 * (pure dispatcher, no real stdio process needed for testing). Uses a
 * smaller catalog than the live demo (speed, not scale, is what's under
 * test here -- the scale claim is examples/large-catalog-search's own,
 * already verified there).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { HNSWIndex } from '../core/hnsw.js';
import { handleMCPRequest } from '../core/mcp.js';
import { generateCatalog } from '../examples/large-catalog-search/catalog.js';
import { buildCatalogTools } from '../examples/large-catalog-search/tools.js';
import { buildMcpHnswTools } from '../examples/mcp-hnsw-search/tools.js';

let tools, catalog;

async function callMcp(name, args) {
  const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);
  expect(res.error).toBeUndefined();
  return JSON.parse(res.result.content[0].text);
}

beforeAll(() => {
  const hnsw = new HNSWIndex({ m: 8, efConstruction: 100, efSearch: 50 });
  catalog = buildCatalogTools(hnsw);
  catalog.indexCatalog(generateCatalog(500));
  tools = buildMcpHnswTools(catalog);
});

describe('MCP HNSW search: only the 3 catalog-search tools are exposed', () => {
  it('tools/list exposes exactly search_products/benchmark_search/catalog_stats', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools);
    const names = res.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['benchmark_search', 'catalog_stats', 'search_products']);
  });
});

describe('MCP HNSW search: real approximate search + honest self-benchmarking', () => {
  it('search_products returns real ANN results for the seeded catalog', async () => {
    const result = await callMcp('search_products', { query: 'wireless gaming laptop', limit: 5 });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(5);
    expect(typeof result.ms).toBe('number');
  });

  it("benchmark_search reuses the SAME indexed vectors for its exact/brute-force side (regression: a second buildCatalogTools() call would silently empty it)", async () => {
    const result = await callMcp('benchmark_search', { query: 'portable acme camera', limit: 10 });
    expect(result.recall).toBeGreaterThan(0); // would be exactly 0 if the exact-scan side had no vectors at all
    expect(typeof result.annMs).toBe('number');
    expect(typeof result.exactMs).toBe('number');
    expect(result.k).toBe(10);
  });

  it('catalog_stats reflects the real indexed count', async () => {
    const result = await callMcp('catalog_stats', {});
    expect(result.vectorsTracked).toBe(500);
  });

  it('a missing required query argument returns a real MCP tool error, not a crash', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: {} } }, tools);
    expect(res.result.isError).toBe(true);
  });
});
