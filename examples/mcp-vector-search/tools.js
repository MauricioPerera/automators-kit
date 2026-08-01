/**
 * Adapts examples/vector-memory's own `buildVectorTools(store)` handlers
 * (index/search/forget/stats — already shaped as `async (args) => {...}`)
 * into MCP tools (`{description, inputSchema, handler}`, the shape
 * `createMCPServer`'s `extraTools` expects) — reused directly, same
 * precedent as examples/mcp-job-queue reusing examples/job-queue's own
 * tools.js, rather than reimplementing the embed/search logic here.
 */

import { buildVectorTools } from '../vector-memory/tools.js';

/** @param {import('../../core/vector.js').VectorStore} store */
export function buildMcpVectorTools(store) {
  const handlers = buildVectorTools(store);

  return {
    index_note: {
      description: 'Embed and store a note for later semantic search.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note content to embed and store' },
          tag: { type: 'string', description: 'Optional tag for filtering search results later' },
          id: { type: 'string', description: 'Optional id (auto-generated if omitted)' },
        },
        required: ['text'],
      },
      handler: handlers.index,
    },
    search_notes: {
      description: 'Semantic search: find stored notes similar in MEANING (word-overlap, not just keyword match) to the query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          tag: { type: 'string', description: 'Optional: only search notes with this tag' },
        },
        required: ['query'],
      },
      handler: handlers.search,
    },
    forget_note: {
      description: 'Remove a stored note by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: handlers.forget,
    },
    note_stats: {
      description: 'How many notes are currently indexed.',
      inputSchema: { type: 'object', properties: {} },
      handler: handlers.stats,
    },
  };
}
