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
        // Skip onError references
        if (op.onError === depId) continue;
        graph.get(op.id).add(depId);
      }
    }
    // Explicit input reference
    if (op.input && opMap.has(op.input)) {
      graph.get(op.id).add(op.input);
    }
  }

  // Kahn's algorithm — group into parallel levels
  const inDegree = new Map();
  for (const [id, deps] of graph) inDegree.set(id, deps.size);

  const levels = [];
  const visited = new Set();

  while (visited.size < operations.length) {
    const level = [];
    for (const [id, deg] of inDegree) {
      if (!visited.has(id) && deg === 0) level.push(id);
    }
    if (level.length === 0) break; // cycle detected — fallback to sequential
    for (const id of level) {
      visited.add(id);
      // Decrement dependents
      for (const [otherId, deps] of graph) {
        if (deps.has(id)) inDegree.set(otherId, inDegree.get(otherId) - 1);
      }
    }
    levels.push(level);
  }

  // If not all visited, fallback
  if (visited.size < operations.length) return null;
  return levels;
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

  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return data;
}

async function handleExecuteN8nWorkflow(config, state) {
  const n8nUrl = config.n8nUrl || process.env.N8N_URL || 'http://localhost:5678';
  const apiKey = config.n8nApiKey || process.env.N8N_API_KEY || '';
  const payload = config.payload ? resolvePath(state, config.payload) : {};

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
      case 'max': return Math.max(...nums);
      case 'min': return Math.min(...nums);
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

      if (levels) {
        // DAG mode: execute by levels
        for (const level of levels) {
          await Promise.all(level.map(opId => this._executeOp(opId, executionId)));
        }
      } else {
        // Fallback: sequential
        for (const op of this.operations) {
          await this._executeOp(op.id, executionId);
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
  async _executeOp(opId, executionId) {
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

      if (op.type === 'Loop') {
        result = await this._executeLoop(config);
      } else if (op.type === 'Conditional') {
        result = handler(config, this.state);
        // Execute branch if specified
        if (result?.executeOperationId) {
          await this._executeOp(result.executeOperationId, executionId);
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
        if (mw.processResult) result = await mw.processResult(result, op.type) || result;
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
          await this._executeOp(op.onError, executionId);
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
  async _executeLoop(config) {
    const data = getPath(this.state, config.inputPath);
    if (!Array.isArray(data)) throw new Error('Loop: input must be an array');

    const results = [];
    const subOps = config.operations || [];

    for (let i = 0; i < data.length; i++) {
      this.state.loop = { current: data[i], index: i };
      const iterResult = {};

      for (const subOpId of subOps) {
        await this._executeOp(subOpId, 'loop');
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
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.ts < this._ttl) {
      this.hits++;
      config._cached = cached.result;
    } else {
      this.misses++;
    }
    return config;
  }

  processResult(result, opType) {
    // Result is stored after execution
    return result;
  }

  stats() { return { hits: this.hits, misses: this.misses, size: this._cache.size }; }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

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
export { getPath, setPath, resolvePath, buildDAG, evalCondition, HANDLERS };
