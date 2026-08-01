/**
 * Workflow Observability — HTTP/shell demo.
 *
 *   bun examples/workflow-observability/setup.js
 *
 * Combines core/log.js + core/metrics.js (built earlier this session to
 * close the "no observability" gap for running Automators Kit in
 * production) with core/workflow.js, real workflow executions instead of
 * the HTTP-request-level demo core/http.js's own `logger()`/
 * `metricsHandler()` already cover. `observe.js`'s `observeWorkflowEngine`
 * watches `_executions` (via `DocStore.watch`, an existing extension
 * point) so every execution — webhook, cron, poll, or manual — gets a
 * structured log entry and feeds `workflow_executions_total`/
 * `workflow_execution_duration_ms` into a Prometheus-scrapeable registry,
 * with zero core/workflow.js changes.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { metricsHandler } from '../../core/http.js';
import { riskyOpNode } from './nodes.js';
import { observeWorkflowEngine } from './observe.js';

const PORT = +(process.env.PORT || 3029);
const DB_PATH = process.env.DB_PATH || './examples/workflow-observability/data';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'workflow-observability-webhook-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'workflow-observability-demo-secret',
});

app.workflowEngine.nodes.add(riskyOpNode);
const metrics = observeWorkflowEngine(app.workflowEngine);

const workflow = app.workflowEngine.create({
  name: 'Risky Run',
  trigger: { type: 'webhook', config: { path: 'risky-run', secret: WEBHOOK_SECRET } },
  nodes: [{ id: 'risky', type: 'risky.op', inputs: { shouldFail: '{{_trigger.shouldFail}}' } }],
});

app.router.get('/metrics', metricsHandler(metrics));
app.shell.registry.register('runs', 'executions', {
  description: 'Recent executions of the Risky Run workflow',
  params: [{ name: 'limit', type: 'number' }],
}, async (args) => app.workflowEngine.getExecutions(workflow._id, args.limit || 10));

app.workflowEngine.start();
Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Workflow observability demo running at http://localhost:${PORT}
  workflow id: ${workflow._id}
  commands: runs:executions

Try (webhook fires the workflow ASYNCHRONOUSLY -- poll runs:executions):
  curl -X POST http://localhost:${PORT}/api/workflows/webhook/risky-run \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" -H "Content-Type: application/json" -d '{"shouldFail":false}'
  curl -X POST http://localhost:${PORT}/api/workflows/webhook/risky-run \\
    -H "X-Webhook-Secret: ${WEBHOOK_SECRET}" -H "Content-Type: application/json" -d '{"shouldFail":true}'
  curl http://localhost:${PORT}/metrics
See examples/workflow-observability/README.md for the full walkthrough.
`);
