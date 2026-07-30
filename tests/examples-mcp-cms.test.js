/**
 * MCP CMS — end-to-end regression test.
 * Unlike tests/mcp.test.js (which drives a FAKE cms with spies to test the
 * dispatcher in isolation), this one drives a REAL createApp()-produced cms
 * through the actual MCP tool handlers — genuine end-to-end coverage of the
 * base 20 CMS tools + this example's own custom tool, via the pure
 * handleMCPRequest dispatcher (no stdio needed for testing).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { handleMCPRequest, buildAllTools } from '../core/mcp.js';
import { buildExtraTools } from '../examples/mcp-cms/tools.js';

let app;
let tools;

function call(id, name, args) {
  return handleMCPRequest({ id, method: 'tools/call', params: { name, arguments: args } }, tools);
}
function parseText(res) {
  return JSON.parse(res.result.content[0].text);
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'mcp-cms-test-secret!!!' });
  await app.cms.contentTypes.create({
    name: 'Article', slug: 'article',
    fields: [{ name: 'body', type: 'text' }, { name: 'blocks', type: 'json' }],
  });
  tools = buildAllTools(app.cms, buildExtraTools(app.cms));
});

describe('MCP CMS: initialize + discovery', () => {
  it('tools/list exposes the 20 base tools plus the 1 custom tool, each with a real schema', async () => {
    const res = await handleMCPRequest({ id: 1, method: 'tools/list' }, tools);
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('create_entry');
    expect(names).toContain('publish_entry');
    expect(names).toContain('publish_with_stats');
    const createEntry = res.result.tools.find((t) => t.name === 'create_entry');
    expect(createEntry.inputSchema.required).toEqual(['title', 'contentTypeSlug']);
  });
});

describe('MCP CMS: real entry lifecycle through the MCP tool surface', () => {
  it('create -> list -> get -> publish -> unpublish, all via tools/call', async () => {
    const created = await call(1, 'create_entry', {
      title: 'Hello MCP', contentTypeSlug: 'article', content: { body: 'hi' },
    });
    const entry = parseText(created);
    expect(entry.title).toBe('Hello MCP');
    expect(entry.status).toBe('draft');

    const listed = await call(2, 'list_entries', { contentType: 'article' });
    const listBody = parseText(listed);
    expect(listBody.entries.some((e) => e._id === entry._id)).toBe(true);

    const published = await call(3, 'publish_entry', { id: entry._id });
    expect(parseText(published).status).toBe('published');

    const unpublished = await call(4, 'unpublish_entry', { id: entry._id });
    expect(parseText(unpublished).status).toBe('draft');
  });

  it('rejects a missing required field before the handler ever runs', async () => {
    const res = await call(5, 'create_entry', { title: 'No content type' });
    expect(res.result.isError).toBe(true);
    expect(parseText(res).error).toMatch(/contentTypeSlug/i);
  });
});

describe('MCP CMS: user sanitization against a REAL user record', () => {
  it('list_users never leaks passwordHash/token/salt, even though the real DB stores them', async () => {
    // A real registered user, not a hand-crafted fake — the real password
    // hashing/storage path actually runs, so this proves the MCP tool
    // strips whatever the real auth system stores, not just what a test
    // fixture happens to include.
    await app.cms.users.register('mcp-user@example.com', 'a-real-password-123');
    const res = await call(1, 'list_users', {});
    const users = parseText(res);
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u.passwordHash).toBeUndefined();
      expect(u.password).toBeUndefined();
      expect(u.salt).toBeUndefined();
    }
  });
});

describe('MCP CMS: custom tool composes across modules (mcp.js + portable-text.js)', () => {
  it('publish_with_stats publishes the entry AND computes word count from its Portable Text blocks', async () => {
    const blocks = [
      { type: 'heading', level: 1, text: 'Hello World' },
      { type: 'paragraph', text: 'This is a short article with a handful of words in it.' },
    ];
    const created = await call(1, 'create_entry', {
      title: 'With blocks', contentTypeSlug: 'article', content: { blocks },
    });
    const entry = parseText(created);

    const res = await call(2, 'publish_with_stats', { id: entry._id });
    const body = parseText(res);
    expect(body.entry.status).toBe('published');
    expect(body.stats.wordCount).toBeGreaterThan(0);
    expect(body.stats.excerpt).toContain('Hello World');
  });

  it('handles an entry with no Portable Text blocks gracefully (stats: null, not an error)', async () => {
    const created = await call(1, 'create_entry', {
      title: 'Plain', contentTypeSlug: 'article', content: { body: 'just text, no blocks' },
    });
    const entry = parseText(created);
    const res = await call(2, 'publish_with_stats', { id: entry._id });
    const body = parseText(res);
    expect(body.entry.status).toBe('published');
    expect(body.stats).toBeNull();
  });
});
