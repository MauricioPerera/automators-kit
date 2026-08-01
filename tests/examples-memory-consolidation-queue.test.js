/**
 * Memory Consolidation Queue — end-to-end regression test.
 * Mirrors examples/memory-consolidation-queue/setup.js (reuses
 * examples/agent-memory-backend's own buildMemoryHandlers for
 * learn/rememberError/stats/dream).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { AgentMemory } from '../core/memory.js';
import { JobQueue } from '../core/queue.js';
import { buildMemoryHandlers } from '../examples/agent-memory-backend/tools.js';

let app, memory, handlers, queue;

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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'memory-consolidation-queue-test-secret!!!' });
  memory = new AgentMemory(app.cms.db, { agentId: 'test-agent' });
  handlers = buildMemoryHandlers(memory);
  queue = new JobQueue(app.cms.db, { concurrency: 1, pollInterval: 20, backoffMs: 20, maxRetries: 2 });
  queue.register('consolidate-memory', async () => handlers.dream());
  queue.start();
});

describe('Memory consolidation queue: dream() runs as a background job instead of blocking the caller', () => {
  it('enqueueing consolidation returns immediately with a pending job, not the dream() report itself', async () => {
    handlers.learn({ task: 'Fix the login bug', outcome: 'success' });
    handlers.rememberError({ error: 'TypeError: x is undefined', solution: 'Add a null check' });

    const job = queue.enqueue('consolidate-memory', {});
    expect(job.status).toBe('pending');
    expect(job.result).toBeNull(); // the caller gets the job doc, not the dream report, synchronously
  });

  it('the job completes with the real dream() report shape once processed', async () => {
    const job = queue.enqueue('consolidate-memory', {});
    const finished = await waitFor(() => {
      const j = queue.list({ limit: 200 }).find((x) => x._id === job._id);
      return j && j.status === 'completed' ? j : null;
    });
    expect(typeof finished.result.merged).toBe('number');
    expect(typeof finished.result.removed).toBe('number');
    expect(typeof finished.result.kept).toBe('number');
    expect(typeof finished.result.duration_ms).toBe('number');
  });

  it('memory:stats reflects real stored memories after learn/rememberError, independent of consolidation', async () => {
    const stats = await handlers.stats();
    expect(stats.episodic).toBeGreaterThan(0);
    expect(stats.semantic).toBeGreaterThan(0);
  });
});
