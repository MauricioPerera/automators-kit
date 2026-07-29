/**
 * Integration Prototyping Kit — HTTP/shell demo.
 *
 *   bun examples/integrations/setup.js
 *
 * "Wire up Slack + Discord + a REST API in a few lines, with retries and
 * secrets handled for you" — core/connector.js (auth presets, retry/backoff,
 * optional SSRF guard) + core/credentials.js (encrypted vault) doing the
 * work n8n's integration nodes do, as a library.
 *
 * Runs fully offline: mocks.js stands in for "Slack"/"Discord"/a flaky
 * third-party API on the SAME server, so you see retries and delivery work
 * for real without needing actual webhook URLs. Swap the stored credential
 * URLs for real ones — the Connector code is identical either way.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { CredentialVault } from '../../core/credentials.js';
import { buildMockIntegrations } from './mocks.js';
import { buildIntegrationTools } from './tools.js';

const PORT = +(process.env.PORT || 3005);
const DB_PATH = process.env.DB_PATH || './examples/integrations/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'integrations-demo-secret',
  logger: true,
});

// Same vault mechanism core/credentials.js already provides: AES-256-GCM,
// random per-installation PBKDF2 salt (persisted on first use).
const vault = new CredentialVault(app.cms.db, process.env.MASTER_KEY || 'integrations-demo-master-key');
await vault.init();

const { router: mockRouter, received, resetFlaky } = buildMockIntegrations();
app.router.route('/mock', mockRouter);

const tools = buildIntegrationTools(vault);

app.shell.registry.register('integrations', 'setup-webhook', {
  description: 'Store a Slack or Discord webhook URL (encrypted)',
  params: [
    { name: 'service', type: 'string', required: true }, // 'slack' | 'discord'
    { name: 'url', type: 'string', required: true },
  ],
}, async (args) => tools.setupWebhook(args));

app.shell.registry.register('integrations', 'setup-api', {
  description: 'Store a REST API base URL + bearer token (encrypted)',
  params: [
    { name: 'baseUrl', type: 'string', required: true },
    { name: 'token', type: 'string' },
  ],
}, async (args) => tools.setupApi(args));

app.shell.registry.register('integrations', 'notify', {
  description: 'Relay a message to every configured chat webhook',
  params: [{ name: 'message', type: 'string', required: true }],
}, async (args) => tools.notify({ message: args.message || args._0 }));

app.shell.registry.register('integrations', 'call-api', {
  description: 'Call the configured REST API (with retries against a flaky endpoint)',
  params: [
    { name: 'retries', type: 'number' },
    { name: 'retryDelay', type: 'number', description: 'ms, testing only — leave unset in production' },
  ],
}, async (args) => tools.callApi(args));

// Reset the mock flaky endpoint's failure counter, and inspect what the
// mock Slack/Discord endpoints received — for the demo/README walkthrough.
app.shell.registry.register('integrations', 'reset-flaky', { description: 'Reset the mock flaky API' }, async () => { resetFlaky(); return { reset: true }; });
app.shell.registry.register('integrations', 'received', { description: 'What the mock Slack/Discord endpoints received' }, async () => received);

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Integration prototyping demo running at http://localhost:${PORT}
  commands: integrations:setup-webhook, integrations:setup-api,
            integrations:notify, integrations:call-api,
            integrations:reset-flaky, integrations:received

Try:
  POST /api/shell/exec {"cmd":"integrations:setup-webhook --service slack --url http://localhost:${PORT}/mock/slack"}
  POST /api/shell/exec {"cmd":"integrations:setup-webhook --service discord --url http://localhost:${PORT}/mock/discord"}
  POST /api/shell/exec {"cmd":"integrations:notify --message \\"deploy finished\\""}
  POST /api/shell/exec {"cmd":"integrations:received"}
See examples/integrations/README.md for the full walkthrough.
`);
