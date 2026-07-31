/**
 * A2E Background — HTTP/shell demo.
 *
 *   bun examples/a2e-background/setup.js
 *
 * Combines core/queue.js's "kick off + poll" pattern (examples/job-queue)
 * with core/a2e.js's declarative executor (examples/a2e-pipeline): run a
 * batch enrichment pipeline as a durable background job instead of
 * blocking the HTTP request — 5 records at 150ms each is 750ms+ of real
 * work, too slow for a synchronous response.
 *
 * A real, serious finding from building this (see README, verified
 * live): a single WorkflowExecutor instance is NOT safe to reuse across
 * concurrent execute() calls — its state/results/errors are mutable
 * instance properties .load() resets, so two pipeline runs sharing one
 * executor under JobQueue's default concurrency (5) can corrupt each
 * other's results. Fixed by building a FRESH executor per job
 * (pipeline.js's buildFreshExecutor()), not sharing one across jobs.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { buildPipelineDef, buildFreshExecutor } from './pipeline.js';

const PORT = +(process.env.PORT || 3024);
const DB_PATH = process.env.DB_PATH || './examples/a2e-background/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'a2e-background-demo-secret',
  logger: true,
});

// concurrency: 3 -- deliberately > 1, so multiple pipeline runs actually
// overlap in practice (the exact condition that corrupts a shared
// executor -- see README) and the fresh-executor-per-job fix is proven
// under real concurrent load, not just single-job happy path.
const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 2 });

queue.register('run-pipeline', async (data) => {
  const executor = buildFreshExecutor(data.delayMs ?? 150);
  executor.load(buildPipelineDef(data.records));
  const r = await executor.execute();
  if (Object.keys(r.errors).length > 0) {
    throw new Error(`Pipeline errors: ${JSON.stringify(r.errors)}`);
  }
  return r.results.summary;
});
queue.start();

const jobsCollection = app.cms.db.collection('_queue_jobs');

app.shell.registry.register('pipelines', 'run', {
  description: 'Enqueue a batch enrichment pipeline run — returns immediately, poll pipelines:status',
  params: [{ name: 'recordsJson', type: 'string', required: true }],
}, async (args) => {
  let records;
  try { records = JSON.parse(args.recordsJson); } catch { throw new Error('recordsJson must be valid JSON'); }
  const job = queue.enqueue('run-pipeline', { records });
  return { jobId: job._id, status: job.status };
});

app.shell.registry.register('pipelines', 'status', {
  description: 'Check a pipeline job by id',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => {
  const job = jobsCollection.findById(args.id);
  return job || queue.deadLetter(200).find((d) => d._id === args.id) || null;
});

app.shell.registry.register('pipelines', 'queue-stats', { description: 'JobQueue stats' }, async () => queue.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
A2E background demo running at http://localhost:${PORT}
  commands: pipelines:run, pipelines:status, pipelines:queue-stats

Try:
  POST /api/shell/exec {"cmd":"pipelines:run --recordsJson '[{\\"id\\":1,\\"name\\":\\"A\\",\\"value\\":10},{\\"id\\":2,\\"name\\":\\"B\\",\\"value\\":20}]'"}
    -> {"jobId":"...","status":"pending"}
  POST /api/shell/exec {"cmd":"pipelines:status --id <jobId>"}
    -> poll until status:"completed", result has the enriched summary
See examples/a2e-background/README.md for the full walkthrough.
`);
