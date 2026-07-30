/**
 * Hybrid recall — transport-agnostic operations combining core/memory.js's
 * keyword recall (fast, free, zero setup) with core/vector.js's cosine
 * similarity as a coverage fallback. Shared by setup.js and the
 * regression test.
 *
 * Reuses examples/vector-memory's own offline embedding (embed.js) rather
 * than duplicating it — same hashing-trick function, same honest caveat:
 * it has no notion of synonyms or meaning, only word overlap. See
 * README.md for what "hybrid" honestly means here, verified empirically
 * before writing a line of this file: it is NOT a semantic fallback for
 * paraphrases (verified live — a true paraphrase can rank an unrelated
 * stored doc higher than the real match). The real, defensible value is
 * coverage: memory.recall() returns a hard `[]` when no query term is
 * even a substring anywhere in a stored doc; store.search() never
 * hard-empties — it always ranks *something* by cosine similarity, which
 * is strictly better than nothing when the keyword layer has nothing to
 * go on, as long as the caller is told it's a lower-confidence result.
 */

import { embed } from '../vector-memory/embed.js';

const VECTOR_COLLECTION = 'knowledge';
const DIM = 64;
// Below this cosine score, a vector-layer result is flagged low-confidence
// rather than presented as if it were a real match. Chosen empirically
// (see README) against a small calibration sample: 5 on-topic queries
// scored 0.61-0.74 against their real matching doc; 5 topically-unrelated
// queries (no real word overlap with any stored doc) scored 0.13-0.49
// against their nearest match. 0.5 is the highest value that still
// separates the two groups in that sample — NOT a statistically rigorous
// guarantee, this hashing-trick embedding is crude enough that noise and
// signal ranges can plausibly overlap on a different corpus. Treat
// `lowConfidence: false` as "more likely real" than a hard promise.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * @param {import('../../core/memory.js').AgentMemory} memory
 * @param {import('../../core/vector.js').VectorStore} store
 */
export function buildHybridRecall(memory, store) {
  return {
    /** Store a piece of knowledge in BOTH layers, same id, same text. */
    learn: async (args) => {
      const entry = memory.storeDoc({ title: args.title, content: args.text, tags: args.tags || [] });
      store.set(VECTOR_COLLECTION, entry._id, embed(args.text, DIM), { title: args.title, text: args.text });
      store.flush();
      return { id: entry._id, title: args.title };
    },

    /**
     * Try memory.js's keyword recall first. Only when it returns a true
     * empty (zero shared vocabulary — not merely a low score) does this
     * fall back to vector.js's cosine search.
     */
    recall: async (args) => {
      const limit = args.limit || 5;
      const keywordHits = memory.recall(args.query, limit, { type: 'documentation' });

      if (keywordHits.length > 0) {
        return {
          source: 'keyword',
          results: keywordHits.map((h) => ({ id: h._id, title: h.title, score: Number(h._score.toFixed(3)) })),
        };
      }

      const vectorHits = store.search(VECTOR_COLLECTION, embed(args.query, DIM), limit);
      const topScore = vectorHits[0]?.score ?? 0;
      return {
        source: 'vector',
        lowConfidence: topScore < LOW_CONFIDENCE_THRESHOLD,
        results: vectorHits.map((h) => ({ id: h.id, title: h.metadata.title, score: Number(h.score.toFixed(3)) })),
      };
    },

    stats: async () => ({
      memory: memory.stats(),
      vectors: store.count(VECTOR_COLLECTION),
    }),
  };
}

export { VECTOR_COLLECTION, DIM, LOW_CONFIDENCE_THRESHOLD };
