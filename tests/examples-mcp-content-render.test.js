/**
 * MCP Content Render — end-to-end regression test.
 * Mirrors mcp-server.js's tool wiring via handleMCPRequest() directly
 * (pure dispatcher, no real stdio process needed for testing, same
 * pattern tests/examples-mcp-vector-search.test.js and
 * tests/examples-mcp-vault.test.js use).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { handleMCPRequest } from '../core/mcp.js';
import { buildMcpContentTools } from '../examples/mcp-content-render/tools.js';

let tools;

async function callMcp(name, args) {
  const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);
  expect(res.error).toBeUndefined();
  return JSON.parse(res.result.content[0].text);
}

beforeAll(() => {
  tools = buildMcpContentTools();
});

describe('MCP content render: only the 3 portable-text tools are exposed', () => {
  it('tools/list exposes exactly render_markdown/normalize_markdown/find_blocks', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools);
    const names = res.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['find_blocks', 'normalize_markdown', 'render_markdown']);
  });
});

const SAMPLE = `# Launch Day

We shipped **v2.0** today, with a new dashboard.

\`\`\`js
console.log('hello');
\`\`\`

- Faster search
- Dark mode
`;

describe('MCP content render: real markdown rendering, round-trip, and structural queries', () => {
  it('render_markdown returns HTML, plain text, word count, and an excerpt from the SAME parsed blocks', async () => {
    const result = await callMcp('render_markdown', { markdown: SAMPLE });
    expect(result.html).toContain('<h1');
    expect(result.html).toContain('<strong>v2.0</strong>');
    expect(result.plainText).toContain('Launch Day');
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it('normalize_markdown round-trips through blocks and re-serializes to canonical markdown', async () => {
    const result = await callMcp('normalize_markdown', { markdown: SAMPLE });
    expect(typeof result.markdown).toBe('string');
    // Re-parsing the normalized output must produce the same rendered HTML --
    // the point of normalization is stable structure, not identical bytes.
    const reRendered = await callMcp('render_markdown', { markdown: result.markdown });
    const original = await callMcp('render_markdown', { markdown: SAMPLE });
    expect(reRendered.html).toBe(original.html);
  });

  it("find_blocks with type='code' extracts exactly the fenced code block", async () => {
    const result = await callMcp('find_blocks', { markdown: SAMPLE, type: 'code' });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].language).toBe('js');
    expect(result.blocks[0].code).toContain("console.log('hello')");
  });

  it("find_blocks with type='heading' returns the document's outline", async () => {
    const result = await callMcp('find_blocks', { markdown: SAMPLE, type: 'heading' });
    expect(result.blocks).toEqual([{ type: 'heading', level: 1, text: 'Launch Day' }]);
  });

  it("find_blocks with a type not present in the document returns an empty array, not an error", async () => {
    const result = await callMcp('find_blocks', { markdown: SAMPLE, type: 'quote' });
    expect(result.blocks).toEqual([]);
  });

  it('a missing required field returns a real MCP tool error, not a crash', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'render_markdown', arguments: {} } }, tools);
    expect(res.result.isError).toBe(true);
  });
});
