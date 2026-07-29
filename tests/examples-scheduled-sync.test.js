/**
 * Scheduled Outbound Sync — end-to-end regression test.
 * Mirrors examples/scheduled-sync/setup.js (reuses buildMockExternalApi +
 * buildSyncTools). Starts a real Bun.serve() because core/connector.js uses
 * real fetch() under the hood (same reason as tests/examples-integrations.test.js).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { CredentialVault } from '../core/credentials.js';
import { buildMockExternalApi } from '../examples/scheduled-sync/mock-external-api.js';
import { buildSyncTools } from '../examples/scheduled-sync/tools.js';

let app, vault, received, failNextCalls, tools, server, baseUrl;

function req(cmd) {
  return new Request(`${baseUrl}/api/shell/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}
async function exec(cmd) { return (await fetch(req(cmd))).json(); }

async function publishEntry(title) {
  const entry = await app.cms.entries.create({ contentTypeSlug: 'record', title, content: { title } });
  return app.cms.entries.publish(entry._id);
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'scheduled-sync-test-secret!!!' });

  await app.cms.contentTypes.create({
    name: 'Record',
    slug: 'record',
    fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
  });

  vault = new CredentialVault(app.cms.db, 'scheduled-sync-test-master-key');
  await vault.init();

  const mocks = buildMockExternalApi();
  received = mocks.received;
  failNextCalls = mocks.failNextCalls;
  app.router.route('/mock/external', mocks.router);

  const stateCol = app.cms.db.collection('_sync_state');
  tools = buildSyncTools(app.cms, vault, stateCol);

  app.shell.registry.register('sync', 'setup-api', { description: 'setup-api' }, async (args) => tools.setupApi(args));
  app.shell.registry.register('sync', 'run-now', { description: 'run-now' }, async (args) => tools.runSync({ retryDelay: args.retryDelay }));
  app.shell.registry.register('sync', 'status', { description: 'status' }, async () => tools.status());

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  await exec(`sync:setup-api --baseUrl ${baseUrl}/mock/external --token demo-token`);
});

afterAll(() => { server.stop(true); });

describe('Scheduled sync: happy path', () => {
  it('syncs published entries and advances the cursor', async () => {
    await publishEntry('Record A');
    await publishEntry('Record B');

    const res = await exec('sync:run-now');
    expect(res.code).toBe(0);
    expect(res.data.synced).toBe(2);
    expect(res.data.failedEntryId).toBeNull();
    expect(received.map((r) => r.title)).toEqual(['Record A', 'Record B']);
  });

  it('a second run with nothing new syncs zero (cursor prevents resending)', async () => {
    const before = received.length;
    const res = await exec('sync:run-now');
    expect(res.data.synced).toBe(0);
    expect(received.length).toBe(before); // nothing new sent
  });

  it('a newly published entry after that gets picked up on the next run', async () => {
    await publishEntry('Record C');
    const res = await exec('sync:run-now');
    expect(res.data.synced).toBe(1);
    expect(received.at(-1).title).toBe('Record C');
  });
});

describe('Scheduled sync: failure stops the cursor, does not skip', () => {
  it('a failed push stops the run there; the entry is retried (not skipped) on the next run', async () => {
    const statusBefore = await exec('sync:status');
    const cursorBefore = statusBefore.data.cursor;

    await publishEntry('Record D');
    failNextCalls(3); // exceeds runSync's own Connector retry budget (retries=2 -> 3 attempts)
    const failedRun = await exec('sync:run-now --retryDelay 10');
    expect(failedRun.data.failedEntryId).not.toBeNull();
    expect(failedRun.data.synced).toBe(0);
    expect(failedRun.data.cursor).toBe(cursorBefore); // did NOT advance past the failure

    const retryRun = await exec('sync:run-now'); // no failNextCall() this time -> succeeds
    expect(retryRun.data.synced).toBe(1);
    expect(received.at(-1).title).toBe('Record D');
  });
});
