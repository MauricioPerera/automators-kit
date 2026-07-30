/**
 * Trigger hub — shared by setup.js (the real HTTP demo) and the regression
 * test, so the demo and test can't drift apart.
 *
 * Wires one core/triggers.js TriggerManager to all 4 trigger types feeding
 * a single onTrigger callback (an in-memory event log): manual, webhook
 * (with an optional per-webhook secret), cron (registered, not waited on —
 * see README), and poll (hash-based change detection + circuit-breaker
 * after consecutive failures).
 */

import { TriggerManager, TriggerType } from '../../core/triggers.js';

// net-guard's assertPublicUrl (called unconditionally by
// TriggerManager.register() for poll triggers, no opt-out unlike
// connector.js's blockInternalHosts) rejects "localhost" outright — see
// README's "A real constraint" section. This is a syntactically-public
// placeholder hostname that passes the check at registration time;
// setup.js/the test redirect real fetch() calls for this exact URL to the
// local mock status server.
export const POLL_TARGET_URL = 'https://status.example.com/health';

export function buildTriggerHub(opts = {}) {
  const events = [];
  const tm = new TriggerManager({
    onTrigger: (workflowId, data) => { events.unshift({ workflowId, ...data, at: Date.now() }); },
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
  });
  return { tm, events };
}

export function registerDemoTriggers(tm, { pollInterval = 1000 } = {}) {
  tm.register('status-watch', {
    type: TriggerType.POLL,
    config: { url: POLL_TARGET_URL, interval: pollInterval },
  });
  tm.register('external-push', {
    type: TriggerType.WEBHOOK,
    config: { path: 'push', secret: 'demo-webhook-secret' },
  });
  tm.register('daily-digest', {
    type: TriggerType.CRON,
    config: { expression: '0 9 * * *' },
  });
  tm.register('admin-rerun', { type: TriggerType.MANUAL, config: {} });
}
