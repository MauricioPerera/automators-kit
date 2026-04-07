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

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

function jsonrpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message, data) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
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

    // --- Users ---
    list_users: {
      description: 'List all users',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => cms.users.findAll(),
    },
    get_user: {
      description: 'Get user by ID',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => cms.users.findById(id),
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

    const { id, method, params } = request;

    try {
      switch (method) {
        // MCP: Initialize
        case 'initialize': {
          send(jsonrpcResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'automators-kit', version: '2.0.0' },
          }));
          break;
        }

        // MCP: List tools
        case 'tools/list': {
          const tools = Object.entries(allTools).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));
          send(jsonrpcResponse(id, { tools }));
          break;
        }

        // MCP: Call tool
        case 'tools/call': {
          const toolName = params?.name;
          const args = params?.arguments || {};
          const tool = allTools[toolName];

          if (!tool) {
            send(jsonrpcResponse(id, {
              content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
              isError: true,
            }));
            break;
          }

          const result = await tool.handler(args);
          send(jsonrpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }));
          break;
        }

        // MCP: Notifications (no response needed)
        case 'notifications/initialized':
        case 'notifications/cancelled':
          break;

        default:
          send(jsonrpcError(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      send(jsonrpcResponse(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
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
