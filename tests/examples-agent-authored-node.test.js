/**
 * Agent-Authored Node — end-to-end regression test.
 * Mirrors examples/agent-authored-node/setup.js (reuses nodes.js's
 * csvParseNode so the demo and test can't drift apart).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { csvParseNode } from '../examples/agent-authored-node/nodes.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

let app, server, baseUrl, workflow;

function req(path, opts) { return new Request(`${baseUrl}${path}`, opts); }

/**
 * Polls for a finished execution not already in `seenIds`, instead of
 * assuming `getExecutions()`'s newest-first sort puts the newest one at
 * index 0. Two executions started in the same millisecond (easy in an
 * all-in-memory test) tie on `startedAt`; the sort's stable tie-break
 * keeps the earlier-inserted one first, so a naive "list[0]" read can
 * silently return a PREVIOUS test's already-finished execution instead of
 * this call's own -- same root cause already found and fixed for
 * examples/scheduled-sync's flaky cursor comparison earlier this session.
 */
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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'agent-authored-node-test-secret!!!' });
  app.workflowEngine.nodes.add(csvParseNode);

  workflow = app.workflowEngine.create({
    name: 'Import Leads CSV',
    trigger: { type: 'webhook', config: { path: 'leads', secret: WEBHOOK_SECRET } },
    nodes: [
      { id: 'parse', type: 'csv.parse', inputs: { text: '{{_trigger.csv}}' } },
      { id: 'qualified', type: 'filter', inputs: { items: '{{parse}}', field: 'score', operator: '>=', value: 70 } },
      { id: 'summary', type: 'set.value', inputs: { value: '{{qualified.length}} of {{parse.length}} leads qualified (score >= 70)' } },
    ],
  });
  app.workflowEngine.start();

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => { server.stop(true); });

async function trigger(csv) {
  const res = await fetch(req('/api/workflows/webhook/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
    body: JSON.stringify({ csv }),
  }));
  return res.json();
}

describe('Agent-authored node: csv.parse composes with the built-in filter node in a real workflow', () => {
  it('parses CSV rows and filters qualified leads via {{ref}} into a downstream built-in node', async () => {
    const seen = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger('name,email,score\nAlice,alice@example.com,85\nBob,bob@example.com,50\nCarol,carol@example.com,72\n');
    const exec = await waitForExecution(seen);

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.parse.data.length).toBe(3);
    expect(exec.nodeResults.qualified.data.map((r) => r.name)).toEqual(['Alice', 'Carol']);
    expect(exec.nodeResults.summary.data).toBe('2 of 3 leads qualified (score >= 70)');
  });

  it('a field containing the delimiter inside quotes survives the whole pipeline intact, not split into extra columns', async () => {
    const seen = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger('name,email,score\n"Doe, Jane",jane@example.com,90\n');
    const exec = await waitForExecution(seen);

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.parse.data).toEqual([{ name: 'Doe, Jane', email: 'jane@example.com', score: '90' }]);
    expect(exec.nodeResults.qualified.data.length).toBe(1);
  });

  it('no qualified leads still produces a coherent, non-crashing summary', async () => {
    const seen = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger('name,email,score\nDave,dave@example.com,10\n');
    const exec = await waitForExecution(seen);

    expect(exec.status).toBe('success');
    expect(exec.nodeResults.summary.data).toBe('0 of 1 leads qualified (score >= 70)');
  });
});
