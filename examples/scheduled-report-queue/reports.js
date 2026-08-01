/**
 * Cron-driven batch enqueue: on each tick, one durable, independently
 * retryable job is enqueued per report — distinct from
 * examples/scheduled-sync (a single cron-triggered action performed
 * directly, no queue; one failure blocks the cursor there until retried)
 * and examples/poll-to-queue (one job per NEW item detected from an
 * external feed, event-driven, not scheduled).
 */

export const REPORT_IDS = ['workspace-a', 'workspace-b', 'workspace-c'];

/**
 * Enqueues one job per report. Called by the cron tick, and exposed as a
 * manual shell command for the live demo (real cron ticks run nightly,
 * not something worth waiting on to verify this works).
 * @param {import('../../core/queue.js').JobQueue} queue
 */
export function enqueueReports(queue) {
  return REPORT_IDS.map((reportId) => queue.enqueue('workspace-report', { reportId }));
}

// 'workspace-b' fails on its first attempt (deterministically, not
// randomly) then succeeds on retry — proves the queue's normal
// retry/backoff still applies to jobs enqueued by a scheduled batch, not
// just a single manually-enqueued job. Tracked per reportId so two
// overlapping batches (e.g. a manual trigger fired while a previous
// batch is still draining) don't clobber each other's attempt count.
const _attempts = new Map();

export async function generateReport({ reportId }) {
  const n = (_attempts.get(reportId) || 0) + 1;
  _attempts.set(reportId, n);
  if (reportId === 'workspace-b' && n === 1) {
    throw new Error(`Transient failure generating report for ${reportId}`);
  }
  return { reportId, generatedAt: Date.now() };
}
