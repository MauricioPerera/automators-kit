/**
 * Async Vector Index — end-to-end regression test.
 * Mirrors examples/async-vector-index/setup.js (reuses tools.js's
 * buildAsyncVectorTools/buildIndexHandler so the demo and the test can't
 * drift apart). Uses in-memory adapters for both the CMS db (JobQueue)
 * and the VectorStore, for speed/isolation.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter as CmsMemoryAdapter } from '../adapters/memory.js';
import { VectorStore, MemoryStorageAdapter as VectorMemoryAdapter } from '../core/vector.js';
import { JobQueue } from '../core/queue.js';
import { buildAsyncVectorTools, buildIndexHandler } from '../examples/async-vector-index/tools.js';

let app, store, queue, tools;

async function waitFor(fn, timeoutMs = 3000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

beforeAll(async () => {
  app = await createApp({ adapter: new CmsMemoryAdapter(), secret: 'async-vector-index-test-secret!!!' });
  store = new VectorStore(new VectorMemoryAdapter(), 64);
  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 20, backoffMs: 20, maxRetries: 2 });
  queue.register('index-document', buildIndexHandler(store));
  queue.start();
  tools = buildAsyncVectorTools(store, queue);
});

describe('Async vector index: a submitted document is NOT immediately searchable, only once its job completes', () => {
  it('search finds nothing for a document right after submit(), then finds it once the job finishes', async () => {
    const { id, jobId } = tools.submit({ text: 'the quick brown fox jumps over the lazy dog' });

    // Right after submit(), the indexing job has not necessarily run yet --
    // this is the honest point of the example, not something to work around.
    const immediate = tools.search({ query: 'quick fox' });
    expect(immediate.find((r) => r.id === id)).toBeUndefined();

    const job = await waitFor(() => {
      const j = tools.jobStatus(jobId);
      return j && j.status === 'completed' ? j : null;
    });
    expect(job.result.indexed).toBe(true);

    const after = tools.search({ query: 'quick fox' });
    expect(after.find((r) => r.id === id)).toBeDefined();
  });

  it('multiple documents submitted together (queue concurrency > 1) all become searchable, none lost', async () => {
    const docs = [
      tools.submit({ text: 'cats are independent pets', tag: 'animals' }),
      tools.submit({ text: 'dogs are loyal companions', tag: 'animals' }),
      tools.submit({ text: 'quarterly revenue exceeded projections', tag: 'finance' }),
    ];

    await waitFor(() => docs.every((d) => tools.jobStatus(d.jobId)?.status === 'completed'));

    const animals = tools.search({ query: 'pets', tag: 'animals', limit: 10 });
    const foundIds = new Set(animals.map((r) => r.id));
    expect(foundIds.has(docs[0].id)).toBe(true);
    expect(foundIds.has(docs[1].id)).toBe(true);
    expect(foundIds.has(docs[2].id)).toBe(false); // different tag, correctly excluded
  });

  it('stats() reports both the indexed count and live queue stats', async () => {
    const before = tools.stats();
    const { jobId } = tools.submit({ text: 'a brand new document for stats tracking' });
    await waitFor(() => tools.jobStatus(jobId)?.status === 'completed');
    const after = tools.stats();
    expect(after.indexed).toBe(before.indexed + 1);
    expect(after.queue.completed).toBeGreaterThan(before.queue.completed);
  });
});
