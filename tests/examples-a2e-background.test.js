/**
 * A2E Background — end-to-end regression test.
 * Mirrors examples/a2e-background/setup.js (reuses pipeline.js so the demo
 * and test can't drift apart). Starts a real Bun.serve() and lets the
 * queue's real timers run (same reasoning as tests/examples-job-queue.test.js).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { buildPipelineDef, buildFreshExecutor } from '../examples/a2e-background/pipeline.js';

let app, server, baseUrl, queue;

function req(cmd) {
  return new Request(`${baseUrl}/api/shell/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
  });
}
async function exec(cmd) { return (await fetch(req(cmd))).json(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForJob(id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await exec(`pipelines:status --id ${id}`);
    if (res.data && ['completed', 'dead'].includes(res.data.status)) return res.data;
    await sleep(20);
  }
  throw new Error('waitForJob timed out');
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'a2e-background-test-secret!!!' });

  // concurrency: 3, matching setup.js -- deliberately > 1, so the
  // fresh-executor-per-job fix is exercised under real concurrent overlap,
  // not just a single-job happy path.
  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 20, backoffMs: 20, maxRetries: 2 });
  queue.register('run-pipeline', async (data) => {
    const executor = buildFreshExecutor(data.delayMs ?? 30);
    executor.load(buildPipelineDef(data.records));
    const r = await executor.execute();
    if (Object.keys(r.errors).length > 0) throw new Error(`Pipeline errors: ${JSON.stringify(r.errors)}`);
    return r.results.summary;
  });
  queue.start();

  const jobsCollection = app.cms.db.collection('_queue_jobs');
  app.shell.registry.register('pipelines', 'run', {
    description: 'run', params: [{ name: 'recordsJson', type: 'string', required: true }],
  }, async (args) => {
    const records = JSON.parse(args.recordsJson);
    const job = queue.enqueue('run-pipeline', { records });
    return { jobId: job._id, status: job.status };
  });
  app.shell.registry.register('pipelines', 'status', {
    description: 'status', params: [{ name: 'id', type: 'string', required: true }],
  }, async (args) => jobsCollection.findById(args.id) || queue.deadLetter(200).find((d) => d._id === args.id) || null);

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  queue.stop();
  server.stop(true);
});

describe('A2E background: kick-off + poll, real background execution', () => {
  it('a pipeline run completes successfully as a background job', async () => {
    const enq = await exec('pipelines:run --recordsJson \'[{"id":1,"name":"A","value":10},{"id":2,"name":"B","value":20}]\'');
    expect(enq.data.status).toBe('pending');

    const done = await waitForJob(enq.data.jobId);
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({
      count: 2,
      totalScore: 60,
      records: [{ id: 1, name: 'A', score: 20 }, { id: 2, name: 'B', score: 40 }],
    });
  });
});

describe('A2E background: real concurrent job isolation (regression coverage for the fresh-executor-per-job fix)', () => {
  it('3 concurrent pipeline runs each get their own correct, uncorrupted result — not sharing one WorkflowExecutor instance', async () => {
    const enqueued = await Promise.all([1, 2, 3].map((i) =>
      exec(`pipelines:run --recordsJson '[{"id":${i},"name":"Rec${i}","value":${i * 10}}]'`)
    ));
    const results = await Promise.all(enqueued.map((e) => waitForJob(e.data.jobId)));

    for (const [i, r] of results.entries()) {
      const n = i + 1;
      expect(r.status).toBe('completed');
      expect(r.result).toEqual({
        count: 1,
        totalScore: n * 10 * 2,
        records: [{ id: n, name: `Rec${n}`, score: n * 10 * 2 }],
      });
    }
  });
});
