/**
 * Node Registry
 * Every integration is a node. Every node is an API call with config.
 * Presets are JSON definitions that map to the generic executor.
 * Zero dependencies.
 *
 * Usage:
 *   const registry = new NodeRegistry();
 *   registry.add({ type: 'slack.send', ... });
 *   const node = registry.get('slack.send');
 *   const result = await registry.execute('slack.send', inputs, credentials);
 */

// ---------------------------------------------------------------------------
// NODE REGISTRY
// ---------------------------------------------------------------------------

export class NodeRegistry {
  constructor() {
    /** @type {Map<string, NodeDefinition>} */
    this._nodes = new Map();
    // Load built-in nodes
    for (const node of BUILTIN_NODES) {
      this._nodes.set(node.type, node);
    }
  }

  /**
   * Register a node (integration).
   * @param {NodeDefinition} node
   */
  add(node) {
    if (!node.type) throw new Error('Node requires a "type" field');
    this._nodes.set(node.type, node);
    return this;
  }

  /** Get a node definition */
  get(type) { return this._nodes.get(type) || null; }

  /** Check if node exists */
  has(type) { return this._nodes.has(type); }

  /** Remove a node */
  remove(type) { return this._nodes.delete(type); }

  /** List all nodes */
  list(category) {
    const all = Array.from(this._nodes.values());
    return category ? all.filter(n => n.category === category) : all;
  }

  /** List categories */
  categories() {
    const cats = new Set();
    for (const n of this._nodes.values()) if (n.category) cats.add(n.category);
    return Array.from(cats);
  }

  /**
   * Export all nodes as ARDF descriptors.
   * @returns {Array<object>}
   */
  toARDF() {
    return this.list().map(n => ({
      schema_version: '1.0.0',
      resource_id: n.type,
      resource_type: 'tool',
      description: n.description || '',
      when_to_use: `Use ${n.name || n.type} in workflow automation`,
      content: {
        type: 'tool/io',
        data: {
          inputs: (n.inputs || []).map(i => ({
            name: i.name, type: i.type || 'any',
            required: !!i.required,
            ...(i.default !== undefined ? { default: i.default } : {}),
          })),
          outputs: {
            success: `${n.type} completed`,
          },
        },
      },
      metadata: {
        category: n.category || 'general',
        tags: [n.category, n.type.split('.')[0]].filter(Boolean),
        maturity: 'stable',
      },
      ...(n.credentials ? { prerequisites: { credentials: n.credentials } } : {}),
    }));
  }

  /**
   * Execute a node.
   * @param {string} type - Node type
   * @param {object} inputs - Input values
   * @param {object} credentials - Resolved credential values
   * @returns {Promise<any>}
   */
  async execute(type, inputs = {}, credentials = {}) {
    const node = this._nodes.get(type);
    if (!node) throw new Error(`Node not found: ${type}`);

    // Custom handler
    if (node.handler) {
      return node.handler(inputs, credentials);
    }

    // API-based node: build and execute HTTP request
    return this._executeApi(node, inputs, credentials);
  }

  /** @private */
  async _executeApi(node, inputs, credentials) {
    // Interpolate template values
    const url = interpolate(node.url || inputs.url, inputs, credentials);
    const method = (node.method || inputs.method || 'GET').toUpperCase();

    // Build headers
    const headers = { ...resolveObj(node.headers || {}, inputs, credentials) };

    // Auth
    if (node.auth || credentials._type) {
      const authType = node.auth || credentials._type;
      if (authType === 'bearer' && credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`;
      } else if (authType === 'basic' && credentials.user && credentials.pass) {
        headers['Authorization'] = `Basic ${btoa(`${credentials.user}:${credentials.pass}`)}`;
      } else if (authType === 'header' && credentials.key) {
        headers[node.authHeader || 'X-API-Key'] = credentials.key;
      }
    }

    // Body
    let body = null;
    if (node.body && !['GET', 'HEAD'].includes(method)) {
      body = JSON.stringify(resolveObj(
        typeof node.body === 'string' ? JSON.parse(interpolate(node.body, inputs, credentials)) : node.body,
        inputs, credentials
      ));
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    } else if (inputs.body && !['GET', 'HEAD'].includes(method)) {
      body = typeof inputs.body === 'string' ? inputs.body : JSON.stringify(inputs.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }

    // Execute with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), inputs.timeout || 30000);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();

    return {
      ok: res.ok,
      status: res.status,
      data,
      headers: Object.fromEntries(res.headers),
    };
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function interpolate(template, inputs, creds) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (inputs[key] !== undefined) return String(inputs[key]);
    if (creds[key] !== undefined) return String(creds[key]);
    return '';
  });
}

function resolveObj(obj, inputs, creds) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => resolveObj(v, inputs, creds));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? interpolate(v, inputs, creds) : resolveObj(v, inputs, creds);
  }
  return out;
}

// ---------------------------------------------------------------------------
// BUILT-IN NODES (presets)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} NodeDefinition
 * @property {string} type - Unique identifier (e.g. 'slack.send', 'http.request')
 * @property {string} name - Display name
 * @property {string} category - Category for grouping
 * @property {string} description - What this node does
 * @property {string} [url] - API URL template
 * @property {string} [method] - HTTP method
 * @property {string} [auth] - Auth type: 'bearer', 'basic', 'header'
 * @property {string} [authHeader] - Header name for 'header' auth
 * @property {object} [headers] - Default headers
 * @property {object} [body] - Body template
 * @property {Array} inputs - Input field definitions
 * @property {Array} outputs - Output field definitions
 * @property {string[]} [credentials] - Required credential keys
 * @property {Function} [handler] - Custom handler (overrides API call)
 */

const BUILTIN_NODES = [
  // ─── Core ──────────────────────────────────────────────────
  {
    type: 'http.request',
    name: 'HTTP Request',
    category: 'core',
    description: 'Make any HTTP request',
    inputs: [
      { name: 'url', type: 'string', required: true },
      { name: 'method', type: 'string', default: 'GET' },
      { name: 'headers', type: 'object' },
      { name: 'body', type: 'object' },
    ],
    outputs: [{ name: 'response', type: 'object' }],
  },
  {
    type: 'code.run',
    name: 'Run Code',
    category: 'core',
    description: 'Execute a JavaScript function',
    inputs: [{ name: 'data', type: 'any' }],
    outputs: [{ name: 'result', type: 'any' }],
    handler: async (inputs) => {
      if (!inputs.code) return inputs.data;
      // Restricted scope: only 'data' and safe globals available
      // Block access to process, require, import, fetch, eval
      const BLOCKED = ['process', 'require', 'import', 'eval', 'Function', 'fetch', 'globalThis', 'Bun', 'Deno'];
      for (const b of BLOCKED) {
        if (inputs.code.includes(b)) throw new Error(`Blocked keyword in code: ${b}`);
      }
      try {
        const fn = new Function('data', `"use strict"; return (function(data) { ${inputs.code} })(data);`);
        return fn(inputs.data);
      } catch (err) {
        throw new Error(`Code execution error: ${err.message}`);
      }
    },
  },
  {
    type: 'set.value',
    name: 'Set Value',
    category: 'core',
    description: 'Set a static or computed value',
    inputs: [{ name: 'value', type: 'any', required: true }],
    outputs: [{ name: 'value', type: 'any' }],
    handler: async (inputs) => inputs.value,
  },
  {
    type: 'filter',
    name: 'Filter',
    category: 'core',
    description: 'Filter items based on conditions',
    inputs: [
      { name: 'items', type: 'array', required: true },
      { name: 'field', type: 'string', required: true },
      { name: 'operator', type: 'string', default: '==' },
      { name: 'value', type: 'any', required: true },
    ],
    outputs: [{ name: 'items', type: 'array' }],
    handler: async (inputs) => {
      const { items, field, operator, value } = inputs;
      if (!Array.isArray(items)) return [];
      return items.filter(item => {
        const v = item[field];
        switch (operator) {
          case '==': case '===': return v === value;
          case '!=': case '!==': return v !== value;
          case '>': return Number(v) > Number(value);
          case '>=': return Number(v) >= Number(value);
          case '<': return Number(v) < Number(value);
          case '<=': return Number(v) <= Number(value);
          case 'contains': return String(v).includes(String(value));
          case 'startsWith': return String(v).startsWith(String(value));
          case 'endsWith': return String(v).endsWith(String(value));
          default: return v === value;
        }
      });
    },
  },
  {
    type: 'merge',
    name: 'Merge',
    category: 'core',
    description: 'Merge data from multiple inputs',
    inputs: [{ name: 'items', type: 'array' }],
    outputs: [{ name: 'merged', type: 'any' }],
    handler: async (inputs) => {
      if (!Array.isArray(inputs.items)) return [];
      return inputs.items.flat(1); // single level only
    },
  },
  {
    type: 'wait',
    name: 'Wait',
    category: 'core',
    description: 'Delay execution',
    inputs: [{ name: 'ms', type: 'number', default: 1000 }],
    outputs: [],
    handler: async (inputs) => new Promise(r => setTimeout(r, inputs.ms || 1000)),
  },
  {
    type: 'if',
    name: 'IF Condition',
    category: 'core',
    description: 'Branch based on condition',
    inputs: [
      { name: 'value', type: 'any', required: true },
      { name: 'operator', type: 'string', default: '==' },
      { name: 'compare', type: 'any' },
    ],
    outputs: [{ name: 'result', type: 'boolean' }],
    handler: async (inputs) => {
      const { value, operator, compare } = inputs;
      switch (operator) {
        case '==': return value == compare;
        case '!=': return value != compare;
        case '>': return value > compare;
        case '<': return value < compare;
        case 'exists': return value != null;
        case 'empty': return !value || (Array.isArray(value) && value.length === 0);
        default: return !!value;
      }
    },
  },

  // ─── Communication ─────────────────────────────────────────
  {
    type: 'slack.send',
    name: 'Slack: Send Message',
    category: 'communication',
    description: 'Send a message to Slack',
    url: '{{webhookUrl}}',
    method: 'POST',
    body: { text: '{{message}}', channel: '{{channel}}' },
    inputs: [
      { name: 'message', type: 'string', required: true },
      { name: 'channel', type: 'string' },
    ],
    credentials: ['webhookUrl'],
    outputs: [{ name: 'ok', type: 'boolean' }],
  },
  {
    type: 'discord.send',
    name: 'Discord: Send Message',
    category: 'communication',
    description: 'Send a message to Discord',
    url: '{{webhookUrl}}',
    method: 'POST',
    body: { content: '{{message}}' },
    inputs: [{ name: 'message', type: 'string', required: true }],
    credentials: ['webhookUrl'],
    outputs: [{ name: 'ok', type: 'boolean' }],
  },
  {
    type: 'email.send',
    name: 'Email: Send (SMTP)',
    category: 'communication',
    description: 'Send email via HTTP email API (Resend, Mailgun, etc)',
    url: '{{apiUrl}}',
    method: 'POST',
    auth: 'bearer',
    body: { from: '{{from}}', to: '{{to}}', subject: '{{subject}}', html: '{{body}}' },
    inputs: [
      { name: 'to', type: 'string', required: true },
      { name: 'subject', type: 'string', required: true },
      { name: 'body', type: 'string', required: true },
      { name: 'from', type: 'string' },
    ],
    credentials: ['apiUrl', 'token'],
    outputs: [{ name: 'id', type: 'string' }],
  },

  // ─── Data ──────────────────────────────────────────────────
  {
    type: 'json.parse',
    name: 'JSON Parse',
    category: 'data',
    description: 'Parse JSON string to object',
    inputs: [{ name: 'text', type: 'string', required: true }],
    outputs: [{ name: 'data', type: 'object' }],
    handler: async (inputs) => JSON.parse(inputs.text),
  },
  {
    type: 'json.stringify',
    name: 'JSON Stringify',
    category: 'data',
    description: 'Convert object to JSON string',
    inputs: [{ name: 'data', type: 'any', required: true }],
    outputs: [{ name: 'text', type: 'string' }],
    handler: async (inputs) => JSON.stringify(inputs.data, null, 2),
  },
  {
    type: 'text.template',
    name: 'Text Template',
    category: 'data',
    description: 'Render text with {{variable}} placeholders',
    inputs: [
      { name: 'template', type: 'string', required: true },
      { name: 'data', type: 'object' },
    ],
    outputs: [{ name: 'text', type: 'string' }],
    handler: async (inputs) => {
      let tpl = inputs.template || '';
      for (const [k, v] of Object.entries(inputs.data || {})) {
        tpl = tpl.split(`{{${k}}}`).join(String(v ?? ''));
      }
      return tpl;
    },
  },
  {
    type: 'base64.encode',
    name: 'Base64 Encode',
    category: 'data',
    description: 'Encode text to Base64',
    inputs: [{ name: 'text', type: 'string', required: true }],
    outputs: [{ name: 'encoded', type: 'string' }],
    handler: async (inputs) => btoa(unescape(encodeURIComponent(inputs.text))),
  },
  {
    type: 'base64.decode',
    name: 'Base64 Decode',
    category: 'data',
    description: 'Decode Base64 to text',
    inputs: [{ name: 'encoded', type: 'string', required: true }],
    outputs: [{ name: 'text', type: 'string' }],
    handler: async (inputs) => decodeURIComponent(escape(atob(inputs.encoded))),
  },
  {
    type: 'math.calc',
    name: 'Math Operation',
    category: 'data',
    description: 'Perform math: add, subtract, multiply, divide, round, etc.',
    inputs: [
      { name: 'a', type: 'number', required: true },
      { name: 'operation', type: 'string', default: 'add' },
      { name: 'b', type: 'number' },
    ],
    outputs: [{ name: 'result', type: 'number' }],
    handler: async ({ a, operation, b }) => {
      switch (operation) {
        case 'add': return a + (b || 0);
        case 'subtract': return a - (b || 0);
        case 'multiply': return a * (b || 1);
        case 'divide': return b ? a / b : 0;
        case 'round': return Math.round(a);
        case 'floor': return Math.floor(a);
        case 'ceil': return Math.ceil(a);
        case 'abs': return Math.abs(a);
        default: return a;
      }
    },
  },
  {
    type: 'datetime.now',
    name: 'Current Date/Time',
    category: 'data',
    description: 'Get current date and time',
    inputs: [{ name: 'format', type: 'string', default: 'iso' }],
    outputs: [{ name: 'datetime', type: 'string' }],
    handler: async (inputs) => {
      const now = new Date();
      if (inputs.format === 'timestamp') return now.getTime();
      return now.toISOString();
    },
  },

  // ─── AI / LLM ─────────────────────────────────────────────
  {
    type: 'openai.chat',
    name: 'OpenAI: Chat Completion',
    category: 'ai',
    description: 'Call OpenAI Chat API',
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    auth: 'bearer',
    body: {
      model: '{{model}}',
      messages: [{ role: 'user', content: '{{prompt}}' }],
    },
    inputs: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'model', type: 'string', default: 'gpt-4o-mini' },
    ],
    credentials: ['token'],
    outputs: [{ name: 'response', type: 'object' }],
  },
  {
    type: 'anthropic.chat',
    name: 'Anthropic: Message',
    category: 'ai',
    description: 'Call Anthropic Messages API',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: { 'x-api-key': '{{apiKey}}', 'anthropic-version': '2023-06-01' },
    body: {
      model: '{{model}}',
      max_tokens: 1024,
      messages: [{ role: 'user', content: '{{prompt}}' }],
    },
    inputs: [
      { name: 'prompt', type: 'string', required: true },
      { name: 'model', type: 'string', default: 'claude-sonnet-4-20250514' },
    ],
    credentials: ['apiKey'],
    outputs: [{ name: 'response', type: 'object' }],
  },
];

export { BUILTIN_NODES };
