/**
 * Tests: core/queue.js
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { JobQueue } from '../core/queue.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';

let db, queue;

beforeEach(() => {
  db = new DocStore(new MemoryStorageAdapter());
  queue = new JobQueue(db, { concurrency: 2, pollInterval: 50, maxRetries: 2, backoffMs: 50 });
});

describe('JobQueue', () => {
  it('enqueue creates job', () => {
    queue.register('test', async () => 'done');
    const job = queue.enqueue('test', { key: 'value' });
    expect(job._id).toBeDefined();
    expect(job.type).toBe('test');
    expect(job.status).toBe('pending');
    expect(job.data.key).toBe('value');
  });

  it('stats shows pending', () => {
    queue.register('test', async () => 'done');
    queue.enqueue('test');
    queue.enqueue('test');
    const s = queue.stats();
    expect(s.pending).toBe(2);
    expect(s.completed).toBe(0);
  });

  it('processes jobs when started', async () => {
    const results = [];
    queue.register('collect', async (data) => { results.push(data.n); return data.n; });
    queue.enqueue('collect', { n: 1 });
    queue.enqueue('collect', { n: 2 });
    queue.start();
    await new Promise(r => setTimeout(r, 300));
    queue.stop();
    expect(results.sort()).toEqual([1, 2]);
    expect(queue.stats().completed).toBe(2);
  });

  it('retries on failure then dead letter', async () => {
    let attempts = 0;
    queue.register('fail', async () => { attempts++; throw new Error('nope'); });
    queue.enqueue('fail', {}, { maxRetries: 2 });
    queue.start();
    await new Promise(r => setTimeout(r, 500));
    queue.stop();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(queue.stats().dead).toBe(1);
  });

  it('dead letter and retry', async () => {
    let count = 0;
    queue.register('maybe', async () => {
      count++;
      if (count < 3) throw new Error('not yet');
      return 'ok';
    });
    queue.enqueue('maybe', {}, { maxRetries: 1 });
    queue.start();
    await new Promise(r => setTimeout(r, 300));
    // Should be in dead letter now
    const dead = queue.deadLetter();
    if (dead.length > 0) {
      queue.retry(dead[0]._id);
      await new Promise(r => setTimeout(r, 300));
    }
    queue.stop();
  });

  it('delay enqueues with future runAt', () => {
    queue.register('delayed', async () => {});
    const job = queue.delay('delayed', { x: 1 }, 5000);
    expect(job.runAt).toBeGreaterThan(Date.now() + 4000);
  });

  it('list jobs', () => {
    queue.register('test', async () => {});
    queue.enqueue('test');
    queue.enqueue('test');
    expect(queue.list().length).toBe(2);
    expect(queue.list({ status: 'pending' }).length).toBe(2);
  });

  it('purge completed', async () => {
    queue.register('quick', async () => 'ok');
    queue.enqueue('quick');
    queue.start();
    await new Promise(r => setTimeout(r, 200));
    queue.stop();
    const purged = queue.purge(0); // purge all completed
    expect(purged).toBeGreaterThanOrEqual(1);
  });

  it('respects concurrency', async () => {
    let concurrent = 0, maxConcurrent = 0;
    queue.register('slow', async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 100));
      concurrent--;
    });
    for (let i = 0; i < 5; i++) queue.enqueue('slow');
    queue.start();
    await new Promise(r => setTimeout(r, 800));
    queue.stop();
    expect(maxConcurrent).toBeLessThanOrEqual(2); // concurrency: 2
  });

  // Hallazgo 1: jobs stuck in 'processing' (process crashed mid-job) must be
  // reclaimed once their lease expires, instead of being lost forever.
  it('reclaims stuck processing jobs after lease expires', async () => {
    const q = new JobQueue(db, { concurrency: 2, pollInterval: 50, maxRetries: 2, backoffMs: 50, leaseMs: 100 });
    let calls = 0;
    q.register('stuck', async () => { calls++; return 'recovered'; });
    // Simulate a job that crashed while processing: status 'processing' with a stale updatedAt.
    const now = Date.now();
    q._jobs.insert({
      type: 'stuck', data: {}, status: 'processing', priority: 0,
      attempts: 0, maxRetries: 2, runAt: now, createdAt: now - 10000,
      updatedAt: now - 5000, result: null, error: null,
    });
    q.start();
    await new Promise(r => setTimeout(r, 300));
    q.stop();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(q.stats().completed).toBe(1);
    expect(q.stats().processing).toBe(0);
  });

  // Hallazgo 2: a registered handler `timeout` must actually be enforced — a
  // handler that never settles fails the job instead of hanging a slot forever.
  it('handler timeout fails the job instead of hanging', async () => {
    queue.register('hang', () => new Promise(() => {}), { timeout: 100 });
    queue.enqueue('hang', {}, { maxRetries: 0 });
    queue.start();
    await new Promise(r => setTimeout(r, 600));
    queue.stop();
    const s = queue.stats();
    expect(s.processing).toBe(0); // slot freed
    expect(s.failed + s.dead).toBeGreaterThanOrEqual(1);
  }, 2000);

  it('handler with timeout that completes in time still succeeds', async () => {
    queue.register('quick-to', async () => 'ok', { timeout: 500 });
    queue.enqueue('quick-to');
    queue.start();
    await new Promise(r => setTimeout(r, 300));
    queue.stop();
    expect(queue.stats().completed).toBe(1);
  });

  // Hallazgo 3: stop() must clear a pending _flushTimer. enqueue() schedules a
  // throttled flush via _markDirty; if stop() is called before that 500ms timer
  // fires, it would fire db.flush() after the queue "stopped" (touching
  // possibly-released resources / keeping the process alive). Verify the timer
  // is gone and no late flush fires.
  it('stop() clears a pending flush timer so no late flush fires', async () => {
    const flushCalls = [];
    const realFlush = db.flush.bind(db);
    db.flush = () => { flushCalls.push(Date.now()); return realFlush(); };

    queue.register('noop', async () => 'ok');
    // enqueue triggers _markDirty → schedules the 500ms throttled flush.
    queue.enqueue('noop');
    expect(queue._flushTimer).not.toBeNull(); // timer armed

    queue.stop(); // must cancel the pending timer + do a final flush
    expect(queue._flushTimer).toBeNull(); // no orphan timer

    const flushesAtStop = flushCalls.length;
    // Wait past the 500ms the orphan timer would have fired.
    await new Promise(r => setTimeout(r, 700));
    // No additional flush should have happened after stop().
    expect(flushCalls.length).toBe(flushesAtStop);
  });
});
