/**
 * claimJobs() — the KDD-contracted piece of integrations/postgres-queue.js.
 * See the sibling KDD checkout's knowledge/contracts/postgres-job-queue.md
 * for the contract (kept external, not vendored into this repo).
 *
 * Opt-in, NOT part of the default `bun test tests/` run: skips cleanly
 * unless POSTGRES_TEST_URL is set. To run:
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-queue-claim.test.js
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

if (!POSTGRES_TEST_URL) {
  describe('claimJobs', () => {
    it.skip('skipped: set POSTGRES_TEST_URL to run against a real Postgres', () => {});
  });
} else {
  const { Pool } = await import('pg');
  const { PostgresJobQueue, claimJobs } = await import('../integrations/postgres-queue.js');

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

  describe('claimJobs: atomic multi-worker job claiming', () => {
    it('claims a due pending job and marks it processing', async () => {
      const q = new PostgresJobQueue(pool);
      const job = await q.enqueue('noop', { x: 1 });
      const claimed = await claimJobs(pool, { limit: 5, leaseMs: 300000 });
      expect(claimed.map((j) => j.id)).toContain(job.id);
      expect(claimed.find((j) => j.id === job.id).status).toBe('processing');
    });

    it('does not claim a job whose run_at is in the future', async () => {
      const q = new PostgresJobQueue(pool);
      await q.enqueue('noop', {}, { delay: 60000 });
      const claimed = await claimJobs(pool, { limit: 5, leaseMs: 300000 });
      expect(claimed.length).toBe(0);
    });

    it('reclaims a job stuck in "processing" past its lease, but not one still within lease', async () => {
      const q = new PostgresJobQueue(pool);
      const stuck = await q.enqueue('noop', {});
      const fresh = await q.enqueue('noop', {});
      // Simulate a crashed worker: force "stuck" into processing with an old updated_at.
      await pool.query(
        "UPDATE queue_jobs SET status='processing', updated_at = now() - interval '10 minutes' WHERE id = $1",
        [stuck.id]
      );
      await pool.query("UPDATE queue_jobs SET status='processing', updated_at = now() WHERE id = $1", [fresh.id]);

      const claimed = await claimJobs(pool, { limit: 5, leaseMs: 300000 }); // 5 min lease
      const ids = claimed.map((j) => j.id);
      expect(ids).toContain(stuck.id); // past its 5-min lease -> reclaimed
      expect(ids).not.toContain(fresh.id); // still within lease -> left alone
    });

    it('honors priority (higher first) then FIFO within the same priority', async () => {
      const q = new PostgresJobQueue(pool);
      const low = await q.enqueue('noop', {}, { priority: 0 });
      const high = await q.enqueue('noop', {}, { priority: 10 });
      const claimed = await claimJobs(pool, { limit: 2, leaseMs: 300000 });
      expect(claimed[0].id).toBe(high.id);
      expect(claimed[1].id).toBe(low.id);
    });

    it('CRITICAL: two concurrent claimers racing the same pending set never claim the same job, and every job is claimed exactly once', async () => {
      const q = new PostgresJobQueue(pool);
      const jobs = [];
      for (let i = 0; i < 40; i++) jobs.push(await q.enqueue('noop', { i }));

      // Two "workers" hitting the SAME table concurrently, each asking for
      // up to 25 -- if FOR UPDATE SKIP LOCKED weren't doing its job, the
      // same row would show up in both result sets.
      const [batchA, batchB] = await Promise.all([
        claimJobs(pool, { limit: 25, leaseMs: 300000 }),
        claimJobs(pool, { limit: 25, leaseMs: 300000 }),
      ]);

      const idsA = batchA.map((j) => j.id);
      const idsB = batchB.map((j) => j.id);
      const overlap = idsA.filter((id) => idsB.includes(id));
      expect(overlap).toEqual([]); // zero double-claims

      const allClaimed = new Set([...idsA, ...idsB]);
      expect(allClaimed.size).toBe(40); // every job claimed by exactly one worker
    });
  });
}
