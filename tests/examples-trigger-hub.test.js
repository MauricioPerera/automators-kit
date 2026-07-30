/**
 * Trigger Hub — end-to-end regression test.
 * Mirrors examples/trigger-hub/setup.js (reuses hub.js + mock-status-api.js
 * so the demo and test can't drift apart). Starts a real Bun.serve() and
 * lets the poll trigger's real setInterval cycle run — core/triggers.js's
 * poll behavior is fundamentally about real elapsed time, not something a
 * pure-dispatch test can fake away (the module's own unit tests use
 * _pollOnce() directly for that; this test exercises the real timer path
 * instead, same reason tests/examples-integrations.test.js starts a real
 * server for core/connector.js's real fetch()).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Router, json, error, cors } from '../core/http.js';
import { Shell } from '../core/shell.js';
import { shellRoutes } from '../routes/shell.js';
import { buildMockStatusApi } from '../examples/trigger-hub/mock-status-api.js';
import { buildTriggerHub, registerDemoTriggers, POLL_TARGET_URL } from '../examples/trigger-hub/hub.js';

let server, baseUrl, tm, events, bumpVersion, failNextCalls, realFetch;

function req(path, opts) { return new Request(`${baseUrl}${path}`, opts); }
async function get(path) { return (await fetch(req(path))).json(); }
async function exec(cmd) {
  return (await fetch(req('/api/shell/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
  }))).json();
}
async function postWebhook(path, body, secret) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Webhook-Secret'] = secret;
  const res = await fetch(req(`/webhook/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

beforeAll(() => {
  const mocks = buildMockStatusApi();
  bumpVersion = mocks.bumpVersion;
  failNextCalls = mocks.failNextCalls;

  const hub = buildTriggerHub({ maxConsecutiveFailures: 3 });
  tm = hub.tm;
  events = hub.events;
  registerDemoTriggers(tm, { pollInterval: 1000 }); // 1000ms is also TriggerManager's own floor
  tm.start();

  const router = new Router();
  router.use(cors());
  router.route('/mock', mocks.router);
  router.post('/webhook/:path', async (ctx) => {
    const body = await ctx.json();
    const secret = ctx.req.headers.get('X-Webhook-Secret');
    const workflowId = tm.fireWebhook(ctx.params.path, body, secret);
    if (!workflowId) return error('No webhook registered for this path, or bad secret', 404);
    return json({ fired: workflowId });
  });
  router.get('/triggers', () => json({ triggers: tm.list() }));
  router.get('/events', () => json({ events }));

  const shell = new Shell({ profile: 'admin' });
  shell.registry.register('triggers', 'fire-manual', {
    description: 'fire-manual', params: [{ name: 'workflowId', type: 'string', required: true }],
  }, async (args) => { tm.fireManual(args.workflowId, { source: 'admin' }); return { fired: args.workflowId }; });
  shell.registry.register('mock', 'bump-version', { description: 'bump' }, async () => ({ version: bumpVersion() }));
  shell.registry.register('mock', 'fail-next', {
    description: 'fail-next', params: [{ name: 'n', type: 'number' }],
  }, async (args) => { failNextCalls(args.n || 1); return { willFail: args.n || 1 }; });
  router.route('/api/shell', shellRoutes(shell));

  server = Bun.serve({ fetch: router.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  // Same net-guard redirect setup.js uses: POLL_TARGET_URL is a
  // syntactically-public placeholder (assertPublicUrl has no opt-out for
  // poll triggers, unlike connector.js's blockInternalHosts), redirected
  // here to this test server's own local mock.
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, opts) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url === POLL_TARGET_URL) return realFetch(`${baseUrl}/mock/status`, opts);
    return realFetch(input, opts);
  };
});

afterAll(() => {
  tm.stop();
  server.stop(true);
  globalThis.fetch = realFetch;
});

describe('Trigger hub: registration', () => {
  it('registers all 4 trigger types, poll starts as pollerStatus: active', async () => {
    const { triggers } = await get('/triggers');
    expect(triggers.length).toBe(4);
    const poll = triggers.find((t) => t.workflowId === 'status-watch');
    expect(poll.pollerStatus).toBe('active');
  });
});

describe('Trigger hub: manual', () => {
  it('fires immediately via the shell', async () => {
    const res = await exec('triggers:fire-manual --workflowId admin-rerun');
    expect(res.data.fired).toBe('admin-rerun');
    const { events: log } = await get('/events');
    expect(log[0].workflowId).toBe('admin-rerun');
    expect(log[0].trigger).toBe('manual');
  });
});

describe('Trigger hub: webhook', () => {
  it('rejects a missing/wrong secret with a generic 404', async () => {
    const wrong = await postWebhook('push', { msg: 'x' }, 'wrong-secret');
    expect(wrong.status).toBe(404);
    const missing = await postWebhook('push', { msg: 'x' });
    expect(missing.status).toBe(404);
  });

  it('fires with the correct secret', async () => {
    const res = await postWebhook('push', { msg: 'hello' }, 'demo-webhook-secret');
    expect(res.status).toBe(200);
    expect(res.body.fired).toBe('external-push');
    const { events: log } = await get('/events');
    expect(log[0].data.msg).toBe('hello');
  });
});

describe('Trigger hub: poll — real hash-based change detection over real HTTP', () => {
  it('does not fire on the first poll (baseline), fires once the mock data actually changes', async () => {
    await sleep(1300); // first real poll cycle establishes the baseline hash
    const before = (await get('/events')).events.filter((e) => e.workflowId === 'status-watch');

    bumpVersion();
    await sleep(1300); // next real poll cycle should detect the change

    const after = (await get('/events')).events.filter((e) => e.workflowId === 'status-watch');
    expect(after.length).toBe(before.length + 1);
    expect(after[0].data.version).toBeGreaterThan(0);
  });
});

describe('Trigger hub: poll circuit-breaker (real HTTP 503s, not mocked fetch)', () => {
  it('a non-ok response counts as a failure, not a data change, and trips the breaker after 3', async () => {
    const beforeCount = (await get('/events')).events.filter((e) => e.workflowId === 'status-watch').length;
    failNextCalls(3);
    await sleep(3800); // 3 real poll cycles at 1000ms

    const { events: log } = await get('/events');
    const afterCount = log.filter((e) => e.workflowId === 'status-watch').length;
    expect(afterCount).toBe(beforeCount); // the 503 bodies must NOT have fired as "changed data"

    const { triggers } = await get('/triggers');
    const poll = triggers.find((t) => t.workflowId === 'status-watch');
    expect(poll.pollerStatus).toBe('error');
    expect(poll.pollerError.lastError).toBe('HTTP 503');
    expect(poll.pollerError.failures).toBe(3);
  });
});
