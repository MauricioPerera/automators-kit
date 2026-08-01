/**
 * Validated Job Queue — end-to-end regression test.
 * Mirrors examples/validated-job-queue/setup.js (reuses schemas.js/
 * validated-queue.js so the demo and the test can't drift apart).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { schemas } from '../examples/validated-job-queue/schemas.js';
import { createValidatedEnqueue } from '../examples/validated-job-queue/validated-queue.js';

let app, queue, validatedEnqueue;

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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'validated-job-queue-test-secret!!!' });
  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 20, backoffMs: 20, maxRetries: 2 });
  queue.register('send-email', async ({ to, subject }) => ({ sent: true, to, subject }));
  queue.start();
  validatedEnqueue = createValidatedEnqueue(queue, schemas);
});

describe('Validated job queue: a malformed payload is rejected before any job is created', () => {
  it('a valid payload enqueues and eventually completes normally', async () => {
    const before = queue.stats();
    const job = validatedEnqueue('send-email', { to: 'a@b.com', subject: 'Hi', body: 'Hello' });
    expect(job.status).toBe('pending');

    await waitFor(() => queue.stats().completed > before.completed);
    const stats = queue.stats();
    expect(stats.completed - before.completed).toBe(1);
  });

  it('an invalid email format throws synchronously and creates ZERO job documents', async () => {
    const before = queue.stats();
    expect(() => validatedEnqueue('send-email', { to: 'not-an-email', subject: 'Hi', body: 'Hello' }))
      .toThrow(/must be a valid email/);

    // Give the (non-existent) job a moment it would need if one had
    // actually been created, then confirm nothing changed at all.
    await new Promise((r) => setTimeout(r, 100));
    const after = queue.stats();
    expect(after.pending).toBe(before.pending);
    expect(after.processing).toBe(before.processing);
    expect(after.completed).toBe(before.completed);
  });

  it('a missing required field is reported by name, and also creates zero jobs', () => {
    const before = queue.stats();
    try {
      validatedEnqueue('send-email', { to: 'a@b.com', body: 'Hello' }); // no subject
      expect(true).toBe(false); // must not reach here
    } catch (err) {
      expect(err.message).toContain('subject');
      expect(err.message).toContain('required');
    }
    expect(queue.stats().pending).toBe(before.pending);
  });

  it('an unregistered job type throws a clear error instead of silently enqueueing unchecked', () => {
    expect(() => validatedEnqueue('unknown-type', {})).toThrow(/No validation schema registered/);
  });
});
