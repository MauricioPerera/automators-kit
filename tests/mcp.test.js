/**
 * Tests: core/mcp.js
 * MCP JSON-RPC dispatch: argument validation + user sanitization.
 *
 * These tests drive the pure `handleMCPRequest` dispatcher (no stdio) with a
 * fake CMS so behavior is asserted without spawning the readline loop.
 */

import { describe, it, expect } from 'bun:test';
import { buildTools, handleMCPRequest, buildAllTools } from '../core/mcp.js';

// ---------------------------------------------------------------------------
// Fake CMS + spies
// ---------------------------------------------------------------------------

function makeFakeCms() {
  const calls = { findBySlug: [], findAllUsers: [], findByIdUser: [] };

  return {
    calls,
    contentTypes: {
      findAll: () => [{ slug: 'post', name: 'Post' }],
      findBySlug: (slug) => {
        calls.findBySlug.push(slug);
        return { slug, name: 'Post' };
      },
    },
    // Users returned RAW (with sensitive fields) to prove the MCP layer strips
    // them regardless of what the underlying store exposes.
    users: {
      findAll: () => {
        calls.findAllUsers.push(true);
        return [
          { _id: 'u1', email: 'a@b.com', name: 'A', role: 'admin',
            passwordHash: 'hash-1', token: 'tok-1', totpSecret: 'totp-1', salt: 'salt-1' },
          { _id: 'u2', email: 'c@d.com', name: 'C', role: 'viewer',
            password: 'plain-pw', secret: 's-2', refreshToken: 'rt-2' },
        ];
      },
      findById: (id) => {
        calls.findByIdUser.push(id);
        return { _id: id, email: 'a@b.com', name: 'A', role: 'admin',
          passwordHash: 'hash-1', token: 'tok-1', totpSecret: 'totp-1', apiKey: 'k-1' };
      },
    },
    // Unused by the tests below but kept for completeness.
    entries: { findAll: () => ({ entries: [], total: 0 }), findById: () => null,
      create: () => ({}), update: () => ({}), delete: () => ({}),
      publish: () => ({}), unpublish: () => ({}) },
    taxonomies: { findAll: () => [], create: () => ({}), delete: () => ({}) },
    terms: { findByTaxonomy: () => [], create: () => ({}) },
  };
}

function parseContentText(response) {
  const text = response.result.content[0].text;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// tools/call — argument validation (Hallazgo 1)
// ---------------------------------------------------------------------------

describe('MCP tools/call argument validation', () => {
  it('rejects missing required field without invoking the handler', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    // get_content_type requires `slug`; omit it.
    const res = await handleMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'get_content_type', arguments: {} } },
      tools,
    );

    expect(res.result.isError).toBe(true);
    const body = parseContentText(res);
    expect(body.error).toMatch(/slug/i);
    // Handler must NOT have been called.
    expect(cms.calls.findBySlug.length).toBe(0);
  });

  it('rejects wrong type (number where string is expected)', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    const res = await handleMCPRequest(
      { id: 2, method: 'tools/call', params: { name: 'get_content_type', arguments: { slug: 123 } } },
      tools,
    );

    expect(res.result.isError).toBe(true);
    const body = parseContentText(res);
    expect(body.error).toMatch(/slug/i);
    expect(body.error).toMatch(/string/i);
    expect(cms.calls.findBySlug.length).toBe(0);
  });

  it('accepts valid args and invokes the handler exactly as before', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    const res = await handleMCPRequest(
      { id: 3, method: 'tools/call', params: { name: 'get_content_type', arguments: { slug: 'post' } } },
      tools,
    );

    expect(res.result.isError).toBeUndefined();
    expect(cms.calls.findBySlug).toEqual(['post']);
    const body = parseContentText(res);
    expect(body.slug).toBe('post');
    expect(body.name).toBe('Post');
  });

  it('rejects wrong type on a numeric field', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    // list_entries.page is type:number; pass a string.
    const res = await handleMCPRequest(
      { id: 4, method: 'tools/call', params: { name: 'list_entries', arguments: { page: 'not-a-number' } } },
      tools,
    );

    expect(res.result.isError).toBe(true);
    const body = parseContentText(res);
    expect(body.error).toMatch(/page/i);
  });

  it('rejects enum violation', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    // list_entries.status enum: draft|published|archived
    const res = await handleMCPRequest(
      { id: 5, method: 'tools/call', params: { name: 'list_entries', arguments: { status: 'bogus' } } },
      tools,
    );

    expect(res.result.isError).toBe(true);
    const body = parseContentText(res);
    expect(body.error).toMatch(/status/i);
  });

  it('returns tool error for unknown tool', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    const res = await handleMCPRequest(
      { id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      tools,
    );

    expect(res.result.isError).toBe(true);
    const body = parseContentText(res);
    expect(body.error).toMatch(/Unknown tool/);
  });
});

// ---------------------------------------------------------------------------
// User sanitization (Hallazgo 2)
// ---------------------------------------------------------------------------

describe('MCP user sanitization', () => {
  const SENSITIVE = ['passwordHash', 'password', 'secret', 'salt', 'totpSecret', 'token', 'refreshToken', 'apiKey'];

  it('list_users strips sensitive fields even though the store exposes them', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    const res = await handleMCPRequest(
      { id: 7, method: 'tools/call', params: { name: 'list_users', arguments: {} } },
      tools,
    );

    const users = parseContentText(res);
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBe(2);
    for (const u of users) {
      for (const key of SENSITIVE) {
        expect(u[key]).toBeUndefined();
      }
    }
    expect(users[0].email).toBe('a@b.com');
    expect(users[1].name).toBe('C');
  });

  it('get_user strips sensitive fields even though the store exposes them', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);

    const res = await handleMCPRequest(
      { id: 8, method: 'tools/call', params: { name: 'get_user', arguments: { id: 'u1' } } },
      tools,
    );

    const user = parseContentText(res);
    expect(user._id).toBe('u1');
    for (const key of SENSITIVE) {
      expect(user[key]).toBeUndefined();
    }
    expect(user.email).toBe('a@b.com');
  });
});

// ---------------------------------------------------------------------------
// Basic dispatch (regression)
// ---------------------------------------------------------------------------

describe('MCP basic dispatch', () => {
  it('initialize returns server info', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);
    const res = await handleMCPRequest({ id: 1, method: 'initialize' }, tools);
    expect(res.result.serverInfo.name).toBe('automators-kit');
    expect(res.result.protocolVersion).toBe('2024-11-05');
  });

  it('tools/list exposes schemas', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);
    const res = await handleMCPRequest({ id: 2, method: 'tools/list' }, tools);
    const names = res.result.tools.map(t => t.name);
    expect(names).toContain('get_content_type');
    expect(names).toContain('list_users');
    expect(res.result.tools[0].inputSchema).toBeDefined();
  });

  it('notifications return null (no response)', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);
    const res = await handleMCPRequest({ method: 'notifications/initialized' }, tools);
    expect(res).toBeNull();
  });

  it('unknown method returns JSON-RPC error', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);
    const res = await handleMCPRequest({ id: 9, method: 'foo/bar' }, tools);
    expect(res.error.code).toBe(-32601);
  });
});

// ---------------------------------------------------------------------------
// Tool error sanitization (Hallazgo 3 — LOW: err.message leak)
// ---------------------------------------------------------------------------

describe('MCP tool error sanitization', () => {
  it('returns a generic error and does NOT leak the internal err.message', async () => {
    const cms = makeFakeCms();
    const tools = buildTools(cms);
    const secret = 'ENOENT /secret/path';

    // A plugin-supplied tool whose handler throws an internal error carrying
    // sensitive details (a filesystem path). The MCP client (agent) must only
    // see a generic message; the real message is logged server-side.
    const toolRegistry = {
      ...tools,
      boom: {
        description: 'always throws',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => { throw new Error(secret); },
      },
    };

    const res = await handleMCPRequest(
      { id: 10, method: 'tools/call', params: { name: 'boom', arguments: {} } },
      toolRegistry,
    );

    expect(res.result.isError).toBe(true);
    const text = res.result.content[0].text;
    // The internal message must not appear anywhere in the client payload.
    expect(text).not.toContain(secret);
    expect(text).not.toContain('/secret/path');
    const body = JSON.parse(text);
    expect(body.error).toMatch(/internal error processing tool call/i);
  });
});

// ---------------------------------------------------------------------------
// buildAllTools — opts.includeCmsTools (point #3 from the 6-examples review)
// ---------------------------------------------------------------------------

describe('buildAllTools: opts.includeCmsTools', () => {
  it('defaults to including the base CMS tools alongside extraTools', () => {
    const cms = makeFakeCms();
    const allTools = buildAllTools(cms, { my_tool: { description: 'x', inputSchema: {}, handler: async () => {} } });
    expect(Object.keys(allTools)).toContain('list_entries');
    expect(Object.keys(allTools)).toContain('my_tool');
  });

  it('includeCmsTools: false excludes every base CMS tool, keeping only extraTools', () => {
    const cms = makeFakeCms();
    const allTools = buildAllTools(
      cms,
      { my_tool: { description: 'x', inputSchema: {}, handler: async () => {} } },
      { includeCmsTools: false },
    );
    expect(Object.keys(allTools)).toEqual(['my_tool']);
    expect(allTools.list_entries).toBeUndefined();
    expect(allTools.create_entry).toBeUndefined();
  });

  it('a purpose-built tool set still dispatches correctly through handleMCPRequest', async () => {
    const cms = makeFakeCms();
    const allTools = buildAllTools(
      cms,
      { echo: { description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] }, handler: async (args) => ({ echoed: args.msg }) } },
      { includeCmsTools: false },
    );

    const listRes = await handleMCPRequest({ id: 1, method: 'tools/list' }, allTools);
    expect(listRes.result.tools.map((t) => t.name)).toEqual(['echo']);

    const callRes = await handleMCPRequest({ id: 2, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } } }, allTools);
    expect(parseContentText(callRes)).toEqual({ echoed: 'hi' });
  });
});