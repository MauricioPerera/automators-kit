/**
 * Workflow Engine
 * n8n-style workflow execution. Connects triggers → nodes → outputs.
 * Uses NodeRegistry for execution, TriggerManager for activation.
 * Zero dependencies.
 *
 * Execution is DAG-parallel, not strictly sequential: nodes with no
 * `{{ref}}` dependency between them run concurrently (see
 * `_buildWorkflowDAG` / `execute()`). Dependencies are inferred from
 * `{{nodeId.field}}` references in `inputs` — no explicit edges to declare.
 *
 * Per-node retry: a node can carry `retries: N` (default 0, no behavior
 * change) and `retryBackoffMs` (default 1000, doubled per attempt) --
 * `_executeNodeWithRetry` retries just that node's own operation on
 * failure, not credential resolution or `runIf`. A successful retry
 * records `nodeResults[id].attempts`; an exhausted one does too, on the
 * error result.
 *
 * N-way branching: a node can carry `runIf: { equals: [a, b] }` (each side
 * resolved the same way `inputs` values are, so `a`/`b` can be `{{ref}}`
 * template strings or literals). When it evaluates false the node is
 * skipped — not run, not an error, `nodeResults[id].status === 'skipped'`
 * — without aborting the rest of the workflow, unlike the `if` node's
 * `onFalse: 'skip'` global barrier. Paired with the built-in `switch` node
 * (`core/nodes.js`, outputs the matched case's `label`), this gives real
 * N-way routing: `runIf: { equals: ['{{switchId}}', 'caseA'] }` on each
 * branch's nodes.
 *
 * Error workflow: a workflow can declare `errorWorkflow: <id>` (or the
 * engine constructor can set `opts.defaultErrorWorkflow` as a fallback for
 * workflows with none of their own). When an execution ends with
 * `status: 'failed'`, that workflow id is executed fire-and-forget with
 * error context as its trigger data (`{{_trigger.workflow.name}}`,
 * `{{_trigger.error.message}}`, `{{_trigger.execution.id}}`,
 * `{{_trigger.trigger}}` for the original trigger data) — see
 * `_maybeTriggerErrorWorkflow`.
 *
 * Sub-workflows: the `workflow.execute` node (registered per-instance in
 * the constructor, not in `core/nodes.js`'s engine-agnostic BUILTIN_NODES,
 * since it needs a live engine to call back into) runs another workflow by
 * id and returns `{ executionId, status, nodeResults }`; a failed
 * sub-workflow throws, failing the calling node the same way any other
 * node error does. `execute()` threads a call chain through
 * `triggerData._subWorkflowChain` (local to each call's own closure, not
 * instance state, so concurrent unrelated executions never share it) and
 * refuses to re-enter a workflow id already in that chain — an
 * `A -> B -> A` cycle throws `Circular sub-workflow reference` instead of
 * recursing forever.
 *
 * Per-item processing: `loop.forEach` (built entirely on `workflow.execute`
 * above -- NOT a real items-array data model; `context[nodeId]` is still a
 * single value everywhere else in the engine) runs an already-defined
 * sub-workflow once per item in an input array, chunked to `concurrency`
 * (default 5) items at a time, and collects `{ item, status, nodeResults }`
 * (or `{ item, status: 'error', error }`) per item into `results`. One
 * item's sub-workflow failing doesn't abort the batch unless
 * `continueOnItemError: false`. Cycle detection is free -- it goes through
 * the same `execute()` call `workflow.execute` does.
 *
 * Persisted wait: two nodes (`core/nodes.js`) pause an execution,
 * surviving process restarts -- unlike the plain `wait` node's in-memory
 * `setTimeout`. `wait.until` resumes automatically once a time/duration
 * passes (a timer, `start()`/`stop()`/`opts.waitPollInterval`, scans for
 * due ones). `wait.forWebhook` resumes only via an explicit
 * `resumeWebhook()` call / `POST /api/workflows/resume/:execId`
 * (routes/workflows.js) -- never auto-resumed. Either way, `execute()`/
 * `_runLevels` stop dispatching further DAG levels and store
 * `status: 'waiting'` with enough state (`execution.waitState`) to resume
 * from the SAME persisted execution document later, in this process or a
 * fresh one (`_resumeExecution`). A downstream node that must run AFTER a
 * wait needs an explicit `{{waitNodeId.resumeAt}}`/`{{waitNodeId.resumeData}}`
 * reference in its `inputs` to land in a later DAG level — same existing
 * gotcha as the `if`/`onFalse: 'skip'` barrier, not a new one.
 *
 * Workflow definition:
 * {
 *   name: "My Workflow",
 *   trigger: { type: "cron", config: { expression: "0 9 * * *" } },
 *   nodes: [
 *     { id: "n1", type: "http.request", inputs: { url: "https://api.example.com/data" } },
 *     { id: "n2", type: "filter", inputs: { items: "{{n1.data}}", field: "active", value: true } },
 *     { id: "n3", type: "slack.send", inputs: { message: "Found {{n2.length}} items" }, credentials: "slack" }
 *   ]
 * }
 */

import { NodeRegistry } from './nodes.js';
import { TriggerManager, TriggerType } from './triggers.js';
import { CredentialVault } from './credentials.js';
import { generateId } from './db.js';
import { buildLevels } from './dag.js';

// Sentinel returned internally when a node's `runIf` guard evaluates false —
// distinguishes "deliberately skipped" from any real handler result
// (including `undefined`/`null`, which a handler can legitimately return).
const SKIPPED = Symbol('workflow-node-skipped');

// ---------------------------------------------------------------------------
// WORKFLOW ENGINE
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure random master key (256 bits, hex).
 * Used when no `opts.masterKey` is provided so the credential vault is never
 * initialized with the public hard-coded `'default-key'`.
 *
 * Trade-off: the generated key is per-instance and NOT persisted across
 * restarts. Credentials encrypted with it cannot be decrypted after a restart
 * unless an explicit `opts.masterKey` is supplied. Callers that need
 * persistent credentials MUST pass their own `masterKey`.
 */
function _generateMasterKey() {
  const crypto = (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle)
    ? globalThis.crypto
    : null;
  if (!crypto || !crypto.getRandomValues) {
    throw new Error('WorkflowEngine: Web Crypto unavailable — cannot generate a secure master key');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export class WorkflowEngine {
  /**
   * @param {import('./db.js').DocStore} db
   * @param {object} opts
   * @param {string} opts.masterKey - For credential vault
   * @param {NodeRegistry} opts.nodeRegistry - Custom node registry
   * @param {string} [opts.defaultErrorWorkflow] - Workflow id run when any
   *   workflow's execution fails and that workflow has no `errorWorkflow`
   *   of its own set (see `create()`/`update()`'s `errorWorkflow` field).
   * @param {number} [opts.waitPollInterval] - How often (ms) to scan for
   *   due `wait.until` pauses to resume. Default 1000.
   */
  constructor(db, opts = {}) {
    this.db = db;
    this._workflows = db.collection('_workflows');
    this._executions = db.collection('_executions');
    this._nodeRegistry = opts.nodeRegistry || new NodeRegistry();
    this._vault = new CredentialVault(db, opts.masterKey || _generateMasterKey());
    this._defaultErrorWorkflow = opts.defaultErrorWorkflow || null;
    this._waitPollInterval = opts.waitPollInterval || 1000;
    this._waitTimer = null;

    try { this._workflows.createIndex('name'); } catch {}
    try { this._workflows.createIndex('active'); } catch {}
    try { this._executions.createIndex('workflowId'); } catch {}
    try { this._executions.createIndex('status'); } catch {}

    // 'workflow.execute' node -- registered here (not in core/nodes.js's
    // engine-agnostic BUILTIN_NODES) because it needs a live WorkflowEngine
    // to call back into, unlike every other built-in node. If `opts.
    // nodeRegistry` is a registry SHARED across multiple engine instances,
    // whichever engine registers last wins for this node type.
    this._nodeRegistry.add({
      type: 'workflow.execute',
      name: 'Execute Workflow',
      category: 'core',
      description: 'Run another workflow by id and return its result',
      inputs: [
        { name: 'workflowId', type: 'string', required: true },
        { name: 'data', type: 'object' }, // becomes the sub-workflow's {{_trigger...}}
      ],
      outputs: [{ name: 'result', type: 'object' }],
      handler: async (inputs, _credentials, ctx) => {
        const subTriggerData = {
          trigger: 'workflow',
          data: inputs.data || {},
          _subWorkflowChain: ctx?.callChain || [],
        };
        const subExec = await this.execute(inputs.workflowId, subTriggerData);
        if (subExec.status === 'failed') {
          const message = Object.values(subExec.errors)[0] || 'sub-workflow execution failed';
          throw new Error(`Sub-workflow '${inputs.workflowId}' failed: ${message}`);
        }
        return { executionId: subExec._id, status: subExec.status, nodeResults: subExec.nodeResults };
      },
    });

    // 'loop.forEach' node -- same "needs a live engine" reason as
    // 'workflow.execute' above, and built entirely on top of it: runs an
    // already-defined sub-workflow once per item in an input array,
    // collecting each run's result. This is NOT a real items-array
    // execution model (context[nodeId] is still a single value everywhere
    // else in the engine) -- it's one additive, opt-in node that reuses
    // execute()'s existing sub-workflow/cycle-detection/error-workflow
    // machinery rather than a second, parallel per-item dispatch engine.
    this._nodeRegistry.add({
      type: 'loop.forEach',
      name: 'For Each Item',
      category: 'core',
      description: 'Run a sub-workflow once per item in an array (bounded concurrency), collecting each run\'s result',
      inputs: [
        { name: 'items', type: 'array', required: true },
        { name: 'workflowId', type: 'string', required: true },
        { name: 'concurrency', type: 'number', default: 5 },
        { name: 'continueOnItemError', type: 'boolean', default: true },
      ],
      outputs: [{ name: 'results', type: 'array' }],
      handler: async (inputs, _credentials, ctx) => {
        const items = Array.isArray(inputs.items) ? inputs.items : [];
        const concurrency = Math.max(1, inputs.concurrency ?? 5);
        const continueOnItemError = inputs.continueOnItemError !== false;
        const callChain = ctx?.callChain || [];

        const results = new Array(items.length);
        let stop = false;

        for (let start = 0; start < items.length; start += concurrency) {
          if (stop) break;
          const chunk = items.slice(start, start + concurrency);
          const settled = await Promise.allSettled(chunk.map((item) => this.execute(inputs.workflowId, {
            trigger: 'workflow',
            data: { item },
            _subWorkflowChain: callChain,
          })));

          for (let i = 0; i < settled.length; i++) {
            const index = start + i;
            const outcome = settled[i];
            if (outcome.status === 'fulfilled' && outcome.value.status !== 'failed') {
              const exec = outcome.value;
              results[index] = { item: chunk[i], status: exec.status, executionId: exec._id, nodeResults: exec.nodeResults };
            } else {
              const message = outcome.status === 'fulfilled'
                ? (Object.values(outcome.value.errors)[0] || 'sub-workflow execution failed')
                : outcome.reason.message;
              results[index] = { item: chunk[i], status: 'error', error: message };
              if (!continueOnItemError) stop = true;
            }
          }
        }

        return { results };
      },
    });

    // Trigger manager
    this._triggers = new TriggerManager({
      onTrigger: (workflowId, triggerData) => {
        this.execute(workflowId, triggerData).catch(err => {
          console.error(`[Workflow] Auto-execution failed for ${workflowId}:`, err.message);
        });
      },
    });
  }

  /** Initialize vault */
  async init() {
    await this._vault.init();
    // Re-register triggers for active workflows
    const active = this._workflows.find({ active: true }).toArray();
    for (const wf of active) {
      if (wf.trigger && wf.trigger.type !== TriggerType.MANUAL) {
        this._triggers.register(wf._id, wf.trigger);
      }
    }
  }

  /** Start triggers (cron, polling) and the wait.until resume poller */
  start() {
    this._triggers.start();
    if (!this._waitTimer) {
      this._waitTimer = setInterval(() => this._pollWaitingExecutions(), this._waitPollInterval);
    }
  }

  /** Stop all triggers and the wait.until resume poller */
  stop() {
    this._triggers.stop();
    if (this._waitTimer) {
      clearInterval(this._waitTimer);
      this._waitTimer = null;
    }
  }

  // ─── CRUD ────────────────────────────────────────────────

  create(definition) {
    this._validateNodeIds(definition.nodes || []);

    const wf = this._workflows.insert({
      name: definition.name,
      description: definition.description || '',
      trigger: definition.trigger || { type: TriggerType.MANUAL },
      nodes: definition.nodes || [],
      active: definition.active !== false,
      settings: definition.settings || {},
      // Workflow id to run (with error context as trigger data) when THIS
      // workflow's execution ends with status 'failed'. Falls back to the
      // engine's opts.defaultErrorWorkflow when unset -- see execute().
      errorWorkflow: definition.errorWorkflow || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Register trigger if active and not manual
    if (wf.active && wf.trigger.type !== TriggerType.MANUAL) {
      this._triggers.register(wf._id, wf.trigger);
    }

    this.db.flush();
    return wf;
  }

  get(id) { return this._workflows.findById(id); }

  findByName(name) { return this._workflows.findOne({ name }); }

  list(filters = {}) {
    const filter = {};
    if (filters.active !== undefined) filter.active = filters.active;
    return this._workflows.find(filter).sort({ updatedAt: -1 }).toArray();
  }

  update(id, changes) {
    const wf = this._workflows.findById(id);
    if (!wf) throw new Error(`Workflow '${id}' not found`);

    // Validate node ids if nodes are being updated.
    if (changes.nodes !== undefined) {
      this._validateNodeIds(changes.nodes);
    }

    // Unregister old trigger
    this._triggers.unregister(id);

    const updates = {};
    for (const k of ['name', 'description', 'trigger', 'nodes', 'active', 'settings', 'errorWorkflow']) {
      if (changes[k] !== undefined) updates[k] = changes[k];
    }
    updates.updatedAt = Date.now();

    this._workflows.update({ _id: id }, { $set: updates });
    this.db.flush();

    // Re-register trigger if active
    const updated = this._workflows.findById(id);
    if (updated.active && updated.trigger.type !== TriggerType.MANUAL) {
      this._triggers.register(id, updated.trigger);
    }

    return updated;
  }

  remove(id) {
    this._triggers.unregister(id);
    this._workflows.removeById(id);
    this.db.flush();
  }

  toggle(id) {
    const wf = this._workflows.findById(id);
    if (!wf) throw new Error(`Workflow '${id}' not found`);
    return this.update(id, { active: !wf.active });
  }

  // ─── EXECUTION ───────────────────────────────────────────

  /**
   * Execute a workflow.
   * @param {string} id - Workflow ID
   * @param {object} triggerData - Data from trigger (webhook body, cron event, etc)
   * @returns {Promise<object>} Execution result
   */
  async execute(id, triggerData = {}) {
    const wf = this._workflows.findById(id);
    if (!wf) throw new Error(`Workflow '${id}' not found`);

    // Sub-workflow call chain, for the `workflow.execute` node's cycle
    // detection. Read from `triggerData._subWorkflowChain` (only present
    // when THIS execute() call was itself started by that node) rather
    // than instance state, so it's correctly scoped to each call's own
    // local closure -- concurrent unrelated top-level executions never
    // share or corrupt each other's chain. A root-triggered execute()
    // (webhook/cron/poll/manual/error-workflow) simply starts with [].
    const callChain = Array.isArray(triggerData?._subWorkflowChain) ? triggerData._subWorkflowChain : [];
    if (callChain.includes(id)) {
      throw new Error(`Circular sub-workflow reference: ${[...callChain, id].join(' -> ')}`);
    }
    const subWorkflowChain = [...callChain, id];

    const execution = {
      workflowId: id,
      workflowName: wf.name,
      trigger: triggerData,
      status: 'running',
      nodeResults: {},
      errors: {},
      startedAt: Date.now(),
      finishedAt: null,
      duration: null,
    };

    // Context: results from previous nodes accessible via {{nodeId.field}}
    const context = { _trigger: triggerData.data || triggerData };
    const nodes = wf.nodes || [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    // Levels of node ids that can run in parallel (see _buildWorkflowDAG).
    // A cycle (shouldn't happen — _validateNodeIds/the caller are expected
    // to produce a valid DAG) falls back to one node per level, i.e. the
    // old strictly-sequential order, rather than throwing.
    const levels = _buildWorkflowDAG(nodes) || nodes.map((n) => [n.id]);

    await this._runLevels(wf, execution, context, nodeMap, levels, 0, subWorkflowChain);

    return this._finalizeExecution(wf, execution, triggerData);
  }

  /**
   * Executes one node, retrying on failure per `node.retries` (default 0 --
   * no behavior change for any existing workflow) with exponential backoff
   * (`node.retryBackoffMs`, default 1000, doubled per attempt -- same
   * formula `core/queue.js` already uses). Only wraps the node's actual
   * operation, not surrounding config resolution (credential lookup/runIf
   * already happened by the time this is called) -- a missing credential
   * is a config error, not a transient one worth retrying. On final
   * failure, attaches `attempts` onto the thrown error so the caller can
   * record how many were made; on eventual success after >1 attempt,
   * records it into `retryAttempts` (keyed by nodeId) for the same reason.
   */
  async _executeNodeWithRetry(nodeId, node, resolvedInputs, creds, ctx, retryAttempts) {
    const maxAttempts = 1 + (node.retries || 0);
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this._nodeRegistry.execute(node.type, resolvedInputs, creds, ctx);
        if (attempt > 1) retryAttempts.set(nodeId, attempt);
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          const backoff = (node.retryBackoffMs ?? 1000) * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    lastErr.attempts = maxAttempts;
    throw lastErr;
  }

  /**
   * Runs `levels[startIndex..]` against `context`, mutating `execution` in
   * place (nodeResults/errors/status). Factored out of execute() so a
   * fresh run (startIndex 0) and _resumeExecution() (startIndex ==
   * wherever a wait previously paused) share the exact same dispatch logic.
   *
   * A `wait.until` node whose resumeAt is still in the future, or a
   * `wait.forWebhook` node (always), pauses: `execution.status` becomes
   * 'waiting' and `execution.waitState` records where/how to resume --
   * the caller must check for that before treating the execution as
   * finished (see _finalizeExecution).
   */
  async _runLevels(wf, execution, context, nodeMap, levels, startIndex, subWorkflowChain) {
    try {
      // Global skip barrier for `if` + `onFalse: 'skip'`, checked BETWEEN
      // levels. Nodes already dispatched in the same level as the `if` node
      // still run to completion even if the `if` evaluates false — there is
      // no meaningful way to "un-dispatch" independent work already in
      // flight in a real parallel executor (core/a2e.js's DAG has the same
      // property). Only nodes in levels that haven't started yet are
      // skipped. This preserves the historical "stop everything after"
      // outcome for skip-guarded side effects (they're always in a LATER
      // level, since they depend on the `if`'s result path or otherwise come
      // after it) while still parallelizing independent branches.
      let skipRemaining = false;
      let stopped = false;

      for (let levelIndex = startIndex; levelIndex < levels.length; levelIndex++) {
        if (skipRemaining || stopped) break;
        const level = levels[levelIndex];

        // Populated by _executeNodeWithRetry when a node needed more than
        // one attempt -- read back below to attach `attempts` to that
        // node's nodeResults entry (only when it actually retried).
        const retryAttempts = new Map();

        const settled = await Promise.allSettled(level.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (node.runIf && !this._evalRunIf(node.runIf, context)) return SKIPPED;
          const resolvedInputs = this._resolveInputs(node.inputs || {}, context);
          let creds = {};
          if (node.credentials) {
            creds = await this._vault.get(node.credentials);
            if (!creds) throw new Error(`Credential '${node.credentials}' not found`);
          }
          return this._executeNodeWithRetry(nodeId, node, resolvedInputs, creds, { callChain: subWorkflowChain }, retryAttempts);
        }));

        // A `wait.until`/`wait.forWebhook` node in this level pauses the
        // whole execution AFTER this level's results are committed --
        // checked below, alongside the existing skip/error commit loop,
        // not before it (same "same-level siblings already dispatched
        // still finish" philosophy as the `if` skip barrier).
        let pauseState = null; // null | { mode: 'time', resumeAt, nodeId } | { mode: 'webhook', secret, nodeId }

        // Commit in the level's (array-preserving) order for deterministic,
        // backward-compatible nodeResults regardless of settle order.
        for (let i = 0; i < level.length; i++) {
          const nodeId = level[i];
          const node = nodeMap.get(nodeId);
          const outcome = settled[i];

          if (outcome.status === 'fulfilled' && outcome.value === SKIPPED) {
            // runIf evaluated false -- deliberately not run, not an error.
            // context[nodeId] is intentionally left unset: any downstream
            // node referencing {{nodeId...}} resolves to undefined, same as
            // referencing a node that never ran for any other reason.
            execution.nodeResults[nodeId] = { status: 'skipped' };
          } else if (outcome.status === 'fulfilled') {
            const result = outcome.value;
            const nodeResult = (result != null && result.data !== undefined) ? result.data : result;
            context[nodeId] = nodeResult;
            execution.nodeResults[nodeId] = { status: 'success', data: nodeResult, duration: null };
            if (retryAttempts.has(nodeId)) execution.nodeResults[nodeId].attempts = retryAttempts.get(nodeId);

            if (node.type === 'if' && result === false && node.onFalse === 'skip') {
              skipRemaining = true;
            }
            if (node.type === 'wait.until' && typeof nodeResult?.resumeAt === 'number' && nodeResult.resumeAt > Date.now()) {
              pauseState = { mode: 'time', resumeAt: nodeResult.resumeAt, nodeId };
            }
            if (node.type === 'wait.forWebhook') {
              pauseState = { mode: 'webhook', secret: nodeResult?.secret ?? null, nodeId };
            }
          } else {
            const err = outcome.reason;
            execution.errors[nodeId] = err.message;
            execution.nodeResults[nodeId] = { status: 'error', error: err.message };
            if (err.attempts > 1) execution.nodeResults[nodeId].attempts = err.attempts;

            // Stop before the NEXT level unless this node has continueOnError.
            // Siblings already running in this same level are not aborted.
            if (!node.continueOnError) {
              execution.status = 'failed';
              stopped = true;
            }
          }
        }

        // A failure or a skip barrier in the SAME level takes priority
        // over pausing -- an execution that's already failed or been told
        // to stop everything should not be resurrected as 'waiting'.
        if (pauseState && !stopped && !skipRemaining) {
          execution.status = 'waiting';
          execution.waitState = { ...pauseState, remainingLevelIndex: levelIndex + 1, subWorkflowChain };
          return;
        }
      }

      if (execution.status === 'running') {
        execution.status = Object.keys(execution.errors).length > 0 ? 'partial' : 'success';
      }

    } catch (err) {
      execution.status = 'failed';
      execution.errors._engine = err.message;
    }
  }

  /**
   * Persists `execution`'s final (or paused) state. Handles both a
   * brand-new execution (no `_id` yet -- inserted) and a resumed one
   * (already has `_id` from its earlier 'waiting' insert -- updated in
   * place, never duplicated). Only fires the error workflow for a
   * genuinely finished (non-waiting) run.
   */
  _finalizeExecution(wf, execution, triggerData) {
    const isWaiting = execution.status === 'waiting';
    if (!isWaiting) {
      execution.finishedAt = Date.now();
      execution.duration = execution.finishedAt - execution.startedAt;
    }

    if (execution._id) {
      const updates = { status: execution.status, nodeResults: execution.nodeResults, errors: execution.errors };
      if (isWaiting) {
        updates.waitState = execution.waitState;
        this._executions.update({ _id: execution._id }, { $set: updates });
      } else {
        updates.finishedAt = execution.finishedAt;
        updates.duration = execution.duration;
        this._executions.update({ _id: execution._id }, { $set: updates, $unset: { waitState: 1 } });
      }
    } else {
      // Store execution history. insert() returns a CLONE with `_id`
      // assigned — it does not mutate the object passed in. Previously this
      // discarded that return value entirely, so callers got an execution
      // object with no `_id` back from execute()/run(), even though the
      // stored copy (reachable via getExecutions()) had a real one — making
      // getExecution(execution._id) unreachable from the return value of a
      // run you just triggered. Same pattern EntryService.create() already
      // uses correctly in core/cms.js.
      execution._id = this._executions.insert(execution)._id;
    }
    this.db.flush();

    if (!isWaiting) {
      this._maybeTriggerErrorWorkflow(wf, execution, triggerData);
    }

    return execution;
  }

  /**
   * Resumes a previously-paused ('waiting') execution from where it left
   * off. Rebuilds everything from the persisted execution document itself
   * (plus a fresh read of the workflow definition) rather than any
   * in-memory state -- this is what makes the pause genuinely survive a
   * process restart: a brand-new WorkflowEngine instance pointed at the
   * same DocStore can call this and continue correctly.
   *
   * @param {object} executionDoc
   * @param {*} [resumeData] - For a `wait.forWebhook` resume: whatever the
   *   caller of `resumeWebhook()` provided, becomes
   *   `{{waitNodeId.resumeData}}` for the rest of the workflow.
   */
  async _resumeExecution(executionDoc, resumeData) {
    const wf = this._workflows.findById(executionDoc.workflowId);
    if (!wf) {
      // The workflow was deleted while this execution was waiting -- fail
      // it explicitly instead of leaving it stuck in 'resuming' forever.
      const finishedAt = Date.now();
      this._executions.update({ _id: executionDoc._id }, {
        $set: {
          status: 'failed',
          errors: { ...(executionDoc.errors || {}), _engine: `Workflow '${executionDoc.workflowId}' no longer exists` },
          finishedAt,
          duration: finishedAt - executionDoc.startedAt,
        },
        $unset: { waitState: 1 },
      });
      this.db.flush();
      return;
    }

    const nodes = wf.nodes || [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const levels = _buildWorkflowDAG(nodes) || nodes.map((n) => [n.id]);

    // Reconstruct context the SAME way execute() builds it initially, plus
    // every already-completed node's result -- the persisted execution
    // document is the single source of truth; no separate serialized
    // context blob was ever stored.
    const context = { _trigger: executionDoc.trigger?.data || executionDoc.trigger };
    for (const [nodeId, result] of Object.entries(executionDoc.nodeResults || {})) {
      if (result.status === 'success') context[nodeId] = result.data;
    }

    const execution = { ...executionDoc, status: 'running' };
    const { remainingLevelIndex, subWorkflowChain, mode, nodeId: waitNodeId } = executionDoc.waitState;
    delete execution.waitState;

    // For a webhook-mode wait, the paused node's own committed result was
    // just a placeholder ({ resumedAt: null, resumeData: null }) -- now
    // that the resume has genuinely happened, replace it with the real
    // resume time and whatever data the caller of resumeWebhook() sent, so
    // downstream nodes referencing {{waitNodeId.resumeData}} see it.
    if (mode === 'webhook' && waitNodeId) {
      const resumedValue = { resumedAt: Date.now(), resumeData: resumeData ?? null };
      context[waitNodeId] = resumedValue;
      execution.nodeResults[waitNodeId] = { status: 'success', data: resumedValue, duration: null };
    }

    await this._runLevels(wf, execution, context, nodeMap, levels, remainingLevelIndex, subWorkflowChain || []);
    this._finalizeExecution(wf, execution, executionDoc.trigger);
  }

  /**
   * Scans for TIME-mode waiting executions whose resumeAt has passed and
   * resumes each fire-and-forget -- called on a timer started by
   * start()/stopped by stop(), mirroring core/cron.js's CronScheduler
   * start()/stop(). `wait.forWebhook` pauses (mode: 'webhook') are never
   * touched here; they only ever resume via an explicit resumeWebhook()
   * call. Same-process re-entrancy guard: flips status away from 'waiting'
   * synchronously (no `await` between the find and this update) before
   * resuming, so a slow resume overlapping the next tick can't double-fire.
   * A genuinely concurrent second PROCESS polling the same db is a
   * separate, unsolved class of gap -- the same one already documented
   * for core/db.js's single-process design.
   */
  _pollWaitingExecutions() {
    const due = this._executions.find({
      status: 'waiting',
      'waitState.mode': 'time',
      'waitState.resumeAt': { $lte: Date.now() },
    }).toArray();
    for (const execDoc of due) {
      const claimed = this._executions.update({ _id: execDoc._id, status: 'waiting' }, { $set: { status: 'resuming' } });
      if (!claimed) continue;
      this._resumeExecution({ ...execDoc, status: 'resuming' }).catch((err) => {
        console.error(`[Workflow] Resume failed for execution '${execDoc._id}':`, err.message);
      });
    }
    this.db.flush();
  }

  /**
   * Resumes an execution paused at a `wait.forWebhook` node -- the
   * counterpart to `webhookTrigger()` below, but for resuming an
   * already-running execution instead of starting a new one. Called from
   * `POST /api/workflows/resume/:execId` (routes/workflows.js).
   *
   * @param {string} executionId
   * @param {*} [data] - becomes `{{waitNodeId.resumeData}}` for the rest
   *   of the workflow.
   * @param {string} [providedSecret] - required to match the wait node's
   *   own `secret` input, if it set one.
   * @returns {string|null} workflowId on success; null when the execution
   *   doesn't exist, isn't waiting on a webhook, or the secret is wrong --
   *   same "don't leak which case" shape as fireWebhook()'s trigger check.
   */
  resumeWebhook(executionId, data, providedSecret) {
    const execDoc = this._executions.findById(executionId);
    if (!execDoc || execDoc.status !== 'waiting' || execDoc.waitState?.mode !== 'webhook') return null;

    const { secret } = execDoc.waitState;
    if (secret !== undefined && secret !== null && secret !== '') {
      if (providedSecret !== secret) return null;
    }

    const claimed = this._executions.update({ _id: executionId, status: 'waiting' }, { $set: { status: 'resuming' } });
    if (!claimed) return null; // already being resumed (or resumed) by another call
    this.db.flush();

    this._resumeExecution({ ...execDoc, status: 'resuming' }, data).catch((err) => {
      console.error(`[Workflow] Webhook resume failed for execution '${executionId}':`, err.message);
    });
    return execDoc.workflowId;
  }

  /**
   * Fires the failed workflow's `errorWorkflow` (or the engine's
   * `defaultErrorWorkflow` if it has none) -- fire-and-forget, the same
   * way webhook/cron/poll triggers themselves fire `execute()` without the
   * original caller awaiting it (see the trigger manager's `onTrigger`
   * above). Whoever called THIS `execute()` still gets its own execution
   * result back immediately; the error workflow runs independently after.
   *
   * The error workflow receives its error context as `{{_trigger...}}`:
   * `{{_trigger.workflow.name}}`, `{{_trigger.error.message}}`,
   * `{{_trigger.execution.id}}`, `{{_trigger.trigger}}` (the ORIGINAL
   * trigger data that started the failed run).
   */
  _maybeTriggerErrorWorkflow(wf, execution, triggerData) {
    if (execution.status !== 'failed') return;
    const errorWorkflowId = wf.errorWorkflow || this._defaultErrorWorkflow;
    if (!errorWorkflowId) return;
    if (errorWorkflowId === wf._id) return; // refuse the trivial direct self-loop

    // Bounds an A -> B -> A -> ... runaway chain (misconfigured error
    // workflows pointing at each other) without tracking full visited-set
    // history -- a depth cap is enough for a "chico, acotado" feature.
    const depth = (triggerData && typeof triggerData === 'object' && triggerData._errorDepth) || 0;
    if (depth >= 5) return;

    const errorContext = {
      _errorDepth: depth + 1,
      workflow: { id: wf._id, name: wf.name },
      execution: { id: execution._id, status: execution.status },
      error: {
        message: Object.values(execution.errors)[0] || 'Workflow execution failed',
        nodeErrors: execution.errors,
      },
      trigger: triggerData,
    };

    this.execute(errorWorkflowId, errorContext).catch((err) => {
      console.error(`[Workflow] Error workflow '${errorWorkflowId}' (for failed workflow '${wf._id}') itself failed:`, err.message);
    });
  }

  /** Manual trigger */
  async run(id, data = {}) {
    return this.execute(id, { trigger: 'manual', data });
  }

  /** Webhook trigger (called from HTTP route) */
  webhookTrigger(path, data, secret) {
    return this._triggers.fireWebhook(path, data, secret);
  }

  // ─── HISTORY ─────────────────────────────────────────────

  getExecutions(workflowId, limit = 50) {
    const filter = workflowId ? { workflowId } : {};
    return this._executions.find(filter).sort({ startedAt: -1 }).limit(limit).toArray();
  }

  getExecution(executionId) {
    return this._executions.findById(executionId);
  }

  purgeExecutions(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    const old = this._executions.find({ startedAt: { $lt: cutoff } }).toArray();
    for (const e of old) this._executions.removeById(e._id);
    this.db.flush();
    return old.length;
  }

  // ─── NODES & CREDENTIALS ────────────────────────────────

  /** Access node registry */
  get nodes() { return this._nodeRegistry; }

  /** Access credential vault */
  get vault() { return this._vault; }

  /** Access trigger manager */
  get triggers() { return this._triggers; }

  // ─── INTERNAL ──────────────────────────────────────────

  /**
   * Validate node ids in a workflow definition BEFORE it can be executed.
   * Rejects:
   *   - duplicate node ids (the second node would silently overwrite the
   *     first's result in the execution context, keyed by `node.id`)
   *   - the reserved id `_trigger` (collides with the trigger-data context key)
   * Throws a clear Error so create()/update() fail before persistence.
   */
  _validateNodeIds(nodes) {
    if (!Array.isArray(nodes)) return;
    const seen = new Set();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const id = node.id;
      if (id === undefined || id === null || id === '') continue;
      if (id === '_trigger') {
        throw new Error(`Workflow node id '_trigger' is reserved (collides with trigger data context key)`);
      }
      if (seen.has(id)) {
        throw new Error(`Workflow node id '${id}' is duplicated — node ids must be unique`);
      }
      seen.add(id);
    }
  }

  /**
   * Evaluate a node's `runIf` guard against the current context. Only
   * `{ equals: [a, b] }` is supported (a/b each resolved the same way
   * `inputs` values are -- can be a `{{ref}}` or a literal) -- enough to
   * drive N-way branching off a `switch` node's `matched` output without
   * growing this into a general expression language. Missing/malformed
   * `runIf` shapes default to true (run the node) rather than silently
   * skipping it.
   */
  _evalRunIf(runIf, context) {
    if (runIf.equals !== undefined) {
      const [a, b] = runIf.equals;
      return this._resolveValue(a, context) === this._resolveValue(b, context);
    }
    return true;
  }

  /**
   * Resolve {{nodeId.field}} and {{_trigger.field}} references in inputs.
   */
  _resolveInputs(inputs, context) {
    const resolved = {};
    for (const [key, value] of Object.entries(inputs)) {
      resolved[key] = this._resolveValue(value, context);
    }
    return resolved;
  }

  _resolveValue(value, context) {
    if (typeof value === 'string') {
      // Full reference: "{{n1.data}}" -> replace with actual value
      const fullMatch = value.match(/^\{\{([^}]+)\}\}$/);
      if (fullMatch) {
        return this._getFromContext(fullMatch[1], context);
      }
      // Inline interpolation: "Found {{n2.length}} items"
      return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
        const val = this._getFromContext(path, context);
        return val !== undefined ? (typeof val === 'object' ? JSON.stringify(val) : String(val)) : '';
      });
    }
    if (Array.isArray(value)) return value.map(v => this._resolveValue(v, context));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this._resolveValue(v, context);
      return out;
    }
    return value;
  }

  _getFromContext(path, context) {
    const parts = path.split('.');
    let current = context;
    for (const p of parts) {
      // Block prototype-chain traversal: never resolve `__proto__`,
      // `constructor` or `prototype` segments. A reference like
      // `{{__proto__.constructor.name}}` must not walk the prototype chain.
      if (p === '__proto__' || p === 'constructor' || p === 'prototype') {
        return undefined;
      }
      if (current == null) return undefined;
      current = current[p];
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// DAG SCHEDULING (ported from core/a2e.js's buildDAG, adapted to this
// engine's `{{nodeId.field}}` template references instead of a2e's
// `/workflow/<opId>` string convention)
// ---------------------------------------------------------------------------

/**
 * Groups a workflow's nodes into levels that can each run in parallel: a
 * node depends on every other node id referenced via `{{nodeId...}}` in its
 * `inputs` OR its `runIf` guard (a `{{_trigger...}}` reference is not a
 * dependency — trigger data is available from the start). A `switch` node
 * feeding a downstream node's `runIf: { equals: ['{{switchId}}', ...] }`
 * must be scheduled into an earlier level the same way an `inputs` reference
 * would, or the guard could evaluate before the switch has run. The
 * dependency detection here is workflow.js-specific (its `{{ref}}` template
 * convention); the actual level-scheduling algorithm (Kahn's) is shared with
 * core/a2e.js's DAG via `./dag.js` — see that module's doc comment for why
 * only THAT part is shared and not the dependency detection itself.
 *
 * @param {Array<{id: string, inputs?: object, runIf?: object}>} nodes
 * @returns {string[][]|null} Array of levels (each an array of node ids), or
 *   `null` if the inputs describe a cycle (caller falls back to sequential).
 */
function _buildWorkflowDAG(nodes) {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const deps = new Map(ids.map((id) => [id, new Set()]));

  for (const node of nodes) {
    const str = JSON.stringify({ inputs: node.inputs || {}, runIf: node.runIf || null });
    const refs = str.match(/\{\{([^}]+)\}\}/g) || [];
    for (const ref of refs) {
      const depId = ref.slice(2, -2).split('.')[0];
      if (depId !== '_trigger' && depId !== node.id && idSet.has(depId)) {
        deps.get(node.id).add(depId);
      }
    }
  }

  return buildLevels(ids, deps);
}
