/**
 * Queue Observability — HTTP/shell demo.
 *
 *   bun examples/queue-observability/setup.js
 *
 * Combines core/log.js + core/metrics.js with core/queue.js: real job
 * outcomes (completed / dead-letter / no-handler-failed), instead of
 * examples/workflow-observability's workflow executions or
 * core/http.js's own request-level logger()/metricsHandler(). observe.js's
 * observeJobQueue() watches `_queue_jobs`/`_queue_dead` via `DocStore.watch()`
 * — no core/queue.js changes needed.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { metricsHandler } from '../../core/http.js';
import { alwaysOk, flakyOnce, alwaysDies } from './handlers.js';
import { observeJobQueue } from './observe.js';

const PORT = +(process.env.PORT || 3033);
const DB_PATH = process.env.DB_PATH || './examples/queue-observability/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'queue-observability-demo-secret',
  logger: true,
});

const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 2 });
queue.register('always-ok', alwaysOk);
queue.register('flaky-once', flakyOnce);
queue.register('always-dies', alwaysDies);
queue.start();

const metrics = observeJobQueue(queue);

app.router.get('/metrics', metricsHandler(metrics));

app.shell.registry.register('jobs', 'enqueue', {
  description: 'Enqueue a job. type: always-ok | flaky-once | always-dies | anything-else (no handler -> immediate failed)',
  params: [
    { name: 'type', type: 'string', required: true },
    { name: 'id', type: 'string' },
  ],
}, async (args) => {
  const job = queue.enqueue(args.type, { id: args.id || args.type });
  return { jobId: job._id, status: job.status };
});

app.shell.registry.register('jobs', 'stats', { description: 'Queue stats' }, async () => queue.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Queue observability demo running at http://localhost:${PORT}
  commands: jobs:enqueue, jobs:stats

Try all 4 terminal outcomes, then check /metrics:
  POST /api/shell/exec {"cmd":"jobs:enqueue --type always-ok"}
  POST /api/shell/exec {"cmd":"jobs:enqueue --type flaky-once --id r1"}
  POST /api/shell/exec {"cmd":"jobs:enqueue --type always-dies"}
  POST /api/shell/exec {"cmd":"jobs:enqueue --type no-such-handler"}
  curl http://localhost:${PORT}/metrics
See examples/queue-observability/README.md for the full walkthrough.
`);
