/**
 * A2E Workflow Executor
 * Agent-to-Execution protocol — JS port. Zero dependencies.
 * 19 operations, DAG parallel execution, middleware, onError fallback.
 *
 * Formats: Compact JSON and JSONL (legacy).
 *
 * Usage:
 *   const executor = new WorkflowExecutor();
 *   executor.load({ operations: [...], execute: 'op1' });
 *   const result = await executor.execute();
 */

import { assertPublicUrl } from './net-guard.js';
import { buildLevels } from './dag.js';

// ---------------------------------------------------------------------------
// DATA MODEL — path get/set
// ---------------------------------------------------------------------------

function getPath(state, path) {
  if (!path || typeof path !== 'string') return undefined;
  const parts = path.replace(/^\//, '').split('/');
  let current = state;
  for (const p of parts) {
    if (current == null) return undefined;
    // Array index
    if (/^\d+$/.test(p)) current = current[parseInt(p)];
    else current = current[p];
  }
  return current;
}

function setPath(state, path, value) {
  if (!path || typeof path !== 'string') return;
  const parts = path.replace(/^\//, '').split('/');
  let current = state;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    if (current[p] == null) {
      current[p] = /^\d+$/.test(next) ? [] : {};
    }
    current = current[p];
  }
  const last = parts[parts.length - 1];
  current[last] = value;
}

/** Resolve {/path/ref} in strings */
function resolvePath(state, value) {
  if (typeof value === 'string') {
    // Full path reference
    if (value.startsWith('/')) return getPath(state, value);
    // Inline references: "Hello {/workflow/name}"
    return value.replace(/\{(\/[^}]+)\}/g, (_, p) => {
      const v = getPath(state, p);
      return v !== undefined ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : '';
    });
  }
  if (Array.isArray(value)) return value.map(v => resolvePath(state, v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePath(state, v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// DAG — topological sort for parallel execution
// ---------------------------------------------------------------------------

function buildDAG(operations) {
  const graph = new Map(); // opId -> Set<depId>
  const opMap = new Map();

  for (const op of operations) {
    opMap.set(op.id, op);
    graph.set(op.id, new Set());
  }

  // Scan configs for /workflow/<opId> references
  for (const op of operations) {
    const configStr = JSON.stringify(op);
    const refs = configStr.match(/\/workflow\/([a-zA-Z0-9_-]+)/g) || [];
    for (const ref of refs) {
      const depId = ref.split('/')[2];
      if (depId !== op.id && opMap.has(depId)) {
        // FIX-24: model onError as a real dependency edge. Previously the
        // onError target was excluded as a dependency, so an op that referenced
        // its own fallback's outputPath ran in parallel with the fallback and
        // could read that path before the fallback resolved (silent undefined).
        // The fallback always executes as a normal op in its own DAG level, so
        // depending on it is safe and does not deadlock; any genuine cycle falls
        // back to sequential execution (buildDAG returns null).
        graph.get(op.id).add(depId);
      }
    }
    // Explicit input reference
    if (op.input && opMap.has(op.input)) {
      graph.get(op.id).add(op.input);
    }
    // FIX-24: model Conditional branches as dependency edges. The branch op
    // (ifTrue/ifFalse) is executed dynamically by the Conditional, but the DAG
    // never saw it as a dependency, so the branch could be scheduled in an
    // earlier level — in parallel with / before the Conditional that triggers
    // it — racing on shared state. Make the branch depend on the Conditional
    // so it always runs after the Conditional resolves. Self-branches are
    // skipped to avoid self-edges (handled by the recursion-depth guard).
    if (op.type === 'Conditional' && op.config) {
      for (const branchId of [op.config.ifTrue, op.config.ifFalse]) {
        if (typeof branchId === 'string' && branchId !== op.id && opMap.has(branchId)) {
          graph.get(branchId).add(op.id);
        }
      }
    }
  }

  // Level-scheduling (Kahn's algorithm) is shared with core/workflow.js's DAG
  // via ./dag.js — see that module's doc comment for why only the scheduler
  // is shared and not this file's own /workflow/<opId> + onError + Conditional
  // dependency detection above.
  return buildLevels(operations.map((op) => op.id), graph);
}

/**
 * Ids declared as the ifTrue/ifFalse branch target of some Conditional
 * operation in `operations`, excluding self-references (an op whose own id
 * is its own branch target must stay reachable via the normal blanket
 * dispatch — nothing else invokes it the first time).
 *
 * These ids already get their own DAG level (they depend on their
 * Conditional, see the FIX-24 edge above), but they must never be
 * blanket-dispatched by execute()'s per-level / sequential-fallback loop —
 * they should run only when the Conditional that references them actually
 * resolves to that branch, via the existing dynamic
 * `_executeOp(result.executeOperationId, ...)` call. Excluding them here is
 * what makes the untaken branch never execute; as a side effect it also
 * stops the TAKEN branch from being invoked a second, redundant time
 * (previously: once via that dynamic call, once again via blanket dispatch
 * once its own DAG level was reached).
 *
 * @param {Array<{id: string, type: string, config?: object}>} operations
 * @returns {Set<string>}
 */
function conditionalBranchTargets(operations) {
  const targets = new Set();
  for (const op of operations) {
    if (op.type !== 'Conditional' || !op.config) continue;
    for (const branchId of [op.config.ifTrue, op.config.ifFalse]) {
      if (typeof branchId === 'string' && branchId !== op.id) targets.add(branchId);
    }
  }
  return targets;
}

/**
 * Ids referenced in the `config.operations` array of any `Loop` operation in
 * `operations`, excluding self-references (same rationale as
 * conditionalBranchTargets's self-reference exclusion).
 *
 * These ids are meant to run ONLY once per iteration, dispatched by
 * `_executeLoop`'s own `_executeOp(subOpId, 'loop', depth + 1)` call. Unlike
 * Conditional's branch targets, buildDAG models no dependency edge for these
 * ids — a Loop's sub-op ids float free into whatever DAG level their own
 * /workflow/ references put them in. Excluding them here is what stops them
 * from ALSO being dispatched independently by execute()'s blanket per-level /
 * sequential-fallback dispatch, in addition to their real per-iteration
 * dispatch — the same bug class already fixed for Conditional branches, just
 * for Loop.
 */
function loopSubOperationTargets(operations) {
  const targets = new Set();
  for (const op of operations) {
    if (op.type !== 'Loop' || !op.config) continue;
    for (const subOpId of op.config.operations || []) {
      if (typeof subOpId === 'string' && subOpId !== op.id) targets.add(subOpId);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// COMPACT FORMAT PARSER
// ---------------------------------------------------------------------------

function parseCompact(input) {
  const operations = [];
  for (const op of input.operations || []) {
    const { id, op: opType, input: inputRef, ...config } = op;
    // Default outputPath
    if (!config.outputPath) config.outputPath = `/workflow/${id}`;
    // Input shorthand
    if (inputRef && !config.inputPath) config.inputPath = `/workflow/${inputRef}`;
    operations.push({ id, type: opType, config, onError: op.onError });
  }
  return { operations, execute: input.execute };
}

/** Parse JSONL format */
function parseJSONL(lines) {
  const operations = [];
  let execute = null;
  for (const line of lines) {
    if (line.operationUpdate) {
      for (const op of line.operationUpdate.operations || []) {
        const opType = Object.keys(op.operation || {})[0];
        const config = op.operation[opType] || {};
        if (!config.outputPath) config.outputPath = `/workflow/${op.id}`;
        operations.push({ id: op.id, type: opType, config, onError: op.onError });
      }
    }
    if (line.beginExecution) execute = line.beginExecution.root;
  }
  return { operations, execute };
}

// ---------------------------------------------------------------------------
// OPERATION HANDLERS (19 operations)
// ---------------------------------------------------------------------------

// ─── API ───

async function handleApiCall(config, state) {
  const url = resolvePath(state, config.url);
  const method = (config.method || 'GET').toUpperCase();
  const headers = resolvePath(state, config.headers || {});
  const body = config.body ? resolvePath(state, config.body) : undefined;

  if (!headers['Content-Type'] && body) headers['Content-Type'] = 'application/json';

  const opts = { method, headers };
  if (body && !['GET', 'HEAD'].includes(method)) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // SSRF guard: reject loopback / private / link-local / metadata destinations
  // before the fetch. config.url may come from an untrusted workflow definition
  // or be resolved from external trigger state. Same guard as core/nodes.js.
  assertPublicUrl(url);

  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return data;
}

async function handleExecuteN8nWorkflow(config, state) {
  const n8nUrl = config.n8nUrl || process.env.N8N_URL || 'http://localhost:5678';
  // API key is taken ONLY from the environment / vault, never from the
  // operation config. config.n8nUrl may be attacker-controlled; reading the
  // key from config.* would let a leaked key be sent to an attacker host.
  const apiKey = process.env.N8N_API_KEY || '';
  const payload = config.payload ? resolvePath(state, config.payload) : {};

  // SSRF guard: reject internal destinations before the fetch. NOTE: this also
  // blocks the historical default `http://localhost:5678`. Operators who run a
  // co-located n8n must now expose it via a public N8N_URL; see FIX-11 report.
  assertPublicUrl(n8nUrl);

  const res = await fetch(`${n8nUrl}/api/v1/workflows/${config.workflowId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey },
    body: JSON.stringify({ data: payload }),
  });
  return await res.json();
}

// ─── DATA ───

function handleFilterData(config, state) {
  const data = getPath(state, config.inputPath);
  if (data === undefined) throw new Error(`FilterData: input path not found: ${config.inputPath}`);
  if (!Array.isArray(data)) throw new Error('FilterData: input must be an array');
  return data.filter(item => {
    for (const cond of config.conditions || []) {
      const val = item[cond.field];
      if (!evalCondition(val, cond.operator, cond.value)) return false;
    }
    return true;
  });
}

function handleTransformData(config, state) {
  const data = getPath(state, config.inputPath);
  switch (config.transform) {
    case 'map': return (data || []).map(item => {
      const out = {};
      for (const f of config.fields || []) out[f] = item[f];
      return out;
    });
    case 'sort': {
      const arr = [...(data || [])];
      const field = config.field || config.sortField;
      arr.sort((a, b) => a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0);
      return config.reverse ? arr.reverse() : arr;
    }
    case 'pick': {
      const out = {};
      for (const f of config.fields || []) out[f] = data?.[f];
      return out;
    }
    case 'flatten': return (data || []).flat();
    case 'group': {
      const groups = {};
      for (const item of data || []) {
        const key = String(item[config.field] ?? '_null');
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      }
      return groups;
    }
    case 'unique': {
      const seen = new Set();
      return (data || []).filter(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    case 'reverse': return [...(data || [])].reverse();
    case 'slice': return (data || []).slice(config.start || 0, config.end);
    default: return data;
  }
}

function handleMergeData(config, state) {
  const sources = (config.sources || []).map(s => getPath(state, s));
  switch (config.strategy) {
    case 'concat': return sources.reduce((acc, s) => [...acc, ...(Array.isArray(s) ? s : [s])], []);
    case 'merge': return Object.assign({}, ...sources.map(s => typeof s === 'object' && !Array.isArray(s) ? s : {}));
    case 'intersect': {
      if (sources.length < 2) return sources[0] || [];
      const sets = sources.map(s => new Set((Array.isArray(s) ? s : []).map(JSON.stringify)));
      const first = sources[0] || [];
      return first.filter(item => sets.every(set => set.has(JSON.stringify(item))));
    }
    case 'union': {
      const seen = new Set();
      const result = [];
      for (const s of sources) {
        for (const item of Array.isArray(s) ? s : []) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) { seen.add(key); result.push(item); }
        }
      }
      return result;
    }
    default: throw new Error(`MergeData: unknown strategy '${config.strategy}'`);
  }
}

function handleStoreData(config, state) {
  const data = getPath(state, config.inputPath);
  setPath(state, `/store/${config.key}`, data);
  return true;
}

function handleSetData(config) {
  return config.value;
}

// ─── DATETIME ───

function handleDateTime(config, state) {
  switch (config.mode) {
    case 'now': return formatDate(new Date(), config);
    case 'convert': {
      const input = getPath(state, config.input || config.inputPath);
      const date = parseDate(input);
      return formatDate(date, config);
    }
    case 'calculate': {
      const input = getPath(state, config.input || config.inputPath);
      const date = parseDate(input);
      const ms = calcDelta(config);
      const op = config.operation === 'subtract' ? -1 : 1;
      return formatDate(new Date(date.getTime() + op * ms), config);
    }
    default: return formatDate(new Date(), config);
  }
}

function handleGetCurrentDateTime(config) {
  return formatDate(new Date(), config);
}

function handleConvertTimezone(config, state) {
  const input = getPath(state, config.inputPath);
  const date = parseDate(input);
  return formatDate(date, { ...config, timezone: config.toTimezone });
}

function handleDateCalculation(config, state) {
  const input = getPath(state, config.inputPath);
  const date = parseDate(input);
  const ms = calcDelta(config);
  const op = config.operation === 'subtract' ? -1 : 1;
  return formatDate(new Date(date.getTime() + op * ms), config);
}

// ─── TEXT ───

function handleFormatText(config, state) {
  const text = String(getPath(state, config.inputPath) ?? '');
  switch (config.format) {
    case 'upper': return text.toUpperCase();
    case 'lower': return text.toLowerCase();
    case 'title': return text.replace(/\b\w/g, c => c.toUpperCase());
    case 'capitalize': return text.charAt(0).toUpperCase() + text.slice(1);
    case 'trim': return text.trim();
    case 'template': {
      const data = getPath(state, config.inputPath);
      let tpl = config.template || '';
      if (typeof data === 'object' && data) {
        for (const [k, v] of Object.entries(data)) {
          tpl = tpl.split(`{${k}}`).join(String(v ?? ''));
        }
      }
      return tpl;
    }
    case 'replace': {
      let result = text;
      for (const [from, to] of Object.entries(config.replacements || {})) {
        result = result.split(from).join(to);
      }
      return result;
    }
    default: return text;
  }
}

function handleExtractText(config, state) {
  const text = String(getPath(state, config.inputPath) ?? '');
  // FIX-24: ReDoS guard — validate the user-supplied pattern BEFORE compiling
  // it. A catastrophic pattern would hang the event loop on .match/.matchAll.
  _validateRegexPattern(config.pattern);
  const re = new RegExp(config.pattern, config.flags || 'g');
  if (config.extractAll) {
    return [...text.matchAll(re)].map(m => m[0]);
  }
  const match = text.match(re);
  return match ? match[0] : null;
}

// ─── VALIDATION ───

function handleValidateData(config, state) {
  const value = String(getPath(state, config.inputPath) ?? '');
  let valid = false;
  let error = null;

  switch (config.validationType) {
    case 'email': valid = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value); error = valid ? null : 'Invalid email format'; break;
    case 'url': valid = /^https?:\/\/.+/.test(value); error = valid ? null : 'Invalid URL format'; break;
    case 'number': valid = !isNaN(Number(value)) && value.trim() !== ''; error = valid ? null : 'Not a valid number'; break;
    case 'integer': valid = Number.isInteger(Number(value)) && value.trim() !== ''; error = valid ? null : 'Not a valid integer'; break;
    case 'phone': valid = /^[\d\s\-+()]+$/.test(value) && value.replace(/\D/g, '').length >= 10; error = valid ? null : 'Invalid phone format'; break;
    case 'date': valid = !isNaN(Date.parse(value)); error = valid ? null : 'Invalid date format'; break;
    case 'custom': {
      // FIX-24: ReDoS guard — validate the user-supplied pattern BEFORE compiling.
      _validateRegexPattern(config.pattern || '.*');
      const re = new RegExp(config.pattern || '.*');
      valid = re.test(value);
      error = valid ? null : `Does not match pattern: ${config.pattern}`;
      break;
    }
    default: error = `Unknown validation type: ${config.validationType}`;
  }

  return { valid, value, error };
}

// ─── MATH ───

function handleCalculate(config, state) {
  let input = getPath(state, config.inputPath);
  const precision = config.precision ?? 2;

  // Array operations
  if (Array.isArray(input)) {
    const nums = input.map(Number).filter(n => Number.isFinite(n));
    switch (config.operation) {
      case 'sum': return round(nums.reduce((a, b) => a + b, 0), precision);
      case 'average': return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, precision) : 0;
      // FIX-38: avoid spread on arbitrarily large arrays — Math.max(...nums)
      // places every element on the call stack; arrays > ~100k can throw
      // RangeError: Maximum call stack size exceeded. Reduce iterates safely.
      case 'max': return nums.reduce((a, b) => Math.max(a, b), -Infinity);
      case 'min': return nums.reduce((a, b) => Math.min(a, b), Infinity);
    }
  }

  const x = Number(input);
  const operand = config.operand !== undefined
    ? Number(typeof config.operand === 'string' && config.operand.startsWith('/') ? getPath(state, config.operand) : config.operand)
    : 0;

  switch (config.operation) {
    case 'add': return round(x + operand, precision);
    case 'subtract': return round(x - operand, precision);
    case 'multiply': return round(x * operand, precision);
    case 'divide': if (operand === 0) throw new Error('Division by zero'); return round(x / operand, precision);
    case 'power': return round(Math.pow(x, operand), precision);
    case 'modulo': return x % operand;
    case 'round': return round(x, precision);
    case 'ceil': return Math.ceil(x);
    case 'floor': return Math.floor(x);
    case 'abs': return Math.abs(x);
    case 'max': return Math.max(x, operand);
    case 'min': return Math.min(x, operand);
    default: throw new Error(`Calculate: unknown operation '${config.operation}'`);
  }
}

// ─── ENCODING ───

function handleEncodeDecode(config, state) {
  const input = String(getPath(state, config.inputPath) ?? '');

  if (config.operation === 'encode') {
    switch (config.encoding) {
      case 'base64': return btoa(unescape(encodeURIComponent(input)));
      case 'url': return encodeURIComponent(input);
      case 'html': return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      default: throw new Error(`Unknown encoding: ${config.encoding}`);
    }
  } else {
    switch (config.encoding) {
      case 'base64': return decodeURIComponent(escape(atob(input)));
      case 'url': return decodeURIComponent(input);
      case 'html': return input.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      default: throw new Error(`Unknown encoding: ${config.encoding}`);
    }
  }
}

// ─── FLOW ───

function handleWait(config) {
  return new Promise(resolve => setTimeout(resolve, config.duration || 0));
}

function handleConditional(config, state) {
  const value = getPath(state, config.condition?.path);
  const op = config.condition?.operator || '==';
  const expected = config.condition?.value;
  const result = evalCondition(value, op, expected);

  return {
    conditionResult: result,
    executeOperationId: result ? config.ifTrue : config.ifFalse,
  };
}

// handleLoop is special — implemented in executor

// ---------------------------------------------------------------------------
// HANDLER REGISTRY
// ---------------------------------------------------------------------------

const HANDLERS = {
  ApiCall: handleApiCall,
  ExecuteN8nWorkflow: handleExecuteN8nWorkflow,
  FilterData: handleFilterData,
  TransformData: handleTransformData,
  MergeData: handleMergeData,
  StoreData: handleStoreData,
  SetData: handleSetData,
  DateTime: handleDateTime,
  GetCurrentDateTime: handleGetCurrentDateTime,
  ConvertTimezone: handleConvertTimezone,
  DateCalculation: handleDateCalculation,
  FormatText: handleFormatText,
  ExtractText: handleExtractText,
  ValidateData: handleValidateData,
  Calculate: handleCalculate,
  EncodeDecode: handleEncodeDecode,
  Wait: handleWait,
  Conditional: handleConditional,
  // Loop handled in executor
};

// ---------------------------------------------------------------------------
// WORKFLOW EXECUTOR
// ---------------------------------------------------------------------------

export class WorkflowExecutor {
  /**
   * @param {object} opts
   * @param {Array} opts.middleware - Array of middleware objects
   */
  constructor(opts = {}) {
    this.state = { workflow: {}, store: {}, loop: {} };
    this.operations = [];
    this.execute_root = null;
    this.middleware = opts.middleware || [];
    this.results = {};
    this.errors = {};
    this._customHandlers = {};
    // Max recursion depth for _executeOp (guards against cyclic Conditional /
    // onError / Loop definitions that would otherwise hang or overflow the stack).
    this.maxDepth = opts.maxDepth ?? 50;
  }

  /** Register a custom operation handler */
  registerHandler(name, handler) {
    this._customHandlers[name] = handler;
    return this;
  }

  /**
   * Load a workflow (compact JSON or JSONL).
   * @param {object|string} input - Compact JSON object, JSON string, or JSONL string
   */
  load(input) {
    let parsed;
    if (typeof input === 'string') {
      input = input.trim();
      if (input.startsWith('{')) {
        parsed = parseCompact(JSON.parse(input));
      } else {
        // JSONL
        const lines = input.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
        parsed = parseJSONL(lines);
      }
    } else {
      parsed = parseCompact(input);
    }

    this.operations = parsed.operations;
    this.execute_root = parsed.execute;
    this.state = { workflow: {}, store: {}, loop: {} };
    this.results = {};
    this.errors = {};
    return this;
  }

  /**
   * Execute the loaded workflow.
   * @returns {Promise<{ state: object, results: object, errors: object }>}
   */
  async execute() {
    const executionId = Date.now().toString(36);

    // Middleware: on_execution_start
    for (const mw of this.middleware) {
      if (mw.onExecutionStart) await mw.onExecutionStart(executionId, this.operations);
    }

    try {
      // Try DAG parallel execution
      const levels = buildDAG(this.operations);
      // Untaken/taken Conditional branch targets and Loop sub-operation ids
      // are dispatched dynamically by _executeOp's own Conditional/Loop
      // handling — never blanket-dispatch them here, or they run an extra,
      // spurious time.
      const branchTargets = conditionalBranchTargets(this.operations);
      const loopTargets = loopSubOperationTargets(this.operations);
      const excludedTargets = new Set([...branchTargets, ...loopTargets]);

      if (levels) {
        // DAG mode: execute by levels
        for (const level of levels) {
          const toRun = level.filter(opId => !excludedTargets.has(opId));
          await Promise.all(toRun.map(opId => this._executeOp(opId, executionId, 0)));
        }
      } else {
        // Fallback: sequential
        for (const op of this.operations) {
          if (excludedTargets.has(op.id)) continue;
          await this._executeOp(op.id, executionId, 0);
        }
      }
    } catch (err) {
      this.errors._executor = err.message;
    }

    // Middleware: on_execution_complete
    for (const mw of this.middleware) {
      if (mw.onExecutionComplete) await mw.onExecutionComplete(executionId, this.results, this.errors);
    }

    return {
      state: this.state,
      results: this.results,
      errors: this.errors,
    };
  }

  /** @private */
  async _executeOp(opId, executionId, depth = 0) {
    // Recursion depth guard — prevents hangs / stack overflow from cyclic
    // Conditional branches, self-referencing onError, or Loops that list
    // their own opId as a sub-operation. Same error pattern as `!handler`.
    if (depth > this.maxDepth) {
      this.errors[opId] = `Max recursion depth (${this.maxDepth}) exceeded — possible cyclic operation reference`;
      return;
    }

    const op = this.operations.find(o => o.id === opId);
    if (!op) return;

    const handler = this._customHandlers[op.type] || HANDLERS[op.type];
    if (!handler && op.type !== 'Loop') {
      this.errors[opId] = `Unknown operation: ${op.type}`;
      return;
    }

    // Middleware: on_operation_start
    for (const mw of this.middleware) {
      if (mw.onOperationStart) await mw.onOperationStart(executionId, opId, op.type);
    }

    // Middleware: process_config
    let config = { ...op.config };
    for (const mw of this.middleware) {
      if (mw.processConfig) config = await mw.processConfig(config, op.type) || config;
    }

    const startTime = performance.now();

    try {
      let result;

      if (config._cached !== undefined && op.type !== 'Conditional' && op.type !== 'Loop') {
        // FIX-24: CacheMiddleware hit — reuse the cached result and skip the
        // handler. Conditional/Loop are excluded: they have dynamic side
        // effects (branch execution / iteration) that must not be skipped.
        result = config._cached;
      } else if (op.type === 'Loop') {
        result = await this._executeLoop(config, depth);
      } else if (op.type === 'Conditional') {
        result = handler(config, this.state);
        // Execute branch if specified
        if (result?.executeOperationId) {
          await this._executeOp(result.executeOperationId, executionId, depth + 1);
        }
      } else {
        result = await handler(config, this.state);
      }

      // Store result
      if (config.outputPath) setPath(this.state, config.outputPath, result);
      this.results[opId] = result;

      // Middleware: process_result + on_operation_complete
      const duration = performance.now() - startTime;
      for (const mw of this.middleware) {
        if (mw.processResult) result = await mw.processResult(result, op.type, config) || result;
        if (mw.onOperationComplete) await mw.onOperationComplete(executionId, opId, op.type, result, duration);
      }

    } catch (err) {
      this.errors[opId] = err.message;

      // Middleware: on_operation_error
      for (const mw of this.middleware) {
        if (mw.onOperationError) await mw.onOperationError(executionId, opId, op.type, err);
      }

      // onError fallback
      if (op.onError) {
        try {
          await this._executeOp(op.onError, executionId, depth + 1);
          // Copy fallback result to original outputPath
          const fallbackOp = this.operations.find(o => o.id === op.onError);
          if (fallbackOp && this.results[op.onError] !== undefined) {
            setPath(this.state, config.outputPath, this.results[op.onError]);
            this.results[opId] = { _fallback: true, result: this.results[op.onError] };
          }
        } catch (fallbackErr) {
          this.errors[`${opId}_fallback`] = fallbackErr.message;
        }
      }
    }
  }

  /** @private */
  async _executeLoop(config, depth) {
    const data = getPath(this.state, config.inputPath);
    if (!Array.isArray(data)) throw new Error('Loop: input must be an array');

    const results = [];
    const subOps = config.operations || [];

    for (let i = 0; i < data.length; i++) {
      this.state.loop = { current: data[i], index: i };
      const iterResult = {};

      for (const subOpId of subOps) {
        await this._executeOp(subOpId, 'loop', depth + 1);
        iterResult[subOpId] = this.results[subOpId];
      }

      results.push(iterResult);
    }

    this.state.loop = {};
    return results;
  }
}

// ---------------------------------------------------------------------------
// MIDDLEWARE CLASSES
// ---------------------------------------------------------------------------

/** Audit middleware — logs all operations */
export class AuditMiddleware {
  constructor() { this.log = []; }

  onExecutionStart(id) { this.log.push({ type: 'execution_start', id, ts: Date.now() }); }
  onOperationStart(execId, opId, opType) { this.log.push({ type: 'op_start', execId, opId, opType, ts: Date.now() }); }
  onOperationComplete(execId, opId, opType, result, duration) { this.log.push({ type: 'op_complete', execId, opId, opType, duration, ts: Date.now() }); }
  onOperationError(execId, opId, opType, err) { this.log.push({ type: 'op_error', execId, opId, opType, error: err.message, ts: Date.now() }); }
  onExecutionComplete(id) { this.log.push({ type: 'execution_complete', id, ts: Date.now() }); }

  getLog() { return this.log; }
  clear() { this.log = []; }
}

/** Cache middleware — caches operation results */
export class CacheMiddleware {
  constructor(ttl = 300000) { this._cache = new Map(); this._ttl = ttl; this.hits = 0; this.misses = 0; }

  processConfig(config, opType) {
    const key = `${opType}:${JSON.stringify(config)}`;
    // FIX-24: stash the key on the config so processResult can store the
    // freshly computed result under the same key. (config is a fresh per-op
    // copy, so these private fields never leak into the cache key, which was
    // already computed above from the clean config.)
    config._cacheKey = key;
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.ts < this._ttl) {
      this.hits++;
      config._cached = cached.result;
    } else {
      this.misses++;
    }
    return config;
  }

  processResult(result, opType, config) {
    // FIX-24: actually populate the cache. Previously this hook was a no-op,
    // so the cache never stored anything and every execution was a miss.
    if (config && config._cacheKey) {
      this._cache.set(config._cacheKey, { result, ts: Date.now() });
    }
    return result;
  }

  stats() { return { hits: this.hits, misses: this.misses, size: this._cache.size }; }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

// FIX-24: ReDoS guard for user-supplied regex patterns (ExtractText,
// ValidateData.custom). Same shape as the guards in core/db.js and
// core/vector.js: (1) reject patterns longer than a fixed cap, (2) a heuristic
// for nested quantifiers like (x+)+ / (x*)* that cause catastrophic
// backtracking. Fail-closed — the pattern comes from an untrusted workflow
// definition, so on doubt we reject rather than risk hanging the event loop.
// Deliberately conservative; may over-reject valid but complex patterns.
const REGEX_MAX_LEN = 200;
function _validateRegexPattern(src) {
  if (typeof src !== 'string') src = String(src ?? '');
  if (src.length > REGEX_MAX_LEN) {
    throw new Error(`Regex pattern too long (max ${REGEX_MAX_LEN} chars)`);
  }
  // Strip escapes (\., \+, ...) and character classes [..] so they don't
  // confuse the nested-quantifier heuristic.
  let s = src.replace(/\\./g, '').replace(/\[(?:[^\]\\]|\\.)*\]/g, 'X');
  // Collapse quantified groups from the inside out; if a quantified group's
  // body already contains a * or +, it's nested -> catastrophic.
  for (let i = 0; i < 32; i++) {
    const m = s.match(/\(([^()]*)\)([*+])/);
    if (!m) break;
    if (/[*+]/.test(m[1])) {
      throw new Error('Regex pattern rejected: potential catastrophic backtracking');
    }
    s = s.replace(/\(([^()]*)\)([*+])/, 'Q');
  }
}

function evalCondition(val, op, expected) {
  switch (op) {
    case '==': case 'eq': return val == expected;
    case '===': return val === expected;
    case '!=': case 'ne': return val != expected;
    case '>': case 'gt': return val > expected;
    case '<': case 'lt': return val < expected;
    case '>=': case 'gte': return val >= expected;
    case '<=': case 'lte': return val <= expected;
    case 'contains': return Array.isArray(val) ? val.includes(expected) : String(val).includes(String(expected));
    case 'in': return Array.isArray(expected) && expected.includes(val);
    case 'startsWith': return String(val).startsWith(String(expected));
    case 'endsWith': return String(val).endsWith(String(expected));
    case 'exists': return val !== undefined && val !== null;
    case 'isEmpty': return val == null || val === '' || (Array.isArray(val) && val.length === 0) || (typeof val === 'object' && Object.keys(val).length === 0);
    default: return val == expected;
  }
}

function parseDate(input) {
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') return new Date(input);
  if (typeof input === 'object' && input) {
    return new Date(input.year || 0, (input.month || 1) - 1, input.day || 1, input.hour || 0, input.minute || 0, input.second || 0);
  }
  return new Date();
}

function formatDate(date, config) {
  const format = config.format || 'iso8601';
  switch (format) {
    case 'iso8601': return date.toISOString();
    case 'timestamp': return date.getTime();
    case 'custom': {
      const s = config.formatString || '%Y-%m-%d';
      return s
        .replace('%Y', String(date.getFullYear()))
        .replace('%m', String(date.getMonth() + 1).padStart(2, '0'))
        .replace('%d', String(date.getDate()).padStart(2, '0'))
        .replace('%H', String(date.getHours()).padStart(2, '0'))
        .replace('%M', String(date.getMinutes()).padStart(2, '0'))
        .replace('%S', String(date.getSeconds()).padStart(2, '0'));
    }
    default: return date.toISOString();
  }
}

function calcDelta(config) {
  return (
    (config.years || 0) * 365 * 24 * 60 * 60 * 1000 +
    (config.months || 0) * 30 * 24 * 60 * 60 * 1000 +
    (config.days || 0) * 24 * 60 * 60 * 1000 +
    (config.hours || 0) * 60 * 60 * 1000 +
    (config.minutes || 0) * 60 * 1000 +
    (config.seconds || 0) * 1000 +
    ((config.amount || 0) * unitToMs(config.unit))
  );
}

function unitToMs(unit) {
  switch (unit) {
    case 'years': return 365 * 24 * 60 * 60 * 1000;
    case 'months': return 30 * 24 * 60 * 60 * 1000;
    case 'days': return 24 * 60 * 60 * 1000;
    case 'hours': return 60 * 60 * 1000;
    case 'minutes': return 60 * 1000;
    case 'seconds': return 1000;
    default: return 0;
  }
}

function round(n, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(n * factor) / factor;
}

// Export helpers for testing
export { getPath, setPath, resolvePath, buildDAG, evalCondition, HANDLERS, conditionalBranchTargets, loopSubOperationTargets };
