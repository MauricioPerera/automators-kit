/**
 * Vector memory — transport-agnostic operations over a `VectorStore`
 * (core/vector.js). Shared by setup.js and the regression test.
 *
 * Real cosine-similarity ranking, not core/memory.js's keyword recall — see
 * README.md for when to reach for which.
 */

import { embed } from './embed.js';

const COLLECTION = 'notes';
const DIM = 64;

/**
 * @param {import('../../core/vector.js').VectorStore} store
 */
export function buildVectorTools(store) {
  return {
    /** Index a note: embed its text and store the vector + metadata. */
    index: async (args) => {
      const id = args.id || `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const vector = embed(args.text, DIM);
      store.set(COLLECTION, id, vector, { text: args.text, tag: args.tag || null, createdAt: Date.now() });
      store.flush();
      return { id, tag: args.tag || null };
    },

    /** Semantic search: embed the query, rank stored notes by cosine similarity. */
    search: async (args) => {
      const vector = embed(args.query, DIM);
      const filter = args.tag ? { tag: args.tag } : null;
      const results = store.search(COLLECTION, vector, args.limit || 5, 0, 'cosine', filter);
      return results.map((r) => ({
        id: r.id,
        score: Number(r.score.toFixed(4)),
        text: r.metadata.text,
        tag: r.metadata.tag,
      }));
    },

    /** Remove a note. */
    forget: async (args) => {
      const removed = store.remove(COLLECTION, args.id);
      store.flush();
      return { id: args.id, removed };
    },

    /** How many notes are indexed. */
    stats: async () => ({ count: store.count(COLLECTION) }),
  };
}

export { COLLECTION, DIM };
