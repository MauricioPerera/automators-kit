/**
 * Job Queue — HTTP/shell demo.
 *
 *   bun examples/job-queue/setup.js
 *
 * "Kick off slow work, return immediately, poll for status" —
 * core/queue.js's JobQueue doing async processing with retries+backoff and
 * dead-letter, off the HTTP request/response path entirely.
 *
 * Runs fully offline: handlers.js's mocks simulate a slow report job, a
 * trivial notification job, and a configurably-flaky job (fails N times
 * then succeeds) so retries/backoff/dead-letter are all visible for real,
 * on a fast poll interval so the demo doesn't take minutes to show.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { buildJobHandlers } from './handlers.js';
import { buildQueueTools } from './tools.js';

const PORT = +(process.env.PORT || 3008);
const DB_PATH = process.env.DB_PATH || './examples/job-queue/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'job-queue-demo-secret',
  logger: true,
});

// Fast poll/backoff for the demo — a production queue would use the
// defaults (pollInterval 1000ms, backoffMs 1000ms exponential).
const queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 100, backoffMs: 100, maxRetries: 3 });

const { handlers, sent, configureFlaky, resetFlaky } = buildJobHandlers();
for (const [type, handler] of Object.entries(handlers)) queue.register(type, handler);
queue.start();

const tools = buildQueueTools(queue, app.cms.db);

app.shell.registry.register('queue', 'enqueue-report', {
  description: 'Enqueue a report-generation job (slow, runs in the background)',
  params: [
    { name: 'entryType', type: 'string' },
    { name: 'format', type: 'string' },
    { name: 'delayMs', type: 'number', description: 'simulated work duration' },
    { name: 'priority', type: 'number' },
  ],
}, async (args) => tools.enqueueReport(args));

app.shell.registry.register('queue', 'enqueue-notification', {
  description: 'Enqueue a notification job',
  params: [{ name: 'to', type: 'string', required: true }, { name: 'message', type: 'string' }],
}, async (args) => tools.enqueueNotification(args));

app.shell.registry.register('queue', 'enqueue-flaky', {
  description: 'Enqueue a job that fails N times before succeeding (or forever, for the dead-letter demo)',
  params: [{ name: 'maxRetries', type: 'number' }],
}, async (args) => tools.enqueueFlaky(args));

app.shell.registry.register('queue', 'job', {
  description: 'Check a job\'s status by id (pending/processing/completed, or dead-letter)',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.jobStatus(args.id || args._0));

app.shell.registry.register('queue', 'list', {
  description: 'List recent jobs, optionally filtered by status',
  params: [{ name: 'status', type: 'string' }, { name: 'limit', type: 'number' }],
}, async (args) => tools.listJobs(args));

app.shell.registry.register('queue', 'stats', { description: 'Queue stats (pending/processing/completed/failed/dead)' }, async () => tools.stats());

app.shell.registry.register('queue', 'dead-letter', {
  description: 'List jobs that exhausted their retries',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => tools.deadLetterList(args.limit));

app.shell.registry.register('queue', 'retry', {
  description: 'Re-enqueue a dead-letter job',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.retryDead(args.id || args._0));

app.shell.registry.register('queue', 'purge', {
  description: 'Delete completed jobs older than N ms',
  params: [{ name: 'olderThanMs', type: 'number' }],
}, async (args) => tools.purgeOld(args.olderThanMs));

// Demo knobs for the flaky-job handler + inspecting what notifications fired.
app.shell.registry.register('queue', 'configure-flaky', {
  description: 'Set how many times the next flaky-job run(s) fail before succeeding',
  params: [{ name: 'failCount', type: 'number', required: true }],
}, async (args) => { configureFlaky(args.failCount); return { configured: args.failCount }; });
app.shell.registry.register('queue', 'reset-flaky', { description: 'Reset the flaky-job failure counter' }, async () => { resetFlaky(); return { reset: true }; });
app.shell.registry.register('queue', 'sent', { description: 'What the mock notification handler sent' }, async () => sent);

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Job queue demo running at http://localhost:${PORT}
  commands: queue:enqueue-report, queue:enqueue-notification, queue:enqueue-flaky,
            queue:job, queue:list, queue:stats, queue:dead-letter, queue:retry,
            queue:purge, queue:configure-flaky, queue:reset-flaky, queue:sent

Try:
  POST /api/shell/exec {"cmd":"queue:enqueue-report --entryType post"}
  POST /api/shell/exec {"cmd":"queue:job --id <id from above>"}
See examples/job-queue/README.md for the full walkthrough.
`);
