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
   * @param {Function} [opts.onWebhookSync] - Called instead of onTrigger for a
   *   webhook whose trigger.config.respond is 'whenFinished':
   *   (workflowId, triggerData) => Promise<execution>. Its return value is
   *   what fireWebhook() resolves to for that case -- see fireWebhook's own
   *   doc comment for the full contract.
   */
  constructor(opts = {}) {
    this._onTrigger = opts.onTrigger || (() => {});
    this._onWebhookSync = opts.onWebhookSync || null;
    this._cron = new CronScheduler();
    this._webhooks = new Map();  // "METHOD:path" -> { workflowId, secret, method }
    this._pollers = new Map();   // workflowId -> { timer, config, _failures }
    this._registered = new Map(); // workflowId -> trigger config
    // Pollers that tripped the consecutive-failure threshold land here so the
    // error state is observable after the poller itself is torn down.
    this._pollerErrors = new Map(); // workflowId -> { status, lastError, failures }
    // Max consecutive poll failures before a poller is auto-unregistered.
    this._maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 5;
  }

  /**
   * Builds the `_webhooks` Map key for a webhook trigger config, shared by
   * register()/unregister()/webhookPathTaken() so all three ever agree on
   * what "the same webhook" means. Prefixed with the (uppercased, defaults
   * to POST for backward compatibility) HTTP method so two workflows can
   * legitimately share a path under different methods (e.g. GET vs POST on
   * `/orders`) without colliding -- same as a real HTTP router would treat
   * them as distinct routes.
   * @private
   */
  _webhookKey(path, workflowId, method) {
    return `${(method || 'POST').toUpperCase()}:${path || workflowId}`;
  }

  /**
   * True if `trigger` (a webhook trigger config) would collide with an
   * ALREADY-registered webhook belonging to a DIFFERENT workflow. Callers
   * (WorkflowEngine.create()/update()) check this BEFORE calling register()
   * and reject the mutation with a clear error instead of register()
   * silently overwriting the Map entry and hijacking an already-working
   * webhook with zero warning -- the bug this exists to prevent, found live
   * during a full system test (2026-08-03).
   * @param {{config?: {path?: string, method?: string}}} trigger
   * @param {string} excludeWorkflowId - the workflow being created/updated;
   *   never a collision against its OWN existing registration.
   */
  webhookPathTaken(trigger, excludeWorkflowId) {
    const path = trigger?.config?.path;
    if (!path) return false; // no path set -> falls back to the (always-unique) workflow id, can never collide
    const key = this._webhookKey(path, null, trigger.config.method);
    const existing = this._webhooks.get(key);
    return !!existing && existing.workflowId !== excludeWorkflowId;
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

      case TriggerType.WEBHOOK: {
        // Store an optional per-webhook secret so callers can be authenticated.
        // When no secret is configured, the webhook stays open (back-compat) —
        // hardening is opt-in by whoever builds the workflow. `method`
        // defaults to POST (the only method this ever supported before
        // 2026-08-03), keeping every existing workflow's behavior unchanged.
        const method = (trigger.config.method || 'POST').toUpperCase();
        this._webhooks.set(this._webhookKey(trigger.config.path, workflowId, method), {
          workflowId,
          secret: trigger.config.secret,
          method,
          // 'immediate' (default, unchanged pre-2026-08-03 behavior): fires
          // and returns the workflowId right away, execution continues in
          // the background. 'whenFinished': fireWebhook() instead returns a
          // Promise for the actual execution (see fireWebhook below) -- lets
          // a workflow act as a synchronous request/response API endpoint.
          respond: trigger.config.respond === 'whenFinished' ? 'whenFinished' : 'immediate',
        });
        break;
      }

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
        this._webhooks.delete(this._webhookKey(trigger.config?.path, workflowId, trigger.config?.method));
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
   *  @param {string} [method] - HTTP method of the incoming request, default
   *    POST (matches the pre-2026-08-03 fixed-POST behavior). A request
   *    whose method doesn't match what the workflow registered gets the
   *    same generic "not found" as an unregistered path — same
   *    don't-leak-which-case shape as the wrong-secret check below.
   *  @returns {string|null} workflowId on success, null when not found or
   *    rejected (wrong/missing secret). */
  /**
   * Fires a registered webhook. Return shape depends on how the webhook was
   * registered (trigger.config.respond):
   *  - not found / bad secret: `null`, same as always.
   *  - 'immediate' (default): the `workflowId` string, same as always --
   *    execution is dispatched fire-and-forget, the HTTP caller gets an
   *    immediate ack. Every workflow that existed before this option was
   *    added behaves exactly as before.
   *  - 'whenFinished': a `Promise<execution>` -- resolves once execute()
   *    itself would return (success, failure, OR a wait.* node pausing --
   *    this does NOT block until a paused wait resumes, only until the run
   *    stops actively progressing). Always dispatched directly in-process,
   *    NEVER through opts.executionQueue -- an HTTP caller blocked waiting
   *    for a real-time answer can't be handed off to an out-of-process
   *    queue worker in this design.
   * Callers distinguish the two non-null cases with `result instanceof Promise`.
   */
  fireWebhook(path, data, providedSecret, method) {
    const entry = this._webhooks.get(this._webhookKey(path, null, method));
    if (!entry) return null;
    const { workflowId, secret, respond } = entry;
    // If the webhook registered a secret, the caller must present an exact match.
    // (Plain comparison — a constant-time compare would be a future hardening.)
    if (secret !== undefined && secret !== null && secret !== '') {
      if (providedSecret !== secret) return null;
    }
    if (respond === 'whenFinished' && this._onWebhookSync) {
      return this._onWebhookSync(workflowId, { trigger: 'webhook', data });
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
      // An HTTP-level error (4xx/5xx) with a valid JSON error body used to
      // fall straight through to the "success" path below — res.json()
      // parses fine, so the error body itself was treated as changed data
      // and fired onTrigger, while the consecutive-failure counter (and
      // therefore the circuit-breaker) never saw it. Routing !res.ok into
      // the same catch block below reuses the existing failure/teardown
      // logic instead of duplicating it.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  /**
   * List all registered triggers. For a `poll` trigger, includes
   * `pollerStatus` ('active' | 'error') so a circuit-broken poller (see
   * `_pollOnce`) is observable here too — previously only `_pollerErrors`
   * (private) recorded that state, so a poller could die from repeated
   * fetch failures while `list()` kept showing it as an ordinary,
   * apparently-still-running registration.
   */
  list() {
    return Array.from(this._registered.entries()).map(([id, trigger]) => {
      const row = { workflowId: id, ...trigger };
      if (trigger.type === TriggerType.POLL) {
        const errState = this._pollerErrors.get(id);
        row.pollerStatus = errState ? 'error' : 'active';
        if (errState) row.pollerError = errState;
      }
      return row;
    });
  }
}
