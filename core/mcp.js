/**
 * MCP Server (Model Context Protocol)
 * JSON-RPC 2.0 over stdio. Zero dependencies.
 * Every Automators Kit instance is an MCP server.
 *
 * Usage:
 *   node mcp.js                    # standalone
 *   import { createMCPServer } from './core/mcp.js'  # embedded
 */

import { createInterface } from 'node:readline';
import { validate } from './validate.js';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

function jsonrpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message, data) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

// Response-object builders (plain objects, not serialized) used by the
// pure request handler so the dispatch logic is unit-testable without stdio.
function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcMethodError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcToolError(id, message) {
  // MCP tool errors are still `result` payloads with isError: true (same shape
  // the rest of this module uses for unknown-tool / handler errors).
  return rpcOk(id, {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  });
}

// Generic message sent to the MCP client when a tool handler (or the dispatch
// loop itself) throws. The real `err.message` is logged server-side via
// console.error only — never serialized into the client-facing `content`,
// since it may leak internals (filesystem paths, adapter details, stack info).
const TOOL_INTERNAL_ERROR_MESSAGE = 'Internal error processing tool call';

// ---------------------------------------------------------------------------
// ARGUMENT VALIDATION (reuses core/validate.js)
// ---------------------------------------------------------------------------

/**
 * Validate MCP tool `arguments` against a tool's JSON-Schema-style
 * `inputSchema` by adapting it to the flat schema format used by
 * core/validate.js. Enforces, at minimum:
 *   (a) every field in `inputSchema.required` is present in `args`,
 *   (b) declared properties match their basic type
 *       (string/number/boolean/object/array).
 * Unknown fields are left untouched (handlers opt into the fields they
 * destructure; we do not strip extras here).
 *
 * @param {object} inputSchema - JSON-Schema-style { type, properties, required }
 * @param {object} args - arguments from the MCP caller
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateToolArgs(inputSchema, args) {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { valid: true, errors: [] };
  }

  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const properties = inputSchema.properties || {};

  // Adapt JSON-Schema-style { properties: { k: { type, enum, ... } }, required: [...] }
  // to validate.js's flat { k: { type, required, enum, ... } }.
  const flatSchema = {};
  for (const [key, prop] of Object.entries(properties)) {
    flatSchema[key] = { ...prop, required: required.includes(key) };
  }

  const result = validate(flatSchema, args || {});
  return { valid: result.valid, errors: result.errors };
}

// ---------------------------------------------------------------------------
// USER SANITIZATION (defense-in-depth at the MCP boundary)
// ---------------------------------------------------------------------------

/**
 * Fields that must never travel to an MCP client (the agent). The user store
 * in core/cms.js already strips `passwordHash`/`password` via UserService
 * .safeUser(); this is a second layer that also catches any future or
 * plugin-supplied sensitive fields by name.
 */
const SENSITIVE_USER_KEYS = [
  'passwordHash', 'password', 'secret', 'salt',
  'totpSecret', 'token', 'refreshToken', 'accessToken', 'apiKey',
];

function sanitizeUser(user) {
  if (user == null) return user;
  if (Array.isArray(user)) return user.map(sanitizeUser);
  const clean = { ...user };
  for (const key of SENSITIVE_USER_KEYS) delete clean[key];
  return clean;
}

// ---------------------------------------------------------------------------
// TOOL REGISTRY
// ---------------------------------------------------------------------------

/**
 * Build CMS tools from a CMS instance.
 * @param {import('./cms.js').CMS} cms
 * @returns {Record<string, { description: string, inputSchema: object, handler: Function }>}
 */
function buildTools(cms) {
  return {
    // --- Content Types ---
    list_content_types: {
      description: 'List all content types',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => cms.contentTypes.findAll(),
    },
    get_content_type: {
      description: 'Get a content type by slug',
      inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'Content type slug' } }, required: ['slug'] },
      handler: async ({ slug }) => cms.contentTypes.findBySlug(slug),
    },
    create_content_type: {
      description: 'Create a new content type',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name' },
          slug: { type: 'string', description: 'URL-friendly identifier' },
          description: { type: 'string' },
          fields: { type: 'array', description: 'Array of field definitions' },
        },
        required: ['name', 'slug'],
      },
      handler: async (args) => cms.contentTypes.create(args),
    },
    delete_content_type: {
      description: 'Delete a content type by slug',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      handler: async ({ slug }) => cms.contentTypes.delete(slug),
    },

    // --- Entries ---
    list_entries: {
      description: 'List entries with optional filters (contentType, status, search, page, limit)',
      inputSchema: {
        type: 'object',
        properties: {
          contentType: { type: 'string', description: 'Content type slug' },
          status: { type: 'string', enum: ['draft', 'published', 'archived'] },
          search: { type: 'string' },
          page: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      handler: async (args) => cms.entries.findAll(args),
    },
    get_entry: {
      description: 'Get an entry by ID',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => cms.entries.findById(id),
    },
    create_entry: {
      description: 'Create a new entry',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          contentTypeSlug: { type: 'string' },
          content: { type: 'object' },
          status: { type: 'string', enum: ['draft', 'published'] },
          slug: { type: 'string' },
        },
        required: ['title', 'contentTypeSlug'],
      },
      handler: async (args) => cms.entries.create(args, 'mcp-agent'),
    },
    update_entry: {
      description: 'Update an entry by ID',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'object' },
          status: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['id'],
      },
      handler: async ({ id, ...data }) => cms.entries.update(id, data),
    },
    delete_entry: {
      description: 'Delete an entry by ID',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => cms.entries.delete(id),
    },
    publish_entry: {
      description: 'Publish an entry',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => cms.entries.publish(id),
    },
    unpublish_entry: {
      description: 'Unpublish an entry (back to draft)',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => cms.entries.unpublish(id),
    },

    // --- Taxonomies ---
    list_taxonomies: {
      description: 'List all taxonomies',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => cms.taxonomies.findAll(),
    },
    create_taxonomy: {
      description: 'Create a taxonomy',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, slug: { type: 'string' }, hierarchical: { type: 'boolean' } },
        required: ['name', 'slug'],
      },
      handler: async (args) => cms.taxonomies.create(args),
    },
    delete_taxonomy: {
      description: 'Delete a taxonomy by slug',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      handler: async ({ slug }) => cms.taxonomies.delete(slug),
    },

    // --- Terms ---
    list_terms: {
      description: 'List terms of a taxonomy',
      inputSchema: { type: 'object', properties: { taxonomySlug: { type: 'string' } }, required: ['taxonomySlug'] },
      handler: async ({ taxonomySlug }) => cms.terms.findByTaxonomy(taxonomySlug),
    },
    create_term: {
      description: 'Create a term in a taxonomy',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, slug: { type: 'string' }, taxonomySlug: { type: 'string' }, parentId: { type: 'string' } },
        required: ['name', 'taxonomySlug'],
      },
      handler: async (args) => cms.terms.create(args),
    },

    // --- Users (sanitized: sensitive fields never reach the MCP client) ---
    list_users: {
      description: 'List all users',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => sanitizeUser(cms.users.findAll()),
    },
    get_user: {
      description: 'Get user by ID',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => sanitizeUser(cms.users.findById(id)),
    },

    // --- Structure ---
    get_structure: {
      description: 'Get full CMS structure (content types + taxonomies)',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        contentTypes: cms.contentTypes.findAll(),
        taxonomies: cms.taxonomies.findAll(),
        terms: cms.taxonomies.findAll().flatMap(t => cms.terms.findByTaxonomy(t.slug)),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// REQUEST DISPATCH (pure, testable — no stdio)
// ---------------------------------------------------------------------------

/**
 * Handle a single parsed JSON-RPC request against a tool registry.
 * Returns a JSON-RPC response object, or `null` for notifications
 * (which require no response). Thrown handler errors propagate to the
 * caller (the stdio loop turns them into tool-error responses).
 *
 * @param {{ id?: any, method: string, params?: object }} request
 * @param {Record<string, { description: string, inputSchema: object, handler: Function }>} allTools
 * @returns {Promise<object|null>}
 */
export async function handleMCPRequest(request, allTools) {
  const { id, method, params } = request || {};

  switch (method) {
    // MCP: Initialize
    case 'initialize': {
      return rpcOk(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'automators-kit', version: '2.0.0' },
      });
    }

    // MCP: List tools
    case 'tools/list': {
      const tools = Object.entries(allTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return rpcOk(id, { tools });
    }

    // MCP: Call tool
    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const tool = allTools[toolName];

      if (!tool) {
        return rpcToolError(id, `Unknown tool: ${toolName}`);
      }

      // Validate arguments against the tool's inputSchema before invoking
      // the handler. Reject missing required fields and wrong basic types.
      const check = validateToolArgs(tool.inputSchema, args);
      if (!check.valid) {
        return rpcToolError(id, `Invalid arguments: ${check.errors.join(', ')}`);
      }

      try {
        const result = await tool.handler(args);
        return rpcOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        // Log the real error server-side only; send the agent a generic
        // message so internals (paths, adapter details) never leak to the
        // MCP client via the `content` payload.
        console.error(`[mcp] tool '${toolName}' failed: ${err?.message ?? err}`);
        return rpcToolError(id, TOOL_INTERNAL_ERROR_MESSAGE);
      }
    }

    // MCP: Notifications (no response needed)
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    default:
      return rpcMethodError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// MCP SERVER
// ---------------------------------------------------------------------------

/**
 * Create and start an MCP server over stdio.
 * @param {import('./cms.js').CMS} cms
 * @param {Record<string, object>} extraTools - Additional tools from plugins
 */
export function createMCPServer(cms, extraTools = {}) {
  const cmsTools = buildTools(cms);
  const allTools = { ...cmsTools, ...extraTools };

  const rl = createInterface({ input: process.stdin, terminal: false });

  function send(msg) {
    process.stdout.write(msg + '\n');
  }

  rl.on('line', async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send(jsonrpcError(null, -32700, 'Parse error'));
      return;
    }

    try {
      const response = await handleMCPRequest(request, allTools);
      if (response) send(JSON.stringify(response));
    } catch (err) {
      // Defensive: handleMCPRequest already catches handler errors and
      // returns a generic tool-error. This catches anything else that escapes
      // the dispatcher. The real message stays server-side only.
      console.error(`[mcp] dispatch error: ${err?.message ?? err}`);
      send(jsonrpcResponse(request?.id, {
        content: [{ type: 'text', text: JSON.stringify({ error: TOOL_INTERNAL_ERROR_MESSAGE }) }],
        isError: true,
      }));
    }
  });

  rl.on('close', () => {
    cms.shutdown().catch(() => {});
    process.exit(0);
  });

  // Log to stderr (not stdout — stdout is for JSON-RPC)
  console.error('Automators Kit MCP server running on stdio');

  return { tools: allTools };
}

/**
 * Get tool definitions without starting the server (for plugin registration).
 */
export { buildTools };