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
   */
  constructor(db, opts = {}) {
    this.db = db;
    this._workflows = db.collection('_workflows');
    this._executions = db.collection('_executions');
    this._nodeRegistry = opts.nodeRegistry || new NodeRegistry();
    this._vault = new CredentialVault(db, opts.masterKey || _generateMasterKey());
    this._defaultErrorWorkflow = opts.defaultErrorWorkflow || null;

    try { this._workflows.createIndex('name'); } catch {}
    try { this._workflows.createIndex('active'); } catch {}
    try { this._executions.createIndex('workflowId'); } catch {}

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

  /** Start triggers (cron, polling) */
  start() { this._triggers.start(); }

  /** Stop all triggers */
  stop() { this._triggers.stop(); }

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

    try {
      // Levels of node ids that can run in parallel (see _buildWorkflowDAG).
      // A cycle (shouldn't happen — _validateNodeIds/the caller are expected
      // to produce a valid DAG) falls back to one node per level, i.e. the
      // old strictly-sequential order, rather than throwing.
      const levels = _buildWorkflowDAG(nodes) || nodes.map((n) => [n.id]);

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

      for (const level of levels) {
        if (skipRemaining || stopped) break;

        const settled = await Promise.allSettled(level.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (node.runIf && !this._evalRunIf(node.runIf, context)) return SKIPPED;
          const resolvedInputs = this._resolveInputs(node.inputs || {}, context);
          let creds = {};
          if (node.credentials) {
            creds = await this._vault.get(node.credentials);
            if (!creds) throw new Error(`Credential '${node.credentials}' not found`);
          }
          return this._nodeRegistry.execute(node.type, resolvedInputs, creds, { callChain: subWorkflowChain });
        }));

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

            if (node.type === 'if' && result === false && node.onFalse === 'skip') {
              skipRemaining = true;
            }
          } else {
            const err = outcome.reason;
            execution.errors[nodeId] = err.message;
            execution.nodeResults[nodeId] = { status: 'error', error: err.message };

            // Stop before the NEXT level unless this node has continueOnError.
            // Siblings already running in this same level are not aborted.
            if (!node.continueOnError) {
              execution.status = 'failed';
              stopped = true;
            }
          }
        }
      }

      if (execution.status === 'running') {
        execution.status = Object.keys(execution.errors).length > 0 ? 'partial' : 'success';
      }

    } catch (err) {
      execution.status = 'failed';
      execution.errors._engine = err.message;
    }

    execution.finishedAt = Date.now();
    execution.duration = execution.finishedAt - execution.startedAt;

    // Store execution history. insert() returns a CLONE with `_id`
    // assigned — it does not mutate the object passed in. Previously this
    // discarded that return value entirely, so callers got an execution
    // object with no `_id` back from execute()/run(), even though the
    // stored copy (reachable via getExecutions()) had a real one — making
    // getExecution(execution._id) unreachable from the return value of a
    // run you just triggered. Same pattern EntryService.create() already
    // uses correctly in core/cms.js.
    execution._id = this._executions.insert(execution)._id;
    this.db.flush();

    this._maybeTriggerErrorWorkflow(wf, execution, triggerData);

    return execution;
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
