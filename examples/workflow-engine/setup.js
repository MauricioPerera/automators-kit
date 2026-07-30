/**
 * Workflow Engine — HTTP demo.
 *
 *   bun examples/workflow-engine/setup.js
 *
 * The n8n-style engine itself, front and center: a webhook-triggered order
 * workflow with 3 independent enrichment nodes that run in DAG-parallel
 * (measured, not just claimed — see README), a summary node wired to all 3
 * via `{{ref}}` templates, and a credential-backed `email.send` node that
 * calls a real (mocked) HTTP API.
 *
 * Runs fully offline: mocks.js stands in for an email API on the same
 * server, so the credential + auth-header path is exercised for real.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { buildMockEmailApi } from './mocks.js';
import { buildEnrichmentNodes } from './nodes.js';

const PORT = +(process.env.PORT || 3010);
const DB_PATH = process.env.DB_PATH || './examples/workflow-engine/data';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'order-webhook-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'workflow-engine-demo-secret',
  logger: true,
});

const { router: mockRouter, sent } = buildMockEmailApi();
app.router.route('/mock/email', mockRouter);

const { nodes, timings } = buildEnrichmentNodes();
for (const node of nodes) app.workflowEngine.nodes.add(node);

await app.workflowEngine.vault.store('order-email', {
  apiUrl: `http://localhost:${PORT}/mock/email/send`,
  token: 'demo-order-token',
}, { service: 'email' });

const workflow = app.workflowEngine.create({
  name: 'Order Intake',
  trigger: { type: 'webhook', config: { path: 'orders', secret: WEBHOOK_SECRET } },
  nodes: [
    { id: 'customer', type: 'enrich.customer', inputs: { customerId: '{{_trigger.customerId}}' } },
    { id: 'tax', type: 'enrich.tax', inputs: { subtotal: '{{_trigger.subtotal}}' } },
    { id: 'shipping', type: 'enrich.shipping', inputs: { address: '{{_trigger.address}}' } },
    {
      // No template node needed: core/workflow.js's OWN {{ref}} resolution
      // already substitutes every {{nodeId.field}} below with the real
      // value before this node ever runs — set.value's handler just
      // returns whatever it was given.
      id: 'summary', type: 'set.value',
      inputs: { value: 'Order for {{customer.name}} ({{customer.tier}}): total ${{tax.total}}, arriving {{shipping.eta}}' },
    },
    {
      // continueOnError: true — see README. Built-in HTTP-based nodes
      // (no custom `handler`, like email.send) go through core/nodes.js's
      // `_executeApi`, which ALWAYS calls net-guard's `assertPublicUrl`
      // with no opt-out. It correctly blocks this example's own local
      // mock API as an "internal destination" — that's the real, honest
      // behavior kept visible here rather than worked around.
      id: 'email', type: 'email.send', credentials: 'order-email', continueOnError: true,
      inputs: { to: '{{_trigger.customerEmail}}', subject: 'Order Confirmation', body: '{{summary}}' },
    },
    {
      // The offline-safe equivalent: same credential, same mock API, but a
      // custom handler instead of the guarded built-in node. See nodes.js.
      id: 'notify', type: 'notify.email', credentials: 'order-email',
      inputs: { to: '{{_trigger.customerEmail}}', subject: 'Order Confirmation', body: '{{summary}}' },
    },
  ],
});

app.shell.registry.register('orders', 'executions', {
  description: 'Recent executions of the Order Intake workflow',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => app.workflowEngine.getExecutions(workflow._id, args.limit || 10));

app.shell.registry.register('orders', 'execution', {
  description: 'A single execution by id',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => app.workflowEngine.getExecution(args.id || args._0));

app.shell.registry.register('orders', 'sent-emails', { description: 'What the mock email API received' }, async () => sent);
app.shell.registry.register('orders', 'timings', { description: 'Start/end timestamps of the 3 parallel enrichment nodes (proof of DAG-parallel overlap)' }, async () => timings);

app.workflowEngine.start();
Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Workflow engine demo running at http://localhost:${PORT}
  workflow id: ${workflow._id}
  commands: orders:executions, orders:execution, orders:sent-emails, orders:timings

Try (webhook fires the workflow ASYNCHRONOUSLY — poll orders:executions):
  curl -X POST http://localhost:${PORT}/api/workflows/webhook/orders \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" -H "Content-Type: application/json" \\
    -d '{"customerId":"vip-1","subtotal":100,"address":"1 Main St","customerEmail":"jane@example.com"}'
  POST /api/shell/exec {"cmd":"orders:executions"}
See examples/workflow-engine/README.md for the full walkthrough.
`);
