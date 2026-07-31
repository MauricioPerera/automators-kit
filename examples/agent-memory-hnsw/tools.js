/**
 * Shared handlers for the agent-memory-hnsw example: index core/memory.js's
 * AgentMemory content into core/hnsw.js's standalone HNSWIndex too, and
 * compare 3 recall strategies over the SAME real memory content as it
 * grows: memory.js's own keyword recall, HNSW approximate semantic
 * search, and a brute-force exact cosine scan (the ANN recall-quality
 * ground truth) — same benchmark methodology as
 * examples/large-catalog-search/tools.js, applied to real agent memory
 * instead of a synthetic product catalog.
 */

import { embed } from '../vector-memory/embed.js';

const DIM = 64;

/**
 * @param {import('../../core/memory.js').AgentMemory} memory
 * @param {import('../../core/hnsw.js').HNSWIndex} hnsw
 * @param {import('../../core/db.js').DocStore} db
 * @param {string} agentId
 */
export function buildHnswMemoryTools(memory, hnsw, db, agentId) {
  // AgentMemory has no getById() of its own -- same documented pattern as
  // examples/job-queue reaching core/queue.js's underlying collection
  // directly: `_mem_sem_${agentId}` is memory.js's own, real collection
  // naming convention (core/memory.js's constructor), not an internal
  // implementation detail invented here.
  const semanticCol = db.collection(`_mem_sem_${agentId}`);

  // HNSWIndex only stores vectors internally for graph traversal -- it has
  // no id->vector lookup of its own, so the brute-force comparator (which
  // needs to scan every vector directly, not via the graph) keeps its own
  // copy, same reason as large-catalog-search/tools.js.
  const vectors = new Map();

  function learn(title, text, tags = []) {
    const entry = memory.storeDoc({ title, content: text, tags });
    const v = embed(text, DIM);
    vectors.set(entry._id, v);
    hnsw.add(entry._id, v);
    return { id: entry._id, title };
  }

  function seed(episodes) {
    for (const ep of episodes) learn(ep.title, ep.text);
    return { indexed: episodes.length, total: hnsw.size };
  }

  function recallSemantic(query, k = 5) {
    const start = performance.now();
    const hits = hnsw.search(embed(query, DIM), k);
    const results = hits.map((h) => ({ id: h.id, title: semanticCol.findById(h.id)?.title, score: Number(h.score.toFixed(4)) }));
    return { results, ms: performance.now() - start };
  }

  function recallExact(query, k = 5) {
    const qv = embed(query, DIM);
    const start = performance.now();
    const scored = [];
    for (const [id, v] of vectors) scored.push({ id, score: 1 - _cosineDist(qv, v) });
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, k).map((r) => ({ ...r, title: semanticCol.findById(r.id)?.title, score: Number(r.score.toFixed(4)) }));
    return { results, ms: performance.now() - start };
  }

  function recallKeyword(query, k = 5) {
    const start = performance.now();
    const hits = memory.recall(query, k, { type: 'documentation' });
    const results = hits.map((h) => ({ id: h._id, title: h.title, score: Number(h._score.toFixed(4)) }));
    return { results, ms: performance.now() - start };
  }

  /**
   * Run all 3 strategies for the same query. Honest trade-off (see
   * README): HNSW is fast but approximate — `recall` (how many of the
   * EXACT top-k it actually found) is not guaranteed to be 1.
   */
  function benchmark(query, k = 5) {
    const semantic = recallSemantic(query, k);
    const exact = recallExact(query, k);
    const keyword = recallKeyword(query, k);
    const exactIds = new Set(exact.results.map((r) => r.id));
    const overlap = semantic.results.filter((r) => exactIds.has(r.id)).length;
    return {
      query,
      k,
      semanticMs: round(semantic.ms),
      exactMs: round(exact.ms),
      keywordMs: round(keyword.ms),
      speedupVsExact: exact.ms > 0 ? round(exact.ms / Math.max(semantic.ms, 0.001)) : null,
      recallVsExact: overlap / k,
      semanticResults: semantic.results,
      exactResults: exact.results,
      keywordResults: keyword.results,
    };
  }

  function stats() {
    return { memory: memory.stats(), hnsw: hnsw.stats(), vectorsTracked: vectors.size };
  }

  return { learn, seed, recallSemantic, recallExact, recallKeyword, benchmark, stats };
}

function round(ms) { return Math.round(ms * 1000) / 1000; }

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
