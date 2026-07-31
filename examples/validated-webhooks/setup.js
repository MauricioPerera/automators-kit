/**
 * Validated Webhooks — HTTP/shell demo.
 *
 *   bun examples/validated-webhooks/setup.js
 *
 * Combines core/validate.js's real schema engine with core/workflow.js's
 * webhook trigger: a malformed payload is rejected with a clear 400
 * BEFORE the workflow ever runs — not a partial/garbage execution that
 * fails midway. Neither module's other example demonstrates this
 * combination.
 *
 * A real architectural finding from designing this (see README, verified
 * live, not just reasoned about): createApp()'s bundled `/api/workflows`
 * router (routes/workflows.js) mounts its OWN, unvalidated webhook route
 * at `/api/workflows/webhook/:path` unconditionally — wrapping validation
 * around a SEPARATE custom route while also using createApp() would leave
 * that original, unvalidated route reachable, completely bypassing the
 * validation. This example does NOT call createApp() (same à la carte
 * spirit as examples/doc-store-analytics) specifically so the validated
 * route below is the ONLY webhook route that exists at all — not a
 * demo that quietly fails to deliver on its own premise.
 */

import { DocStore } from '../../core/db.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { WorkflowEngine } from '../../core/workflow.js';
import { Router, json, error, cors } from '../../core/http.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { validate } from '../../core/validate.js';
import { ORDER_WEBHOOK_SCHEMA } from './schemas.js';

const PORT = +(process.env.PORT || 3026);
const DB_PATH = process.env.DB_PATH || './examples/validated-webhooks/data';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'order-webhook-secret';

const db = new DocStore(new FileStorageAdapter(DB_PATH));
const engine = new WorkflowEngine(db, { masterKey: process.env.MASTER_KEY || 'validated-webhooks-demo-master-key' });
await engine.init();

const workflow = engine.create({
  name: 'Order Intake',
  trigger: { type: 'webhook', config: { path: 'orders', secret: WEBHOOK_SECRET } },
  nodes: [
    {
      id: 'summary', type: 'set.value',
      inputs: { value: 'Order from {{_trigger.customerId}}: {{_trigger.items.length}} item(s), ${{_trigger.subtotal}}' },
    },
  ],
});
engine.start();

const router = new Router();
router.use(cors());

router.post('/webhooks/:path', async (ctx) => {
  const body = await ctx.json();
  const result = validate(ORDER_WEBHOOK_SCHEMA, body);
  if (!result.valid) return error(result.errors.join('; '), 400);

  // Same convention as routes/workflows.js's own webhook route: secret
  // read from a header, never body/query.
  const secret = ctx.req.headers.get('X-Webhook-Secret');
  const workflowId = engine.webhookTrigger(ctx.params.path, result.data, secret);
  if (!workflowId) return error('No workflow registered for this webhook, or bad secret', 404);
  return json({ triggered: workflowId });
});

const shell = new Shell({ profile: 'admin' });
shell.registry.register('orders', 'executions', {
  description: 'Recent executions of the Order Intake workflow',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => engine.getExecutions(workflow._id, args.limit || 10));

router.route('/api/shell', shellRoutes(shell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Validated webhooks demo running at http://localhost:${PORT}
  POST /webhooks/orders (X-Webhook-Secret: ${WEBHOOK_SECRET})
  shell: orders:executions

Try:
  curl -X POST http://localhost:${PORT}/webhooks/orders \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" -H "Content-Type: application/json" \\
    -d '{"customerId":"c1","customerEmail":"jane@example.com","subtotal":42.5,"items":[{"sku":"SKU-1","qty":2}]}'
  # a malformed payload (missing items, bad email, etc.) gets a 400 BEFORE
  # the workflow ever runs -- check orders:executions stays empty
See examples/validated-webhooks/README.md for the full walkthrough.
`);
