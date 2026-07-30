/**
 * Poll-to-queue bridge — shared by setup.js and the regression test.
 *
 * core/triggers.js's poll trigger only tells you "the feed's data
 * changed" (one whole-blob hash comparison, see core/triggers.js's
 * _pollOnce) — it has no notion of individual items. This diffs the
 * fetched item list against a locally-tracked `seenIds` set on every
 * fire and enqueues ONE durable core/queue.js job per genuinely new
 * item, so a single feed change with 3 new items becomes 3 independently
 * retryable jobs, not one all-or-nothing poll event.
 *
 * A real gotcha, verified live (see README): TriggerManager's poll NEVER
 * fires onTrigger on its first cycle (that cycle only establishes the
 * baseline hash) -- so `seenIds` must be seeded from an explicit initial
 * fetch BEFORE the poll trigger starts, or every item already on the feed
 * at startup gets (re)enqueued the moment the first real change fires.
 */

import { TriggerManager, TriggerType } from '../../core/triggers.js';

// net-guard's assertPublicUrl (called unconditionally by
// TriggerManager.register() for poll triggers, no opt-out) rejects
// "localhost" -- same constraint documented in examples/trigger-hub. This
// syntactically-public placeholder passes registration; setup.js/the test
// redirect real fetch() calls for this exact URL to the local mock feed.
export const POLL_TARGET_URL = 'https://incidents.example.com/feed';

/**
 * @param {import('../../core/queue.js').JobQueue} queue
 * @param {Set<string>} seenIds - pre-seeded from a baseline fetch by the caller
 */
export function buildPollToQueue(queue, seenIds) {
  const tm = new TriggerManager({
    onTrigger: (workflowId, { data }) => {
      const items = (data && data.items) || [];
      for (const item of items) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        queue.enqueue('process-incident', item);
      }
    },
    maxConsecutiveFailures: 3,
  });
  return tm;
}

export function registerPollTrigger(tm, { pollInterval = 1000 } = {}) {
  tm.register('incident-feed', {
    type: TriggerType.POLL,
    config: { url: POLL_TARGET_URL, interval: pollInterval },
  });
}
