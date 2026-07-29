/**
 * Scheduled Outbound Sync — HTTP/shell demo.
 *
 *   bun examples/scheduled-sync/setup.js
 *
 * The reverse of examples/integrations: instead of reacting to inbound
 * events, this pushes data OUT on a schedule — every 5 minutes (core/cron.js),
 * publish-and-sync any CMS entry that changed since the last successful run
 * to an external system (core/connector.js), tracking progress with a
 * cursor so re-runs don't resend what already synced.
 *
 * Runs fully offline: mock-external-api.js stands in for the external
 * system on this same server.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { CredentialVault } from '../../core/credentials.js';
import { CronScheduler } from '../../core/cron.js';
import { buildMockExternalApi } from './mock-external-api.js';
import { buildSyncTools } from './tools.js';

const PORT = +(process.env.PORT || 3006);
const DB_PATH = process.env.DB_PATH || './examples/scheduled-sync/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'scheduled-sync-demo-secret',
  logger: true,
});

// Demo admin (needed to create/publish entries via the CMS's HTTP API in
// the README walkthrough) — same pattern as examples/content-pipeline.
const ADMIN_EMAIL = 'admin@scheduled-sync.demo';
const ADMIN_PASSWORD = 'demo-admin-12345';
try {
  await app.cms.users.register(ADMIN_EMAIL, ADMIN_PASSWORD, { name: 'Demo Admin', role: 'admin' });
} catch (err) {
  console.log(`[setup] admin already exists: ${err.message}`);
}

await app.cms.contentTypes.create({
  name: 'Record',
  slug: 'record',
  description: 'Records synced to an external system when published',
  fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
}).catch((err) => console.log(`[setup] content type already exists: ${err.message}`));

const vault = new CredentialVault(app.cms.db, process.env.MASTER_KEY || 'scheduled-sync-demo-master-key');
await vault.init();

const { router: mockRouter, received, failNextCalls } = buildMockExternalApi();
app.router.route('/mock/external', mockRouter);

const stateCol = app.cms.db.collection('_sync_state');
const tools = buildSyncTools(app.cms, vault, stateCol);

app.shell.registry.register('sync', 'setup-api', {
  description: 'Store the external system base URL + token (encrypted)',
  params: [
    { name: 'baseUrl', type: 'string', required: true },
    { name: 'token', type: 'string' },
  ],
}, async (args) => tools.setupApi(args));

app.shell.registry.register('sync', 'run-now', {
  description: 'Run the sync immediately (same logic the cron job runs on schedule)',
  params: [{ name: 'retryDelay', type: 'number', description: 'ms, testing only — leave unset in production' }],
}, async (args) => tools.runSync({ retryDelay: args.retryDelay }));

app.shell.registry.register('sync', 'status', {
  description: 'Current cursor and how many published entries are pending sync',
}, async () => tools.status());

app.shell.registry.register('sync', 'received', {
  description: '(demo only) what the mock external API actually received',
}, async () => received);

app.shell.registry.register('sync', 'fail-next', {
  description: '(demo only) make the next push persistently fail (exceeding runSync\'s own retry budget), to see the cursor-stops-at-failure behavior',
}, async () => { failNextCalls(3); return { willFailNext: 3 }; });

// The actual schedule for production use — every 5 minutes.
const cron = new CronScheduler();
cron.add('outbound-sync', '*/5 * * * *', async () => {
  const report = await tools.runSync();
  console.log(`[cron] sync: synced=${report.synced} failedEntryId=${report.failedEntryId}`);
});
cron.start();

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Scheduled sync demo running at http://localhost:${PORT}
  admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}
  commands:    sync:setup-api, sync:run-now, sync:status, sync:received, sync:fail-next
  cron:        runs every 5 minutes (real schedule); use sync:run-now to trigger immediately for the demo

See examples/scheduled-sync/README.md for the full curl walkthrough.
`);
