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
});
