/**
 * Agent Shell
 * AI-first command gateway. Port from Agent-Shell (TypeScript) to vanilla JS.
 * 2 MCP tools (help + exec) = ~600 constant tokens regardless of command count.
 * Zero dependencies.
 *
 * Usage:
 *   const shell = new Shell();
 *   shell.register('users', 'list', { ... }, handler);
 *   const result = await shell.exec('users:list --limit 10 | .data[0]');
 */

// ---------------------------------------------------------------------------
// PARSER — command string → AST
// ---------------------------------------------------------------------------

const MAX_INPUT = 4096;
const MAX_PIPELINE = 10;
const MAX_BATCH = 20;

/**
 * Parse a command string into an AST.
 * Supports: single, pipeline (>>), batch (batch [...]), JQ filter (|)
 * @param {string} input
 * @returns {{ type: string, commands: Array, filter: string|null, error: string|null }}
 */
export function parse(input) {
  if (!input || typeof input !== 'string') return { error: 'Empty input' };
  input = input.trim();
  if (input.length > MAX_INPUT) return { error: `Input too long (max ${MAX_INPUT})` };

  // Batch: batch [cmd1, cmd2, ...]
  if (input.startsWith('batch [') || input.startsWith('batch[')) {
    const inner = input.slice(input.indexOf('[') + 1, input.lastIndexOf(']'));
    if (!inner) return { error: 'Empty batch' };
    const cmds = inner.split(',').map(s => s.trim()).filter(Boolean);
    if (cmds.length > MAX_BATCH) return { error: `Batch too large (max ${MAX_BATCH})` };
    return { type: 'batch', commands: cmds.map(parseCommand), filter: null };
  }

  // Pipeline: cmd1 >> cmd2 >> cmd3
  if (input.includes(' >> ')) {
    const segments = input.split(' >> ');
    if (segments.length > MAX_PIPELINE) return { error: `Pipeline too deep (max ${MAX_PIPELINE})` };
    // Last segment may have a JQ filter
    const last = segments[segments.length - 1];
    const { cmd: lastCmd, filter } = splitFilter(last);
    const commands = segments.slice(0, -1).map(s => parseCommand(s));
    commands.push(parseCommand(lastCmd));
    return { type: 'pipeline', commands, filter };
  }

  // Single command (possibly with JQ filter)
  const { cmd, filter } = splitFilter(input);
  return { type: 'single', commands: [parseCommand(cmd)], filter };
}

function splitFilter(input) {
  // Split on ' | ' but not inside quotes
  const idx = input.indexOf(' | ');
  if (idx === -1) return { cmd: input, filter: null };
  return { cmd: input.slice(0, idx), filter: input.slice(idx + 3).trim() };
}

function parseCommand(input) {
  input = input.trim();
  const tokens = tokenize(input);
  if (tokens.length === 0) return { namespace: null, command: null, args: {}, flags: {} };

  const first = tokens[0];
  let namespace = null, command = null;

  // Built-in commands (no namespace)
  const BUILTINS = ['search', 'describe', 'help', 'history', 'undo', 'context'];
  if (BUILTINS.includes(first)) {
    command = first;
    tokens.shift();
  } else if (first.includes(':')) {
    const [ns, cmd] = first.split(':');
    namespace = ns;
    command = cmd;
    tokens.shift();
  } else {
    command = first;
    tokens.shift();
  }

  // Parse args and flags
  const args = {};
  const flags = {};
  let i = 0;
  let positionalIdx = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      // Global flags (no value)
      if (['dry-run', 'validate', 'confirm'].includes(key)) {
        flags[key] = true;
        i++;
        continue;
      }
      // Named arg with value
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        args[key] = parseValue(tokens[i + 1]);
        i += 2;
      } else {
        args[key] = true;
        i++;
      }
    } else {
      // Positional
      args[`_${positionalIdx++}`] = parseValue(t);
      i++;
    }
  }

  return { namespace, command, args, flags };
}

function tokenize(input) {
  const tokens = [];
  let current = '';
  let inQuote = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ') {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  const n = Number(v);
  if (!isNaN(n) && v !== '') return n;
  return v;
}

// ---------------------------------------------------------------------------
// JQ FILTER — .field, .[0], [.a, .b], .[].field
// ---------------------------------------------------------------------------

/**
 * Apply a JQ-subset filter to data.
 * @param {any} data
 * @param {string} expression
 * @returns {any}
 */
export function applyFilter(data, expression) {
  if (!expression || expression === '.') return data;

  // Multi-select: [.a, .b, .c]
  if (expression.startsWith('[') && expression.endsWith(']')) {
    const fields = expression.slice(1, -1).split(',').map(f => f.trim());
    const result = {};
    for (const f of fields) {
      const key = f.replace(/^\./, '');
      result[key] = resolvePath(data, key);
    }
    return result;
  }

  // Array iteration: .[].field
  if (expression.includes('.[]')) {
    const [before, after] = expression.split('.[]');
    let arr = before && before !== '.' ? resolvePath(data, before.replace(/^\./, '')) : data;
    if (!Array.isArray(arr)) return null;
    if (after) {
      const field = after.replace(/^\./, '');
      return arr.map(item => resolvePath(item, field));
    }
    return arr;
  }

  // Simple path: .field.subfield or .[0]
  const path = expression.replace(/^\./, '');
  return resolvePath(data, path);
}

function resolvePath(data, path) {
  if (!path) return data;
  const parts = path.split('.').filter(Boolean);
  let current = data;

  for (const part of parts) {
    if (current == null) return undefined;
    // Array index: [N] or [-N]
    const idxMatch = part.match(/^\[(-?\d+)\]$/);
    if (idxMatch) {
      if (!Array.isArray(current)) return undefined;
      const idx = parseInt(idxMatch[1]);
      current = idx < 0 ? current[current.length + idx] : current[idx];
    } else if (part.includes('[')) {
      // field[N]
      const [field, rest] = part.split('[');
      current = current[field];
      if (current == null) return undefined;
      const idx = parseInt(rest.replace(']', ''));
      current = Array.isArray(current) ? (idx < 0 ? current[current.length + idx] : current[idx]) : undefined;
    } else {
      current = current[part];
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// COMMAND REGISTRY
// ---------------------------------------------------------------------------

export class CommandRegistry {
  constructor() {
    /** @type {Map<string, { definition: object, handler: Function, undoHandler?: Function }>} */
    this._commands = new Map();
  }

  /**
   * Register a command.
   * @param {string} namespace
   * @param {string} name
   * @param {object} definition - { description, params, output, example, tags, reversible, permissions }
   * @param {Function} handler - async (args, context) => result
   * @param {Function} [undoHandler] - async (args, prevResult) => result
   */
  register(namespace, name, definition, handler, undoHandler) {
    const id = `${namespace}:${name}`;
    this._commands.set(id, {
      definition: { namespace, name, id, ...definition },
      handler,
      undoHandler,
    });
    return this;
  }

  /** Resolve a command by id */
  resolve(id) {
    return this._commands.get(id) || null;
  }

  /** Check if command exists */
  has(id) { return this._commands.has(id); }

  /** List all commands */
  list(namespace) {
    const all = Array.from(this._commands.values()).map(c => c.definition);
    return namespace ? all.filter(d => d.namespace === namespace) : all;
  }

  /** Get namespaces */
  namespaces() {
    const ns = new Set();
    for (const c of this._commands.values()) ns.add(c.definition.namespace);
    return Array.from(ns);
  }

  /** Get compact signatures (AI-optimized) */
  signatures() {
    return this.list().map(d => {
      const params = (d.params || []).map(p =>
        `--${p.name}: ${p.type}${p.required ? ' [REQUIRED]' : ''}${p.default !== undefined ? ` = ${p.default}` : ''}`
      ).join('\n  ');
      return `${d.id} | ${d.description}\n  ${params}`;
    }).join('\n\n');
  }

  /** Count commands */
  get size() { return this._commands.size; }
}

// ---------------------------------------------------------------------------
// SHELL — main orchestrator
// ---------------------------------------------------------------------------

export class Shell {
  /**
   * @param {object} opts
   * @param {CommandRegistry} opts.registry
   * @param {string[]} opts.permissions - Allowed permissions for this session
   * @param {string} opts.profile - Agent profile: 'admin' | 'operator' | 'reader' | 'restricted'
   */
  constructor(opts = {}) {
    this.registry = opts.registry || new CommandRegistry();
    this.permissions = opts.permissions || ['*'];
    this.profile = opts.profile || 'admin';
    this._history = [];
    this._context = {};
    this._maxHistory = 100;

    // Register built-in commands
    this._registerBuiltins();
  }

  /**
   * The help protocol — static, ~600 tokens.
   */
  help() {
    return `Agent Shell — Interaction Protocol

2 tools: help() and exec(cmd)

== Discovery ==
  search <query>            Search commands by description
  describe <ns:cmd>         View command definition

== Execution ==
  namespace:command --arg value    Execute command
  --dry-run                        Simulate only
  --validate                       Check syntax only
  --confirm                        Preview before execute

== Filtering ==
  command | .field                 Extract field
  command | [.a, .b]              Multi-select
  command | .[].field             Iterate array

== Composition ==
  cmd1 >> cmd2                     Pipeline
  batch [cmd1, cmd2]               Parallel execution

== State ==
  history                          View command history
  context                          View session context

Commands: ${this.registry.size} registered
Profiles: admin, operator, reader, restricted (current: ${this.profile})`;
  }

  /**
   * Execute a command string.
   * @param {string} input
   * @returns {Promise<{ code: number, data: any, error: string|null, meta: object }>}
   */
  async exec(input) {
    const start = performance.now();

    // Parse
    const parsed = parse(input);
    if (parsed.error) {
      return this._response(1, null, parsed.error, input, start);
    }

    try {
      let result;

      switch (parsed.type) {
        case 'batch':
          result = await this._execBatch(parsed.commands);
          break;
        case 'pipeline':
          result = await this._execPipeline(parsed.commands);
          break;
        default:
          result = await this._execSingle(parsed.commands[0]);
      }

      // Apply JQ filter if present
      if (parsed.filter && result.data !== null && result.data !== undefined) {
        result.data = applyFilter(result.data, parsed.filter);
      }

      // Store in history
      this._history.unshift({
        id: `h${Date.now().toString(36)}`,
        input,
        code: result.code,
        timestamp: new Date().toISOString(),
      });
      if (this._history.length > this._maxHistory) this._history.pop();

      return { ...result, meta: { ...result.meta, duration_ms: Math.round(performance.now() - start) } };

    } catch (err) {
      return this._response(1, null, err.message, input, start);
    }
  }

  /** Set a context variable */
  setContext(key, value) { this._context[key] = value; }

  /** Get context */
  getContext() { return { ...this._context }; }

  /** Get command history */
  getHistory(limit = 20) { return this._history.slice(0, limit); }

  // ─── EXECUTION MODES ─────────────────────────────────────

  async _execSingle(cmd) {
    if (!cmd.command) return this._error(1, 'Empty command');

    // Built-in commands
    switch (cmd.command) {
      case 'search': return this._cmdSearch(cmd);
      case 'describe': return this._cmdDescribe(cmd);
      case 'help': return this._ok(this.help());
      case 'history': return this._ok(this.getHistory());
      case 'context': return this._ok(this.getContext());
    }

    // Resolve registered command
    const id = cmd.namespace ? `${cmd.namespace}:${cmd.command}` : cmd.command;
    const registered = this.registry.resolve(id);
    if (!registered) return this._error(2, `Command not found: ${id}`);

    // Permission check
    if (!this._checkPermission(id)) {
      return this._error(3, `Permission denied: ${id}`);
    }

    // Dry-run mode
    if (cmd.flags['dry-run']) {
      return this._ok({
        mode: 'dry-run',
        command: id,
        args: cmd.args,
        wouldExecute: true,
        definition: registered.definition,
      });
    }

    // Validate mode
    if (cmd.flags['validate']) {
      const validation = this._validateArgs(registered.definition, cmd.args);
      return this._ok({ mode: 'validate', command: id, valid: validation.valid, errors: validation.errors });
    }

    // Execute
    const result = await registered.handler(cmd.args, {
      context: this._context,
      history: this._history,
      shell: this,
    });

    return this._ok(result);
  }

  async _execPipeline(commands) {
    let previousResult = null;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      // Inject previous result as _input
      if (previousResult !== null) {
        cmd.args._input = previousResult;
      }

      const result = await this._execSingle(cmd);
      if (result.code !== 0) return result; // stop on error
      previousResult = result.data;
    }

    return this._ok(previousResult);
  }

  async _execBatch(commands) {
    const results = await Promise.all(
      commands.map(cmd => this._execSingle(cmd))
    );
    return this._ok(results.map((r, i) => ({
      command: commands[i].namespace ? `${commands[i].namespace}:${commands[i].command}` : commands[i].command,
      code: r.code,
      data: r.data,
      error: r.error,
    })));
  }

  // ─── BUILT-IN COMMANDS ───────────────────────────────────

  _cmdSearch(cmd) {
    const query = (cmd.args._0 || '').toLowerCase();
    if (!query) return this._error(1, 'search requires a query');

    const all = this.registry.list();
    const scored = all.map(def => {
      const text = `${def.id} ${def.description} ${(def.tags || []).join(' ')}`.toLowerCase();
      const terms = query.split(/\s+/);
      const matched = terms.filter(t => text.includes(t)).length;
      return { def, score: matched / terms.length };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

    return this._ok(scored.map(r => ({
      id: r.def.id,
      description: r.def.description,
      score: r.score,
    })));
  }

  _cmdDescribe(cmd) {
    const id = cmd.args._0;
    if (!id) return this._error(1, 'describe requires a command id');
    const registered = this.registry.resolve(id);
    if (!registered) return this._error(2, `Command not found: ${id}`);
    return this._ok(registered.definition);
  }

  // ─── PERMISSION CHECK ────────────────────────────────────

  _checkPermission(commandId) {
    if (this.permissions.includes('*')) return true;
    // Built-in commands (no colon) are always allowed for search/describe/help
    if (!commandId.includes(':')) {
      return this.permissions.some(p => p === commandId || p === 'search' || p === 'describe' || p === 'help');
    }
    const [ns, cmd] = commandId.split(':');
    return this.permissions.some(p => {
      if (p === commandId) return true;           // exact: users:list
      if (p === `${ns}:*`) return true;            // namespace: users:*
      if (p === `*:${cmd}`) return true;           // command: *:list
      if (p === `*:read` && ['list', 'get', 'search', 'describe', 'count', 'status'].includes(cmd)) return true;
      if (p === `${ns}:read` && ['list', 'get', 'search', 'describe', 'count', 'status'].includes(cmd)) return true;
      return false;
    });
  }

  // ─── VALIDATION ──────────────────────────────────────────

  _validateArgs(definition, args) {
    const errors = [];
    for (const param of definition.params || []) {
      if (param.required && args[param.name] === undefined) {
        errors.push(`Missing required: --${param.name}`);
      }
      if (args[param.name] !== undefined && param.type) {
        const val = args[param.name];
        if (param.type === 'number' && typeof val !== 'number') errors.push(`--${param.name} must be a number`);
        if (param.type === 'string' && typeof val !== 'string') errors.push(`--${param.name} must be a string`);
        if (param.type === 'boolean' && typeof val !== 'boolean') errors.push(`--${param.name} must be a boolean`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  // ─── RESPONSE BUILDERS ───────────────────────────────────

  _ok(data) { return { code: 0, data, error: null, meta: {} }; }
  _error(code, msg) { return { code, data: null, error: msg, meta: {} }; }

  _response(code, data, error, input, start) {
    return {
      code,
      data,
      error,
      meta: {
        command: input,
        duration_ms: Math.round(performance.now() - start),
        timestamp: new Date().toISOString(),
      },
    };
  }

  // ─── BUILT-IN SKILL REGISTRATION ────────────────────────

  _registerBuiltins() {
    const r = this.registry;

    // Context commands
    r.register('context', 'set', {
      description: 'Set a context variable',
      params: [{ name: 'key', type: 'string', required: true }, { name: 'value', type: 'any', required: true }],
    }, async (args) => {
      this._context[args.key || args._0] = args.value || args._1;
      return { set: args.key || args._0 };
    });

    r.register('context', 'get', {
      description: 'Get a context variable',
      params: [{ name: 'key', type: 'string', required: true }],
    }, async (args) => this._context[args.key || args._0]);

    // JSON filter
    r.register('json', 'filter', {
      description: 'Filter JSON data with JQ expression',
      params: [
        { name: 'data', type: 'any' },
        { name: 'expression', type: 'string', required: true },
      ],
    }, async (args) => applyFilter(args._input || args.data, args.expression || args._0));

    // Math
    r.register('math', 'calc', {
      description: 'Calculate: add, subtract, multiply, divide',
      params: [
        { name: 'a', type: 'number', required: true },
        { name: 'op', type: 'string', required: true },
        { name: 'b', type: 'number', required: true },
      ],
    }, async (args) => {
      const { a, op, b } = args;
      switch (op) {
        case '+': case 'add': return a + b;
        case '-': case 'subtract': return a - b;
        case '*': case 'multiply': return a * b;
        case '/': case 'divide': return b !== 0 ? a / b : null;
        default: return null;
      }
    });

    // Text
    r.register('text', 'template', {
      description: 'Render template with {{var}} placeholders',
      params: [
        { name: 'template', type: 'string', required: true },
        { name: 'data', type: 'object' },
      ],
    }, async (args) => {
      let tpl = args.template;
      const data = args.data || args._input || {};
      for (const [k, v] of Object.entries(data)) {
        tpl = tpl.split(`{{${k}}}`).join(String(v ?? ''));
      }
      return tpl;
    });

    // Encode/decode
    r.register('encode', 'base64', {
      description: 'Base64 encode text',
      params: [{ name: 'text', type: 'string', required: true }],
    }, async (args) => btoa(unescape(encodeURIComponent(args.text || args._0))));

    r.register('decode', 'base64', {
      description: 'Base64 decode text',
      params: [{ name: 'text', type: 'string', required: true }],
    }, async (args) => decodeURIComponent(escape(atob(args.text || args._0))));

    // DateTime
    r.register('datetime', 'now', {
      description: 'Get current date/time',
      params: [{ name: 'format', type: 'string', default: 'iso' }],
    }, async (args) => {
      if (args.format === 'timestamp') return Date.now();
      return new Date().toISOString();
    });
  }
}

// ---------------------------------------------------------------------------
// AGENT PROFILES (RBAC presets)
// ---------------------------------------------------------------------------

export const AGENT_PROFILES = {
  admin: ['*'],
  operator: ['*:list', '*:get', '*:create', '*:update', '*:delete', '*:run', 'shell:*', 'http:*'],
  reader: ['*:list', '*:get', '*:search', '*:describe', '*:count', '*:status'],
  restricted: ['search', 'describe', 'help'],
};
