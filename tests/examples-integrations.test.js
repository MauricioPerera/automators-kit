/**
 * Integration Prototyping Kit — end-to-end regression test.
 * Mirrors examples/integrations/setup.js (reuses buildMockIntegrations +
 * buildIntegrationTools) so the demo and the test can't drift apart.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { CredentialVault } from '../core/credentials.js';
import { buildMockIntegrations } from '../examples/integrations/mocks.js';
import { buildIntegrationTools } from '../examples/integrations/tools.js';

let app;
let vault;
let received;
let resetFlaky;
let server;
let baseUrl;

function req(cmd) {
  return new Request(`${baseUrl}/api/shell/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function exec(cmd) {
  const res = await fetch(req(cmd));
  return res.json();
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'integrations-test-secret!!!' });

  vault = new CredentialVault(app.cms.db, 'integrations-test-master-key');
  await vault.init();

  const mocks = buildMockIntegrations();
  received = mocks.received;
  resetFlaky = mocks.resetFlaky;
  app.router.route('/mock', mocks.router);

  const tools = buildIntegrationTools(vault);
  app.shell.registry.register('integrations', 'setup-webhook', { description: 'setup-webhook' }, async (args) => tools.setupWebhook(args));
  app.shell.registry.register('integrations', 'setup-api', { description: 'setup-api' }, async (args) => tools.setupApi(args));
  app.shell.registry.register('integrations', 'notify', { description: 'notify' }, async (args) => tools.notify({ message: args.message || args._0 }));
  app.shell.registry.register('integrations', 'call-api', { description: 'call-api' }, async (args) => tools.callApi(args));

  // core/connector.js uses real fetch() under the hood, so the mock
  // endpoints need an ACTUAL listener — app.handle() alone (in-process
  // Request/Response, no real socket) isn't reachable by fetch().
  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe('Integrations: notify (Slack + Discord)', () => {
  it('delivers a message to both configured webhooks', async () => {
    // Point the stored credentials at the mock endpoints on THIS app.
    await exec(`integrations:setup-webhook --service slack --url ${baseUrl}/mock/slack`);
    await exec(`integrations:setup-webhook --service discord --url ${baseUrl}/mock/discord`);

    const res = await exec('integrations:notify --message "deploy finished"');
    expect(res.code).toBe(0);
    expect(res.data.slack.ok).toBe(true);
    expect(res.data.discord.ok).toBe(true);

    expect(received.slack.at(-1)).toEqual({ text: 'deploy finished' });
    expect(received.discord.at(-1)).toEqual({ content: 'deploy finished' });
  });

  it('reports a service as skipped, not an error, when it was never configured', async () => {
    const freshApp = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'fresh-secret!!!' });
    const freshVault = new CredentialVault(freshApp.cms.db, 'fresh-master-key');
    await freshVault.init();
    const freshTools = buildIntegrationTools(freshVault);
    freshApp.shell.registry.register('integrations', 'notify', { description: 'notify' }, async (args) => freshTools.notify({ message: args.message || args._0 }));

    const res = await freshApp.handle(req('integrations:notify --message "hi"'));
    const body = await res.json();
    expect(body.data.slack.skipped).toBe(true);
    expect(body.data.discord.skipped).toBe(true);
  });
});

describe('Integrations: call-api retries against a genuinely flaky endpoint', () => {
  it('retries through 2 real 503s and succeeds on the 3rd attempt', async () => {
    resetFlaky();
    await exec(`integrations:setup-api --baseUrl ${baseUrl}/mock --token demo-token`);

    const res = await exec('integrations:call-api --retries 3 --retryDelay 10');
    expect(res.code).toBe(0);
    expect(res.data.ok).toBe(true);
    expect(res.data.status).toBe(200);
    expect(res.data.data.recoveredAfterFailures).toBe(2);
  });

  it('exhausting retries on repeated 5xx returns the last failed response, not a thrown error', async () => {
    // Real core/connector.js behavior, confirmed against the live mock: a
    // 5xx exhausting all attempts returns the normal { ok:false, status }
    // result — it only THROWS ConnectorError on a network/timeout failure,
    // not on "server kept saying 503". Callers must check `.ok`, not only
    // catch exceptions, to detect an exhausted-retries HTTP failure.
    resetFlaky(); // needs 2 failures + 1 success; only 1 retry (2 attempts) isn't enough
    const res = await exec('integrations:call-api --retries 1 --retryDelay 10');
    expect(res.code).toBe(0); // the shell command itself did not throw
    expect(res.data.ok).toBe(false);
    expect(res.data.status).toBe(503);
  });
});
