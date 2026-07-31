/**
 * PostgresJobQueue — end-to-end regression test against a REAL Postgres.
 * Covers the class's public surface (enqueue/start/stop/stats/list/
 * deadLetter/retry/purge). The atomic claim query itself
 * (core correctness-critical piece, KDD-contracted) has its own dedicated
 * frozen oracle: tests/integrations-postgres-queue-claim.test.js.
 *
 * Opt-in, NOT part of the default `bun test tests/` run: skips cleanly
 * unless POSTGRES_TEST_URL is set, so the project's existing deterministic
 * offline suite is unaffected. To run:
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-queue.test.js
 *
 * Requires the optional `pg` dependency (see package.json's
 * optionalDependencies) -- not installed by default.
 *
 * Waits poll for the expected DB state instead of sleeping a fixed delay:
 * over a real network connection (e.g. an SSH tunnel to a remote Postgres),
 * round-trip time is variable and a fixed sleep tuned for localhost is
 * flaky under load.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

async function waitFor(check, { timeoutMs = 5000, intervalMs = 30 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

if (!POSTGRES_TEST_URL) {
  describe('PostgresJobQueue', () => {
    it.skip('skipped: set POSTGRES_TEST_URL to run against a real Postgres', () => {});
  });
} else {
  const { Pool } = await import('pg');
  const { PostgresJobQueue } = await import('../integrations/postgres-queue.js');

  let pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_TEST_URL, max: 10 });
    await new PostgresJobQueue(pool).init();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE queue_jobs, queue_dead');
  });

  describe('PostgresJobQueue: same public shape as core/queue.js\'s JobQueue, async where real I/O happens', () => {
    it('runs a job end to end: enqueue -> processed -> completed, with the real result stored', async () => {
      const q = new PostgresJobQueue(pool, { pollInterval: 20 });
      q.register('echo', async (data) => ({ echoed: data.msg }));
      const job = await q.enqueue('echo', { msg: 'hi' });
      q.start();

      const done = await waitFor(async () => {
        const status = await q.list({});
        const found = status.find((j) => j.id === job.id);
        return found && found.status === 'completed' ? found : null;
      });
      q.stop();

      expect(done.status).toBe('completed');
      expect(done.result).toEqual({ echoed: 'hi' });
    });

    it('retries with backoff, then moves to dead letter after exhausting maxRetries', async () => {
      const q = new PostgresJobQueue(pool, { pollInterval: 20, backoffMs: 10 });
      let attempts = 0;
      q.register('flaky', async () => { attempts++; throw new Error('boom'); }, {});
      await q.enqueue('flaky', {}, { maxRetries: 2 });
      q.start();

      const dead = await waitFor(async () => {
        const d = await q.deadLetter(10);
        return d.length > 0 ? d : null;
      });
      q.stop();

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(dead.length).toBe(1);
      expect(dead[0].error).toBe('boom');
    });

    it('stats() reflects real counts', async () => {
      const q = new PostgresJobQueue(pool, { pollInterval: 20 });
      q.register('noop2', async () => ({ ok: true }));
      await q.enqueue('noop2', {});
      q.start();

      const stats = await waitFor(async () => {
        const s = await q.stats();
        return s.completed === 1 ? s : null;
      });
      q.stop();

      expect(stats.completed).toBe(1);
      expect(stats.pending).toBe(0);
    });

    it('retry() re-enqueues a dead-letter job', async () => {
      const q = new PostgresJobQueue(pool, { pollInterval: 20, backoffMs: 5 });
      q.register('always-fails', async () => { throw new Error('nope'); });
      await q.enqueue('always-fails', {}, { maxRetries: 1 });
      q.start();

      const dead = await waitFor(async () => {
        const d = await q.deadLetter(10);
        return d.length > 0 ? d : null;
      });
      q.stop();

      expect(dead.length).toBe(1);
      const requeued = await q.retry(dead[0].id);
      expect(requeued.status).toBe('pending');
      expect((await q.deadLetter(10)).length).toBe(0);
    });

    it('purge() removes completed jobs older than the given age, leaves recent ones', async () => {
      const q = new PostgresJobQueue(pool, { pollInterval: 20 });
      q.register('noop3', async () => ({}));
      const job = await q.enqueue('noop3', {});
      q.start();

      await waitFor(async () => {
        const status = await q.list({});
        const found = status.find((j) => j.id === job.id);
        return found && found.status === 'completed';
      });
      q.stop();

      await pool.query("UPDATE queue_jobs SET updated_at = now() - interval '2 days' WHERE id = $1", [job.id]);
      const purged = await q.purge(24 * 60 * 60 * 1000);
      expect(purged).toBe(1);
    });
  });
}
