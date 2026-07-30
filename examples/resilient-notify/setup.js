/**
 * Resilient Notify — HTTP/shell demo.
 *
 *   bun examples/resilient-notify/setup.js
 *
 * Combines 3 examples' modules into one real pattern: alerting must not
 * block the request that triggered it (core/queue.js's JobQueue), must
 * survive a channel being transiently down (JobQueue's retry+backoff,
 * dead letter), and should reach *someone* fast rather than wait on one
 * specific channel (core/parallel.js's parallelRace over
 * core/connector.js calls, credentials from core/credentials.js's vault —
 * same building blocks as examples/integrations).
 *
 * Runs fully offline: mocks.js stands in for Slack/Discord/a pager REST
 * API on the same server.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { CredentialVault } from '../../core/credentials.js';
import { buildMockChannels } from './mocks.js';
import { buildNotifyHandler } from './handlers.js';

const PORT = +(process.env.PORT || 3016);
const DB_PATH = process.env.DB_PATH || './examples/resilient-notify/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'resilient-notify-demo-secret',
  logger: true,
});

const { router: mockRouter, configure: configureChannel, reset: resetChannels } = buildMockChannels();
app.router.route('/mock', mockRouter);

const vault = new CredentialVault(app.cms.db, process.env.MASTER_KEY || 'resilient-notify-demo-master-key');
await vault.init();
await vault.store('channel-slack', { url: `http://localhost:${PORT}/mock/slack` });
await vault.store('channel-discord', { url: `http://localhost:${PORT}/mock/discord` });
await vault.store('channel-pager', { url: `http://localhost:${PORT}/mock/pager`, token: 'demo-pager-token' });

const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 3 });
queue.register('notify', buildNotifyHandler(vault));
queue.start();

app.shell.registry.register('alert', 'send', {
  description: 'Enqueue an alert — races all configured channels, takes whichever answers first',
  params: [
    { name: 'message', type: 'string', required: true },
    { name: 'source', type: 'string' },
    { name: 'maxRetries', type: 'number' },
  ],
}, async (args) => {
  const job = queue.enqueue('notify', { message: args.message, source: args.source || 'demo' }, { maxRetries: args.maxRetries });
  return { jobId: job._id, status: job.status };
});

app.shell.registry.register('alert', 'status', {
  description: "Check an alert job's status by id",
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => {
  const job = app.cms.db.collection('_queue_jobs').findById(args.id);
  return job || queue.deadLetter(200).find((d) => d._id === args.id) || null;
});

app.shell.registry.register('alert', 'dead-letter', { description: 'Alerts that exhausted every retry' }, async () => queue.deadLetter());
app.shell.registry.register('alert', 'retry', {
  description: 'Re-enqueue a dead-letter alert',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => {
  const job = queue.retry(args.id);
  return job ? { jobId: job._id, status: job.status } : null;
});

app.shell.registry.register('alert', 'configure-channel', {
  description: 'Set a mock channel\'s latency/failure count for the demo',
  params: [
    { name: 'channel', type: 'string', required: true },
    { name: 'delayMs', type: 'number' },
    { name: 'failCount', type: 'number' },
  ],
}, async (args) => { const { channel, ...patch } = args; configureChannel(channel, patch); return { configured: channel, patch }; });
app.shell.registry.register('alert', 'reset-channels', { description: 'Reset all mock channels to defaults' }, async () => { resetChannels(); return { reset: true }; });

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Resilient notify demo running at http://localhost:${PORT}
  commands: alert:send, alert:status, alert:dead-letter, alert:retry,
            alert:configure-channel, alert:reset-channels

Try:
  POST /api/shell/exec {"cmd":"alert:send --message \\"deploy finished\\""}
  POST /api/shell/exec {"cmd":"alert:status --id <id from above>"}
See examples/resilient-notify/README.md for the full walkthrough.
`);
