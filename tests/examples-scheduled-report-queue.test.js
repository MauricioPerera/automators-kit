/**
 * Scheduled Report Queue — end-to-end regression test.
 * Mirrors examples/scheduled-report-queue/setup.js (reuses reports.js's
 * enqueueReports/generateReport so the demo and the test can't drift
 * apart). Uses MemoryStorageAdapter and a fast poll/backoff, same as the
 * live demo.
 *
 * reports.js's deterministic once-only failure for 'workspace-b' is
 * tracked in MODULE-LEVEL state, shared across every test in this file
 * (ES modules are singleton-cached) -- it fires exactly once, on the
 * very first time generateReport ever runs for that reportId. That
 * happens inside the FIRST test's batch, so the retry assertion lives
 * there; later tests re-enqueueing 'workspace-b' will see it succeed
 * immediately (already past its one-time failure), which is fine for
 * what those tests are actually checking (no job lost/duplicated).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { REPORT_IDS, enqueueReports, generateReport } from '../examples/scheduled-report-queue/reports.js';

let app, queue;

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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'scheduled-report-queue-test-secret!!!' });
  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 20, backoffMs: 20, maxRetries: 2 });
  queue.register('workspace-report', generateReport);
  queue.start();
});

describe('Scheduled report queue: one cron tick enqueues one job per report, all processed exactly once', () => {
  it('enqueues exactly REPORT_IDS.length jobs, all complete, and workspace-b\'s one-time failure retries and succeeds', async () => {
    const before = queue.stats();
    const jobs = enqueueReports(queue);
    expect(jobs.length).toBe(REPORT_IDS.length);
    expect(new Set(jobs.map((j) => j.data.reportId)).size).toBe(REPORT_IDS.length);

    await waitFor(() => {
      const s = queue.stats();
      return s.completed - before.completed >= REPORT_IDS.length ? s : null;
    });

    const list = queue.list({ limit: 200 });
    const wbJob = list.find((j) => j._id === jobs.find((j2) => j2.data.reportId === 'workspace-b')._id);
    expect(wbJob.status).toBe('completed');
    expect(wbJob.attempts).toBe(2); // 1 failure + 1 successful retry
    expect(wbJob.result.reportId).toBe('workspace-b');

    const stats = queue.stats();
    expect(stats.dead - before.dead).toBe(0);
  });

  it('two batches enqueued back-to-back (overlapping cron ticks / a manual trigger during drain) never lose or duplicate a job', async () => {
    const before = queue.stats();
    const batchA = enqueueReports(queue);
    const batchB = enqueueReports(queue);
    const allIds = new Set([...batchA, ...batchB].map((j) => j._id));
    expect(allIds.size).toBe(REPORT_IDS.length * 2); // 6 distinct job ids, no accidental reuse

    const stats = await waitFor(() => {
      const s = queue.stats();
      const done = s.completed - before.completed;
      return done >= REPORT_IDS.length * 2 ? s : null;
    });
    expect(stats.completed - before.completed).toBe(REPORT_IDS.length * 2);
  });
});
