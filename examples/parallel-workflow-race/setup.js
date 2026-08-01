/**
 * Parallel Workflow Race — HTTP/shell demo.
 *
 *   bun examples/parallel-workflow-race/setup.js
 *
 * Combines core/parallel.js with core/workflow.js: 3 concurrent
 * executions of the SAME workflow definition (one per scoring "model"),
 * raced via `parallelMerge`'s `highest-confidence` strategy — distinct
 * from examples/provider-fanout (races raw core/connector.js calls, not
 * real workflow executions) and every other workflow.js example (fires
 * exactly one execution per trigger, never concurrent runs of the same
 * definition).
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { scoreLeadNode } from './nodes.js';
import { raceLeadScoring } from './tools.js';

const PORT = +(process.env.PORT || 3035);
const DB_PATH = process.env.DB_PATH || './examples/parallel-workflow-race/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'parallel-workflow-race-demo-secret',
  logger: true,
});

app.workflowEngine.nodes.add(scoreLeadNode);

const workflow = app.workflowEngine.create({
  name: 'Score Lead',
  trigger: { type: 'manual' },
  nodes: [{ id: 'score', type: 'score.lead', inputs: { leadId: '{{_trigger.leadId}}', model: '{{_trigger.model}}' } }],
});

app.shell.registry.register('leads', 'race', {
  description: 'Fire 3 concurrent executions of the Score Lead workflow (models A/B/C), keep the highest-confidence result',
  params: [{ name: 'leadId', type: 'string', required: true }],
}, async (args) => {
  const merged = await raceLeadScoring(app.workflowEngine, workflow._id, args.leadId || args._0);
  return { winner: merged.resolved, allResults: merged.results.map((r) => ({ model: r.id, confidence: r.confidence, score: r.output.score })) };
});

app.shell.registry.register('leads', 'executions', {
  description: 'Recent executions of the Score Lead workflow',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => app.workflowEngine.getExecutions(workflow._id, args.limit || 10));

app.workflowEngine.start();
Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Parallel workflow race demo running at http://localhost:${PORT}
  workflow id: ${workflow._id}
  commands: leads:race, leads:executions

Try:
  POST /api/shell/exec {"cmd":"leads:race --leadId lead-42"}
  POST /api/shell/exec {"cmd":"leads:executions"}
See examples/parallel-workflow-race/README.md for the full walkthrough.
`);
