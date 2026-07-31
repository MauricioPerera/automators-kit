/**
 * Rate-Limited Queue — end-to-end regression test.
 * Mirrors examples/rate-limited-queue/setup.js's wiring: a rateLimit()
 * middleware sitting directly in front of a JobQueue.enqueue() call.
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { Router, json, rateLimit } from '../core/http.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { JobQueue } from '../core/queue.js';
import { buildReportHandler } from '../examples/rate-limited-queue/handlers.js';
import { buildRateLimitedQueueTools } from '../examples/rate-limited-queue/tools.js';

const cleanup = [];
afterAll(() => { for (const fn of cleanup) fn(); });

// Fresh queue + router + limiter per scenario -- rateLimit() tracks state by
// key (IP) across the whole middleware's lifetime, so scenarios sharing one
// limiter would see each other's request counts.
function buildScenario({ max = 3, windowMs = 10000, delayMs = 10 } = {}) {
  const db = new DocStore(new MemoryStorageAdapter());
  const queue = new JobQueue(db, { concurrency: 2, pollInterval: 20, backoffMs: 20, maxRetries: 3 });
  const { handler, rendered } = buildReportHandler({ delayMs });
  queue.register('generate-report', handler);
  queue.start();
  const tools = buildRateLimitedQueueTools(queue, db);

  const limiter = rateLimit({ max, windowMs });
  const reportsRouter = new Router();
  reportsRouter.use(limiter);
  reportsRouter.post('/', async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const { jobId, status } = tools.enqueueReport({ topic: body.topic || 'untitled' });
    return json({ jobId, status }, 202);
  });
  reportsRouter.get('/:id', async (ctx) => {
    const job = tools.jobStatus(ctx.params.id);
    if (!job) return json({ error: 'Not found' }, 404);
    return json(job);
  });

  const router = new Router();
  router.route('/api/reports', reportsRouter);
  router.get('/api/stats', async () => json(tools.stats()));

  cleanup.push(() => { queue.stop(); limiter.stop(); });
  return { db, queue, tools, router, rendered };
}

function post(router, topic) {
  return router.handle(new Request('http://x/api/reports', {
    method: 'POST',
    body: JSON.stringify({ topic }),
  }));
}

describe('Rate-limited queue: the limiter blocks intake before a job is ever created', () => {
  it('allows exactly `max` enqueues, then 429s without creating a job', async () => {
    const { router } = buildScenario({ max: 3 });
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await post(router, `t${i}`));

    expect(responses[0].status).toBe(202);
    expect(responses[1].status).toBe(202);
    expect(responses[2].status).toBe(202);
    expect(responses[3].status).toBe(429);

    const allowedBodies = await Promise.all(responses.slice(0, 3).map((r) => r.json()));
    for (const b of allowedBodies) expect(b.status).toBe('pending');

    const blockedBody = await responses[3].json();
    expect(blockedBody.jobId).toBeUndefined();
  });

  it('carries X-RateLimit-* headers on the 202 (allowed) response, mirroring core/http.js\'s CORS-style header merge', async () => {
    const { router } = buildScenario({ max: 3 });
    const res = await post(router, 'headers-check');
    expect(res.status).toBe(202);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res.headers.get('X-RateLimit-Remaining')).not.toBeNull();
  });
});

describe('Rate-limited queue: an allowed request really reaches the queue and completes', () => {
  it('an enqueued job actually runs and its result is queryable by id', async () => {
    const db2 = new DocStore(new MemoryStorageAdapter());
    const queue2 = new JobQueue(db2, { concurrency: 1, pollInterval: 10, backoffMs: 10, maxRetries: 1 });
    const { handler } = buildReportHandler({ delayMs: 5 });
    queue2.register('generate-report', handler);
    queue2.start();
    const tools2 = buildRateLimitedQueueTools(queue2, db2);

    const { jobId } = tools2.enqueueReport({ topic: 'widgets' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const job = tools2.jobStatus(jobId);
    expect(job.status).toBe('completed');
    expect(job.result.report).toBe('report for widgets');
    queue2.stop();
  });

  it('an unknown job id returns null, not throw', () => {
    const { tools } = buildScenario();
    expect(tools.jobStatus('nope')).toBeNull();
  });
});
