/**
 * Tests: core/vector.js
 */

import { describe, it, expect } from 'bun:test';
import {
  VectorStore, QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore,
  IVFIndex, BM25Index, SimpleTokenizer, MemoryStorageAdapter,
  normalize, cosineSim, euclideanDist, dotProduct, manhattanDist, computeScore,
} from '../core/vector.js';

function randomVec(dim) {
  return Array.from({ length: dim }, () => Math.random() - 0.5);
}

describe('Math utils', () => {
  it('normalize produces unit vector', () => {
    const v = normalize([3, 4]);
    const len = Math.sqrt(v[0] ** 2 + v[1] ** 2);
    expect(len).toBeCloseTo(1, 5);
  });

  it('cosineSim identical = 1', () => {
    const v = [1, 2, 3];
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });

  it('cosineSim orthogonal = 0', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('euclideanDist same = 0', () => {
    expect(euclideanDist([1, 2], [1, 2])).toBeCloseTo(0, 5);
  });

  it('dotProduct', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('manhattanDist', () => {
    expect(manhattanDist([1, 2], [4, 6])).toBe(7);
  });

  it('computeScore dispatches', () => {
    const a = [1, 0], b = [1, 0];
    expect(computeScore(a, b, 2, 'cosine')).toBeCloseTo(1, 3);
  });
});

describe('VectorStore', () => {
  it('set and search', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'a', [1, 0, 0, 0], { title: 'A' });
    store.set('col', 'b', [0, 1, 0, 0], { title: 'B' });
    store.set('col', 'c', [0.9, 0.1, 0, 0], { title: 'C' });
    store.flush();
    const results = store.search('col', [1, 0, 0, 0], 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe('a');
  });

  it('get returns vector + metadata', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'x', [1, 2, 3, 4], { tag: 'test' });
    store.flush();
    const entry = store.get('col', 'x');
    expect(entry).not.toBeNull();
    expect(entry.metadata.tag).toBe('test');
  });

  it('remove', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'x', [1, 0, 0, 0]);
    store.flush();
    expect(store.has('col', 'x')).toBe(true);
    store.remove('col', 'x');
    expect(store.has('col', 'x')).toBe(false);
  });

  it('count and ids', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'a', [1, 0, 0, 0]);
    store.set('col', 'b', [0, 1, 0, 0]);
    store.flush();
    expect(store.count('col')).toBe(2);
    expect(store.ids('col').sort()).toEqual(['a', 'b']);
  });

  it('drop collection', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'a', [1, 0, 0, 0]);
    store.flush();
    store.drop('col');
    expect(store.count('col')).toBe(0);
  });

  it('export and import', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'a', [1, 0, 0, 0], { tag: 'test' });
    store.flush();
    const exported = store.export('col');
    expect(exported.length).toBe(1);
    expect(exported[0].id).toBe('a');

    const store2 = new VectorStore(new MemoryStorageAdapter(), 4);
    store2.import('col', exported);
    store2.flush();
    expect(store2.count('col')).toBe(1);
  });

  it('searchAcross multiple collections', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('a', 'x', [1, 0, 0, 0]);
    store.set('b', 'y', [0.9, 0.1, 0, 0]);
    store.flush();
    const results = store.searchAcross(['a', 'b'], [1, 0, 0, 0], 5);
    expect(results.length).toBe(2);
  });
});

describe('QuantizedStore', () => {
  it('search returns same order as Float32', () => {
    const dim = 32;
    const vecs = Array.from({ length: 20 }, () => randomVec(dim));
    const query = randomVec(dim);

    const f32 = new VectorStore(new MemoryStorageAdapter(), dim);
    const q8 = new QuantizedStore(new MemoryStorageAdapter(), dim);

    vecs.forEach((v, i) => {
      f32.set('c', `d${i}`, v);
      q8.set('c', `d${i}`, v);
    });
    f32.flush(); q8.flush();

    const r32 = f32.search('c', query, 5);
    const rq8 = q8.search('c', query, 5);

    // Top-1 should match
    expect(rq8[0].id).toBe(r32[0].id);
  });
});

describe('BinaryQuantizedStore', () => {
  it('search works', () => {
    const store = new BinaryQuantizedStore(new MemoryStorageAdapter(), 32);
    for (let i = 0; i < 10; i++) store.set('c', `d${i}`, randomVec(32));
    store.flush();
    const results = store.search('c', randomVec(32), 5);
    expect(results.length).toBe(5);
  });
});

describe('IVFIndex', () => {
  it('build + search', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 16);
    for (let i = 0; i < 50; i++) store.set('c', `d${i}`, randomVec(16));
    store.flush();

    const ivf = new IVFIndex(store, 5, 2);
    ivf.build('c');
    expect(ivf.hasIndex('c')).toBe(true);

    const results = ivf.search('c', randomVec(16), 5);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('BM25Index', () => {
  it('keyword search', () => {
    const bm25 = new BM25Index();
    bm25.addDocument('col', 'doc1', 'the quick brown fox');
    bm25.addDocument('col', 'doc2', 'the lazy dog');
    bm25.addDocument('col', 'doc3', 'quick fox jumps');
    const results = bm25.search('col', 'quick fox', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('doc1'); // best match
  });
});
