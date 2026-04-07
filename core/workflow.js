/**
 * Workflow Engine
 * n8n-style workflow execution. Connects triggers → nodes → outputs.
 * Uses NodeRegistry for execution, TriggerManager for activation.
 * Zero dependencies.
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

// ---------------------------------------------------------------------------
// WORKFLOW ENGINE
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  /**
   * @param {import('./db.js').DocStore} db
   * @param {object} opts
   * @param {string} opts.masterKey - For credential vault
   * @param {NodeRegistry} opts.nodeRegistry - Custom node registry
   */
  constructor(db, opts = {}) {
    this.db = db;
    this._workflows = db.collection('_workflows');
    this._executions = db.collection('_executions');
    this._nodeRegistry = opts.nodeRegistry || new NodeRegistry();
    this._vault = new CredentialVault(db, opts.masterKey || 'default-key');

    try { this._workflows.createIndex('name'); } catch {}
    try { this._workflows.createIndex('active'); } catch {}
    try { this._executions.createIndex('workflowId'); } catch {}

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
    const wf = this._workflows.insert({
      name: definition.name,
      description: definition.description || '',
      trigger: definition.trigger || { type: TriggerType.MANUAL },
      nodes: definition.nodes || [],
      active: definition.active !== false,
      settings: definition.settings || {},
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

    // Unregister old trigger
    this._triggers.unregister(id);

    const updates = {};
    for (const k of ['name', 'description', 'trigger', 'nodes', 'active', 'settings']) {
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

    try {
      // Execute nodes sequentially (respecting order)
      for (const node of wf.nodes) {
        try {
          // Resolve inputs from context
          const resolvedInputs = this._resolveInputs(node.inputs || {}, context);

          // Get credentials if needed
          let creds = {};
          if (node.credentials) {
            creds = await this._vault.get(node.credentials);
            if (!creds) throw new Error(`Credential '${node.credentials}' not found`);
          }

          // Execute node
          const result = await this._nodeRegistry.execute(node.type, resolvedInputs, creds);

          // Store result in context for downstream nodes
          const nodeResult = (result != null && result.data !== undefined) ? result.data : result;
          context[node.id] = nodeResult;
          execution.nodeResults[node.id] = {
            status: 'success',
            data: context[node.id],
            duration: null,
          };

          // IF node: check condition and skip next nodes if needed
          if (node.type === 'if' && result === false && node.onFalse === 'skip') {
            break;
          }

        } catch (err) {
          execution.errors[node.id] = err.message;
          execution.nodeResults[node.id] = { status: 'error', error: err.message };

          // Stop on error unless node has continueOnError
          if (!node.continueOnError) {
            execution.status = 'failed';
            break;
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

    // Store execution history
    this._executions.insert(execution);
    this.db.flush();

    return execution;
  }

  /** Manual trigger */
  async run(id, data = {}) {
    return this.execute(id, { trigger: 'manual', data });
  }

  /** Webhook trigger (called from HTTP route) */
  webhookTrigger(path, data) {
    return this._triggers.fireWebhook(path, data);
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
      if (current == null) return undefined;
      current = current[p];
    }
    return current;
  }
}
