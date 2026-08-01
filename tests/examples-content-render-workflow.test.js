/**
 * Content Render Workflow — end-to-end regression test.
 * Mirrors examples/content-render-workflow/setup.js (reuses nodes.js's
 * contentRenderNode so the demo and test can't drift apart).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { contentRenderNode } from '../examples/content-render-workflow/nodes.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

let app, server, baseUrl, workflow;

function req(path, opts) { return new Request(`${baseUrl}${path}`, opts); }

/** webhookTrigger() fires execute() fire-and-forget -- poll until a fresh
 * execution (by id, not by sort position) lands and finishes.
 *
 * Root cause of a real intermittent flake this used to have: the previous
 * version trusted getExecutions()'s startedAt-DESC sort to always put the
 * newest execution at list[0], checked via `list.length > sinceCount`.
 * Array.sort is stable but has no tie-breaker for EQUAL startedAt values
 * (a Date.now() millisecond) -- when two consecutive tests' executions
 * started in the same millisecond (common at in-memory speed), the stable
 * sort left the OLDER one first, so this test picked up the PREVIOUS
 * test's execution instead of its own (its markdown/HTML, not this run's).
 * Same bug class already diagnosed and fixed in examples/scheduled-sync
 * earlier this session (updatedAt ties) -- just not caught here until now.
 * Fixed the same way tests/examples-workflow-observability.test.js already
 * does it: track which execution ids existed BEFORE triggering, and wait
 * for one NOT in that set, regardless of sort order. */
async function waitForExecution(seenIds, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = app.workflowEngine.getExecutions(workflow._id, 50);
    const fresh = list.find((e) => !seenIds.has(e._id) && e.finishedAt);
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitForExecution timed out');
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'content-render-workflow-test-secret!!!' });
  app.workflowEngine.nodes.add(contentRenderNode);

  workflow = app.workflowEngine.create({
    name: 'Publish Markdown Post',
    trigger: { type: 'webhook', config: { path: 'posts', secret: WEBHOOK_SECRET } },
    nodes: [
      { id: 'render', type: 'content.render', inputs: { markdown: '{{_trigger.markdown}}' } },
      { id: 'summary', type: 'set.value', inputs: { value: '"{{_trigger.title}}" ({{render.wordCount}} words): {{render.excerpt}}' } },
    ],
  });
  app.workflowEngine.start();

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => { server.stop(true); });

async function trigger(body) {
  const res = await fetch(req('/api/workflows/webhook/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
    body: JSON.stringify(body),
  }));
  return res.json();
}

describe('Content render workflow: real markdown rendered as a workflow step', () => {
  it('parses markdown into HTML/plainText/wordCount and interpolates it into a downstream node via {{ref}}', async () => {
    const seenIds = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger({
      title: 'Launch Day',
      markdown: '# Launch Day\n\nWe shipped **v2.0** today, with a new dashboard.\n\n- Faster search\n- Dark mode',
    });
    const exec = await waitForExecution(seenIds);

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.render.data.html).toContain('<h1');
    expect(exec.nodeResults.render.data.html).toContain('<strong>v2.0</strong>');
    expect(exec.nodeResults.render.data.wordCount).toBeGreaterThan(0);
    expect(exec.nodeResults.summary.data).toContain('"Launch Day"');
    expect(exec.nodeResults.summary.data).toContain(`${exec.nodeResults.render.data.wordCount} words`);
  });
});

describe('Content render workflow: HTML output is escaped, plain-text output is not (verified, not assumed)', () => {
  it('toHTML output escapes an inline script tag', async () => {
    const seenIds = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger({ title: 'Security Note', markdown: 'A test with <script>alert(1)</script> inline text.' });
    const exec = await waitForExecution(seenIds);

    expect(exec.nodeResults.render.data.html).toContain('&lt;script&gt;');
    expect(exec.nodeResults.render.data.html).not.toContain('<script>alert');
  });

  it('the plain-text excerpt (and anything downstream that interpolates it) carries the raw tag unescaped -- a real caveat for any HTML-rendering step built on top, not a bug in toPlainText()', async () => {
    const seenIds = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger({ title: 'Security Note', markdown: 'A test with <script>alert(1)</script> inline text.' });
    const exec = await waitForExecution(seenIds);

    expect(exec.nodeResults.render.data.excerpt).toContain('<script>alert(1)</script>');
    expect(exec.nodeResults.summary.data).toContain('<script>alert(1)</script>');
  });
});
