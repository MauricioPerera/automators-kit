/**
 * PostgresExecutionLog — end-to-end regression test against a REAL Postgres.
 * Covers the class's full public surface (record/getExecutions/getExecution/
 * purgeExecutions). No atomic/concurrency-critical operation here (unlike
 * integrations/postgres-queue.js's claimJobs()), so no separate KDD-contracted
 * oracle -- same test-first rigor without the extra formal apparatus.
 *
 * Opt-in, NOT part of the default `bun test tests/` run: skips cleanly
 * unless POSTGRES_TEST_URL is set, so the project's existing deterministic
 * offline suite is unaffected. To run:
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-execution-log.test.js
 *
 * Requires the optional `pg` dependency (see package.json's
 * optionalDependencies) -- not installed by default.
 *
 * Run this file alone (as documented above), not stacked together with the
 * other opt-in integrations-postgres-*.test.js files in one `bun test`
 * invocation: each file creates its own `pg.Pool`, and 3+ concurrent pools
 * against a session-mode Supavisor tenant can exceed its connection limit,
 * causing unrelated timeouts -- not a bug in any of the modules themselves
 * (each passes cleanly alone; the previously-verified claim+queue pair also
 * still passes together).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

function fakeExecution(overrides = {}) {
  const now = Date.now();
  return {
    _id: `exec-${Math.random().toString(36).slice(2)}`,
    workflowId: 'wf1',
    workflowName: 'Test workflow',
    trigger: { manual: true },
    status: 'success',
    nodeResults: { n1: { status: 'success', data: 42 } },
    errors: {},
    startedAt: now,
    finishedAt: now + 10,
    duration: 10,
    ...overrides,
  };
}

if (!POSTGRES_TEST_URL) {
  describe('PostgresExecutionLog', () => {
    it.skip('skipped: set POSTGRES_TEST_URL to run against a real Postgres', () => {});
  });
} else {
  const { Pool } = await import('pg');
  const { PostgresExecutionLog } = await import('../integrations/postgres-execution-log.js');

  let pool;
  let log;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_TEST_URL, max: 10 });
    log = new PostgresExecutionLog(pool);
    await log.init();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE workflow_executions');
  });

  describe('PostgresExecutionLog: shared, multi-process-readable workflow execution history', () => {
    it('records an execution and returns it in WorkflowEngine-compatible shape', async () => {
      const exec = fakeExecution();
      const stored = await log.record(exec);
      expect(stored._id).toBe(exec._id);
      expect(stored.workflowId).toBe('wf1');
      expect(stored.workflowName).toBe('Test workflow');
      expect(stored.trigger).toEqual({ manual: true });
      expect(stored.status).toBe('success');
      expect(stored.nodeResults).toEqual({ n1: { status: 'success', data: 42 } });
      expect(stored.errors).toEqual({});
      expect(stored.startedAt).toBe(exec.startedAt);
      expect(stored.finishedAt).toBe(exec.finishedAt);
      expect(stored.duration).toBe(10);
    });

    it('recording the same execution _id twice updates it in place (does not duplicate)', async () => {
      const exec = fakeExecution({ status: 'running', finishedAt: null, duration: null });
      await log.record(exec);

      const finished = { ...exec, status: 'success', finishedAt: exec.startedAt + 50, duration: 50 };
      await log.record(finished);

      const all = await log.getExecutions('wf1', 10);
      expect(all.length).toBe(1);
      expect(all[0].status).toBe('success');
      expect(all[0].duration).toBe(50);
    });

    it('getExecutions(workflowId) returns only that workflow, newest first, respecting limit', async () => {
      await log.record(fakeExecution({ workflowId: 'wf1', startedAt: 1000 }));
      await log.record(fakeExecution({ workflowId: 'wf1', startedAt: 3000 }));
      await log.record(fakeExecution({ workflowId: 'wf1', startedAt: 2000 }));
      await log.record(fakeExecution({ workflowId: 'wf2', startedAt: 5000 }));

      const wf1 = await log.getExecutions('wf1', 10);
      expect(wf1.length).toBe(3);
      expect(wf1.map((e) => e.startedAt)).toEqual([3000, 2000, 1000]);

      const limited = await log.getExecutions('wf1', 2);
      expect(limited.length).toBe(2);
      expect(limited.map((e) => e.startedAt)).toEqual([3000, 2000]);
    });

    it('getExecutions() with no workflowId returns across all workflows', async () => {
      await log.record(fakeExecution({ workflowId: 'wf1' }));
      await log.record(fakeExecution({ workflowId: 'wf2' }));

      const all = await log.getExecutions(undefined, 10);
      expect(all.length).toBe(2);
    });

    it('getExecution(id) returns one execution, or null when missing', async () => {
      const exec = fakeExecution();
      await log.record(exec);

      const found = await log.getExecution(exec._id);
      expect(found._id).toBe(exec._id);

      const missing = await log.getExecution('does-not-exist');
      expect(missing).toBeNull();
    });

    it('purgeExecutions(olderThanMs) removes old executions, leaves recent ones', async () => {
      const old = fakeExecution();
      const recent = fakeExecution();
      await log.record(old);
      await log.record(recent);

      await pool.query("UPDATE workflow_executions SET started_at = now() - interval '10 days' WHERE id = $1", [old._id]);

      const purged = await log.purgeExecutions(7 * 24 * 60 * 60 * 1000);
      expect(purged).toBe(1);

      const remaining = await log.getExecutions(undefined, 10);
      expect(remaining.length).toBe(1);
      expect(remaining[0]._id).toBe(recent._id);
    });
  });
}
