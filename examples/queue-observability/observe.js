/**
 * Observes EVERY JobQueue job's terminal outcome — completed, failed
 * (no registered handler for the job's type), or dead (exhausted
 * retries) — via `db.watch()` on `_queue_jobs`/`_queue_dead`, the same
 * `DocStore.watch()` extension point examples/workflow-observability
 * uses for `core/workflow.js`. No core/queue.js changes needed.
 *
 * A job's document goes through several intermediate `update()` calls
 * before reaching a terminal state (pending -> processing -> pending
 * again on retry -> processing -> ...) -- verified live (see the
 * example's README) that exactly ONE terminal event fires per job
 * regardless of how many retries it took: `_queue_jobs` update events
 * are only counted when `status` is `'completed'` or `'failed'`
 * (the immediate "no handler registered" case, which never even reaches
 * `'processing'`); a job that exhausts retries is deleted from
 * `_queue_jobs` (ignored here — a `delete` event, not `update`) and
 * inserted into `_queue_dead` instead, counted from THAT insert.
 */

import { createLogger } from '../../core/log.js';
import { MetricsRegistry } from '../../core/metrics.js';

/**
 * @param {import('../../core/queue.js').JobQueue} queue
 * @param {object} [opts]
 * @param {ReturnType<typeof createLogger>} [opts.log]
 * @param {MetricsRegistry} [opts.metrics]
 * @returns {MetricsRegistry}
 */
export function observeJobQueue(queue, opts = {}) {
  const log = opts.log || createLogger('queue');
  const metrics = opts.metrics || new MetricsRegistry();
  const counter = () => metrics.counter('queue_jobs_total', 'Total processed jobs, by terminal status');
  // Duration here is enqueue-to-terminal-state, NOT handler execution time
  // alone -- for a job that needed retries, it includes every backoff
  // delay in between. A real, worth-knowing distinction, not a flaw.
  const histogram = () => metrics.histogram('queue_job_duration_ms', 'Time from enqueue to terminal state, in ms (includes any retry backoff)');

  queue.db.watch('_queue_jobs', (event) => {
    if (event.type !== 'update') return;
    const job = event.doc;
    if (job.status !== 'completed' && job.status !== 'failed') return;

    const labels = { type: job.type, status: job.status };
    const durationMs = job.updatedAt - job.createdAt;
    log.info('job finished', { jobId: job._id, type: job.type, status: job.status, attempts: job.attempts, durationMs });
    counter().inc(labels);
    histogram().observe(labels, durationMs);
  });

  queue.db.watch('_queue_dead', (event) => {
    if (event.type !== 'insert') return;
    const job = event.doc;
    const labels = { type: job.type, status: 'dead' };
    const durationMs = job.diedAt - job.createdAt;
    log.warn('job moved to dead letter', { jobId: job._id, type: job.type, attempts: job.attempts, error: job.error });
    counter().inc(labels);
    histogram().observe(labels, durationMs);
  });

  return metrics;
}
