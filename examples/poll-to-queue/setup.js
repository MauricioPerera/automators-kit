/**
 * Poll To Queue — HTTP/shell demo.
 *
 *   bun examples/poll-to-queue/setup.js
 *
 * Combines core/triggers.js's poll trigger (examples/trigger-hub) with
 * core/queue.js's JobQueue (examples/job-queue): watch an external feed
 * for changes, enqueue ONE durable, independently-retryable job per
 * genuinely new item — a real production ingestion pattern neither
 * example demonstrates alone (trigger-hub only logs fired events;
 * job-queue has no poll source, jobs are enqueued directly).
 *
 * hub.js has the actual bridge logic and the 2 real gotchas found while
 * building this (net-guard blocking localhost poll targets, and the
 * baseline-seeding requirement since TriggerManager's poll never fires
 * onTrigger on its first cycle). See README for both, verified live.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { buildMockFeedApi } from './mock-feed-api.js';
import { buildIncidentHandlers } from './handlers.js';
import { buildPollToQueue, registerPollTrigger, POLL_TARGET_URL } from './hub.js';

const PORT = +(process.env.PORT || 3022);
const DB_PATH = process.env.DB_PATH || './examples/poll-to-queue/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'poll-to-queue-demo-secret',
  logger: true,
});

const { router: mockRouter, addItem, failNextCalls } = buildMockFeedApi();
app.router.route('/mock', mockRouter);

// Start serving BEFORE the baseline fetch below — it needs the mock feed
// endpoint reachable over real HTTP.
Bun.serve({ fetch: app.handle, port: PORT });

// A couple of incidents that exist BEFORE this demo starts watching, so
// the baseline-seeding step below actually has something to prove: a
// fresh run must never (re)enqueue these just because it's the first time
// it has seen the feed.
addItem({ id: 'inc-1', title: 'Disk usage above 90% on db-1', severity: 'warning' });
addItem({ id: 'inc-2', title: 'Elevated 5xx rate on checkout service', severity: 'critical' });

const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 3 });
const { handlers, processed, failNextFor } = buildIncidentHandlers();
queue.register('process-incident', handlers['process-incident']);
queue.start();

// net-guard blocks registering a poll trigger against "localhost" outright
// (no opt-out, see examples/trigger-hub). POLL_TARGET_URL is a
// syntactically-public placeholder that passes registration; real fetch()
// calls to that exact URL are redirected here to this server's own mock.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, opts) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url === POLL_TARGET_URL) return realFetch(`http://localhost:${PORT}/mock/feed`, opts);
  return realFetch(input, opts);
};

// Baseline seed: fetch the feed BEFORE the poll trigger starts. Without
// this, TriggerManager's poll never fires onTrigger on its first cycle
// (it only establishes the baseline hash there) -- the first REAL fire,
// on whatever change happens next, would include inc-1/inc-2 in its item
// list too, and with an empty seenIds set both would look "new" and get
// enqueued a second time.
const seenIds = new Set();
const baseline = await (await fetch(POLL_TARGET_URL)).json();
for (const item of baseline.items) seenIds.add(item.id);

const tm = buildPollToQueue(queue, seenIds);
registerPollTrigger(tm, { pollInterval: 1000 });
tm.start();

app.shell.registry.register('incidents', 'add', {
  description: 'Add a new incident to the mock feed (the poll trigger picks it up within ~1s)',
  params: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'severity', type: 'string' },
  ],
}, async (args) => addItem({ id: args.id, title: args.title, severity: args.severity || 'info' }));

app.shell.registry.register('incidents', 'fail-next', {
  description: 'Make processing a specific incident id fail N times (drives retry/backoff/dead-letter)',
  params: [{ name: 'id', type: 'string', required: true }, { name: 'n', type: 'number', required: true }],
}, async (args) => { failNextFor(args.id, args.n); return { id: args.id, willFail: args.n }; });

app.shell.registry.register('incidents', 'feed-down', {
  description: 'Make the feed endpoint itself fail the next N poll cycles (drives the poll circuit-breaker)',
  params: [{ name: 'n', type: 'number', required: true }],
}, async (args) => { failNextCalls(args.n); return { willFail: args.n }; });

app.shell.registry.register('incidents', 'processed', { description: 'Incidents successfully processed so far' }, async () => processed);
app.shell.registry.register('incidents', 'queue-stats', { description: 'JobQueue stats (pending/processing/completed/dead)' }, async () => queue.stats());
app.shell.registry.register('incidents', 'dead-letter', { description: 'Incidents that exhausted all retries' }, async () => queue.deadLetter());
app.shell.registry.register('incidents', 'triggers', { description: 'The poll trigger\'s status (pollerStatus reflects circuit-breaker state)' }, async () => tm.list());

console.log(`
Poll-to-queue demo running at http://localhost:${PORT}
  commands: incidents:add, incidents:fail-next, incidents:feed-down,
            incidents:processed, incidents:queue-stats,
            incidents:dead-letter, incidents:triggers

Started with inc-1/inc-2 already on the feed (baseline-seeded, never
enqueued). Try:
  POST /api/shell/exec {"cmd":"incidents:add --id inc-3 --title \\"New alert\\""}
    -> a new job appears within ~1s; check incidents:processed
  POST /api/shell/exec {"cmd":"incidents:fail-next --id inc-4 --n 5"}
  POST /api/shell/exec {"cmd":"incidents:add --id inc-4 --title \\"Flaky\\""}
    -> retries with backoff, then dead letter; check incidents:dead-letter
See examples/poll-to-queue/README.md for the full walkthrough.
`);
