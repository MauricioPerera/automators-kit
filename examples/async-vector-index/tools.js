/**
 * Async vector indexing: embedding + VectorStore.set() run inside a
 * core/queue.js job, off the HTTP request path entirely — a document
 * submitted via POST /api/documents is NOT immediately searchable; it
 * becomes searchable once its "index-document" job actually completes.
 * That's the honest, intentional trade-off this example exists to
 * demonstrate (eventual consistency, not a bug) — every other vector
 * search example (examples/vector-memory, examples/large-catalog-search,
 * examples/hybrid-catalog-search, examples/cms-semantic-search) indexes
 * synchronously, in the same call that submits the document.
 *
 * Reuses examples/vector-memory's own embed.js directly (same pattern
 * examples/mcp-job-queue reuses examples/job-queue's tools.js) rather
 * than duplicating the offline hashing-trick embedding.
 */

import { embed } from '../vector-memory/embed.js';

export const COLLECTION = 'documents';
export const DIM = 64;

/**
 * @param {import('../../core/vector.js').VectorStore} store
 * @param {import('../../core/queue.js').JobQueue} queue
 */
export function buildAsyncVectorTools(store, queue) {
  return {
    /** Enqueue a document for background indexing. Returns immediately, NOT yet searchable. */
    submit(args) {
      const id = args.id || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const job = queue.enqueue('index-document', { id, text: args.text, tag: args.tag || null });
      return { id, jobId: job._id, status: job.status };
    },

    /** Semantic search over whatever has finished indexing so far. */
    search(args) {
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

    /** Check a specific indexing job's status. */
    jobStatus(jobId) {
      return queue.list({ limit: 200 }).find((j) => j._id === jobId) || null;
    },

    stats() {
      return { indexed: store.count(COLLECTION), queue: queue.stats() };
    },
  };
}

/**
 * The 'index-document' job handler: embed + store.set() + flush, off the
 * request path.
 *
 * `embedDelayMs` simulates a real embeddings API's network round trip.
 * Without it, this demo's offline embed() (see embed.js) is fully
 * synchronous, so a job with NO real `await` inside it runs its whole
 * body synchronously the moment `enqueue()` calls `_poll()` internally
 * (core/queue.js's `enqueue()` triggers an immediate poll when already
 * started) -- `store.set()` would already have happened before the
 * caller's very next line even runs, making the "not searchable until
 * the job completes" behavior this example exists to demonstrate
 * unobservable in practice (verified live: without a delay, an
 * immediate search right after submit() DOES find the document). A real
 * embeddings API call has genuine network latency, so this gap is real
 * in production regardless of what a local demo's fast path does.
 */
export function buildIndexHandler(store, embedDelayMs = 30) {
  return async ({ id, text, tag }) => {
    if (embedDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, embedDelayMs));
    const vector = embed(text, DIM);
    store.set(COLLECTION, id, vector, { text, tag, indexedAt: Date.now() });
    store.flush();
    return { id, indexed: true };
  };
}
