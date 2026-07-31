/**
 * Validated Webhooks — end-to-end regression test. Starts a real
 * Bun.serve() and drives it directly (no createApp() -- see
 * examples/validated-webhooks/setup.js for why: createApp()'s own bundled
 * /api/workflows/webhook/:path route would bypass validation entirely,
 * verified live before writing this example).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { WorkflowEngine } from '../core/workflow.js';
import { Router, json, error, cors } from '../core/http.js';
import { validate } from '../core/validate.js';
import { ORDER_WEBHOOK_SCHEMA } from '../examples/validated-webhooks/schemas.js';

let server, baseUrl, engine, workflow;
const SECRET = 'test-secret';

function validOrder(overrides = {}) {
  return {
    customerId: 'c1',
    customerEmail: 'jane@example.com',
    subtotal: 42.5,
    items: [{ sku: 'SKU-1', qty: 2 }],
    ...overrides,
  };
}

async function post(path, body, secret = SECRET) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const db = new DocStore(new MemoryStorageAdapter());
  engine = new WorkflowEngine(db, { masterKey: 'test-master-key' });
  await engine.init();

  workflow = engine.create({
    name: 'Order Intake',
    trigger: { type: 'webhook', config: { path: 'orders', secret: SECRET } },
    nodes: [{ id: 'summary', type: 'set.value', inputs: { value: 'Order from {{_trigger.customerId}}: {{_trigger.items.length}} item(s), ${{_trigger.subtotal}}' } }],
  });
  engine.start();

  const router = new Router();
  router.use(cors());
  router.post('/webhooks/:path', async (ctx) => {
    const body = await ctx.json();
    const result = validate(ORDER_WEBHOOK_SCHEMA, body);
    if (!result.valid) return error(result.errors.join('; '), 400);
    const secret = ctx.req.headers.get('X-Webhook-Secret');
    const workflowId = engine.webhookTrigger(ctx.params.path, result.data, secret);
    if (!workflowId) return error('No workflow registered for this webhook, or bad secret', 404);
    return json({ triggered: workflowId });
  });

  server = Bun.serve({ fetch: router.handle, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  engine.stop();
  server.stop(true);
});

describe('Validated webhooks: a valid payload triggers and runs the workflow', () => {
  it('accepts a valid order and the workflow actually runs', async () => {
    const res = await post('/webhooks/orders', validOrder());
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(workflow._id);

    const executions = engine.getExecutions(workflow._id);
    const exec = executions.find((e) => e._id === res.body.triggered) || executions[0];
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.summary.data).toBe('Order from c1: 1 item(s), $42.5');
  });
});

describe('Validated webhooks: malformed payloads are rejected BEFORE the workflow ever runs', () => {
  it('rejects a missing required field with 400, no execution created', async () => {
    const before = engine.getExecutions(workflow._id).length;
    const res = await post('/webhooks/orders', { customerId: 'c2', customerEmail: 'bob@example.com', subtotal: 10 }); // no items
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/items is required/);
    expect(engine.getExecutions(workflow._id).length).toBe(before);
  });

  it('rejects an invalid email format with 400, no execution created', async () => {
    const before = engine.getExecutions(workflow._id).length;
    const res = await post('/webhooks/orders', validOrder({ customerEmail: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/);
    expect(engine.getExecutions(workflow._id).length).toBe(before);
  });

  it('rejects a non-integer quantity nested inside items[], no execution created', async () => {
    const before = engine.getExecutions(workflow._id).length;
    const res = await post('/webhooks/orders', validOrder({ items: [{ sku: 'X', qty: 1.5 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/items\[0\]\.qty must be an integer/);
    expect(engine.getExecutions(workflow._id).length).toBe(before);
  });

  it('a schema-valid payload with the wrong secret is still rejected, no execution created', async () => {
    const before = engine.getExecutions(workflow._id).length;
    const res = await post('/webhooks/orders', validOrder(), 'wrong-secret');
    expect(res.status).toBe(404);
    expect(engine.getExecutions(workflow._id).length).toBe(before);
  });
});
