/**
 * Scheduled Report Queue — HTTP/shell demo.
 *
 *   bun examples/scheduled-report-queue/setup.js
 *
 * Combines core/cron.js with core/queue.js: a cron tick enqueues one
 * durable, independently-retryable job per report, instead of doing the
 * work directly inline. Neither example covers this alone —
 * examples/scheduled-sync's cron job performs its sync action directly
 * (no queue; a single failure blocks the cursor there until retried);
 * examples/job-queue has no scheduling trigger at all, only manual
 * enqueue calls; examples/poll-to-queue enqueues one job per NEW item
 * detected by a poll trigger (event-driven), not a fixed batch on a
 * schedule.
 *
 * Real cron ticks fire nightly (`0 2 * * *`) — not something worth
 * waiting on to verify this works. `reports:run-now` exposes the exact
 * same `enqueueReports()` the cron job calls, for the live demo.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { CronScheduler } from '../../core/cron.js';
import { enqueueReports, generateReport } from './reports.js';

const PORT = +(process.env.PORT || 3030);
const DB_PATH = process.env.DB_PATH || './examples/scheduled-report-queue/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'scheduled-report-queue-demo-secret',
  logger: true,
});

// Fast poll/backoff for the demo — a production queue would use the
// defaults (pollInterval 1000ms, backoffMs 1000ms exponential).
const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 2 });
queue.register('workspace-report', generateReport);
queue.start();

const cron = new CronScheduler();
cron.add('nightly-reports', '0 2 * * *', async () => { enqueueReports(queue); });
cron.start();

app.shell.registry.register('reports', 'run-now', {
  description: 'Manually run the same batch enqueue the nightly cron job runs (for demo/testing)',
}, async () => {
  const jobs = enqueueReports(queue);
  return { enqueued: jobs.map((j) => ({ id: j._id, reportId: j.data.reportId })) };
});

app.shell.registry.register('reports', 'stats', {
  description: 'Queue stats (pending/processing/completed/failed/dead)',
}, async () => queue.stats());

app.shell.registry.register('reports', 'list', {
  description: 'List recent report jobs, optionally filtered by status',
  params: [{ name: 'status', type: 'string' }, { name: 'limit', type: 'number' }],
}, async (args) => queue.list(args));

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Scheduled report queue demo running at http://localhost:${PORT}
  commands: reports:run-now, reports:stats, reports:list

Try (run it twice in a row to see two batches interleave in the queue):
  POST /api/shell/exec {"cmd":"reports:run-now"}
  POST /api/shell/exec {"cmd":"reports:stats"}
  POST /api/shell/exec {"cmd":"reports:list"}
See examples/scheduled-report-queue/README.md for the full walkthrough.
`);
