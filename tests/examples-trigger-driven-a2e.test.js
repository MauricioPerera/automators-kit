/**
 * Trigger-Driven a2e — end-to-end regression test.
 * Mirrors examples/trigger-driven-a2e/setup.js's bridge: core/triggers.js
 * TriggerManager firing a fresh core/a2e.js WorkflowExecutor per fire.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';
import { WorkflowExecutor } from '../core/a2e.js';
import { TriggerManager, TriggerType } from '../core/triggers.js';
import { buildPipelineDef, enrichCustomer } from '../examples/trigger-driven-a2e/pipeline.js';

let db, executions, triggers, runs;

async function runPipeline(triggerData) {
  const executor = new WorkflowExecutor();
  executor.registerHandler('EnrichCustomer', enrichCustomer);
  executor.load(buildPipelineDef(triggerData.data));

  const r = await executor.execute();
  const failed = Object.keys(r.errors).length > 0;
  const decision = failed ? null : (r.results.check?.conditionResult ? r.results.businessWelcome : r.results.personalWelcome);

  const record = executions.insert({
    trigger: triggerData.trigger,
    input: triggerData.data,
    enriched: r.results.enriched,
    decision,
    errors: r.errors,
    status: failed ? 'failed' : 'success',
    createdAt: Date.now(),
  });
  db.flush();
  return record;
}

beforeAll(() => {
  db = new DocStore(new MemoryStorageAdapter());
  executions = db.collection('_a2e_executions');
  runs = []; // tracks in-flight promises so tests can await concurrent fires
  triggers = new TriggerManager({
    onTrigger: (workflowId, triggerData) => {
      runs.push(runPipeline(triggerData));
    },
  });
  triggers.register('customer-enrich', { type: TriggerType.WEBHOOK, config: { path: 'customer-enrich', secret: 'shh' } });
});

describe('Trigger-driven a2e: a webhook fires a real a2e.js pipeline, not core/workflow.js', () => {
  it('a business-domain email is routed to the business track', async () => {
    runs.length = 0;
    triggers.fireWebhook('customer-enrich', { name: 'Alice', email: 'alice@acme.com' }, 'shh');
    const record = await runs[0];
    expect(record.enriched.tier).toBe('business');
    expect(record.decision).toBe('Routed to the business onboarding track');
    expect(record.status).toBe('success');
  });

  it('a personal-domain email is routed to the personal track', async () => {
    runs.length = 0;
    triggers.fireWebhook('customer-enrich', { name: 'Bob', email: 'bob@gmail.com' }, 'shh');
    const record = await runs[0];
    expect(record.enriched.tier).toBe('personal');
    expect(record.decision).toBe('Routed to the personal onboarding track');
  });

  it('a wrong secret is rejected before the pipeline ever runs', () => {
    runs.length = 0;
    const result = triggers.fireWebhook('customer-enrich', { name: 'Eve', email: 'eve@acme.com' }, 'wrong-secret');
    expect(result).toBeNull();
    expect(runs.length).toBe(0);
  });

  it('a failed enrichment (missing email) is NOT silently routed to "personal" -- decision is null, status is failed', async () => {
    // a2e.js's DAG dispatch does not stop on a failed op (documented,
    // verified in examples/a2e-vault-api): the Conditional downstream of a
    // throwing op reads an undefined path, which evaluates to false and
    // would otherwise pick the SAME branch as a genuine "personal" result.
    // This bridge guards against that explicitly -- this is the regression
    // test for that guard.
    runs.length = 0;
    triggers.fireWebhook('customer-enrich', { name: 'NoEmail' }, 'shh');
    const record = await runs[0];
    expect(record.status).toBe('failed');
    expect(record.decision).toBeNull();
    expect(record.errors.enriched).toContain('invalid or missing email');
  });

  it('two concurrent fires with different payloads each get their own correct decision -- a fresh executor per fire is not corrupted by the other', async () => {
    runs.length = 0;
    triggers.fireWebhook('customer-enrich', { name: 'Carol', email: 'carol@acme.com' }, 'shh');
    triggers.fireWebhook('customer-enrich', { name: 'Dave', email: 'dave@gmail.com' }, 'shh');
    const [a, b] = await Promise.all(runs);

    const carol = [a, b].find((r) => r.input.name === 'Carol');
    const dave = [a, b].find((r) => r.input.name === 'Dave');
    expect(carol.enriched.tier).toBe('business');
    expect(dave.enriched.tier).toBe('personal');
  });
});
