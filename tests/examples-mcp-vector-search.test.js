/**
 * MCP Vector Search — end-to-end regression test.
 * Mirrors mcp-server.js's tool wiring (reuses tools.js's
 * buildMcpVectorTools, itself reusing examples/vector-memory's
 * buildVectorTools) via handleMCPRequest() directly -- pure dispatcher,
 * no real stdio process needed for testing (same pattern
 * tests/examples-agent-memory-backend.test.js uses).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { VectorStore, MemoryStorageAdapter as VectorMemoryAdapter } from '../core/vector.js';
import { handleMCPRequest } from '../core/mcp.js';
import { buildMcpVectorTools } from '../examples/mcp-vector-search/tools.js';

let store, tools;

async function callMcp(name, args) {
  const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);
  expect(res.error).toBeUndefined();
  return JSON.parse(res.result.content[0].text);
}

beforeAll(() => {
  store = new VectorStore(new VectorMemoryAdapter(), 64);
  tools = buildMcpVectorTools(store);
});

describe('MCP vector search: only the 4 vector tools are exposed (includeCmsTools: false in the real server)', () => {
  it('tools/list exposes exactly index_note/search_notes/forget_note/note_stats, no CMS tools', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools);
    const names = res.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['forget_note', 'index_note', 'note_stats', 'search_notes']);
  });
});

describe('MCP vector search: real semantic search over stdio-shaped tool calls', () => {
  it('index_note then search_notes ranks the shared-vocabulary note above an unrelated one', async () => {
    // The offline hashing-trick embedding (see examples/vector-memory/embed.js)
    // ranks by real word overlap, not paraphrase/synonym understanding
    // (already documented in examples/hybrid-recall) -- this query shares
    // actual words with the finance note, not just the same topic.
    await callMcp('index_note', { text: 'The quarterly revenue report shows strong growth.', tag: 'finance' });
    await callMcp('index_note', { text: 'Cats are independent, low-maintenance pets.', tag: 'animals' });

    const results = await callMcp('search_notes', { query: 'quarterly revenue growth' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tag).toBe('finance');
  });

  it('search_notes respects the tag filter', async () => {
    await callMcp('index_note', { text: 'Dogs are loyal companions.', tag: 'animals' });
    const results = await callMcp('search_notes', { query: 'revenue growth', tag: 'animals', limit: 10 });
    expect(results.every((r) => r.tag === 'animals')).toBe(true);
  });

  it('forget_note removes it from future search results', async () => {
    const { id } = await callMcp('index_note', { text: 'A note that will be forgotten.' });
    const before = await callMcp('search_notes', { query: 'forgotten note', limit: 10 });
    expect(before.some((r) => r.id === id)).toBe(true);

    await callMcp('forget_note', { id });
    const after = await callMcp('search_notes', { query: 'forgotten note', limit: 10 });
    expect(after.some((r) => r.id === id)).toBe(false);
  });

  it('note_stats reflects the real indexed count', async () => {
    const before = await callMcp('note_stats', {});
    await callMcp('index_note', { text: 'One more note for stats tracking.' });
    const after = await callMcp('note_stats', {});
    expect(after.count).toBe(before.count + 1);
  });

  it('a missing required field (query) returns a real MCP tool error, not a crash', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: {} } }, tools);
    expect(res.result.isError).toBe(true);
  });
});
