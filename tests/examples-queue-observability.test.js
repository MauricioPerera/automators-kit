/**
 * Queue Observability — end-to-end regression test.
 * Mirrors examples/queue-observability/setup.js (reuses handlers.js/
 * observe.js so the demo and the test can't drift apart).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { metricsHandler } from '../core/http.js';
import { alwaysOk, flakyOnce, alwaysDies } from '../examples/queue-observability/handlers.js';
import { observeJobQueue } from '../examples/queue-observability/observe.js';

let app, queue, metrics, entries;

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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'queue-observability-test-secret!!!' });
  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 20, backoffMs: 20, maxRetries: 2 });
  queue.register('always-ok', alwaysOk);
  queue.register('flaky-once', flakyOnce);
  queue.register('always-dies', alwaysDies);
  queue.start();

  entries = [];
  const log = { debug() {}, warn: (msg, fields) => entries.push({ level: 'warn', msg, ...fields }), error() {}, info: (msg, fields) => entries.push({ level: 'info', msg, ...fields }) };
  metrics = observeJobQueue(queue, { log });
});

describe('Queue observability: all 3 terminal outcomes are observed exactly once each', () => {
  it('a job that succeeds immediately is counted as completed', async () => {
    const job = queue.enqueue('always-ok', {});
    await waitFor(() => entries.find((e) => e.jobId === job._id));
    const entry = entries.find((e) => e.jobId === job._id);
    expect(entry.level).toBe('info');
    expect(entry.status).toBe('completed');
    expect(entry.attempts).toBe(1);
  });

  it("a job that fails once then succeeds on retry is counted exactly once, as completed (not twice)", async () => {
    const job = queue.enqueue('flaky-once', { id: 'retry-1' });
    await waitFor(() => entries.filter((e) => e.jobId === job._id).length > 0);
    // Give any spurious second emission a chance to show up before asserting.
    await new Promise((r) => setTimeout(r, 100));
    const matching = entries.filter((e) => e.jobId === job._id);
    expect(matching.length).toBe(1);
    expect(matching[0].status).toBe('completed');
    expect(matching[0].attempts).toBe(2); // 1 failure + 1 successful retry
  });

  it('a job that exhausts all retries is counted exactly once, as dead', async () => {
    const job = queue.enqueue('always-dies', {});
    await waitFor(() => entries.find((e) => e.jobId === job._id && e.level === 'warn'));
    const matching = entries.filter((e) => e.jobId === job._id);
    expect(matching.length).toBe(1);
    expect(matching[0].level).toBe('warn');
    expect(matching[0].msg).toBe('job moved to dead letter');
  });

  it('a job with no registered handler is counted as failed, without ever reaching "processing"', async () => {
    const job = queue.enqueue('no-such-type', {});
    await waitFor(() => entries.find((e) => e.jobId === job._id));
    const matching = entries.filter((e) => e.jobId === job._id);
    expect(matching.length).toBe(1);
    expect(matching[0].status).toBe('failed');
  });

  it('feeds queue_jobs_total (all 3 statuses) into the registry, and /metrics exposes it over real HTTP', async () => {
    const output = metrics.render();
    expect(output).toContain('queue_jobs_total{type="always-ok",status="completed"}');
    expect(output).toContain('queue_jobs_total{type="always-dies",status="dead"}');
    expect(output).toContain('queue_jobs_total{type="no-such-type",status="failed"}');

    const app2 = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'metrics-route-test-secret!!!' });
    app2.router.get('/metrics', metricsHandler(metrics));
    const server = Bun.serve({ fetch: app2.handle, port: 0 });
    const res = await fetch(`http://localhost:${server.port}/metrics`);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toContain('# TYPE queue_jobs_total counter');
    server.stop(true);
  });
});
