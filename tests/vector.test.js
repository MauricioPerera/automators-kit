/**
 * Tests: core/vector.js
 */

import { describe, it, expect } from 'bun:test';
import {
  VectorStore, QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore,
  IVFIndex, BM25Index, SimpleTokenizer, MemoryStorageAdapter,
  normalize, cosineSim, euclideanDist, dotProduct, manhattanDist, computeScore,
  matchFilter, Reranker,
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

    // INT8 quantization is lossy by design — asserting the exact top-1
    // always matches is flaky by construction (measured empirically: 498/500
    // over random trials, i.e. it genuinely fails ~0.4% of the time on a
    // near-tie the quantization noise flips). The real guarantee is that the
    // quantized store finds something close to the true best match, not
    // exactly it — asserting the float32 top-1 shows up within the
    // quantized top-3 held 500/500 over the same trials.
    const rq8Ids = rq8.slice(0, 3).map((r) => r.id);
    expect(rq8Ids).toContain(r32[0].id);
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

  // FIX-07 Hallazgo 1: build con sampleDims debe clusterizar sobre los primeros
  // `sampleDims` componentes (no sobre dim completa), de forma consistente con
  // _getCandidates. Una query truncada (Matryoshka) debe caer en el cluster
  // correcto y devolver el vecino verdadero.
  it('build con sampleDims clusteriza sobre dims truncadas y recall es consistente', () => {
    const dim = 32;
    const sampleDims = 8;
    const store = new VectorStore(new MemoryStorageAdapter(), dim);

    // 5 grupos bien separados en los primeros `sampleDims` componentes;
    // las dims 8..31 (fuera de sampleDims) llevan ruido grande y distinto
    // por vector para que clusterizar sobre dim completa agruparía distinto.
    const groups = 5, perGroup = 6;
    for (let g = 0; g < groups; g++) {
      for (let j = 0; j < perGroup; j++) {
        const v = new Array(dim).fill(0);
        // primer componente = separación de grupo (domina en espacio truncado)
        v[0] = g * 1000;
        // dim 1: perturbación única por vector (para que el target sea top-1)
        v[1] = j * 0.001;
        // dims 8..31: ruido grande y distinto (scramble fuera de sampleDims)
        for (let d = sampleDims; d < dim; d++) v[d] = ((g * 31 + j * 17 + d) % 97) * 1000;
        store.set('c', `g${g}j${j}`, v);
      }
    }
    store.flush();

    const ivf = new IVFIndex(store, /*numClusters*/ 5, /*numProbes*/ 1);
    const built = ivf.build('c', sampleDims);

    // Estructural: los centroides quedaron en dimensión sampleDims (no dim).
    const idx = ivf._loadIndex('c');
    expect(idx.sampleDims).toBe(sampleDims);
    expect(idx.centroids[0].length).toBe(sampleDims);

    // Funcional: query truncado = primeros sampleDims del target.
    const targetId = 'g2j3';
    const tFull = store.get('c', targetId).vector;
    const q = tFull.slice(0, sampleDims);

    const results = ivf.search('c', q, 5);
    expect(results.length).toBeGreaterThan(0);
    // "Consistente" = el top-1 es el propio target (cosine sobre los primeros
    // sampleDims = 1.0) y su cluster fue sondeado gracias al clustering truncado.
    expect(results[0].id).toBe(targetId);
    expect(built.numClusters).toBe(5);
  });
});

describe('matchFilter $regex (FIX-07 Hallazgo 2: ReDoS)', () => {
  it('rechaza patrón catastrófico ANTES de ejecutar .test() (no cuelga)', () => {
    // (a+)+$ contra un string largo es ReDoS catastrófico. Debe lanzar
    // rápido, no colgar el event loop. Timeout bajo: si el fix falla, el test
    // muere por timeout en vez de colgar la suite.
    const evil = '(a+)+$';
    const longString = 'a'.repeat(50_000);
    expect(() => matchFilter({ x: longString }, { x: { $regex: evil } }))
      .toThrow(/\$regex/);
  }, 2000);

  it('patrones $regex normales siguen funcionando igual que antes', () => {
    expect(matchFilter({ name: 'AI-123' }, { name: { $regex: '^AI' } })).toBe(true);
    expect(matchFilter({ name: 'ML-123' }, { name: { $regex: '^AI' } })).toBe(false);
    expect(matchFilter({ tags: 'vector-db' }, { tags: { $regex: 'vector' } })).toBe(true);
    // patrón cerca del límite de longitud pero válido
    const ok = 'a'.repeat(100);
    expect(matchFilter({ x: 'a'.repeat(150) }, { x: { $regex: ok } })).toBe(true);
    // RegExp object ya construido sigue aceptándose
    expect(matchFilter({ x: 'hello' }, { x: { $regex: /^he/ } })).toBe(true);
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

// FIX-21: Reranker.crossModelSearch indexa respuesta de API externa sin
// bounds check sobre r.index. Construye sources con un VectorStore real y
// stubbeando Reranker.rank para devolver índices controlados.
describe('Reranker.crossModelSearch (FIX-21: bounds check sobre r.index)', () => {
  function makeSources() {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'd0', [1, 0, 0, 0], { text: 'alpha' });
    store.set('col', 'd1', [0, 1, 0, 0], { text: 'beta'  });
    store.set('col', 'd2', [0, 0, 1, 0], { text: 'gamma' });
    store.flush();
    return [{ store, collection: 'col', queryVector: [1, 0, 0, 0] }];
  }

  it('salta índices fuera de rango / undefined sin lanzar y devuelve los válidos', async () => {
    const reranker = new Reranker({ apiUrl: 'http://x', apiToken: 't' });
    // Respuesta maliciosa/de un provider buggy: 99 fuera de rango, undefined,
    // un string, y negativo. Sólo 0 y 1 son válidos (allCandidates.length=3).
    reranker.rank = async () => ([
      { index: 0,       score: 0.9 },
      { index: 99,      score: 0.8 }, // fuera de rango
      { index: undefined, score: 0.7 }, // ausente
      { index: 'x',     score: 0.6 }, // no entero
      { index: -1,      score: 0.5 }, // negativo
      { index: 1,       score: 0.4 },
    ]);

    const results = await reranker.crossModelSearch('q', makeSources(), { limit: 5 });

    // No lanza; los inválidos se saltan; sólo quedan los dos válidos.
    expect(results.length).toBe(2);
    expect(results.map(r => r.id)).toEqual(['d0', 'd1']);
    expect(results[0].score).toBe(0.9);
    expect(results[1].score).toBe(0.4);
  });

  it('caso normal (todos los índices válidos) sigue funcionando igual que antes', async () => {
    const reranker = new Reranker({ apiUrl: 'http://x', apiToken: 't' });
    reranker.rank = async () => ([
      { index: 2, score: 0.95 },
      { index: 0, score: 0.80 },
      { index: 1, score: 0.70 },
    ]);

    const results = await reranker.crossModelSearch('q', makeSources(), { limit: 5 });

    expect(results.length).toBe(3);
    expect(results.map(r => r.id)).toEqual(['d2', 'd0', 'd1']);
    expect(results.map(r => r.score)).toEqual([0.95, 0.80, 0.70]);
    // metadata y collection se propagan correctamente
    expect(results[0].metadata.text).toBe('gamma');
    expect(results[0].collection).toBe('col');
  });
});

// FIX-36 Hallazgo 1: _cosinePolar reportaba scores de "coseno" fuera de [-1,1]
// porque dividía solo por |query| y no por |stored|. La norma del vector
// reconstruido con _pairs pares (cos,sin) normalizados es sqrt(pairs), así que
// el score escalaba con sqrt(pairs) y podía exceder 1. El coseno real divide por
// |query| * |stored|.
describe('PolarQuantizedStore cosine scale (FIX-36 Hallazgo 1)', () => {
  it('todo score de búsqueda cae dentro de [-1, 1] (tolerancia FP)', () => {
    const dim = 8; // _pairs = 4 → norma stored = sqrt(4) = 2; bug daba score ~2x
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim);
    for (let i = 0; i < 30; i++) store.set('c', `d${i}`, randomVec(dim));
    store.flush();

    const results = store.search('c', randomVec(dim), 30);
    expect(results.length).toBe(30);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1.0001);
      expect(r.score).toBeLessThanOrEqual(1.0001);
    }
  });

  it('self-query no excede 1 (antes del fix daba ~sqrt(pairs))', () => {
    const dim = 4; // _pairs = 2 → bug producía score ~sqrt(2) ≈ 1.414
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim);
    const v = [0.7, 0.3, -0.2, 0.6];
    store.set('c', 'self', v);
    store.flush();

    const results = store.search('c', v, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('self');
    // coseno verdadero de un vector consigo mismo ≤ 1
    expect(results[0].score).toBeLessThanOrEqual(1 + 1e-9);
    expect(results[0].score).toBeGreaterThanOrEqual(-1 - 1e-9);
  });
});

// FIX-36 Hallazgo 2: TopKHeap con k=0 lanzaba TypeError al acceder this.data[0]
// en push. Alcanzable vía limit=0 en search / matryoshkaSearch / searchAcross.
describe('TopKHeap k=0 / limit=0 no lanza (FIX-36 Hallazgo 2)', () => {
  it('search con limit=0 retorna [] sin lanzar', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('col', 'a', [1, 0, 0, 0]);
    store.set('col', 'b', [0, 1, 0, 0]);
    store.flush();
    expect(() => store.search('col', [1, 0, 0, 0], 0)).not.toThrow();
    const results = store.search('col', [1, 0, 0, 0], 0);
    expect(results).toEqual([]);
  });

  it('PolarQuantizedStore.search con limit=0 retorna [] sin lanzar', () => {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), 4);
    store.set('c', 'a', [1, 0, 0, 0]);
    store.flush();
    expect(() => store.search('c', [1, 0, 0, 0], 0)).not.toThrow();
    expect(store.search('c', [1, 0, 0, 0], 0)).toEqual([]);
  });

  it('matryoshkaSearch con limit=0 retorna [] sin lanzar', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 8);
    store.set('c', 'a', [1, 0, 0, 0, 0, 0, 0, 0]);
    store.flush();
    expect(() => store.matryoshkaSearch('c', [1, 0, 0, 0, 0, 0, 0, 0], 0))
      .not.toThrow();
    expect(store.matryoshkaSearch('c', [1, 0, 0, 0, 0, 0, 0, 0], 0)).toEqual([]);
  });

  it('searchAcross con limit=0 retorna [] sin lanzar', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 4);
    store.set('a', 'x', [1, 0, 0, 0]);
    store.set('b', 'y', [0, 1, 0, 0]);
    store.flush();
    expect(() => store.searchAcross(['a', 'b'], [1, 0, 0, 0], 0)).not.toThrow();
    expect(store.searchAcross(['a', 'b'], [1, 0, 0, 0], 0)).toEqual([]);
  });
});

// CORRECTNESS (2026-08-03, verified from a full-codebase audit lead):
// searchAcross min-max normalized EACH collection independently before
// merging, destroying the only thing that made the scores comparable -- they
// all come from the same query under the same metric. Every collection's best
// hit was rescaled to exactly 1.0 no matter how irrelevant, and a collection
// returning a single result got 1.0 unconditionally.
describe('searchAcross ranks on true similarity, not per-collection rank', () => {
  const build = () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 3);
    // 'good' is genuinely close to [1,0,0]; 'junk' is orthogonal/opposite.
    store.set('good', 'g1', [1, 0, 0]);
    store.set('good', 'g2', [0.99, 0.14, 0]);
    store.set('good', 'g3', [0.98, 0.20, 0]);
    store.set('junk', 'j1', [0, 1, 0]);
    store.set('junk', 'j2', [0, 0.9, 0.4]);
    store.set('junk', 'j3', [-1, 0, 0]);
    store.flush();
    return store;
  };

  it('does not let an orthogonal vector tie a perfect match', () => {
    const results = build().searchAcross(['good', 'junk'], [1, 0, 0], 3, 'cosine');
    // Before the fix this returned junk/j1=1.0, good/g1=1.0, junk/j2=1.0.
    expect(results.map((r) => r.id)).toEqual(['g1', 'g2', 'g3']);
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  it('returns the real similarity, not a rescaled rank', () => {
    const results = build().searchAcross(['good', 'junk'], [1, 0, 0], 6, 'cosine');
    const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
    expect(byId.g2).toBeCloseTo(0.9901, 3);
    expect(byId.j3).toBeCloseTo(-1.0, 3);   // was rescaled to 0.0 (or 1.0 alone)
  });

  it('a collection returning ONE result is not forced to 1.0', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 3);
    store.set('a', 'a1', [1, 0, 0]);
    store.set('a', 'a2', [0.91, 0.41, 0]);
    store.set('b', 'b1', [-0.9988, 0.05, 0]); // near-opposite
    store.flush();
    const results = store.searchAcross(['a', 'b'], [1, 0, 0], 3, 'cosine');
    // Before: b1 scored 1.0 and outranked a2 (0.91).
    expect(results.map((r) => r.id)).toEqual(['a1', 'a2', 'b1']);
    expect(results[2].score).toBeLessThan(0);
  });

  it('a single collection is unaffected', () => {
    const store = build();
    expect(store.searchAcross(['good'], [1, 0, 0], 2, 'cosine').map((r) => r.id)).toEqual(['g1', 'g2']);
  });
});

// CORRECTNESS (2026-08-03, verified from a full-codebase audit lead): IVF's
// `assignments` array is positional (slot i -> cluster), but
// VectorStore.remove() splices the vector out and renumbers every later
// position, and nothing invalidated the index. After a single delete, slot i
// described a DIFFERENT vector than the one it was clustered from. Measured
// before the fix: deleting one cluster made a query sitting squarely inside
// another return the wrong cluster entirely -- recall 0/4, cosines
// 0.000-0.003 where the exact scan returned 1.000.
describe('IVFIndex survives mutations of the underlying collection', () => {
  const buildFixture = () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 2);
    const centers = { C0: [10, 0], C1: [0, 10], C2: [-10, 0], C3: [0, -10] };
    for (const [name, [x, y]] of Object.entries(centers)) {
      for (let i = 0; i < 4; i++) store.set('v', `${name}_${i}`, [x + i * 0.01, y + i * 0.01]);
    }
    store.flush();
    const ivf = new IVFIndex(store, 4, 1); // probe a single cluster
    ivf.build('v');
    return { store, ivf };
  };

  it('still returns the right cluster after deletions renumber positions', () => {
    const { store, ivf } = buildFixture();
    for (let i = 0; i < 4; i++) store.remove('v', `C0_${i}`);
    store.flush();

    const query = [0, 10]; // squarely inside C1
    const exact = store.search('v', query, 4, 0, 'cosine').map((r) => r.id);
    const got = ivf.search('v', query, 4, 'cosine').map((r) => r.id);
    expect(got).toEqual(exact);
    expect(got.every((id) => id.startsWith('C1_'))).toBe(true);
  });

  it('finds vectors ADDED after build (they used to be invisible)', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 2);
    store.set('v', 'old1', [1, 0]);
    store.set('v', 'old2', [0, 1]);
    store.flush();
    const ivf = new IVFIndex(store, 2, 2);
    ivf.build('v');

    store.set('v', 'NEW_PERFECT', [1, 0]);
    store.flush();
    expect(ivf.search('v', [1, 0], 3, 'cosine').map((r) => r.id)).toContain('NEW_PERFECT');
  });

  it('keeps full recall against an exact scan after many deletes', () => {
    const store = new VectorStore(new MemoryStorageAdapter(), 8);
    const rnd = () => Array.from({ length: 8 }, () => Math.random() * 2 - 1);
    for (let i = 0; i < 120; i++) store.set('v', `id${i}`, rnd());
    store.flush();
    const ivf = new IVFIndex(store, 6, 6); // probe every cluster -> must match exactly
    ivf.build('v');
    for (let i = 0; i < 40; i++) store.remove('v', `id${i}`);
    store.flush();

    for (let t = 0; t < 5; t++) {
      const query = rnd();
      const exact = store.search('v', query, 5, 0, 'cosine').map((r) => r.id);
      const got = ivf.search('v', query, 5, 'cosine').map((r) => r.id);
      expect(got).toEqual(exact);
    }
  });

  it('reports drift so a due rebuild is observable rather than guesswork', () => {
    const { store, ivf } = buildFixture();
    expect(ivf.indexStats('v').stale).toBe(false);

    store.remove('v', 'C0_0');
    store.set('v', 'brand_new', [5, 5]);
    store.flush();
    const stats = ivf.indexStats('v');
    expect(stats.removedSinceBuild).toBe(1);
    expect(stats.addedSinceBuild).toBe(1);
    expect(stats.stale).toBe(true);
  });

  it('a freshly built index over an untouched collection matches the exact scan', () => {
    const { store, ivf } = buildFixture();
    const query = [0, 10];
    expect(ivf.search('v', query, 4, 'cosine').map((r) => r.id))
      .toEqual(store.search('v', query, 4, 0, 'cosine').map((r) => r.id));
  });
});
