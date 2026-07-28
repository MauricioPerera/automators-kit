/**
 * Content Pipeline — end-to-end regression test.
 * Runs the examples/content-pipeline scenario via createApp() + HTTP,
 * no server/port needed. Mirrors tests/integration.test.js's pattern.
 * Keeps examples/content-pipeline/README.md's curl walkthrough honest.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { Shell } from '../core/shell.js';
import { setupContentPipeline } from '../examples/content-pipeline/pipeline.js';

let app;
let publishWorkflowId;
let webhookSecret;

function req(method, path, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  const opts = { method, headers };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

// WorkflowEngine fires webhook-triggered executions without awaiting them
// (core/workflow.js: `onTrigger` calls `this.execute(...).catch(...)`, not
// `await this.execute(...)`) — the HTTP response confirms the trigger fired,
// not that the workflow finished. A real caller needs to poll
// GET /api/workflows/:id/executions (documented in the README); tests wait
// a beat instead of polling since there's no real I/O to wait on here.
const flushAsyncExecution = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(async () => {
  app = await createApp({
    adapter: new MemoryStorageAdapter(),
    secret: 'pipeline-test-secret!!!',
  });
  const setup = await setupContentPipeline(app, { webhookSecret: 'test-hook-secret' });
  publishWorkflowId = setup.publishWorkflowId;
  webhookSecret = setup.webhookSecret;
});

describe('Content pipeline: intake webhook', () => {
  it('rejects requests with no secret header or the wrong one', async () => {
    const noHeader = await app.handle(req('POST', '/api/workflows/webhook/intake', { title: 'x', body: 'y' }));
    expect(noHeader.status).toBe(404);

    const wrongHeader = await app.handle(req('POST', '/api/workflows/webhook/intake', { title: 'x', body: 'y' }, {
      'X-Webhook-Secret': 'nope',
    }));
    expect(wrongHeader.status).toBe(404);
  });

  it('creates a draft article, converting markdown to HTML', async () => {
    const res = await app.handle(req('POST', '/api/workflows/webhook/intake', {
      title: 'Hello Automators',
      body: '# Hi\n\nThis is **markdown**, converted by the pipeline.',
    }, { 'X-Webhook-Secret': webhookSecret }));
    expect(res.status).toBe(200);
    await flushAsyncExecution();

    const { entries } = app.cms.entries.findAll({ contentTypeSlug: 'article' });
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe('draft');
    expect(entries[0].content.body).toContain('>Hi</h1>');
    expect(entries[0].content.body).toContain('<strong>markdown</strong>');
  });

  it('skips submissions with no title instead of creating a broken entry (if/onFalse:skip)', async () => {
    const before = app.cms.entries.findAll({ contentTypeSlug: 'article' }).entries.length;

    const res = await app.handle(req('POST', '/api/workflows/webhook/intake', {
      body: 'no title here',
    }, { 'X-Webhook-Secret': webhookSecret }));
    expect(res.status).toBe(200);
    await flushAsyncExecution();

    const after = app.cms.entries.findAll({ contentTypeSlug: 'article' }).entries.length;
    expect(after).toBe(before);
  });
});

describe('Content pipeline: publish workflow', () => {
  it('publishes drafts older than the given threshold', async () => {
    const result = await app.workflowEngine.run(publishWorkflowId, { olderThanMs: 0 });
    expect(result.status).toBe('success');
    expect(result.nodeResults.publish.data.publishedCount).toBeGreaterThan(0);

    const published = app.cms.entries.findAll({ contentTypeSlug: 'article', status: 'published' }).entries;
    expect(published.length).toBeGreaterThan(0);
  });
});

describe('Content pipeline: agent shell', () => {
  it('pipeline:stats reflects the current entry counts', async () => {
    const result = await app.shell.exec('pipeline:stats');
    expect(result.code).toBe(0);
    expect(result.data.total).toBeGreaterThan(0);
    expect(result.data.published).toBeGreaterThan(0);
  });

  it('RBAC: a restricted-profile shell is denied, an admin-profile shell is allowed', async () => {
    // Same CommandRegistry (so the custom commands are visible to both),
    // different profiles — exercises core/shell.js AGENT_PROFILES directly.
    const restrictedShell = new Shell({ registry: app.shell.registry, profile: 'restricted' });
    const denied = await restrictedShell.exec('pipeline:stats');
    expect(denied.code).not.toBe(0);
    expect(denied.error).toMatch(/permission denied/i);

    const adminShell = new Shell({ registry: app.shell.registry, profile: 'admin' });
    const allowed = await adminShell.exec('pipeline:stats');
    expect(allowed.code).toBe(0);
  });
});

describe('Content pipeline: SSRF guard (net-guard.js)', () => {
  it('blocks an http.request node targeting a cloud-metadata address', async () => {
    const wf = app.workflowEngine.create({
      name: 'ssrf-check',
      trigger: { type: 'manual' },
      nodes: [{ id: 'n1', type: 'http.request', inputs: { url: 'http://169.254.169.254/' } }],
    });
    const result = await app.workflowEngine.run(wf._id, {});
    expect(result.errors.n1).toMatch(/net-guard/i);
  });
});
