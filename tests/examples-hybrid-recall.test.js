/**
 * Hybrid Recall — end-to-end regression test.
 * Mirrors examples/hybrid-recall/setup.js (reuses tools.js's
 * buildHybridRecall so the demo and test can't drift apart).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { AgentMemory } from '../core/memory.js';
import { VectorStore } from '../core/vector.js';
import { buildHybridRecall, VECTOR_COLLECTION, DIM } from '../examples/hybrid-recall/tools.js';
import { embed } from '../examples/vector-memory/embed.js';

let hybrid, store;

// A storage adapter VectorStore accepts directly, in-memory only, no filesystem.
class InMemoryVectorAdapter {
  constructor() { this._bins = new Map(); this._jsons = new Map(); }
  readBin(k) { return this._bins.get(k) ?? null; }
  writeBin(k, v) { this._bins.set(k, v); }
  readJson(k) { return this._jsons.get(k) ?? null; }
  writeJson(k, v) { this._jsons.set(k, v); }
  delete(k) { this._bins.delete(k); this._jsons.delete(k); }
}

beforeAll(async () => {
  const app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'hybrid-recall-test-secret!!!' });
  const memory = new AgentMemory(app.cms.db, { agentId: 'test' });
  store = new VectorStore(new InMemoryVectorAdapter(), 64);
  hybrid = buildHybridRecall(memory, store);

  await hybrid.learn({ title: 'OAuth', text: 'OAuth token refresh fails after 24 hours, root cause was clock skew between servers' });
  await hybrid.learn({ title: 'DBPool', text: 'Database connection pool exhausted under high concurrent load, fixed by increasing pool size' });
  await hybrid.learn({ title: 'SafariCSS', text: 'CSS grid layout breaks on Safari mobile, needed a webkit prefix fallback' });
});

describe('Hybrid recall: keyword layer serves when it has any shared vocabulary', () => {
  it('an on-topic query is served by the keyword layer', async () => {
    const res = await hybrid.recall({ query: 'oauth token clock skew' });
    expect(res.source).toBe('keyword');
    expect(res.results[0].title).toBe('OAuth');
  });

  it('a partial-word-overlap query still gets a keyword hit (memory.js uses substring matching)', async () => {
    const res = await hybrid.recall({ query: 'safari mobile css broken' });
    expect(res.source).toBe('keyword');
    expect(res.results[0].title).toBe('SafariCSS');
  });
});

describe('Hybrid recall: vector layer only engages on a true keyword empty', () => {
  it('a query with zero shared vocabulary anywhere falls back to the vector layer', async () => {
    const res = await hybrid.recall({ query: 'kubernetes pod crashloop backoff memory limit' });
    expect(res.source).toBe('vector');
    // Regression coverage for the real finding this example is built
    // around: the vector layer never hard-empties, unlike memory.recall().
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('flags a vector-layer result as lowConfidence when no stored doc is actually relevant', async () => {
    const res = await hybrid.recall({ query: 'quarterly sales report revenue growth' });
    expect(res.source).toBe('vector');
    expect(res.lowConfidence).toBe(true);
  });

  it('honest limitation, verified at the vector-store level: a true paraphrase can rank an UNRELATED doc above the real match', () => {
    // "login stops working after a day, tokens expire early" is a genuine
    // paraphrase of the OAuth doc with almost no shared words. The offline
    // hashing-trick embedding has no synonym understanding (same caveat
    // examples/vector-memory's embed.js already documents). Queried
    // directly against the vector store (bypassing the keyword layer,
    // which happens to weakly match this exact sentence via the shared
    // stopword "after") to isolate and lock in the honestly-verified
    // limitation, not hide it — if a future embed.js change fixes this,
    // this test should start failing and get updated, not silently rot.
    const results = store.search(VECTOR_COLLECTION, embed('login stops working after a day, tokens expire early', DIM), 3);
    expect(results[0].metadata.title).not.toBe('OAuth');
  });
});

describe('Hybrid recall: stats', () => {
  it('reports counts from both layers', async () => {
    const stats = await hybrid.stats();
    expect(stats.memory.types.docs).toBe(3);
    expect(stats.vectors).toBe(3);
  });
});
