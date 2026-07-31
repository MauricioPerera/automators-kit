/**
 * Validated Workflow Nodes — HTTP/shell demo.
 *
 *   bun examples/validated-workflow-nodes/setup.js
 *
 * Combines core/validate.js with core/workflow.js: a validate.js schema
 * gates a workflow node's handler, catching bad DATA FLOWING BETWEEN
 * NODES mid-pipeline -- not just the initial HTTP/trigger payload.
 * examples/api-validation and examples/validated-webhooks only ever
 * validate the request body at the HTTP boundary; core/nodes.js's own
 * `inputs` array (name/type/required) is documentation only, never
 * enforced by NodeRegistry.execute() (verified by reading it).
 *
 * The scenario: order.applyDiscount (deliberately unvalidated, a
 * realistic upstream transform) can silently produce a NEGATIVE amount
 * from a >100% discount -- a perfectly valid trigger payload by itself
 * (discountPercent is just a number). order.charge (validated) catches
 * that downstream, before any charge logic runs, with an actionable
 * error instead of silently "charging" a negative amount.
 *
 * No core changes needed -- this is entirely a node-definition-level
 * wrapper (nodes.js's validatedNode()), same extension point
 * examples/plugin-workflow-nodes and examples/content-render-workflow
 * already use.
 */

import { WorkflowEngine } from '../../core/workflow.js';
import { DocStore, FileStorageAdapter } from '../../core/db.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { Router, json, cors } from '../../core/http.js';
import { applyDiscountNode, chargeNode, chargeNodeUnsafe } from './nodes.js';

const PORT = +(process.env.PORT || 3031);
const DB_PATH = process.env.DB_PATH || './examples/validated-workflow-nodes/data';

const db = new DocStore(new FileStorageAdapter(DB_PATH));
const engine = new WorkflowEngine(db, { masterKey: process.env.MASTER_KEY || 'validated-workflow-nodes-demo-key' });
await engine.init();

engine.nodes.add(applyDiscountNode);
engine.nodes.add(chargeNode);
engine.nodes.add(chargeNodeUnsafe);

let workflowId = engine.findByName('order-fulfillment')?._id;
if (!workflowId) {
  const wf = engine.create({
    name: 'order-fulfillment',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'applyDiscount', type: 'order.applyDiscount', inputs: { amount: '{{_trigger.amount}}', discountPercent: '{{_trigger.discountPercent}}' } },
      { id: 'charge', type: 'order.charge', inputs: { amount: '{{applyDiscount.discountedAmount}}', currency: '{{_trigger.currency}}' } },
    ],
  });
  workflowId = wf._id;
}

// Same shape, but the second node has no validation gate -- for the
// side-by-side comparison.
let unsafeWorkflowId = engine.findByName('order-fulfillment-unsafe')?._id;
if (!unsafeWorkflowId) {
  const wf = engine.create({
    name: 'order-fulfillment-unsafe',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'applyDiscount', type: 'order.applyDiscount', inputs: { amount: '{{_trigger.amount}}', discountPercent: '{{_trigger.discountPercent}}' } },
      { id: 'charge', type: 'order.charge.unsafe', inputs: { amount: '{{applyDiscount.discountedAmount}}', currency: '{{_trigger.currency}}' } },
    ],
  });
  unsafeWorkflowId = wf._id;
}

const shell = new Shell({ profile: 'admin' });

shell.registry.register('order', 'run', {
  description: 'Run the validated order-fulfillment workflow',
  params: [
    { name: 'amount', type: 'number', required: true },
    { name: 'discountPercent', type: 'number', required: true },
    { name: 'currency', type: 'string', required: true },
  ],
}, async (args) => engine.run(workflowId, { amount: args.amount, discountPercent: args.discountPercent, currency: args.currency }));

shell.registry.register('order', 'run-unsafe', {
  description: 'Run the SAME pipeline with no validation gate on the charge node, for comparison',
  params: [
    { name: 'amount', type: 'number', required: true },
    { name: 'discountPercent', type: 'number', required: true },
    { name: 'currency', type: 'string', required: true },
  ],
}, async (args) => engine.run(unsafeWorkflowId, { amount: args.amount, discountPercent: args.discountPercent, currency: args.currency }));

const router = new Router();
router.use(cors());
router.route('/api/shell', shellRoutes(shell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Validated workflow nodes demo running at http://localhost:${PORT}
  commands: order:run, order:run-unsafe

Try (a >100% discount silently makes the amount negative upstream):
  POST /api/shell/exec {"cmd":"order:run --amount 100 --discountPercent 150 --currency USD"}
    -> node "charge" fails with an actionable validation error
  POST /api/shell/exec {"cmd":"order:run-unsafe --amount 100 --discountPercent 150 --currency USD"}
    -> "succeeds", silently charging -50
See examples/validated-workflow-nodes/README.md for the full walkthrough.
`);
