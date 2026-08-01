/**
 * Observes EVERY WorkflowEngine execution -- webhook, cron, poll, or
 * manual -- via `db.watch('_executions', ...)`, not by wrapping
 * `execute()`/`run()` directly. Those internal trigger paths call
 * `execute()` fire-and-forget (see core/workflow.js's constructor:
 * `this.execute(workflowId, triggerData).catch(...)`), so a caller-side
 * "await execute() then log" wrapper (the pattern
 * integrations/postgres-execution-log.js uses) would silently miss every
 * trigger-fired run and only catch manual ones. `_executions.insert()`
 * happens exactly once, at the very end of `execute()`, with the fully
 * finished execution doc (status/duration already final) -- watching for
 * that single insert event covers every execution path uniformly, using
 * an extension point (`DocStore.watch`) that already exists, no core
 * changes needed.
 */

import { createLogger } from '../../core/log.js';
import { MetricsRegistry } from '../../core/metrics.js';

/**
 * @param {import('../../core/workflow.js').WorkflowEngine} engine
 * @param {object} [opts]
 * @param {ReturnType<typeof createLogger>} [opts.log]
 * @param {MetricsRegistry} [opts.metrics]
 * @returns {MetricsRegistry}
 */
export function observeWorkflowEngine(engine, opts = {}) {
  const log = opts.log || createLogger('workflow');
  const metrics = opts.metrics || new MetricsRegistry();

  engine.db.watch('_executions', (event) => {
    if (event.type !== 'insert') return;
    const exec = event.doc;
    const labels = { workflow: exec.workflowName || exec.workflowId, status: exec.status };

    log.info('workflow execution finished', {
      workflowId: exec.workflowId,
      workflowName: exec.workflowName,
      status: exec.status,
      duration: exec.duration,
    });

    metrics.counter('workflow_executions_total', 'Total workflow executions').inc(labels);
    if (exec.duration != null) {
      metrics
        .histogram('workflow_execution_duration_ms', 'Workflow execution duration in ms')
        .observe(labels, exec.duration);
    }
  });

  return metrics;
}
