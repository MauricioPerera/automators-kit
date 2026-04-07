/**
 * Trigger System
 * Starts workflow execution from: webhook, cron, poll, manual.
 * Zero dependencies.
 */

import { CronScheduler } from './cron.js';

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
    this._pollers = new Map();   // workflowId -> { timer, config }
    this._registered = new Map(); // workflowId -> trigger config
  }

  /**
   * Register a trigger for a workflow.
   * @param {string} workflowId
   * @param {object} trigger - { type, config }
   */
  register(workflowId, trigger) {
    this._registered.set(workflowId, trigger);

    switch (trigger.type) {
      case TriggerType.CRON:
        this._cron.add(`wf_${workflowId}`, trigger.config.expression, () => {
          this._onTrigger(workflowId, { trigger: 'cron', firedAt: Date.now() });
        });
        break;

      case TriggerType.WEBHOOK:
        this._webhooks.set(trigger.config.path || workflowId, workflowId);
        break;

      case TriggerType.POLL: {
        const interval = trigger.config.interval || 60000;
        const timer = setInterval(async () => {
          try {
            const res = await fetch(trigger.config.url, {
              headers: trigger.config.headers || {},
            });
            const data = await res.json();
            // Check if data changed (simple hash comparison)
            const hash = JSON.stringify(data);
            const lastHash = this._pollers.get(workflowId)?._lastHash;
            if (hash !== lastHash) {
              this._pollers.get(workflowId)._lastHash = hash;
              if (lastHash !== undefined) { // skip first poll
                this._onTrigger(workflowId, { trigger: 'poll', data });
              }
            }
          } catch (err) {
            console.error(`[Trigger] Poll error for ${workflowId}:`, err.message);
          }
        }, interval);
        this._pollers.set(workflowId, { timer, config: trigger.config, _lastHash: undefined });
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
        break;
      }
    }

    this._registered.delete(workflowId);
  }

  /** Fire a webhook trigger (called from HTTP route) */
  fireWebhook(path, data) {
    const workflowId = this._webhooks.get(path);
    if (!workflowId) return null;
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
  }

  /** List all registered triggers */
  list() {
    return Array.from(this._registered.entries()).map(([id, trigger]) => ({
      workflowId: id,
      ...trigger,
    }));
  }
}
