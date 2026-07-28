/**
 * Trigger System
 * Starts workflow execution from: webhook, cron, poll, manual.
 * Zero dependencies.
 */

import { CronScheduler } from './cron.js';
import { assertPublicUrl } from './net-guard.js';

// ---------------------------------------------------------------------------
// TRIGGER TYPES
// ---------------------------------------------------------------------------

export const TriggerType = {
  MANUAL: 'manual',
  WEBHOOK: 'webhook',
  CRON: 'cron',
  POLL: 'poll',
};

// ---------------------------------------------------------------------------
// TRIGGER MANAGER
// ---------------------------------------------------------------------------

export class TriggerManager {
  /**
   * @param {object} opts
   * @param {Function} opts.onTrigger - Called when trigger fires: (workflowId, triggerData) => void
   */
  constructor(opts = {}) {
    this._onTrigger = opts.onTrigger || (() => {});
    this._cron = new CronScheduler();
    this._webhooks = new Map();  // name -> workflowId
    this._pollers = new Map();   // workflowId -> { timer, config, _failures }
    this._registered = new Map(); // workflowId -> trigger config
    // Pollers that tripped the consecutive-failure threshold land here so the
    // error state is observable after the poller itself is torn down.
    this._pollerErrors = new Map(); // workflowId -> { status, lastError, failures }
    // Max consecutive poll failures before a poller is auto-unregistered.
    this._maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 5;
  }

  /**
   * Register a trigger for a workflow.
   * @param {string} workflowId
   * @param {object} trigger - { type, config }
   */
  register(workflowId, trigger) {
    // SSRF guard for pollers: validate the destination before recording the
    // trigger so a rejected URL leaves nothing registered (no recurring fetch).
    if (trigger.type === TriggerType.POLL) {
      assertPublicUrl(trigger.config.url);
    }

    this._registered.set(workflowId, trigger);

    switch (trigger.type) {
      case TriggerType.CRON:
        this._cron.add(`wf_${workflowId}`, trigger.config.expression, () => {
          this._onTrigger(workflowId, { trigger: 'cron', firedAt: Date.now() });
        });
        break;

      case TriggerType.WEBHOOK:
        // Store an optional per-webhook secret so callers can be authenticated.
        // When no secret is configured, the webhook stays open (back-compat) —
        // hardening is opt-in by whoever builds the workflow.
        this._webhooks.set(trigger.config.path || workflowId, {
          workflowId,
          secret: trigger.config.secret,
        });
        break;

      case TriggerType.POLL: {
        // Clamp interval to a minimum of 1000ms to avoid a tight loop that
        // piles up async fetches faster than the event loop can drain them
        // (local DoS via config.interval: 0 or any sub-second value).
        const interval = Math.max(trigger.config.interval || 60000, 1000);
        const timer = setInterval(() => this._pollOnce(workflowId), interval);
        this._pollers.set(workflowId, {
          timer,
          config: trigger.config,
          interval,
          _lastHash: undefined,
          _failures: 0,
        });
        break;
      }
    }
  }

  /** Unregister a trigger */
  unregister(workflowId) {
    const trigger = this._registered.get(workflowId);
    if (!trigger) return;

    switch (trigger.type) {
      case TriggerType.CRON:
        this._cron.remove(`wf_${workflowId}`);
        break;
      case TriggerType.WEBHOOK:
        this._webhooks.delete(trigger.config?.path || workflowId);
        break;
      case TriggerType.POLL: {
        const poller = this._pollers.get(workflowId);
        if (poller) clearInterval(poller.timer);
        this._pollers.delete(workflowId);
        this._pollerErrors.delete(workflowId);
        break;
      }
    }

    this._registered.delete(workflowId);
  }

  /** Fire a webhook trigger (called from HTTP route).
   *  @param {string} path - Webhook path
   *  @param {*} data - Payload delivered by the caller
   *  @param {string} [providedSecret] - Secret presented by the caller; required
   *    only when the registered webhook has `config.secret` set.
   *  @returns {string|null} workflowId on success, null when not found or
   *    rejected (wrong/missing secret). */
  fireWebhook(path, data, providedSecret) {
    const entry = this._webhooks.get(path);
    if (!entry) return null;
    const { workflowId, secret } = entry;
    // If the webhook registered a secret, the caller must present an exact match.
    // (Plain comparison — a constant-time compare would be a future hardening.)
    if (secret !== undefined && secret !== null && secret !== '') {
      if (providedSecret !== secret) return null;
    }
    this._onTrigger(workflowId, { trigger: 'webhook', data });
    return workflowId;
  }

  /** Fire a manual trigger */
  fireManual(workflowId, data = {}) {
    this._onTrigger(workflowId, { trigger: 'manual', data });
  }

  /** Start all cron triggers */
  start() {
    this._cron.start();
  }

  /** Stop all triggers */
  stop() {
    this._cron.stop();
    for (const [, poller] of this._pollers) {
      clearInterval(poller.timer);
    }
    this._pollers.clear();
    this._pollerErrors.clear();
  }

  /**
   * Run a single poll cycle for a registered poller. Extracted from the
   * setInterval callback so the failure/teardown path is deterministic and
   * testable without waiting on real timers.
   *
   * On a successful fetch+parse the per-poller consecutive-failure counter is
   * reset to 0. On failure the counter is bumped; once it reaches
   * `_maxConsecutiveFailures` the poller is torn down (clearInterval + removed
   * from `_pollers`) and its error state is recorded in `_pollerErrors` so it
   * stays observable after teardown.
   */
  async _pollOnce(workflowId) {
    const poller = this._pollers.get(workflowId);
    if (!poller) return; // unregistered
    try {
      const res = await fetch(poller.config.url, {
        headers: poller.config.headers || {},
      });
      const data = await res.json();
      const current = this._pollers.get(workflowId);
      if (!current) return; // unregistered during await
      // Successful poll: reset the consecutive-failure counter.
      current._failures = 0;
      // Check if data changed (simple hash comparison)
      const hash = JSON.stringify(data);
      if (hash !== current._lastHash) {
        const isFirstPoll = current._lastHash === undefined;
        current._lastHash = hash;
        if (!isFirstPoll) {
          this._onTrigger(workflowId, { trigger: 'poll', data });
        }
      }
    } catch (err) {
      console.error(`[Trigger] Poll error for ${workflowId}:`, err.message);
      const current = this._pollers.get(workflowId);
      if (!current) return; // already torn down
      current._failures = (current._failures || 0) + 1;
      if (current._failures >= this._maxConsecutiveFailures) {
        // Circuit-breaker: stop the recurring poll and record an observable
        // error state instead of looping forever on a dead endpoint.
        clearInterval(current.timer);
        this._pollers.delete(workflowId);
        this._pollerErrors.set(workflowId, {
          status: 'error',
          lastError: err.message,
          failures: current._failures,
        });
      }
    }
  }

  /** List all registered triggers */
  list() {
    return Array.from(this._registered.entries()).map(([id, trigger]) => ({
      workflowId: id,
      ...trigger,
    }));
  }
}
