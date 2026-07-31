/**
 * Validated Workflow Nodes — end-to-end regression test.
 * Mirrors examples/validated-workflow-nodes/setup.js's wiring: a
 * validate.js schema gating a core/workflow.js node's handler.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { WorkflowEngine } from '../core/workflow.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { applyDiscountNode, chargeNode, chargeNodeUnsafe, validatedNode } from '../examples/validated-workflow-nodes/nodes.js';

let engine, workflowId, unsafeWorkflowId;

beforeAll(async () => {
  const db = new DocStore(new MemoryStorageAdapter());
  engine = new WorkflowEngine(db, { masterKey: 'test-key' });
  await engine.init();
  engine.nodes.add(applyDiscountNode);
  engine.nodes.add(chargeNode);
  engine.nodes.add(chargeNodeUnsafe);

  workflowId = engine.create({
    name: 'order-fulfillment',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'applyDiscount', type: 'order.applyDiscount', inputs: { amount: '{{_trigger.amount}}', discountPercent: '{{_trigger.discountPercent}}' } },
      { id: 'charge', type: 'order.charge', inputs: { amount: '{{applyDiscount.discountedAmount}}', currency: '{{_trigger.currency}}' } },
    ],
  })._id;

  unsafeWorkflowId = engine.create({
    name: 'order-fulfillment-unsafe',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'applyDiscount', type: 'order.applyDiscount', inputs: { amount: '{{_trigger.amount}}', discountPercent: '{{_trigger.discountPercent}}' } },
      { id: 'charge', type: 'order.charge.unsafe', inputs: { amount: '{{applyDiscount.discountedAmount}}', currency: '{{_trigger.currency}}' } },
    ],
  })._id;
});

describe('Validated workflow nodes: validate.js catches bad data flowing BETWEEN nodes, not just the trigger payload', () => {
  it('a valid order runs end to end and charges the discounted amount', async () => {
    const exec = await engine.run(workflowId, { amount: 100, discountPercent: 20, currency: 'USD' });
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.charge.data.amount).toBe(80);
  });

  it('a >100% discount produces a negative amount upstream; the validated charge node blocks it with an actionable error', async () => {
    const exec = await engine.run(workflowId, { amount: 100, discountPercent: 150, currency: 'USD' });
    // The discountPercent itself is a perfectly valid trigger payload --
    // the bad value only exists after applyDiscount's own math, so
    // HTTP-boundary validation (examples/api-validation) could never have
    // caught this; it has to happen at the node input, mid-pipeline.
    expect(exec.nodeResults.applyDiscount.data.discountedAmount).toBe(-50);
    expect(exec.status).toBe('failed');
    expect(exec.errors.charge).toBe('Validation failed: amount must be >= 0.01');
    expect(exec.nodeResults.charge.status).toBe('error');
  });

  it('an unsupported currency is blocked with an actionable error, not a silent pass-through', async () => {
    const exec = await engine.run(workflowId, { amount: 100, discountPercent: 10, currency: 'XYZ' });
    expect(exec.status).toBe('failed');
    expect(exec.errors.charge).toBe('Validation failed: currency must be one of: USD, EUR, GBP');
  });

  it('the SAME bad input against the unvalidated charge node "succeeds" while silently charging a negative amount', async () => {
    const exec = await engine.run(unsafeWorkflowId, { amount: 100, discountPercent: 150, currency: 'USD' });
    expect(exec.status).toBe('success');
    expect(exec.nodeResults.charge.data.charged).toBe(true);
    expect(exec.nodeResults.charge.data.amount).toBe(-50);
  });
});

describe('validatedNode()', () => {
  it('passes validate()\'s cleaned data (with defaults applied) to the real handler, not the raw inputs', async () => {
    let received;
    const node = validatedNode({
      type: 'test.echo',
      handler: async (inputs) => { received = inputs; return inputs; },
    }, { name: { type: 'string', required: true }, greeting: { type: 'string', default: 'hello' } });

    await node.handler({ name: 'x' });
    expect(received).toEqual({ name: 'x', greeting: 'hello' });
  });

  it('never calls the real handler when validation fails', async () => {
    let called = false;
    const node = validatedNode({
      type: 'test.echo',
      handler: async () => { called = true; return {}; },
    }, { name: { type: 'string', required: true } });

    await expect(node.handler({})).rejects.toThrow('Validation failed: name is required');
    expect(called).toBe(false);
  });
});
