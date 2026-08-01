/**
 * Parallel Workflow Race — end-to-end regression test.
 * Mirrors examples/parallel-workflow-race/setup.js (reuses nodes.js's
 * scoreLeadNode and tools.js's raceLeadScoring so the demo and the test
 * can't drift apart).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { scoreLeadNode } from '../examples/parallel-workflow-race/nodes.js';
import { raceLeadScoring } from '../examples/parallel-workflow-race/tools.js';

let app, workflow;

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'parallel-workflow-race-test-secret!!!' });
  app.workflowEngine.nodes.add(scoreLeadNode);
  workflow = app.workflowEngine.create({
    name: 'Score Lead',
    trigger: { type: 'manual' },
    nodes: [{ id: 'score', type: 'score.lead', inputs: { leadId: '{{_trigger.leadId}}', model: '{{_trigger.model}}' } }],
  });
});

describe('Parallel workflow race: 3 concurrent executions of the same workflow, highest-confidence wins', () => {
  it('fires exactly 3 new executions, one per model, all completing successfully', async () => {
    const before = app.workflowEngine.getExecutions(workflow._id, 100).length;
    await raceLeadScoring(app.workflowEngine, workflow._id, 'lead-1', ['A', 'B', 'C']);
    const after = app.workflowEngine.getExecutions(workflow._id, 100);
    expect(after.length - before).toBe(3);
    expect(after.slice(0, 3).every((e) => e.status === 'success')).toBe(true);
  });

  it("model C (highest confidence, 0.85) deterministically wins the race, regardless of models array order", async () => {
    const merged = await raceLeadScoring(app.workflowEngine, workflow._id, 'lead-2', ['A', 'C', 'B']);
    expect(merged.resolved.model).toBe('C');
    expect(merged.results.length).toBe(3);
  });

  it('all 3 raw results are still available, not just the winner', async () => {
    const merged = await raceLeadScoring(app.workflowEngine, workflow._id, 'lead-3');
    const models = merged.results.map((r) => r.id).sort();
    expect(models).toEqual(['A', 'B', 'C']);
    const confidences = Object.fromEntries(merged.results.map((r) => [r.id, r.confidence]));
    expect(confidences).toEqual({ A: 0.6, B: 0.75, C: 0.85 });
  });

  it('two concurrent races for DIFFERENT leads never cross-contaminate each other\'s scores', async () => {
    const [race1, race2] = await Promise.all([
      raceLeadScoring(app.workflowEngine, workflow._id, 'lead-alpha'),
      raceLeadScoring(app.workflowEngine, workflow._id, 'lead-beta'),
    ]);
    expect(race1.resolved.leadId).toBe('lead-alpha');
    expect(race2.resolved.leadId).toBe('lead-beta');
    for (const r of race1.results) expect(r.output.leadId).toBe('lead-alpha');
    for (const r of race2.results) expect(r.output.leadId).toBe('lead-beta');
  });
});
