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
import { generateId, isInternalCollectionName, getTableSchema } from './db.js';
import { buildLevels } from './dag.js';

// Sentinel returned internally when a node's `runIf` guard evaluates false —
// distinguishes "deliberately skipped" from any real handler result
// (including `undefined`/`null`, which a handler can legitimately return).
const SKIPPED = Symbol('workflow-node-skipped');

// Job type this engine registers on `opts.executionQueue` (see the
// constructor and `_dispatchExecution` below). Namespaced so it doesn't
// collide with an application's own job types on a shared queue instance.
const EXECUTION_JOB_TYPE = 'akit:execute-workflow';

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
   * @param {object} [opts.executionQueue] - A `core/queue.js` `JobQueue` or
   *   `integrations/postgres-queue.js` `PostgresJobQueue` instance (both
   *   share the same `register`/`enqueue`/`start`/`stop` shape, used here
   *   duck-typed so either works transparently). When set, TRIGGER-fired
   *   executions (webhook/cron/poll) and error-workflow triggering are
   *   enqueued instead of run in-process directly, so any worker process
   *   sharing that queue (via `PostgresJobQueue`, genuinely multi-process/
   *   multi-machine) can pick them up -- real horizontal scaling for
   *   triggered load. Default unset: zero behavior change, everything
   *   runs in-process exactly as before. Deliberately does NOT affect
   *   `run()`/`retryExecution()`/`resumeWebhook()` (an explicit caller
   *   waiting for a real synchronous result) or the `workflow.execute`/
   *   `loop.forEach` nodes (a sub-workflow the parent must await directly)
   *   -- see `_dispatchExecution`'s doc comment. This distributes
   *   EXECUTION DISPATCH only; the underlying `db` (workflow/execution/
   *   credential storage) still needs to be genuinely shared for true
   *   multi-machine deployment (e.g. `integrations/postgres-collection.js`,
   *   not wired in here) -- a single-machine `FileStorageAdapter` on local
   *   disk works fine for multi-PROCESS scaling on one box, not multiple.
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

    // Instance-wide backpressure for FIRE-AND-FORGET dispatch (see
    // _dispatchExecution). Without a cap, N simultaneous webhook/cron/poll
    // firings started N simultaneous executions -- each resolving
    // credentials, issuing outbound fetches and writing to the DB -- with no
    // queue and no ceiling, so a burst degrades into a collapse rather than
    // into a slowdown. The optional `executionQueue` had a concurrency cap
    // but requires Postgres and is opt-in; the DEFAULT path had none at all.
    //
    // The default is a real number rather than "unlimited" on purpose: below
    // it nothing changes, and above it the behavior only changes in the
    // regime that was already broken. Set 0 to opt out entirely.
    this._maxConcurrentExecutions = opts.maxConcurrentExecutions ?? 100;
    // Overflow waits here instead of running. Bounded too: an unbounded
    // in-memory backlog is its own way to fall over, so past this the
    // dispatch REJECTS -- each caller already attaches a .catch that logs,
    // so shed load is visible rather than a silent OOM.
    this._maxQueuedExecutions = opts.maxQueuedExecutions ?? 1000;
    this._activeDispatched = 0;
    this._dispatchQueue = [];

    this._executionQueue = opts.executionQueue || null;
    if (this._executionQueue) {
      this._executionQueue.register(EXECUTION_JOB_TYPE, async (data) => {
        const result = await this.execute(data.workflowId, data.triggerData);
        // Deliberately a small summary, not the full result -- the real
        // record already lives in `_executions` (via _finalizeExecution,
        // same as any other execution), reachable through the normal
        // getExecution()/getExecutions() API regardless of whether this
        // ran via the queue or in-process. Keeps the queue's own `result`
        // column from bloating with potentially large nodeResults.
        return { executionId: result._id, status: result.status };
      });
    }

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
      // Found live (2026-08-03 full system test): this used to declare a
      // single `result` output field, but the handler below returns
      // { executionId, status, nodeResults } directly (no `data` key, so
      // _runLevels' unwrap doesn't apply and the whole object survives as
      // {{nodeId}}) -- there never was a `.result` field to reference.
      // Listing the real keys here instead of a wrong placeholder one.
      outputs: [
        { name: 'executionId', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'nodeResults', type: 'object' },
      ],
      handler: async (inputs, _credentials, ctx) => {
        const subTriggerData = {
          trigger: 'workflow',
          data: inputs.data || {},
          _subWorkflowChain: ctx?.callChain || [],
          // CORRECTNESS (2026-08-03, verified from a full-codebase audit
          // lead): this used to carry only the call chain, dropping
          // `_errorDepth`. _maybeTriggerErrorWorkflow reads the depth off the
          // triggerData it is handed, so every hop through a sub-workflow
          // reset it to 0 and the `depth >= 5` cap NEVER engaged. With `A`
          // failing into error workflow `B`, and `B` calling `A` back through
          // this node, that is an unbounded cascade: measured 6720 executions
          // of A in 20 seconds, stopped only by killing the process from
          // outside. (An in-process watchdog cannot even observe it -- the
          // cascade starves the event loop, so a setTimeout never fires.)
          _errorDepth: ctx?.errorDepth || 0,
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

    // 'data.table' node -- registered here (not in core/nodes.js's
    // engine-agnostic BUILTIN_NODES) because it needs live DB access, same
    // structural reason 'workflow.execute'/'loop.forEach' above need a live
    // engine. Reads/writes any DB collection directly -- the same data
    // exposed via GET/POST/PUT/DELETE /api/db/:col -- without a workflow
    // having to loop back through its own HTTP API (an http.request node
    // hitting /api/db/:col) just to touch a "data table" from within a run.
    // Mirrors that route's filter/sort/limit/offset shape and $-operator
    // filter convention (e.g. { field: { $gt: 5 } }) so the two stay
    // interchangeable in how a caller thinks about querying a collection.
    this._nodeRegistry.add({
      type: 'data.table',
      name: 'Data Table',
      category: 'core',
      description: 'Read or write a DB collection (find/insert/update/delete/count) -- the same data exposed at /api/db/:col',
      inputs: [
        { name: 'collection', type: 'string', required: true },
        { name: 'operation', type: 'string', required: true }, // find | insert | update | delete | count
        { name: 'filter', type: 'object', default: {} }, // find/update/delete/count
        { name: 'sort', type: 'object' }, // find, e.g. { createdAt: -1 }
        { name: 'limit', type: 'number', default: 50 }, // find, capped at 500
        { name: 'offset', type: 'number', default: 0 }, // find
        { name: 'data', type: 'any' }, // insert: a doc or array of docs. update: fields to $set
      ],
      // Output shape depends on operation:
      //  - find/insert: `{ data }` -- a `data` key on a handler's return
      //    value is unwrapped by _runLevels (same convention every other
      //    node relies on for {{nodeId}} to resolve directly to the useful
      //    payload, not {{nodeId.data}}), so {{nodeId}} IS the doc/array.
      //    Deliberately does NOT also return total/limit/offset/hasMore for
      //    'find' -- those would be silently discarded by that same
      //    unwrap (only the `data` key survives), which would be a worse
      //    trap than just not offering them; use operation: 'count' for a
      //    total.
      //  - update/delete/count: `{ count }`, no `data` key -- the unwrap
      //    only triggers when `result.data !== undefined`, so this object
      //    survives intact and {{nodeId.count}} works as expected.
      outputs: [
        { name: 'data', type: 'any' },
        { name: 'count', type: 'number' },
      ],
      handler: async (inputs) => {
        const collection = inputs.collection;
        if (!collection) throw new Error("data.table: 'collection' is required");
        // SECURITY (2026-08-03, full-codebase audit): this node is documented
        // as "the same data exposed at /api/db/:col", but it was strictly MORE
        // powerful -- `routes/collections.js` refuses internal (`_`-prefixed)
        // collections, this handler had no such check. Reproduced live: a user
        // with only the global `editor` role (enough to POST /api/workflows)
        // built a workflow whose first node read `_users` -- dumping every
        // passwordHash into the execution record, which is itself readable --
        // and whose second node set their own `role` to 'admin'. Also reachable
        // that way: `_credentials`(+`_credentials_meta`, the FieldCrypto salt),
        // `_sessions`, `_api_keys`, and `_workflows` itself (editing any
        // workflow, bypassing project gating). Uses the SAME shared
        // `isInternalCollectionName` the route uses, specifically so the two
        // surfaces can't drift apart again -- that drift is what made this a
        // second door to the same privilege escalation. Traversal is handled a
        // layer down by `assertSafeCollectionName` in `DocStore.collection()`.
        if (isInternalCollectionName(collection)) {
          throw new Error(`data.table: collection '${collection}' is internal system state and cannot be accessed from a workflow`);
        }
        // A collection with a registered schema is written through a
        // validating `Table`; one without behaves exactly as before. Reads go
        // to the raw collection either way -- validation is a write-time
        // concern, and routing reads through Table would change nothing except
        // adding a lookup. Same helper the /api/db routes use, so a collection
        // is typed for BOTH surfaces or for neither.
        const table = getTableSchema(this.db, collection);
        const col = this.db.collection(collection);
        const filter = inputs.filter || {};

        switch (inputs.operation) {
          case 'find': {
            let cursor = col.find(filter);
            if (inputs.sort) cursor = cursor.sort(inputs.sort);
            const limit = Math.min(inputs.limit ?? 50, 500);
            const offset = inputs.offset || 0;
            const data = cursor.skip(offset).limit(limit).toArray();
            return { data };
          }
          case 'insert': {
            const target = table || col;
            if (Array.isArray(inputs.data)) {
              const docs = inputs.data.map((d) => target.insert(d));
              this.db.flush();
              return { data: docs };
            }
            const doc = target.insert(inputs.data || {});
            this.db.flush();
            return { data: doc };
          }
          case 'update': {
            const count = (table || col).updateMany(filter, { $set: inputs.data || {} });
            this.db.flush();
            return { count };
          }
          case 'delete': {
            const count = col.removeMany(filter);
            this.db.flush();
            return { count };
          }
          case 'count': {
            return { count: col.count(filter) };
          }
          default:
            throw new Error(`data.table: unknown operation '${inputs.operation}' -- expected one of: find, insert, update, delete, count`);
        }
      },
    });

    // 'workflow.staticData' node -- registered here (not in core/nodes.js's
    // engine-agnostic BUILTIN_NODES) for the same "needs a live engine"
    // reason as 'workflow.execute'/'loop.forEach'/'data.table' above, plus
    // one more thing none of those need: knowing WHICH workflow is
    // currently running, with no id passed as an input. That id is the
    // last entry of ctx.callChain -- execute() always seeds
    // subWorkflowChain as `[...callChain, id]` (core/workflow.js's own
    // execute(), see its comment), so the last element is always the
    // current execution's own workflow id, root-triggered or not.
    // Persistent per-workflow scratch space -- e.g. a poll trigger's own
    // dedup cursor -- surviving across executions without a data.table
    // row. Stored directly on the workflow doc's `staticData` field
    // (default {}), deliberately NOT reachable through create()/update()'s
    // field whitelist -- this is engine/node-managed runtime state, not a
    // user-editable workflow property.
    this._nodeRegistry.add({
      type: 'workflow.staticData',
      name: 'Workflow Static Data',
      category: 'core',
      description: 'Read or write a small JSON scratch space tied to the current workflow, persisted across executions',
      inputs: [
        { name: 'action', type: 'string', required: true }, // get | set | merge
        { name: 'data', type: 'object' }, // set: replaces entirely. merge: shallow-merged in
      ],
      outputs: [{ name: 'data', type: 'object' }],
      handler: async (inputs, _credentials, ctx) => {
        const callChain = ctx?.callChain || [];
        const workflowId = callChain[callChain.length - 1];
        if (!workflowId) throw new Error('workflow.staticData: no current workflow id available');

        switch (inputs.action) {
          case 'get':
            return { data: this.getStaticData(workflowId) };
          case 'set':
            return { data: this.setStaticData(workflowId, inputs.data || {}) };
          case 'merge':
            return { data: this.mergeStaticData(workflowId, inputs.data || {}) };
          default:
            throw new Error(`workflow.staticData: unknown action '${inputs.action}' -- expected one of: get, set, merge`);
        }
      },
    });

    // Trigger manager
    this._triggers = new TriggerManager({
      onTrigger: (workflowId, triggerData) => {
        this._dispatchExecution(workflowId, triggerData).catch(err => {
          console.error(`[Workflow] Auto-execution failed for ${workflowId}:`, err.message);
        });
      },
      // A 'whenFinished' webhook needs the real execution result to answer
      // the still-open HTTP request with -- always direct/in-process
      // (execute(), never opts.executionQueue), since the caller is blocked
      // waiting for a real-time answer, not polling later. If execute()
      // itself rejects (e.g. the workflow was deleted mid-flight), that
      // rejection propagates to fireWebhook()'s caller to handle, same as
      // any other awaited call -- no swallowing here, unlike onTrigger's
      // fire-and-forget .catch() above.
      onWebhookSync: (workflowId, triggerData) => this.execute(workflowId, triggerData),
    });
  }

  /** Initialize vault (and the execution queue's tables, for PostgresJobQueue) */
  async init() {
    await this._vault.init();
    // PostgresJobQueue needs init() to create its tables; core/queue.js's
    // JobQueue has no init() at all -- duck-typed check, harmless either way.
    if (typeof this._executionQueue?.init === 'function') {
      await this._executionQueue.init();
    }
    // Re-register triggers for active workflows
    const active = this._workflows.find({ active: true }).toArray();
    for (const wf of active) {
      if (wf.trigger && wf.trigger.type !== TriggerType.MANUAL) {
        this._triggers.register(wf._id, wf.trigger);
      }
    }
  }

  /**
   * Fire-and-forget execution dispatch, shared by trigger firing and
   * error-workflow triggering (see both call sites) -- the two places
   * that never had an explicit caller waiting on the result even before
   * `executionQueue` existed. When `opts.executionQueue` is configured,
   * enqueues a job instead of running in-process directly; otherwise
   * (the default) calls `execute()` exactly as before. Returns whatever
   * the chosen path returns so each caller can attach its OWN `.catch()`
   * with a message specific to its own context (a genuinely failed
   * WORKFLOW never rejects this -- `execute()` resolves with `status:
   * 'failed'` for a node-level failure; only an unexpected exception, or
   * a failure to enqueue, reaches that `.catch()`).
   */
  _dispatchExecution(workflowId, triggerData) {
    if (this._executionQueue) {
      return Promise.resolve(this._executionQueue.enqueue(EXECUTION_JOB_TYPE, { workflowId, triggerData }));
    }

    // The cap lives HERE and deliberately NOT in execute(). execute() is also
    // how a `workflow.execute` / `loop.forEach` node runs a SUB-workflow from
    // inside an already-running execution, and how run()/retryExecution()/
    // resumeWebhook()/a `respond: 'whenFinished'` webhook run with a caller
    // awaiting the result. Gating execute() would let a parent hold a slot
    // while waiting for a child that can never get one -- a self-inflicted
    // deadlock. This path is the one with no caller waiting and the one an
    // external burst can actually flood, so it is the correct and safe place
    // to apply backpressure.
    if (this._maxConcurrentExecutions > 0 && this._activeDispatched >= this._maxConcurrentExecutions) {
      if (this._dispatchQueue.length >= this._maxQueuedExecutions) {
        return Promise.reject(new Error(
          `Execution backlog full (${this._dispatchQueue.length} queued, ${this._activeDispatched} running): refusing to dispatch workflow '${workflowId}'`
        ));
      }
      return new Promise((resolve, reject) => {
        this._dispatchQueue.push({ workflowId, triggerData, resolve, reject });
      });
    }
    return this._runDispatched(workflowId, triggerData);
  }

  /** @private Runs a dispatched execution while holding a concurrency slot. */
  _runDispatched(workflowId, triggerData) {
    this._activeDispatched++;
    return this.execute(workflowId, triggerData).finally(() => {
      this._activeDispatched--;
      this._drainDispatchQueue();
    });
  }

  /** @private Starts as many queued dispatches as there is now room for. */
  _drainDispatchQueue() {
    while (this._dispatchQueue.length > 0 &&
           (this._maxConcurrentExecutions <= 0 || this._activeDispatched < this._maxConcurrentExecutions)) {
      const next = this._dispatchQueue.shift();
      this._runDispatched(next.workflowId, next.triggerData).then(next.resolve, next.reject);
    }
  }

  /**
   * Live dispatch pressure, so an operator can see backpressure happening
   * instead of inferring it from latency. `queued > 0` means the cap is
   * actively holding work back.
   */
  executionStats() {
    return {
      running: this._activeDispatched,
      queued: this._dispatchQueue.length,
      maxConcurrent: this._maxConcurrentExecutions,
      maxQueued: this._maxQueuedExecutions,
    };
  }

  /** Start triggers (cron, polling), the wait.until resume poller, and the execution queue if configured */
  start() {
    this._triggers.start();
    if (!this._waitTimer) {
      this._waitTimer = setInterval(() => this._pollWaitingExecutions(), this._waitPollInterval);
    }
    this._executionQueue?.start();
  }

  /** Stop all triggers, the wait.until resume poller, and the execution queue if configured */
  stop() {
    this._triggers.stop();
    if (this._waitTimer) {
      clearInterval(this._waitTimer);
      this._waitTimer = null;
    }
    this._executionQueue?.stop();
  }

  // ─── CRUD ────────────────────────────────────────────────

  /**
   * @param {object} definition
   * @param {string} [createdBy] - Acting user's id, for attribution only
   *   (`createdBy`/`updatedBy` on the stored doc). A SEPARATE trailing
   *   param, deliberately never read from `definition` -- that object can
   *   come straight from an HTTP request body (routes/workflows.js), and a
   *   client-supplied `createdBy` would let a caller impersonate someone
   *   else. Callers pass the AUTHENTICATED caller's own id here instead.
   */
  create(definition, createdBy = null) {
    this._validateNodeIds(definition.nodes || []);

    const trigger = definition.trigger || { type: TriggerType.MANUAL };
    const active = definition.active !== false;
    // Reject a colliding webhook path/method BEFORE inserting anything, so a
    // rejected create() leaves nothing persisted (same "reject before
    // recording" precedent core/triggers.js's register() already follows
    // for a poller's SSRF-guarded URL). Without this, TriggerManager.
    // register()'s Map.set() would silently overwrite the earlier
    // workflow's entry, hijacking its webhook with zero warning anywhere --
    // the exact bug found live during a full system test (2026-08-03).
    if (active && trigger.type === TriggerType.WEBHOOK && this._triggers.webhookPathTaken(trigger, null)) {
      throw new Error(`Webhook path '${trigger.config?.path}' (${(trigger.config?.method || 'POST').toUpperCase()}) is already registered to another active workflow`);
    }

    const wf = this._workflows.insert({
      name: definition.name,
      description: definition.description || '',
      trigger,
      nodes: definition.nodes || [],
      active,
      settings: definition.settings || {},
      // Workflow id to run (with error context as trigger data) when THIS
      // workflow's execution ends with status 'failed'. Falls back to the
      // engine's opts.defaultErrorWorkflow when unset -- see execute().
      errorWorkflow: definition.errorWorkflow || null,
      // Organizational only (core/projects.js's ProjectManager owns the
      // actual Project/Folder records and role enforcement) -- opaque
      // strings here, not validated against ProjectManager, same as
      // `errorWorkflow` isn't validated against another workflow existing.
      projectId: definition.projectId || null,
      folderId: definition.folderId || null,
      createdBy,
      updatedBy: createdBy,
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
    if (filters.projectId !== undefined) filter.projectId = filters.projectId;
    if (filters.folderId !== undefined) filter.folderId = filters.folderId;
    return this._workflows.find(filter).sort({ updatedAt: -1 }).toArray();
  }

  /**
   * @param {string} id
   * @param {object} changes
   * @param {string} [updatedBy] - Acting user's id -- same "separate
   *   trailing param, never trusted from `changes`" reasoning as create()'s
   *   `createdBy`.
   */
  update(id, changes, updatedBy = null) {
    const wf = this._workflows.findById(id);
    if (!wf) throw new Error(`Workflow '${id}' not found`);

    // Validate node ids if nodes are being updated.
    if (changes.nodes !== undefined) {
      this._validateNodeIds(changes.nodes);
    }

    // Same collision guard as create() -- computed against the EFFECTIVE
    // post-update trigger/active (changes may touch either or neither),
    // excluding this workflow's own id so it can keep/reuse its own path.
    const effectiveTrigger = changes.trigger !== undefined ? changes.trigger : wf.trigger;
    const effectiveActive = changes.active !== undefined ? changes.active : wf.active;
    if (effectiveActive && effectiveTrigger?.type === TriggerType.WEBHOOK && this._triggers.webhookPathTaken(effectiveTrigger, id)) {
      throw new Error(`Webhook path '${effectiveTrigger.config?.path}' (${(effectiveTrigger.config?.method || 'POST').toUpperCase()}) is already registered to another active workflow`);
    }

    // Unregister old trigger
    this._triggers.unregister(id);

    const updates = {};
    for (const k of ['name', 'description', 'trigger', 'nodes', 'active', 'settings', 'errorWorkflow', 'projectId', 'folderId']) {
      if (changes[k] !== undefined) updates[k] = changes[k];
    }
    if (updatedBy !== null) updates.updatedBy = updatedBy;
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

  toggle(id, updatedBy = null) {
    const wf = this._workflows.findById(id);
    if (!wf) throw new Error(`Workflow '${id}' not found`);
    return this.update(id, { active: !wf.active }, updatedBy);
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

    const result = await this._runLevelsWithTimeout(wf, execution, context, nodeMap, levels, 0, subWorkflowChain);

    return this._finalizeExecution(wf, result, triggerData);
  }

  /**
   * Wraps `_runLevels` with an optional workflow-level execution timeout
   * (`wf.settings.executionTimeoutMs`, default off — zero behavior change
   * for every existing workflow, since `settings` was already a stored but
   * completely unused field). Found live (2026-08-03, n8n comparison): a
   * hung node handler (e.g. a custom node awaiting something that never
   * resolves) blocked the whole execution forever, with no engine-level
   * guard anywhere — `http.request`'s own 30s fetch timeout only covers
   * that one built-in node, nothing else.
   *
   * On timeout, this does NOT (cannot) truly cancel the in-flight
   * `_runLevels` call — JS has no real task cancellation, and forcing every
   * node handler to accept and honor an AbortSignal would be a much larger,
   * invasive contract change to every built-in and custom node. Instead:
   * from the CALLER's perspective the execution genuinely IS cut off —
   * `execute()`/`_resumeExecution()`/`retryExecution()` all return
   * immediately with a failed result — by racing a timer against the real
   * call and, if the timer wins, building a fully decoupled
   * `structuredClone` snapshot marked failed/`timedOut` instead of
   * mutating the shared `execution` object in place. The orphaned real
   * call keeps running in the background (unstoppable) and may keep
   * mutating the ORIGINAL `execution` object as it eventually finishes
   * levels, but nothing ever reads or re-persists that object again, so
   * the snapshot already handed to `_finalizeExecution` can't be corrupted
   * by it. Not retryable via `retryExecution()` afterward — no `failedAt`
   * level boundary was ever recorded, since the timeout didn't come from
   * `_runLevels`' own node-failure commit path.
   */
  async _runLevelsWithTimeout(wf, execution, context, nodeMap, levels, startIndex, subWorkflowChain) {
    const timeoutMs = wf.settings?.executionTimeoutMs;
    if (!(timeoutMs > 0)) {
      await this._runLevels(wf, execution, context, nodeMap, levels, startIndex, subWorkflowChain);
      return execution;
    }

    let timedOut = false;
    // Deliberately NOT unref()'d. Tried that first and it caused a genuine
    // hang, not just a harmless "don't keep the process alive" hint: when
    // this timer is the only thing pending (a bare `Promise.race` against a
    // truly-never-settling promise, e.g. an isolated script or a bun test
    // with nothing else scheduled), Bun treats an unref'd timer as nothing
    // to wait for and simply never fires its callback -- the exact
    // opposite of what an execution timeout must do. A normal ref'd timer
    // is safe here: it's short-lived (bounded by `timeoutMs`) and, in the
    // real running engine, plenty of other things (the wait-poller
    // setInterval, autosave) already keep the process alive regardless.
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
    });

    await Promise.race([
      this._runLevels(wf, execution, context, nodeMap, levels, startIndex, subWorkflowChain),
      timeoutPromise,
    ]);

    if (!timedOut) return execution;

    const snapshot = structuredClone(execution);
    snapshot.status = 'failed';
    snapshot.errors._engine = `Execution timed out after ${timeoutMs}ms (workflow settings.executionTimeoutMs)`;
    snapshot.timedOut = true;
    return snapshot;
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
          // `errorDepth` rides along with `callChain` so a sub-workflow call
          // can carry it forward -- see the workflow.execute handler and
          // _maybeTriggerErrorWorkflow for why losing it uncapped the cascade.
          return this._executeNodeWithRetry(nodeId, node, resolvedInputs, creds, { callChain: subWorkflowChain, errorDepth: execution.trigger?._errorDepth || 0 }, retryAttempts);
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
              // Recorded so retryExecution() knows where to resume -- the
              // level never fully committed, so `levelIndex` (not +1, unlike
              // waitState) is where a retry must re-dispatch from.
              execution.failedAt = { levelIndex, subWorkflowChain };
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
        // failedAt is set/cleared explicitly (rather than left to whatever
        // was already on the stored doc) because this branch runs on every
        // retryExecution() outcome too: a retry that fails again needs a
        // fresh failedAt (a later level may now be the failure point), and
        // a retry that finally succeeds must not leave a stale failedAt
        // behind implying the execution is still retryable.
        const unset = { waitState: 1 };
        if (execution.status === 'failed' && execution.failedAt) updates.failedAt = execution.failedAt;
        else unset.failedAt = 1;
        // Same explicit set/clear reasoning as failedAt above, for a
        // _runLevelsWithTimeout() snapshot's `timedOut` flag on a
        // resume()/retryExecution() outcome (an execute()-path timeout
        // always inserts fresh, carrying the field along automatically).
        if (execution.timedOut) updates.timedOut = true;
        else unset.timedOut = 1;
        this._executions.update({ _id: execution._id }, { $set: updates, $unset: unset });
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

    const result = await this._runLevelsWithTimeout(wf, execution, context, nodeMap, levels, remainingLevelIndex, subWorkflowChain || []);
    this._finalizeExecution(wf, result, executionDoc.trigger);
  }

  /**
   * Retries a FAILED execution, re-dispatching from the DAG level where it
   * failed (`executionDoc.failedAt`, recorded by `_runLevels` at the moment
   * a node failure stops the run) instead of re-triggering the whole
   * workflow from scratch. Re-runs that WHOLE level, including any sibling
   * node in it that had already succeeded -- the same level-boundary
   * granularity `_resumeExecution` already uses for a paused wait, not a
   * per-node cherry-pick. Context is rebuilt from every already-successful
   * `nodeResults` entry, same as `_resumeExecution`; only the failed
   * level's own error entries are cleared, so an unrelated `continueOnError`
   * failure recorded in an earlier level is preserved rather than silently
   * dropped by the retry.
   * @param {string} execId
   * @returns {Promise<object>} the updated execution
   */
  async retryExecution(execId) {
    const executionDoc = this._executions.findById(execId);
    if (!executionDoc) throw new Error(`Execution '${execId}' not found`);
    if (executionDoc.status !== 'failed') {
      throw new Error(`Execution '${execId}' has status '${executionDoc.status}', not 'failed' -- only a failed execution can be retried`);
    }
    if (!executionDoc.failedAt) {
      throw new Error(`Execution '${execId}' has no recorded failure point to retry from (an internal engine error, not a node failure, likely stopped it)`);
    }

    const wf = this._workflows.findById(executionDoc.workflowId);
    if (!wf) throw new Error(`Workflow '${executionDoc.workflowId}' no longer exists`);

    const nodes = wf.nodes || [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const levels = _buildWorkflowDAG(nodes) || nodes.map((n) => [n.id]);

    const context = { _trigger: executionDoc.trigger?.data || executionDoc.trigger };
    for (const [nodeId, result] of Object.entries(executionDoc.nodeResults || {})) {
      if (result.status === 'success') context[nodeId] = result.data;
    }

    const { levelIndex, subWorkflowChain } = executionDoc.failedAt;
    const failedLevelNodeIds = new Set(levels[levelIndex] || []);
    const errors = {};
    for (const [nodeId, message] of Object.entries(executionDoc.errors || {})) {
      if (!failedLevelNodeIds.has(nodeId)) errors[nodeId] = message;
    }

    const execution = { ...executionDoc, status: 'running', errors };
    delete execution.failedAt;

    const result = await this._runLevelsWithTimeout(wf, execution, context, nodeMap, levels, levelIndex, subWorkflowChain || []);
    this._finalizeExecution(wf, result, executionDoc.trigger);
    return result;
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
      // The depth cap above bounds a long chain of DISTINCT error workflows.
      // This bounds the far more likely shape -- an actual cycle -- using the
      // machinery execute() already has: appending the failing workflow to the
      // chain means an error workflow that calls back into it is refused with
      // `Circular sub-workflow reference` on the first lap rather than the
      // fifth. Previously the error hop was invisible to cycle detection
      // because no chain was passed at all.
      _subWorkflowChain: [...((triggerData && triggerData._subWorkflowChain) || []), wf._id],
      workflow: { id: wf._id, name: wf.name },
      execution: { id: execution._id, status: execution.status },
      error: {
        message: Object.values(execution.errors)[0] || 'Workflow execution failed',
        nodeErrors: execution.errors,
      },
      trigger: triggerData,
    };

    this._dispatchExecution(errorWorkflowId, errorContext).catch((err) => {
      console.error(`[Workflow] Error workflow '${errorWorkflowId}' (for failed workflow '${wf._id}') itself failed:`, err.message);
    });
  }

  /** Manual trigger */
  async run(id, data = {}) {
    return this.execute(id, { trigger: 'manual', data });
  }

  /** Webhook trigger (called from HTTP route) */
  webhookTrigger(path, data, secret, method) {
    return this._triggers.fireWebhook(path, data, secret, method);
  }

  // ─── STATIC DATA ─────────────────────────────────────────
  //
  // Small persistent JSON scratch space tied to a workflow, surviving
  // across executions -- e.g. a poll trigger's own dedup cursor, without
  // needing a separate data.table row. Stored directly on the workflow
  // document; last-write-wins, no locking, same concurrency guarantee an
  // in-process single-writer trigger/node already has in practice. Also
  // reachable from inside a run via the 'workflow.staticData' node.

  getStaticData(workflowId) {
    const wf = this._workflows.findById(workflowId);
    if (!wf) throw new Error(`Workflow '${workflowId}' not found`);
    return wf.staticData || {};
  }

  setStaticData(workflowId, data) {
    if (!this._workflows.findById(workflowId)) throw new Error(`Workflow '${workflowId}' not found`);
    const next = data || {};
    this._workflows.update({ _id: workflowId }, { $set: { staticData: next } });
    this.db.flush();
    return next;
  }

  mergeStaticData(workflowId, partial) {
    const current = this.getStaticData(workflowId);
    return this.setStaticData(workflowId, { ...current, ...(partial || {}) });
  }

  // ─── HISTORY ─────────────────────────────────────────────

  /**
   * @param {string} [workflowId]
   * @param {number} [limit]
   * @param {object} [opts]
   * @param {string} [opts.status] - e.g. 'failed', to find retryable
   *   executions without fetching everything and filtering client-side.
   *   Added as a 3rd param (not folded into an opts-only signature) to
   *   keep every existing positional (workflowId, limit) call working
   *   unchanged.
   */
  getExecutions(workflowId, limit = 50, opts = {}) {
    const filter = workflowId ? { workflowId } : {};
    if (opts.status) filter.status = opts.status;
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
      // CORRECTNESS (2026-08-03, verified from a full-codebase audit lead):
      // this used to `continue` past a missing id, validating nothing. The
      // consequences were silent and severe: `_buildWorkflowDAG` put every
      // id-less node in one level under the key `undefined`, `nodeMap`
      // collapsed them to the LAST one, and results were indexed positionally
      // against a level holding the same key twice. Reproduced with two
      // id-less nodes: the first node's handler NEVER ran, the second's ran
      // TWICE, `nodeResults` had a single `"undefined"` key, and the execution
      // reported `success` with no errors. A node with a real side effect
      // could therefore be skipped and another double-charged, invisibly.
      //
      // An id is not optional in this engine: it is the {{ref}} name, the DAG
      // vertex, and the nodeResults key. Refusing at create()/update() time is
      // the only place that can fail loudly -- `routes/workflows.js`'s
      // CreateSchema declares `nodes` as a bare array and cannot express a
      // per-node requirement, so the HTTP surface relies on this check too.
      if (id === undefined || id === null || id === '') {
        throw new Error('Every workflow node needs a non-empty `id` — it is the {{ref}} name, the DAG vertex and the nodeResults key');
      }
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
/**
 * Extracts the set of node ids referenced via `{{ref...}}` in a node's
 * `inputs`/`runIf` (excluding `{{_trigger...}}` and self-references, same
 * exclusions `_buildWorkflowDAG` always applied inline). Factored out so
 * `_buildWorkflowDAG` (runtime scheduling) and `validateWorkflowDefinition`
 * (authoring-time lint, below) share exactly one definition of what counts
 * as a `{{ref}}` — including references to ids that don't exist in the
 * workflow, which the caller decides how to treat (silently dropped for
 * scheduling, flagged as an error for linting).
 * @param {{id: string, inputs?: object, runIf?: object}} node
 * @returns {Set<string>}
 */
function _extractNodeRefs(node) {
  const str = JSON.stringify({ inputs: node.inputs || {}, runIf: node.runIf || null });
  const refs = str.match(/\{\{([^}]+)\}\}/g) || [];
  const ids = new Set();
  for (const ref of refs) {
    const depId = ref.slice(2, -2).split('.')[0];
    if (depId !== '_trigger' && depId !== node.id) ids.add(depId);
  }
  return ids;
}

function _buildWorkflowDAG(nodes) {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const deps = new Map(ids.map((id) => [id, new Set()]));

  for (const node of nodes) {
    for (const depId of _extractNodeRefs(node)) {
      if (idSet.has(depId)) deps.get(node.id).add(depId);
    }
  }

  return buildLevels(ids, deps);
}

/**
 * Authoring-time lint for a workflow's node list — the counterpart to
 * `_buildWorkflowDAG`'s runtime scheduling, meant to be run BEFORE a real
 * execution instead of discovering these the hard way mid-run. Catches
 * classes of mistake `_buildWorkflowDAG` silently tolerates today:
 *
 *  - A `{{ref}}` pointing at a node id that doesn't exist in this workflow
 *    (typo, or a node that got deleted) — silently ignored by
 *    `_buildWorkflowDAG` (never becomes a real dependency), and the
 *    templated value never resolves at runtime either.
 *  - Two nodes sharing the same `id` — `nodeMap`/`context` are keyed by
 *    id, so one silently shadows the other at execution time.
 *  - A dependency cycle — `_buildWorkflowDAG` returns `null` on a cycle
 *    and the engine silently falls back to a one-node-per-level, strictly
 *    sequential order, with no indication anything was wrong.
 *
 * Also surfaces, as warnings (not errors, since it may be intentional),
 * every `wait.*` node's computed DAG level and which later levels it will
 * pause — the exact ordering gotcha found in a real live-tested workflow:
 * a `wait.forWebhook`/`wait.until` node pauses ALL levels after its own
 * once it actually waits, regardless of whether those levels are
 * logically related to it, so an agent needs to see this laid out before
 * running the workflow for real, not discover it after a run pauses
 * somewhere unexpected.
 *
 * @param {Array<{id:string, type:string, inputs?:object, runIf?:object}>} nodes
 * @returns {{ valid: boolean, errors: string[], warnings: string[], levels: Array<Array<{id:string,type:string}>> }}
 */
export function validateWorkflowDefinition(nodes) {
  nodes = nodes || [];
  const errors = [];
  const warnings = [];
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);

  // Duplicate ids and the reserved `_trigger` id are also hard-blocked by
  // `_validateNodeIds` at create()/update() time (same wording) -- surfaced
  // here too so POST /api/workflows/validate gives the same signal on a
  // raw, not-yet-created definition instead of only failing on submit.
  const seenIds = new Set();
  for (const id of ids) {
    if (id === '_trigger') {
      errors.push(`Workflow node id '_trigger' is reserved (collides with trigger data context key)`);
    } else if (seenIds.has(id)) {
      errors.push(`Workflow node id '${id}' is duplicated — node ids must be unique`);
    }
    seenIds.add(id);
  }

  const deps = new Map(ids.map((id) => [id, new Set()]));
  for (const node of nodes) {
    for (const depId of _extractNodeRefs(node)) {
      if (idSet.has(depId)) {
        deps.get(node.id).add(depId);
      } else {
        errors.push(`Node '${node.id}' references '{{${depId}...}}' but no node with id '${depId}' exists in this workflow — this reference will never resolve`);
      }
    }
  }

  const builtLevels = buildLevels(ids, deps);
  if (builtLevels === null) {
    errors.push('Circular dependency detected among node references — the engine would silently fall back to running every node one at a time in array order instead of the intended dependency order');
  }

  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  const levels = (builtLevels || nodes.map((n) => [n.id])).map((level) =>
    level.map((id) => ({ id, type: typeById.get(id) }))
  );

  levels.forEach((level, levelIndex) => {
    const waitNode = level.find((n) => n.type === 'wait.until' || n.type === 'wait.forWebhook');
    if (waitNode && levelIndex < levels.length - 1) {
      warnings.push(`Node '${waitNode.id}' (${waitNode.type}) is in DAG level ${levelIndex} — if it actually pauses at runtime, every node in level ${levelIndex + 1} onward will NOT run until the execution is resumed, even if they're unrelated to this wait`);
    }
  });

  return { valid: errors.length === 0, errors, warnings, levels };
}
