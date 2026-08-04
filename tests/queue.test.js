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

// CORRECTNESS (2026-08-03, verified from a full-codebase audit lead): the
// reclaim arm of _poll ("stuck in processing, lease expired -> the worker
// died") could not tell a DEAD worker from a SLOW one, because _process
// stamped updatedAt once at claim time and never renewed it. Any handler
// outrunning leaseMs -- default FIVE MINUTES, so a large export or a slow
// upstream -- was re-claimed and re-executed by the same process, again every
// lease period. Reproduced before the fix: 4 invocations for one enqueued job,
// with the queue still reporting completed: 1.
describe('a slow handler is not mistaken for a dead worker', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('runs a handler that outruns the lease exactly ONCE', async () => {
    const q = new JobQueue(new DocStore(new MemoryStorageAdapter()), { pollInterval: 30, leaseMs: 150 });
    let calls = 0;
    q.register('slow', async () => { calls++; await sleep(600); });
    q.enqueue('slow', {});
    q.start();
    await sleep(1000);
    q.stop();
    expect(calls).toBe(1);
  });

  it('does not corrupt the running counter (it used to leak, shrinking concurrency)', async () => {
    const q = new JobQueue(new DocStore(new MemoryStorageAdapter()), { pollInterval: 30, leaseMs: 150 });
    q.register('slow', async () => { await sleep(500); });
    q.enqueue('slow', {});
    q.start();
    await sleep(900);
    q.stop();
    expect(q.stats().running).toBe(0);
    expect(q.stats().completed).toBe(1);
  });

  it('several concurrent slow jobs each still run once', async () => {
    const q = new JobQueue(new DocStore(new MemoryStorageAdapter()), { pollInterval: 30, leaseMs: 150 });
    const calls = {};
    q.register('slow', async (d) => { calls[d.id] = (calls[d.id] || 0) + 1; await sleep(500); });
    for (const id of ['a', 'b', 'c']) q.enqueue('slow', { id });
    q.start();
    await sleep(1000);
    q.stop();
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('STILL reclaims a job genuinely orphaned by a crashed process', async () => {
    // The reclaim arm exists for exactly this: a row left in 'processing' by a
    // process that died. A fresh process has an empty _inFlight, so the fix
    // must not disable recovery -- only self-reclaim.
    const db2 = new DocStore(new MemoryStorageAdapter());
    db2.collection('_queue_jobs').insert({
      type: 'orphan', data: {}, status: 'processing', attempts: 0, maxRetries: 3,
      priority: 0, runAt: Date.now() - 10000, createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000, // lease long expired
    });
    const q = new JobQueue(db2, { pollInterval: 30, leaseMs: 150 });
    let ran = 0;
    q.register('orphan', async () => { ran++; });
    q.start();
    await sleep(250);
    q.stop();
    expect(ran).toBe(1);
  });

  it('renews the persisted lease while the handler runs, so the row stops looking abandoned', async () => {
    const db2 = new DocStore(new MemoryStorageAdapter());
    const q = new JobQueue(db2, { pollInterval: 30, leaseMs: 150 });
    q.register('slow', async () => { await sleep(600); });
    q.enqueue('slow', {});
    q.start();
    await sleep(400); // well past one lease period, handler still running
    const row = db2.collection('_queue_jobs').find({ status: 'processing' }).toArray()[0];
    expect(row).toBeTruthy();
    expect(Date.now() - row.updatedAt).toBeLessThan(150); // heartbeat kept it fresh
    q.stop();
    await sleep(300);
  });
});
