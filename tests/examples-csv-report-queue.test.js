/**
 * CSV Report Queue — end-to-end regression test.
 * Mirrors examples/csv-report-queue/setup.js (reuses report.js's
 * computeSalesReport so the demo and the test can't drift apart).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { computeSalesReport } from '../examples/csv-report-queue/report.js';

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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'csv-report-queue-test-secret!!!' });
  queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 20, backoffMs: 20, maxRetries: 1 });
  queue.register('generate-sales-report', async ({ csv }) => computeSalesReport(csv));
  queue.start();
});

const CSV = 'product,category,amount\nWidget,tools,10\nGadget,tools,20\nDesk,furniture,150\nChair,furniture,50\n';

describe('CSV report queue: aggregation runs in the background, submit returns before it finishes', () => {
  it('submit returns immediately with a pending job, not the report itself', () => {
    const job = queue.enqueue('generate-sales-report', { csv: CSV });
    expect(job.status).toBe('pending');
    expect(job.result).toBeNull();
  });

  it('the job completes with a correct aggregate report', async () => {
    const job = queue.enqueue('generate-sales-report', { csv: CSV });
    const finished = await waitFor(() => {
      const j = queue.list({ limit: 200 }).find((x) => x._id === job._id);
      return j && j.status === 'completed' ? j : null;
    });
    expect(finished.result.rowsProcessed).toBe(4);
    expect(finished.result.total).toBe(230);
    expect(finished.result.byCategory).toEqual({ tools: 30, furniture: 200 });
    expect(finished.result.topCategory).toEqual({ category: 'furniture', amount: 200 });
  });

  it('rows with an unparseable amount are skipped and reported, not silently included or crashing the job', async () => {
    const csvWithBadRow = 'product,category,amount\nWidget,tools,10\nBroken,tools,not-a-number\n';
    const job = queue.enqueue('generate-sales-report', { csv: csvWithBadRow });
    const finished = await waitFor(() => {
      const j = queue.list({ limit: 200 }).find((x) => x._id === job._id);
      return j && j.status === 'completed' ? j : null;
    });
    expect(finished.result.rowsProcessed).toBe(2);
    expect(finished.result.rowsSkipped).toBe(1);
    expect(finished.result.total).toBe(10);
  });

  it('a quoted field containing a comma survives into the aggregation intact', async () => {
    const csvWithQuoted = 'product,category,amount\n"Widget, Deluxe",tools,15\n';
    const job = queue.enqueue('generate-sales-report', { csv: csvWithQuoted });
    const finished = await waitFor(() => {
      const j = queue.list({ limit: 200 }).find((x) => x._id === job._id);
      return j && j.status === 'completed' ? j : null;
    });
    expect(finished.result.rowsProcessed).toBe(1);
    expect(finished.result.total).toBe(15);
  });
});
