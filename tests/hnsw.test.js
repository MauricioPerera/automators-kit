/**
 * Tests: core/hnsw.js — HNSW Index
 */

import { describe, it, expect } from 'bun:test';
import { HNSWIndex } from '../core/hnsw.js';

function randomVec(dim) {
  return Array.from({ length: dim }, () => Math.random());
}

describe('HNSWIndex', () => {
  it('add and search single vector', () => {
    const hnsw = new HNSWIndex({ m: 4, efConstruction: 20, efSearch: 10 });
    hnsw.add('a', [1, 0, 0, 0]);
    const results = hnsw.search([1, 0, 0, 0], 1);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('a');
    expect(results[0].distance).toBeCloseTo(0, 3);
  });

  it('finds nearest neighbor correctly', () => {
    const hnsw = new HNSWIndex({ m: 8, efConstruction: 50, efSearch: 20 });
    hnsw.add('a', [1, 0, 0]);
    hnsw.add('b', [0, 1, 0]);
    hnsw.add('c', [0.9, 0.1, 0]);

    const results = hnsw.search([1, 0, 0], 3);
    // 'a' should be closest, then 'c', then 'b'
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('c');
  });

  it('handles multiple insertions', () => {
    const hnsw = new HNSWIndex({ m: 8, efConstruction: 50 });
    for (let i = 0; i < 100; i++) {
      hnsw.add(`doc-${i}`, randomVec(32));
    }
    expect(hnsw.size).toBe(100);
    const results = hnsw.search(randomVec(32), 10);
    expect(results.length).toBe(10);
  });

  it('returns correct number of results', () => {
    const hnsw = new HNSWIndex({ m: 4 });
    for (let i = 0; i < 5; i++) hnsw.add(`d${i}`, randomVec(16));
    expect(hnsw.search(randomVec(16), 3).length).toBe(3);
    expect(hnsw.search(randomVec(16), 10).length).toBe(5); // only 5 in index
  });

  it('remove works', () => {
    const hnsw = new HNSWIndex({ m: 4, efConstruction: 20 });
    hnsw.add('a', [1, 0]);
    hnsw.add('b', [0, 1]);
    hnsw.add('c', [1, 1]);
    expect(hnsw.size).toBe(3);
    hnsw.remove('b');
    expect(hnsw.size).toBe(2);
    expect(hnsw.has('b')).toBe(false);
    const results = hnsw.search([0, 1], 5);
    expect(results.every(r => r.id !== 'b')).toBe(true);
  });

  it('has() and ids()', () => {
    const hnsw = new HNSWIndex();
    hnsw.add('x', [1, 2, 3]);
    hnsw.add('y', [4, 5, 6]);
    expect(hnsw.has('x')).toBe(true);
    expect(hnsw.has('z')).toBe(false);
    expect(hnsw.ids().sort()).toEqual(['x', 'y']);
  });

  it('stats()', () => {
    const hnsw = new HNSWIndex({ m: 8 });
    hnsw.add('a', randomVec(8));
    const s = hnsw.stats();
    expect(s.count).toBe(1);
    expect(s.m).toBe(8);
  });

  it('empty index returns empty results', () => {
    const hnsw = new HNSWIndex();
    expect(hnsw.search([1, 2, 3], 5)).toEqual([]);
  });

  it('duplicate add is idempotent', () => {
    const hnsw = new HNSWIndex();
    hnsw.add('a', [1, 0]);
    hnsw.add('a', [0, 1]); // duplicate
    expect(hnsw.size).toBe(1);
  });

  it('remove entry point keeps every remaining node reachable (no orphaned upper layers)', () => {
    // Deterministic level assignment by insertion order:
    //   A=3 (becomes entry point), C=0, D=0, E=0, B=2 (inserted LAST).
    // Map iteration order = insertion order, so after removing A the
    // FIRST remaining node is C (level 0). The naive reassignment picked
    // that first node and set maxLevel=0, orphaning B's level-2 layer.
    // The fix must pick the remaining node with the HIGHEST level (B, 2).
    const hnsw = new HNSWIndex({ m: 4, efConstruction: 50, efSearch: 50 });
    const preset = [3, 0, 0, 0, 2];
    let li = 0;
    hnsw._randomLevel = () => preset[li++];

    const dim = 8;
    const va = randomVec(dim), vc = randomVec(dim), vd = randomVec(dim);
    const ve = randomVec(dim), vb = randomVec(dim);
    hnsw.add('A', va);
    hnsw.add('C', vc);
    hnsw.add('D', vd);
    hnsw.add('E', ve);
    hnsw.add('B', vb);

    expect(hnsw.entryPoint).toBe(0); // A is index 0, highest level
    expect(hnsw.maxLevel).toBe(3);

    hnsw.remove('A'); // remove the entry point

    // maxLevel must reflect the highest REMAINING level (B=2), not C=0.
    expect(hnsw.maxLevel).toBe(2);

    // Every remaining node must be findable via a self-query (distance 0
    // to itself) — proves none were orphaned by the entry-point swap.
    for (const [id, vec] of [['B', vb], ['C', vc], ['D', vd], ['E', ve]]) {
      const res = hnsw.search(vec, hnsw.size);
      expect(res.some(r => r.id === id)).toBe(true);
    }
  });

  it('remove then re-add reuses freed indices (no unbounded vectors growth)', () => {
    const hnsw = new HNSWIndex({ m: 4, efConstruction: 20 });
    const dim = 8;
    const N = 30, M = 10;

    for (let i = 0; i < N; i++) hnsw.add(`n${i}`, randomVec(dim));
    expect(hnsw.vectors.length).toBe(N);

    for (let i = 0; i < M; i++) hnsw.remove(`n${i}`); // punch M holes
    expect(hnsw.size).toBe(N - M);
    expect(hnsw.vectors.length).toBe(N); // holes, not shrunk

    for (let i = 0; i < M; i++) hnsw.add(`new${i}`, randomVec(dim));
    expect(hnsw.size).toBe(N);
    // Re-adds MUST recycle the freed holes instead of appending → length
    // stays at N. Under the old code this grew to N + M.
    expect(hnsw.vectors.length).toBe(N);
    expect(hnsw.freeList.length).toBe(0);
  });

  it('recall quality with 1000 vectors', () => {
    const dim = 32;
    const n = 1000;
    const hnsw = new HNSWIndex({ m: 16, efConstruction: 100, efSearch: 50, metric: 'cosine' });

    const vectors = [];
    for (let i = 0; i < n; i++) {
      const vec = randomVec(dim);
      vectors.push(vec);
      hnsw.add(`d${i}`, vec);
    }

    // Brute force search for ground truth
    const query = randomVec(dim);
    const bruteForce = vectors.map((v, i) => {
      let dot = 0, na = 0, nb = 0;
      for (let j = 0; j < dim; j++) { dot += query[j] * v[j]; na += query[j] * query[j]; nb += v[j] * v[j]; }
      return { id: `d${i}`, dist: 1 - dot / (Math.sqrt(na) * Math.sqrt(nb)) };
    }).sort((a, b) => a.dist - b.dist);

    const k = 10;
    const trueTopK = new Set(bruteForce.slice(0, k).map(r => r.id));
    const hnswResults = hnsw.search(query, k);
    const hnswTopK = new Set(hnswResults.map(r => r.id));

    // Calculate recall@10
    let hits = 0;
    for (const id of hnswTopK) {
      if (trueTopK.has(id)) hits++;
    }
    const recall = hits / k;

    // HNSW should have at least 70% recall with these params
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  // Found while building examples/agent-memory-hnsw: _selectNeighbors/
  // _pruneNeighbors used to pick the M raw-closest candidates with no
  // diversity check, so many exact-duplicate vectors could monopolize
  // every neighbor slot around them, fragmenting the graph. Verified live:
  // recall collapsed from 1.0 to 0.0 with just 2x exact duplication. Fixed
  // with the HNSW paper's diversity heuristic (a candidate is only kept if
  // it's closer to the query than to every already-selected neighbor).
  it('diversity-aware neighbor selection keeps recall high even with many exact-duplicate vectors', () => {
    const dim = 16;
    const hnsw = new HNSWIndex({ m: 8, efConstruction: 50, efSearch: 30, metric: 'cosine' });
    const vectors = [];

    // 20 unique vectors, each inserted 5 times under different ids (exact
    // duplicates) -- the degeneracy this fix targets.
    for (let g = 0; g < 20; g++) {
      const base = randomVec(dim);
      for (let dup = 0; dup < 5; dup++) {
        const id = `g${g}-d${dup}`;
        vectors.push({ id, vec: base });
        hnsw.add(id, base);
      }
    }

    const query = vectors[0].vec;
    const bruteForce = vectors.map(({ id, vec }) => {
      let dot = 0, na = 0, nb = 0;
      for (let j = 0; j < dim; j++) { dot += query[j] * vec[j]; na += query[j] * query[j]; nb += vec[j] * vec[j]; }
      return { id, dist: 1 - dot / (Math.sqrt(na) * Math.sqrt(nb)) };
    }).sort((a, b) => a.dist - b.dist);

    const k = 10;
    const trueTopK = new Set(bruteForce.slice(0, k).map((r) => r.id));
    const hnswResults = hnsw.search(query, k);
    const hits = hnswResults.filter((r) => trueTopK.has(r.id)).length;
    expect(hits / k).toBeGreaterThanOrEqual(0.8);
  });

  it('_randomLevel is finite and bounded when Math.random() returns 0', () => {
    const hnsw = new HNSWIndex({ m: 4, efConstruction: 20 });
    const originalRandom = Math.random;
    // Force Math.random to always return 0 — would have hung the process.
    Math.random = () => 0;
    try {
      const level = hnsw._randomLevel();
      // Must be a finite integer, not Infinity/NaN, and capped at 32.
      expect(Number.isFinite(level)).toBe(true);
      expect(Number.isInteger(level)).toBe(true);
      expect(level).toBeLessThanOrEqual(32);
      expect(level).toBeGreaterThanOrEqual(0);

      // Add must not hang and must produce a finite level assignment.
      hnsw.add('zero-rand', [1, 0, 0, 0]);
      expect(hnsw.size).toBe(1);
      expect(Number.isFinite(hnsw.maxLevel)).toBe(true);
      expect(hnsw.maxLevel).toBeLessThanOrEqual(32);

      // search still works.
      const res = hnsw.search([1, 0, 0, 0], 1);
      expect(res.length).toBe(1);
      expect(res[0].id).toBe('zero-rand');
    } finally {
      Math.random = originalRandom; // restore — never leak the global mock
    }
  });
});
