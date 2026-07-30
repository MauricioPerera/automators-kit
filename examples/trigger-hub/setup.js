/**
 * Trigger Hub — HTTP/shell demo.
 *
 *   bun examples/trigger-hub/setup.js
 *
 * core/triggers.js's TriggerManager, front and center: 4 trigger types
 * (manual, webhook, cron, poll) all feeding one unified onTrigger
 * callback. No CMS, no WorkflowEngine — TriggerManager needs neither
 * (à la carte, same spirit as examples/doc-store-analytics).
 *
 * The poll trigger watches a mock status endpoint on this same server and
 * only fires when the response data actually changes (hash comparison),
 * with a circuit-breaker after 3 consecutive failures. Since
 * TriggerManager.register() calls net-guard's assertPublicUrl
 * unconditionally for poll triggers (no opt-out), it cannot be registered
 * against "localhost" directly — see hub.js's POLL_TARGET_URL comment and
 * this README for the real, verified constraint and the redirect used to
 * demo it anyway.
 */

import { Router, json, error, cors } from '../../core/http.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { buildMockStatusApi } from './mock-status-api.js';
import { buildTriggerHub, registerDemoTriggers, POLL_TARGET_URL } from './hub.js';

const PORT = +(process.env.PORT || 3019);

const { router: mockRouter, bumpVersion, failNextCalls } = buildMockStatusApi();

// net-guard blocks registering a poll trigger against "localhost" (or any
// loopback/RFC1918 literal) outright. POLL_TARGET_URL is a syntactically
// public placeholder that passes registration; real fetch() calls to that
// exact URL are redirected here to this server's own local mock. Every
// other fetch() passes through unchanged.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, opts) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url === POLL_TARGET_URL) return realFetch(`http://localhost:${PORT}/mock/status`, opts);
  return realFetch(input, opts);
};

const { tm, events } = buildTriggerHub({ maxConsecutiveFailures: 3 });
registerDemoTriggers(tm, { pollInterval: 1000 });
tm.start();

const router = new Router();
router.use(cors());
router.route('/mock', mockRouter);

router.post('/webhook/:path', async (ctx) => {
  const body = await ctx.json();
  // Same convention as routes/workflows.js's webhookTrigger route: secret
  // read from a header, never body/query; same generic 404 either way.
  const secret = ctx.req.headers.get('X-Webhook-Secret');
  const workflowId = tm.fireWebhook(ctx.params.path, body, secret);
  if (!workflowId) return error('No webhook registered for this path, or bad secret', 404);
  return json({ fired: workflowId });
});

router.get('/triggers', () => json({ triggers: tm.list() }));
router.get('/events', () => json({ events }));

const shell = new Shell({ profile: 'admin' });
shell.registry.register('triggers', 'fire-manual', {
  description: 'Manually fire a registered trigger',
  params: [{ name: 'workflowId', type: 'string', required: true }],
}, async (args) => { tm.fireManual(args.workflowId, { source: 'admin' }); return { fired: args.workflowId }; });
shell.registry.register('triggers', 'list', { description: 'List all registered triggers (poll rows include pollerStatus)' }, async () => tm.list());
shell.registry.register('triggers', 'events', { description: 'Recently fired trigger events, newest first' }, async () => events.slice(0, 20));
shell.registry.register('mock', 'bump-version', { description: 'Change the mock status endpoint data — the poll trigger detects it next cycle' }, async () => ({ version: bumpVersion() }));
shell.registry.register('mock', 'fail-next', {
  description: 'Make the mock status endpoint fail the next N calls (drives the poll circuit-breaker)',
  params: [{ name: 'n', type: 'number' }],
}, async (args) => { failNextCalls(args.n || 1); return { willFail: args.n || 1 }; });

router.route('/api/shell', shellRoutes(shell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Trigger hub demo running at http://localhost:${PORT}
  GET  /triggers                       — list all 4 registered triggers
  GET  /events                         — fired events, newest first
  POST /webhook/push (X-Webhook-Secret: demo-webhook-secret)
  shell: triggers:fire-manual, triggers:list, triggers:events,
         mock:bump-version, mock:fail-next

The poll trigger ('status-watch') checks the mock status endpoint every
1s and only fires when its data changes.

Try:
  POST /api/shell/exec {"cmd":"mock:bump-version"}     # poll fires within ~1s
  POST /api/shell/exec {"cmd":"mock:fail-next --n 3"}  # trips the circuit-breaker
  GET  /triggers                                        # pollerStatus: "error"
See examples/trigger-hub/README.md for the full walkthrough.
`);
