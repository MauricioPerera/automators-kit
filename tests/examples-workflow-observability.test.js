/**
 * Workflow Observability — end-to-end regression test.
 * Mirrors examples/workflow-observability/setup.js (reuses nodes.js's
 * riskyOpNode and observe.js's observeWorkflowEngine so the demo and the
 * test can't drift apart).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { metricsHandler } from '../core/http.js';
import { riskyOpNode } from '../examples/workflow-observability/nodes.js';
import { observeWorkflowEngine } from '../examples/workflow-observability/observe.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

let app, server, baseUrl, workflow, entries, metrics;

function req(path, opts) { return new Request(`${baseUrl}${path}`, opts); }

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
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'workflow-observability-test-secret!!!' });
  app.workflowEngine.nodes.add(riskyOpNode);

  entries = [];
  const log = { debug() {}, warn() {}, error() {}, info: (msg, fields) => entries.push({ msg, ...fields }) };
  metrics = observeWorkflowEngine(app.workflowEngine, { log });

  workflow = app.workflowEngine.create({
    name: 'Risky Run',
    trigger: { type: 'webhook', config: { path: 'risky-run', secret: WEBHOOK_SECRET } },
    nodes: [{ id: 'risky', type: 'risky.op', inputs: { shouldFail: '{{_trigger.shouldFail}}' } }],
  });

  app.router.get('/metrics', metricsHandler(metrics));
  app.workflowEngine.start();

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => { server.stop(true); });

async function trigger(shouldFail) {
  return fetch(req('/api/workflows/webhook/risky-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
    body: JSON.stringify({ shouldFail }),
  }));
}

describe('Workflow observability: every execution (not just manual ones) is observed via db.watch', () => {
  it('a successful webhook-triggered execution produces a structured log entry with status "success"', async () => {
    const seen = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger(false);
    const exec = await waitForExecution(seen);
    expect(exec.status).toBe('success');

    const entry = entries.find((e) => e.workflowId === workflow._id && e.status === 'success');
    expect(entry).toBeDefined();
    expect(entry.msg).toBe('workflow execution finished');
    expect(typeof entry.duration).toBe('number');
  });

  it('a failed webhook-triggered execution produces a structured log entry with status "failed"', async () => {
    const seen = new Set(app.workflowEngine.getExecutions(workflow._id, 50).map((e) => e._id));
    await trigger(true);
    const exec = await waitForExecution(seen);
    expect(exec.status).toBe('failed');

    const entry = entries.find((e) => e.workflowId === workflow._id && e.status === 'failed');
    expect(entry).toBeDefined();
  });

  it('feeds workflow_executions_total (both statuses) and workflow_execution_duration_ms into the registry', () => {
    const output = metrics.render();
    expect(output).toContain(`workflow_executions_total{workflow="Risky Run",status="success"} 1`);
    expect(output).toContain(`workflow_executions_total{workflow="Risky Run",status="failed"} 1`);
    expect(output).toContain('workflow_execution_duration_ms_count{workflow="Risky Run",status="success"} 1');
  });

  it('/metrics exposes the registry in Prometheus text format over real HTTP', async () => {
    const res = await fetch(req('/metrics'));
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# TYPE workflow_executions_total counter');
  });
});
