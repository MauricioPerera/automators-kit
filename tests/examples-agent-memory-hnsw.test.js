/**
 * Agent Memory HNSW — end-to-end regression test.
 * Mirrors examples/agent-memory-hnsw/setup.js (reuses tools.js/episodes.js
 * so the demo and test can't drift apart). Small memory size (560) for
 * speed on most tests here -- setup.js's own live walkthrough uses the
 * full 5000-entry scale. The timing-comparison test uses its own larger
 * (2000-entry) `benchTools` fixture instead; see that test for why.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { AgentMemory } from '../core/memory.js';
import { HNSWIndex } from '../core/hnsw.js';
import { generateEpisodes } from '../examples/agent-memory-hnsw/episodes.js';
import { buildHnswMemoryTools } from '../examples/agent-memory-hnsw/tools.js';

let tools;
let benchTools;

beforeAll(async () => {
  const app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'agent-memory-hnsw-test-secret!!!' });
  const memory = new AgentMemory(app.cms.db, { agentId: 'test-agent' });
  const hnsw = new HNSWIndex({ m: 16, efConstruction: 100, efSearch: 40 });
  tools = buildHnswMemoryTools(memory, hnsw, app.cms.db, 'test-agent');
  tools.seed(generateEpisodes(560)); // exactly 1 per unique template, no duplication

  // Separate, larger-scale dataset for the semantic-vs-exact timing
  // comparison only (see that test for why 560 entries isn't enough).
  // Kept out of the shared `tools` fixture above so the other tests here
  // stay fast and their entry-count assertions (e.g. stats.memory.types.docs)
  // don't have to track an inflated seed size.
  const benchMemory = new AgentMemory(app.cms.db, { agentId: 'bench-agent' });
  const benchHnsw = new HNSWIndex({ m: 16, efConstruction: 100, efSearch: 40 });
  benchTools = buildHnswMemoryTools(benchMemory, benchHnsw, app.cms.db, 'bench-agent');
  benchTools.seed(generateEpisodes(2000));
});

describe('Agent memory HNSW: indexes real memory content into both layers', () => {
  it('learn() stores in AgentMemory and HNSWIndex with the same id', () => {
    const text = 'a manually added troubleshooting note about redis timeouts';
    const { id } = tools.learn('Manual note', text);
    const stats = tools.stats();
    expect(stats.memory.types.docs).toBe(561);
    expect(stats.hnsw.count).toBe(561);
    // Query with the exact stored text -- a real self-match (score 1), not
    // a paraphrase. The offline hashing-trick embedding (same one
    // examples/hybrid-recall documents) has no synonym understanding, so a
    // short 3-word query like "redis timeouts" alone is not guaranteed to
    // rank its own longer source sentence above 560+ other entries sharing
    // common words like "timeouts"/"connection" -- verified live before
    // writing this assertion, not assumed.
    const semantic = tools.recallSemantic(text, 1);
    expect(semantic.results[0].id).toBe(id);
    expect(semantic.results[0].score).toBe(1);
  });
});

describe('Agent memory HNSW: 3-way benchmark over real memory content', () => {
  it('semantic (HNSW) and exact (brute-force) agree on the top result — no duplicate-vector degeneracy in this dataset', () => {
    const b = tools.benchmark('database connection timeout', 5);
    expect(b.semanticResults[0].score).toBe(b.exactResults[0].score);
    expect(b.recallVsExact).toBeGreaterThanOrEqual(0.8);
  });

  it('keyword recall never hard-empties are separate concerns from semantic recall — all 3 strategies return something for an on-topic query', () => {
    const b = tools.benchmark('database connection timeout', 5);
    expect(b.semanticResults.length).toBe(5);
    expect(b.exactResults.length).toBe(5);
    expect(b.keywordResults.length).toBeGreaterThan(0);
  });

  it('semantic search is measurably faster than the brute-force exact scan over the same data', () => {
    // Root cause of the ~1-in-5 flake this used to have: at the 560-entry
    // size the other tests in this file use (kept small for their own
    // speed), both operations complete in well under a millisecond, so the
    // real HNSW-vs-brute-force gap (confirmed by profiling: HNSW is faster
    // on average) is smaller than ordinary measurement noise -- OS
    // scheduling, GC, JIT jitter -- and a single performance.now() sample
    // occasionally comes out the wrong way round. Brute-force scan cost
    // grows linearly with N while HNSW's stays ~flat, so `benchTools`
    // (2000 entries, built in beforeAll above) makes the gap large enough
    // (consistently several-hundred-microseconds-to-milliseconds, verified
    // live: 0 inversions across dozens of runs) to clear the noise floor
    // outright. Still take the median over a few trials as defense in
    // depth -- this runs once, it doesn't retry the test until it passes.
    const TRIALS = 5;
    const semMs = [];
    const exactMs = [];
    for (let i = 0; i < TRIALS; i++) {
      const b = benchTools.benchmark('database connection timeout', 5);
      semMs.push(b.semanticMs);
      exactMs.push(b.exactMs);
    }
    const median = (arr) => arr.slice().sort((a, c) => a - c)[Math.floor(arr.length / 2)];
    expect(median(semMs)).toBeLessThan(median(exactMs));
  });
});

describe('Agent memory HNSW: regression coverage for the diversity-aware neighbor selection fix', () => {
  it('recall stays high even when the same content is learned multiple times under different ids (exact-duplicate vectors)', () => {
    // core/hnsw.js used to collapse to ~0 recall with just 2x exact
    // duplication before the diversity-aware neighbor selection fix
    // (verified live while building this example) -- this locks that fix
    // in against real agent-memory content, not just synthetic test vectors.
    for (let i = 0; i < 3; i++) tools.learn(`Dup ${i}`, 'a duplicate entry about queue-worker stuck jobs incident');
    const b = tools.benchmark('queue-worker stuck jobs', 5);
    expect(b.recallVsExact).toBeGreaterThanOrEqual(0.6);
  });
});
