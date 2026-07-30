/**
 * Workflow Engine — end-to-end regression test.
 * Mirrors examples/workflow-engine/setup.js (reuses buildMockEmailApi +
 * buildEnrichmentNodes) so the demo and the test can't drift apart. Starts
 * a real Bun.serve() because the email.send node uses real fetch() under
 * the hood (same reason as tests/examples-integrations.test.js).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { buildMockEmailApi } from '../examples/workflow-engine/mocks.js';
import { buildEnrichmentNodes } from '../examples/workflow-engine/nodes.js';

const WEBHOOK_SECRET = 'order-webhook-secret';

let app, server, baseUrl, workflow, sent, timings;

function req(path, opts) {
  return new Request(`${baseUrl}${path}`, opts);
}

/** Poll until a new execution (created after `sinceCount` prior ones) lands
 * and finished — webhookTrigger() fires execute() fire-and-forget, the HTTP
 * response returns before the workflow finishes running. */
async function waitForExecution(sinceCount, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = app.workflowEngine.getExecutions(workflow._id, 50);
    if (list.length > sinceCount && list[0].finishedAt) return list[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitForExecution timed out');
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'workflow-engine-test-secret!!!' });

  const mocks = buildMockEmailApi();
  sent = mocks.sent;
  app.router.route('/mock/email', mocks.router);

  const enrichment = buildEnrichmentNodes();
  timings = enrichment.timings;
  for (const node of enrichment.nodes) app.workflowEngine.nodes.add(node);

  server = Bun.serve({ fetch: app.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;

  await app.workflowEngine.vault.store('order-email', {
    apiUrl: `${baseUrl}/mock/email/send`,
    token: 'demo-order-token',
  }, { service: 'email' });

  workflow = app.workflowEngine.create({
    name: 'Order Intake',
    trigger: { type: 'webhook', config: { path: 'orders', secret: WEBHOOK_SECRET } },
    nodes: [
      { id: 'customer', type: 'enrich.customer', inputs: { customerId: '{{_trigger.customerId}}' } },
      { id: 'tax', type: 'enrich.tax', inputs: { subtotal: '{{_trigger.subtotal}}' } },
      { id: 'shipping', type: 'enrich.shipping', inputs: { address: '{{_trigger.address}}' } },
      {
        id: 'summary', type: 'set.value',
        inputs: { value: 'Order for {{customer.name}} ({{customer.tier}}): total ${{tax.total}}, arriving {{shipping.eta}}' },
      },
      {
        id: 'email', type: 'email.send', credentials: 'order-email', continueOnError: true,
        inputs: { to: '{{_trigger.customerEmail}}', subject: 'Order Confirmation', body: '{{summary}}' },
      },
      {
        id: 'notify', type: 'notify.email', credentials: 'order-email',
        inputs: { to: '{{_trigger.customerEmail}}', subject: 'Order Confirmation', body: '{{summary}}' },
      },
    ],
  });
  app.workflowEngine.start();
});

afterAll(() => {
  app.workflowEngine.stop();
  server.stop(true);
});

describe('Workflow engine: webhook trigger', () => {
  it('rejects a fire with the wrong secret — no execution recorded', async () => {
    const before = app.workflowEngine.getExecutions(workflow._id, 50).length;
    const res = await fetch(req('/api/workflows/webhook/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'wrong' },
      body: JSON.stringify({ customerId: 'x', subtotal: 1, address: 'x', customerEmail: 'x@x.com' }),
    }));
    expect(res.status).toBe(404); // same generic 404 as "path not registered"
    expect(app.workflowEngine.getExecutions(workflow._id, 50).length).toBe(before);
  });

  it('a correctly-authenticated webhook fires the workflow end-to-end', async () => {
    const before = app.workflowEngine.getExecutions(workflow._id, 50).length;
    const res = await fetch(req('/api/workflows/webhook/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
      body: JSON.stringify({ customerId: 'vip-1', subtotal: 100, address: '1 Main St', customerEmail: 'jane@example.com' }),
    }));
    expect(res.status).toBe(200);

    const exec = await waitForExecution(before);
    // 'partial', not 'success': the built-in email.send node is REJECTED by
    // net-guard for pointing at a local/internal mock (see README) — that's
    // real, correct, by-design behavior this test asserts FOR, not around.
    expect(exec.status).toBe('partial');
    expect(exec.nodeResults.customer.data.tier).toBe('gold');
    expect(exec.nodeResults.tax.data.total).toBe(121);
    expect(exec.nodeResults.summary.data).toBe('Order for Jane Doe (gold): total $121, arriving 3 business days');
    expect(exec.errors.email).toMatch(/net-guard: blocked internal destination/);
    // The custom-handler node (notify.email) is NOT subject to that guard —
    // it succeeds, using the SAME vault credential.
    expect(exec.nodeResults.notify.status).toBe('success');
    expect(sent.some((s) => s.to === 'jane@example.com' && s.html === exec.nodeResults.summary.data)).toBe(true);
  });
});

describe('Workflow engine: DAG-parallel execution, measured', () => {
  it('the 3 independent enrichment nodes overlap in wall-clock time', async () => {
    const before = app.workflowEngine.getExecutions(workflow._id, 50).length;
    timings.length = 0;
    await fetch(req('/api/workflows/webhook/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
      body: JSON.stringify({ customerId: 'c2', subtotal: 50, address: 'international drive', customerEmail: 'x@x.com' }),
    }));
    await waitForExecution(before);

    expect(timings.length).toBe(3);
    // If sequential, node N's start would be >= the previous node's end.
    // DAG-parallel means at least one pair genuinely overlaps.
    const overlaps = timings.some((a, i) =>
      timings.some((b, j) => i !== j && a.start < b.end && b.start < a.end));
    expect(overlaps).toBe(true);
  });
});

describe('Workflow engine: execution history', () => {
  it('getExecutions / getExecution expose past runs', () => {
    const list = app.workflowEngine.getExecutions(workflow._id, 50);
    expect(list.length).toBeGreaterThanOrEqual(2);
    const one = app.workflowEngine.getExecution(list[0]._id);
    expect(one.workflowId).toBe(workflow._id);
  });
});
