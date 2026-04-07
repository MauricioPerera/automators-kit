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
});
