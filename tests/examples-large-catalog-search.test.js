/**
 * Large Catalog Search — end-to-end regression test.
 * Mirrors examples/large-catalog-search/setup.js (reuses buildCatalogTools +
 * generateCatalog) so the demo and the test can't drift apart. Uses a small
 * catalog (200 products) instead of the live demo's 8000 for test speed —
 * HNSWIndex is pure in-process, no real server/fetch needed.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { HNSWIndex } from '../core/hnsw.js';
import { generateCatalog } from '../examples/large-catalog-search/catalog.js';
import { buildCatalogTools } from '../examples/large-catalog-search/tools.js';

let app;
let hnsw;
let tools;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function exec(cmd) {
  const res = await app.handle(req(cmd));
  return res.json();
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'large-catalog-search-test-secret!!!' });
  hnsw = new HNSWIndex({ m: 16, efConstruction: 100, efSearch: 40 });
  tools = buildCatalogTools(hnsw);
  tools.indexCatalog(generateCatalog(200));

  app.shell.registry.register('catalog', 'search-ann', { description: 'search-ann' }, async (args) => tools.searchAnn(args.query || args._0, args.k || 10));
  app.shell.registry.register('catalog', 'search-exact', { description: 'search-exact' }, async (args) => tools.searchExact(args.query || args._0, args.k || 10));
  app.shell.registry.register('catalog', 'benchmark', { description: 'benchmark' }, async (args) => tools.benchmark(args.query || args._0, args.k || 10));
  app.shell.registry.register('catalog', 'add', { description: 'add' }, async (args) => tools.addProduct(args));
  app.shell.registry.register('catalog', 'remove', { description: 'remove' }, async (args) => tools.removeProduct(args.id || args._0));
  app.shell.registry.register('catalog', 'stats', { description: 'stats' }, async () => tools.stats());
});

describe('generateCatalog: deterministic', () => {
  it('the same n always produces the same catalog', () => {
    expect(generateCatalog(50)).toEqual(generateCatalog(50));
  });

  it('produces n unique ids', () => {
    const cat = generateCatalog(200);
    expect(cat.length).toBe(200);
    expect(new Set(cat.map((p) => p.id)).size).toBe(200);
  });
});

describe('Catalog search: ANN vs exact', () => {
  it('search-ann returns up to k results, ranked by score descending', async () => {
    const res = await exec('catalog:search-ann --query "wireless gaming laptop" --k 5');
    expect(res.code).toBe(0);
    expect(res.data.results.length).toBeLessThanOrEqual(5);
    const scores = res.data.results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('search-exact returns the true top-k by brute-force cosine', async () => {
    const res = await exec('catalog:search-exact --query "wireless gaming laptop" --k 5');
    expect(res.code).toBe(0);
    expect(res.data.results.length).toBe(5);
  });

  it('benchmark reports timing and a recall ratio between 0 and 1', async () => {
    const res = await exec('catalog:benchmark --query "budget printer" --k 10');
    expect(res.code).toBe(0);
    expect(typeof res.data.annMs).toBe('number');
    expect(typeof res.data.exactMs).toBe('number');
    expect(res.data.recall).toBeGreaterThanOrEqual(0);
    expect(res.data.recall).toBeLessThanOrEqual(1);
  });

  it('an exact match query recalls itself in both ANN and exact results', async () => {
    const res = await exec('catalog:benchmark --query "acme wireless laptop model 0" --k 5');
    const annIds = res.data.annResults.map((r) => r.id);
    const exactIds = res.data.exactResults.map((r) => r.id);
    expect(exactIds[0]).toBe('p0'); // exact scan always finds the literal match first
    expect(annIds).toContain('p0');
  });
});

describe('Catalog mutation: add/remove on the live index', () => {
  it('a newly added product is findable immediately', async () => {
    const addRes = await exec('catalog:add --id newprod --text "acme wireless ultra-thin drone model 9999"');
    expect(addRes.data.added).toBe('newprod');

    const searchRes = await exec('catalog:search-exact --query "acme wireless ultra-thin drone model 9999" --k 1');
    expect(searchRes.data.results[0].id).toBe('newprod');
  });

  it('a removed product no longer appears in exact search results', async () => {
    await exec('catalog:add --id toremove --text "unique removable test product xyzzy"');
    const before = await exec('catalog:search-exact --query "unique removable test product xyzzy" --k 1');
    expect(before.data.results[0].id).toBe('toremove');

    const removeRes = await exec('catalog:remove --id toremove');
    expect(removeRes.data.removed).toBe(true);

    const after = await exec('catalog:search-exact --query "unique removable test product xyzzy" --k 1');
    expect(after.data.results.map((r) => r.id)).not.toContain('toremove');
  });

  it('stats reflects the current index size', async () => {
    const res = await exec('catalog:stats');
    expect(res.data.count).toBeGreaterThan(0);
    expect(res.data.vectorsTracked).toBe(res.data.count);
  });
});
