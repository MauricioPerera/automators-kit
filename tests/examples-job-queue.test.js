/**
 * Job Queue — end-to-end regression test.
 * Mirrors examples/job-queue/setup.js (reuses buildJobHandlers +
 * buildQueueTools) so the demo and the test can't drift apart. Uses
 * MemoryStorageAdapter (in-process, no disk) and a fast poll/backoff, same
 * as the live demo, so this stays fast without touching real time.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { buildJobHandlers } from '../examples/job-queue/handlers.js';
import { buildQueueTools } from '../examples/job-queue/tools.js';

let app;
let queue;
let tools;
let sent;
let configureFlaky;
let resetFlaky;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function exec(cmd) {
  const res = await app.handle(req(cmd));
  return res.json();
}

/** Poll a condition until it's true or the timeout expires — mirrors how a
 * real client would poll a job's status instead of blocking on it. */
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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'job-queue-test-secret!!!' });
  queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 20, backoffMs: 20, maxRetries: 3 });

  const jh = buildJobHandlers();
  sent = jh.sent;
  configureFlaky = jh.configureFlaky;
  resetFlaky = jh.resetFlaky;
  for (const [type, handler] of Object.entries(jh.handlers)) queue.register(type, handler);
  queue.start();

  tools = buildQueueTools(queue, app.cms.db);
  app.shell.registry.register('queue', 'enqueue-report', { description: 'x' }, async (args) => tools.enqueueReport(args));
  app.shell.registry.register('queue', 'enqueue-notification', { description: 'x' }, async (args) => tools.enqueueNotification(args));
  app.shell.registry.register('queue', 'enqueue-flaky', { description: 'x' }, async (args) => tools.enqueueFlaky(args));
  app.shell.registry.register('queue', 'job', { description: 'x' }, async (args) => tools.jobStatus(args.id || args._0));
  app.shell.registry.register('queue', 'list', { description: 'x' }, async (args) => tools.listJobs(args));
  app.shell.registry.register('queue', 'stats', { description: 'x' }, async () => tools.stats());
  app.shell.registry.register('queue', 'dead-letter', { description: 'x' }, async (args) => tools.deadLetterList(args.limit));
  app.shell.registry.register('queue', 'retry', { description: 'x' }, async (args) => tools.retryDead(args.id || args._0));
});

afterAll(() => {
  queue.stop();
});

beforeEach(() => {
  resetFlaky();
});

describe('Job queue: happy path', () => {
  it('a report job goes pending -> completed and carries its result', async () => {
    const enq = await exec('queue:enqueue-report --entryType post --delayMs 10');
    expect(enq.data.status).toBe('pending');

    const completed = await waitFor(async () => {
      const res = await exec(`queue:job --id ${enq.data.jobId}`);
      return res.data?.status === 'completed' ? res.data : null;
    });
    expect(completed.result.report).toMatch(/post/);
    expect(completed.attempts).toBe(1);
  });

  it('a notification job actually reaches the mock handler', async () => {
    const enq = await exec('queue:enqueue-notification --to a@b.com --message hi');
    await waitFor(async () => (await exec(`queue:job --id ${enq.data.jobId}`)).data?.status === 'completed');
    expect(sent.some((s) => s.to === 'a@b.com')).toBe(true);
  });
});

describe('Job queue: retry with backoff', () => {
  it('a job that fails twice then succeeds is retried automatically, not dead-lettered', async () => {
    configureFlaky(2); // fails twice, succeeds on the 3rd attempt — within maxRetries:3
    const enq = await exec('queue:enqueue-flaky');
    const completed = await waitFor(async () => {
      const res = await exec(`queue:job --id ${enq.data.jobId}`);
      return res.data?.status === 'completed' ? res.data : null;
    }, 5000);
    expect(completed.attempts).toBe(3);
    expect(completed.result.ok).toBe(true);
  });
});

describe('Job queue: dead letter', () => {
  it('a job that never stops failing exhausts retries and moves to the dead letter', async () => {
    configureFlaky(999); // always fails
    const enq = await exec('queue:enqueue-flaky --maxRetries 2');

    const dead = await waitFor(async () => {
      const dl = await exec('queue:dead-letter');
      return dl.data.find((d) => d._id === enq.data.jobId) || null;
    }, 5000);
    expect(dead.attempts).toBe(2);
    expect(dead.status).toBe('dead');

    // No longer in the live collection.
    const statusRes = await exec(`queue:job --id ${enq.data.jobId}`);
    expect(statusRes.data.status).toBe('dead');
  });

  it('retrying a dead-letter job re-enqueues it, and it can now succeed', async () => {
    configureFlaky(999);
    const enq = await exec('queue:enqueue-flaky --maxRetries 1');
    await waitFor(async () => (await exec('queue:dead-letter')).data.some((d) => d._id === enq.data.jobId), 5000);

    resetFlaky(); // let it succeed this time
    const retryRes = await exec(`queue:retry --id ${enq.data.jobId}`);
    expect(retryRes.data.jobId).not.toBe(enq.data.jobId); // retryDead() creates a NEW job, different id

    const completed = await waitFor(async () => {
      const res = await exec(`queue:job --id ${retryRes.data.jobId}`);
      return res.data?.status === 'completed' ? res.data : null;
    }, 5000);
    expect(completed.result.ok).toBe(true);
  });
});

describe('Job queue: stats', () => {
  it('reflects current queue state', async () => {
    const res = await exec('queue:stats');
    expect(typeof res.data.pending).toBe('number');
    expect(typeof res.data.dead).toBe('number');
  });
});
