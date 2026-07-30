/**
 * Resilient Notify — end-to-end regression test.
 * Mirrors examples/resilient-notify/setup.js (reuses buildMockChannels +
 * buildNotifyHandler) so the demo and the test can't drift apart. Starts a
 * real Bun.serve() because core/connector.js uses real fetch() under the
 * hood (same reason as tests/examples-integrations.test.js).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { CredentialVault } from '../core/credentials.js';
import { buildMockChannels } from '../examples/resilient-notify/mocks.js';
import { buildNotifyHandler } from '../examples/resilient-notify/handlers.js';

let app, server, baseUrl, vault, queue, received, configureChannel, resetChannels;

function req(cmd) {
  return new Request(`${baseUrl}/api/shell/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
  });
}
async function exec(cmd) { return (await fetch(req(cmd))).json(); }

/** Poll until a job leaves 'pending'/'processing', the way a real client would. */
async function waitForJob(id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await exec(`alert:status --id ${id}`);
    if (res.data && ['completed', 'dead'].includes(res.data.status)) return res.data;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitForJob timed out');
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'resilient-notify-test-secret!!!' });

  const mocks = buildMockChannels();
  received = mocks.received;
  configureChannel = mocks.configure;
  resetChannels = mocks.reset;
  app.router.route('/mock', mocks.router);

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  vault = new CredentialVault(app.cms.db, 'resilient-notify-test-master-key');
  await vault.init();
  await vault.store('channel-slack', { url: `${baseUrl}/mock/slack` });
  await vault.store('channel-discord', { url: `${baseUrl}/mock/discord` });
  await vault.store('channel-pager', { url: `${baseUrl}/mock/pager`, token: 'demo-pager-token' });

  queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 20, backoffMs: 20, maxRetries: 3 });
  queue.register('notify', buildNotifyHandler(vault));
  queue.start();

  app.shell.registry.register('alert', 'send', { description: 'send' }, async (args) => {
    const job = queue.enqueue('notify', { message: args.message, source: args.source }, { maxRetries: args.maxRetries });
    return { jobId: job._id, status: job.status };
  });
  app.shell.registry.register('alert', 'status', { description: 'status' }, async (args) => {
    const job = app.cms.db.collection('_queue_jobs').findById(args.id);
    return job || queue.deadLetter(200).find((d) => d._id === args.id) || null;
  });
  app.shell.registry.register('alert', 'dead-letter', { description: 'dl' }, async () => queue.deadLetter());
  app.shell.registry.register('alert', 'retry', { description: 'retry' }, async (args) => {
    const job = queue.retry(args.id);
    return job ? { jobId: job._id, status: job.status } : null;
  });
});

afterAll(() => {
  queue.stop();
  server.stop(true);
});

beforeEach(() => {
  resetChannels();
});

describe('Resilient notify: happy path (race)', () => {
  it('completes via whichever channel answers first, and the job records which one', async () => {
    const enq = await exec('alert:send --message "deploy finished"');
    expect(enq.data.status).toBe('pending');

    const done = await waitForJob(enq.data.jobId);
    expect(done.status).toBe('completed');
    expect(['slack', 'discord', 'pager']).toContain(done.result.channel);
  });

  it('a losing channel that also succeeds in time still actually receives the message (parallelRace does not cancel it)', async () => {
    // Equal, fast latency on slack/discord so both are likely to complete
    // within the race window regardless of which one "wins".
    configureChannel('slack', { delayMs: 20 });
    configureChannel('discord', { delayMs: 20 });
    const enq = await exec('alert:send --message "both should receive this"');
    await waitForJob(enq.data.jobId);
    // Give the loser's already-in-flight request a moment to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(received.slack.some((m) => m.text === 'both should receive this')).toBe(true);
    expect(received.discord.some((m) => m.text === 'both should receive this')).toBe(true);
  });
});

describe('Resilient notify: one channel down does not block the alert', () => {
  it('a single failing channel is ignored by the race — the alert still completes fast', async () => {
    configureChannel('slack', { failCount: 999 }); // always fails
    const enq = await exec('alert:send --message "slack is down"');
    const done = await waitForJob(enq.data.jobId);
    expect(done.status).toBe('completed');
    expect(done.result.channel).not.toBe('slack');
  });
});

describe('Resilient notify: all channels down -> dead letter -> retry -> recovers', () => {
  it('exhausts retries into the dead letter when every channel fails, then succeeds once channels recover', async () => {
    configureChannel('slack', { failCount: 999 });
    configureChannel('discord', { failCount: 999 });
    configureChannel('pager', { failCount: 999 });

    const enq = await exec('alert:send --message "everything is down" --maxRetries 2');
    const dead = await waitForJob(enq.data.jobId);
    expect(dead.status).toBe('dead');
    expect(dead.error).toMatch(/All notification channels failed/);

    resetChannels(); // channels recover
    const retryRes = await exec(`alert:retry --id ${enq.data.jobId}`);
    expect(retryRes.data.jobId).not.toBe(enq.data.jobId);

    const recovered = await waitForJob(retryRes.data.jobId);
    expect(recovered.status).toBe('completed');
  });
});
