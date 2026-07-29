/**
 * Job handlers for the job-queue example — deliberately slow/flaky mocks so
 * this example runs fully offline/deterministically (no real report
 * generator or notification service needed to see retries, backoff, and
 * dead-letter work for real).
 */

/**
 * @returns {{ handlers: Record<string, Function>, sent: object[], configureFlaky: Function, resetFlaky: Function }}
 */
export function buildJobHandlers() {
  const sent = [];
  let flakyFailuresRemaining = 0; // configurable per-demo via configureFlaky

  const handlers = {
    // Simulates a slow report job (crunching data takes real time).
    'generate-report': async (data) => {
      await sleep(data.delayMs ?? 50);
      return {
        report: `Report for ${data.entryType || 'all'} (${data.format || 'json'})`,
        rows: data.rows ?? 42,
        generatedAt: Date.now(),
      };
    },

    // Trivial — just records what would have been sent.
    'send-notification': async (data) => {
      sent.push(data);
      return { sent: true, to: data.to };
    },

    // Fails `flakyFailuresRemaining` times, then succeeds — for demoing
    // retry+backoff (finite failures) and dead-letter (failures that
    // outlast maxRetries) with the SAME handler, just different counts.
    'flaky-job': async (data) => {
      if (flakyFailuresRemaining > 0) {
        flakyFailuresRemaining--;
        throw new Error(`Simulated transient failure (${flakyFailuresRemaining} more queued)`);
      }
      return { ok: true, payload: data };
    },
  };

  return {
    handlers,
    sent,
    configureFlaky: (failCount) => { flakyFailuresRemaining = failCount; },
    resetFlaky: () => { flakyFailuresRemaining = 0; },
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
