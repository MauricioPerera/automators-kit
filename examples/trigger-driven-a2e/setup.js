/**
 * Trigger-Driven a2e — HTTP demo.
 *
 *   bun examples/trigger-driven-a2e/setup.js
 *
 * Combines core/triggers.js with core/a2e.js: a webhook fires a real
 * a2e.js `WorkflowExecutor` pipeline, not a `core/workflow.js`
 * `WorkflowEngine`. `TriggerManager` is built directly INTO
 * `WorkflowEngine` (its constructor owns one internally) but has zero
 * wiring to `core/a2e.js` at all -- every existing a2e.js example
 * (a2e-pipeline, a2e-vault-api, a2e-background) invokes pipelines
 * manually (`.load()` + `.execute()`), never from a real trigger.
 *
 * Two real a2e.js constraints this bridge has to work around (both
 * already documented from prior examples, verified again live here):
 *   1. WorkflowExecutor.execute() takes NO per-call input -- unlike
 *      WorkflowEngine.execute(id, triggerData). Reusing a pipeline with
 *      different data means building a FRESH definition with the data
 *      baked in and load()-ing it again (pipeline.js's
 *      buildPipelineDef(), same pattern examples/a2e-vault-api used).
 *   2. A single WorkflowExecutor instance is not safe for concurrent
 *      execute() calls (examples/a2e-background's finding) -- webhook
 *      fires can genuinely overlap, so this bridge constructs a FRESH
 *      executor per fire, never reuses one across requests.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { WorkflowExecutor } from '../../core/a2e.js';
import { TriggerManager, TriggerType } from '../../core/triggers.js';
import { Router, json, error, cors } from '../../core/http.js';
import { buildPipelineDef, enrichCustomer } from './pipeline.js';

const PORT = +(process.env.PORT || 3034);
const DB_PATH = process.env.DB_PATH || './examples/trigger-driven-a2e/data';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'trigger-driven-a2e-demo-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'trigger-driven-a2e-demo-app-secret',
});

const executions = app.cms.db.collection('_a2e_executions');

/** A fresh WorkflowExecutor + a freshly-built definition, every single
 * fire -- see the file header for why both are required. */
async function runPipeline(triggerData) {
  const executor = new WorkflowExecutor();
  executor.registerHandler('EnrichCustomer', enrichCustomer);
  executor.load(buildPipelineDef(triggerData.data));

  const r = await executor.execute();
  const failed = Object.keys(r.errors).length > 0;
  // a2e.js's DAG dispatch does not stop on a failed op (documented,
  // verified in examples/a2e-vault-api): when `enriched` throws, `check`'s
  // Conditional still runs, reading an undefined `/workflow/enriched/tier`
  // -- which evaluates to false and silently picks the SAME branch as a
  // genuine "personal" classification. Guard against that here rather
  // than storing a misleading decision for a run that actually failed.
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
  app.cms.db.flush();
  return record;
}

const triggers = new TriggerManager({
  onTrigger: (workflowId, triggerData) => {
    // Fire-and-forget, same shape as WorkflowEngine's own internal
    // trigger bridge -- fireWebhook() below doesn't wait for the
    // pipeline to finish, only for it to have started.
    runPipeline(triggerData).catch((err) => {
      console.error(`[trigger-driven-a2e] pipeline run failed for ${workflowId}:`, err.message);
    });
  },
});
triggers.register('customer-enrich', {
  type: TriggerType.WEBHOOK,
  config: { path: 'customer-enrich', secret: WEBHOOK_SECRET },
});

const router = new Router();
router.use(cors());

router.post('/webhooks/:path', async (ctx) => {
  const body = await ctx.json().catch(() => ({}));
  const providedSecret = ctx.req.headers.get('X-Webhook-Secret');
  const workflowId = triggers.fireWebhook(ctx.params.path, body, providedSecret);
  if (!workflowId) return error('Webhook rejected (unknown path or bad secret)', 401);
  return json({ accepted: true, workflowId }, 202);
});

router.get('/api/executions', async () => json(executions.find({}).sort({ createdAt: -1 }).toArray()));
router.get('/api/executions/:id', async (ctx) => {
  const exec = executions.findById(ctx.params.id);
  if (!exec) return json({ error: 'Not found' }, 404);
  return json(exec);
});

router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Trigger-driven a2e demo running at http://localhost:${PORT}
  POST /webhooks/customer-enrich   (header X-Webhook-Secret: ${WEBHOOK_SECRET})
  GET  /api/executions
  GET  /api/executions/:id

Try:
  curl -s -X POST http://localhost:${PORT}/webhooks/customer-enrich \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" \\
    -d '{"name":"Alice","email":"alice@acme.com"}'
See examples/trigger-driven-a2e/README.md for the full walkthrough.
`);
