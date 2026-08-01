/**
 * Agent-Authored Node — HTTP/shell demo.
 *
 *   bun examples/agent-authored-node/setup.js
 *
 * Demonstrates the actual point of this example: `core/nodes.js`'s 18
 * built-ins don't include a CSV node (n8n's does) — instead of waiting
 * for the framework to grow one, an agent built it, following a KDD task
 * contract for the correctness-critical piece (kept external, not
 * vendored into this repo — see kdd-external-contracts/csv-parse.md in
 * the sibling checkout), validated against a frozen-oracle test suite and
 * the real CCDD gate (measured complexity within budget) before this
 * example ever used it. The result — `core/csv.js`'s `parseCsv` — is a
 * real, reusable core module, not throwaway example code: any other
 * workflow/example can import it directly, and `nodes.js`'s `csv.parse`
 * wraps it via the SAME `WorkflowEngine.nodes.add()` extension point
 * every other custom node in this repo already uses (see
 * examples/content-render-workflow, examples/plugin-workflow-nodes).
 *
 * The workflow itself: a webhook receives raw CSV text of leads
 * (name,email,score), `csv.parse` turns it into row objects, the
 * BUILT-IN `filter` node keeps qualified leads (score >= 70) — proving
 * the new node composes with existing ones like any other, not a bolted-
 * on special case.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { csvParseNode } from './nodes.js';

const PORT = +(process.env.PORT || 3028);
const DB_PATH = process.env.DB_PATH || './examples/agent-authored-node/data';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'agent-authored-node-webhook-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'agent-authored-node-demo-secret',
  logger: true,
});

app.workflowEngine.nodes.add(csvParseNode);

const workflow = app.workflowEngine.create({
  name: 'Import Leads CSV',
  trigger: { type: 'webhook', config: { path: 'leads', secret: WEBHOOK_SECRET } },
  nodes: [
    { id: 'parse', type: 'csv.parse', inputs: { text: '{{_trigger.csv}}' } },
    { id: 'qualified', type: 'filter', inputs: { items: '{{parse}}', field: 'score', operator: '>=', value: 70 } },
    {
      id: 'summary', type: 'set.value',
      inputs: { value: '{{qualified.length}} of {{parse.length}} leads qualified (score >= 70)' },
    },
  ],
});

app.shell.registry.register('leads', 'executions', {
  description: 'Recent executions of the Import Leads CSV workflow',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => app.workflowEngine.getExecutions(workflow._id, args.limit || 10));

app.workflowEngine.start();
Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Agent-authored node demo running at http://localhost:${PORT}
  workflow id: ${workflow._id}
  commands: leads:executions

Try (webhook fires the workflow ASYNCHRONOUSLY -- poll leads:executions):
  curl -X POST http://localhost:${PORT}/api/workflows/webhook/leads \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" -H "Content-Type: application/json" \\
    -d '{"csv":"name,email,score\\nAlice,alice@example.com,85\\nBob,bob@example.com,50\\nCarol,\\"c, corp\\"@example.com,72"}'
  POST /api/shell/exec {"cmd":"leads:executions"}
See examples/agent-authored-node/README.md for the full walkthrough.
`);
