/**
 * Poll To Queue — end-to-end regression test.
 * Mirrors examples/poll-to-queue/setup.js (reuses mock-feed-api.js +
 * handlers.js + hub.js so the demo and test can't drift apart). Starts a
 * real Bun.serve() and lets the poll trigger's real setInterval cycle run
 * — same reasoning as tests/examples-trigger-hub.test.js.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { buildMockFeedApi } from '../examples/poll-to-queue/mock-feed-api.js';
import { buildIncidentHandlers } from '../examples/poll-to-queue/handlers.js';
import { buildPollToQueue, registerPollTrigger, POLL_TARGET_URL } from '../examples/poll-to-queue/hub.js';

let server, baseUrl, queue, processed, failNextFor, tm, realFetch;

function req(cmd) {
  return new Request(`${baseUrl}/api/shell/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
  });
}
async function exec(cmd) { return (await fetch(req(cmd))).json(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

beforeAll(async () => {
  const app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'poll-to-queue-test-secret!!!' });
  const mocks = buildMockFeedApi();
  app.router.route('/mock', mocks.router);

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  // Pre-existing items, same as setup.js — the baseline seed below must
  // not enqueue these.
  mocks.addItem({ id: 'inc-1', title: 'Pre-existing 1' });
  mocks.addItem({ id: 'inc-2', title: 'Pre-existing 2' });

  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 50, backoffMs: 50, maxRetries: 3 });
  const handlerSet = buildIncidentHandlers();
  processed = handlerSet.processed;
  failNextFor = handlerSet.failNextFor;
  queue.register('process-incident', handlerSet.handlers['process-incident']);
  queue.start();

  realFetch = globalThis.fetch;
  globalThis.fetch = (input, opts) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url === POLL_TARGET_URL) return realFetch(`${baseUrl}/mock/feed`, opts);
    return realFetch(input, opts);
  };

  const seenIds = new Set();
  const baseline = await (await fetch(POLL_TARGET_URL)).json();
  for (const item of baseline.items) seenIds.add(item.id);

  tm = buildPollToQueue(queue, seenIds);
  registerPollTrigger(tm, { pollInterval: 1000 }); // 1000ms is also TriggerManager's own floor
  tm.start();

  app.shell.registry.register('incidents', 'add', {
    description: 'add', params: [{ name: 'id', type: 'string', required: true }, { name: 'title', type: 'string', required: true }],
  }, async (args) => mocks.addItem({ id: args.id, title: args.title }));
  app.shell.registry.register('incidents', 'feed-down', {
    description: 'feed-down', params: [{ name: 'n', type: 'number', required: true }],
  }, async (args) => { mocks.failNextCalls(args.n); return { willFail: args.n }; });
});

afterAll(() => {
  tm.stop();
  queue.stop();
  server.stop(true);
  globalThis.fetch = realFetch;
});

describe('Poll to queue: baseline seeding', () => {
  it('never enqueues items that already existed on the feed before the demo started watching', async () => {
    await sleep(1300); // let the first real poll cycle run (baseline-only, per triggers.js)
    const stats = queue.stats();
    expect(stats.completed).toBe(0);
    expect(stats.pending).toBe(0);
    expect(processed.length).toBe(0);
  });
});

describe('Poll to queue: real end-to-end ingestion', () => {
  it('a new feed item becomes a durable job and gets processed', async () => {
    await exec('incidents:add --id inc-3 --title "New alert"');
    await sleep(1300); // next real poll cycle detects the change
    expect(processed.some((p) => p.id === 'inc-3')).toBe(true);
  });

  it('a persistently failing item exhausts retries into the dead letter, isolated from other jobs', async () => {
    failNextFor('inc-4', 5); // more than maxRetries (3)
    await exec('incidents:add --id inc-4 --title "Flaky"');
    await sleep(1300);
    // Retries with backoff happen fast (backoffMs: 50) — give them room.
    await sleep(500);
    const dead = queue.deadLetter();
    expect(dead.some((d) => d.data.id === 'inc-4')).toBe(true);
    // inc-3 from the previous test must be unaffected.
    expect(processed.some((p) => p.id === 'inc-3')).toBe(true);
  });
});

describe('Poll to queue: circuit-breaker on a real feed outage', () => {
  it('3 real HTTP 503s from the feed trip the breaker without enqueueing anything spurious', async () => {
    const beforeCount = processed.length;
    await exec('incidents:feed-down --n 3');
    await sleep(3800); // 3 real poll cycles at 1000ms
    expect(processed.length).toBe(beforeCount); // no spurious enqueue from the 503 bodies
    const triggers = tm.list();
    const poll = triggers.find((t) => t.workflowId === 'incident-feed');
    expect(poll.pollerStatus).toBe('error');
    expect(poll.pollerError.lastError).toBe('HTTP 503');
  });
});
