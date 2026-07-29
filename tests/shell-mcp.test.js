/**
 * Tests: core/shell-mcp.js — the 2-tool MCP port of Agent-Shell's McpServer.
 *
 * Drives the pure `handleShellMCPRequest` dispatcher (no stdio) against a
 * real `Shell` instance, so behavior is asserted without spawning the
 * readline loop (same testability shape as tests/mcp.test.js).
 */

import { describe, it, expect } from 'bun:test';
import { Shell, AGENT_PROFILES } from '../core/shell.js';
import { handleShellMCPRequest } from '../core/shell-mcp.js';

function makeShell(profile = 'admin') {
  const shell = new Shell({ profile, permissions: AGENT_PROFILES[profile] });
  shell.registry.register('users', 'list', {
    description: 'List users',
    params: [{ name: 'limit', type: 'number' }],
  }, async () => ['alice', 'bob']);
  return shell;
}

function parseResultText(res) {
  return JSON.parse(res.result.content[0].text);
}

// ---------------------------------------------------------------------------
// Initialization gate (per MCP spec: tools/* rejected before initialize)
// ---------------------------------------------------------------------------

describe('Shell MCP: initialization gate', () => {
  it('rejects tools/list before initialize', async () => {
    const shell = makeShell();
    const res = await handleShellMCPRequest({ id: 1, method: 'tools/list' }, shell);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32600);
  });

  it('rejects tools/call before initialize', async () => {
    const shell = makeShell();
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'shell_help' } },
      shell,
    );
    expect(res.error.code).toBe(-32600);
  });

  it('initialize returns server info and unlocks tools/*', async () => {
    const shell = makeShell();
    const state = { initialized: false };

    const initRes = await handleShellMCPRequest({ id: 1, method: 'initialize' }, shell, state);
    expect(initRes.result.protocolVersion).toBe('2024-11-05');
    expect(initRes.result.serverInfo.name).toBe('automators-kit-shell');
    expect(state.initialized).toBe(true);

    const listRes = await handleShellMCPRequest({ id: 2, method: 'tools/list' }, shell, state);
    expect(listRes.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tools/list — exactly 2 tools, regardless of registry size
// ---------------------------------------------------------------------------

describe('Shell MCP: tools/list', () => {
  it('exposes exactly shell_help and shell_exec, with schemas', async () => {
    const shell = makeShell();
    const state = { initialized: true };
    const res = await handleShellMCPRequest({ id: 1, method: 'tools/list' }, shell, state);
    const names = res.result.tools.map((t) => t.name);
    expect(names).toEqual(['shell_help', 'shell_exec']);
    expect(res.result.tools[1].inputSchema.required).toEqual(['command']);
  });

  it('the tool count stays 2 no matter how many commands are registered', async () => {
    const shell = makeShell();
    for (let i = 0; i < 20; i++) {
      shell.registry.register('bulk', `cmd${i}`, { description: 'x' }, async () => i);
    }
    const state = { initialized: true };
    const res = await handleShellMCPRequest({ id: 1, method: 'tools/list' }, shell, state);
    expect(res.result.tools.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// tools/call: shell_help
// ---------------------------------------------------------------------------

describe('Shell MCP: shell_help', () => {
  it('returns the shell interaction protocol text', async () => {
    const shell = makeShell();
    const state = { initialized: true };
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'shell_help' } },
      shell,
      state,
    );
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toBe(shell.help());
  });
});

// ---------------------------------------------------------------------------
// tools/call: shell_exec
// ---------------------------------------------------------------------------

describe('Shell MCP: shell_exec', () => {
  it('executes a registered command and returns the Shell response as JSON text', async () => {
    const shell = makeShell();
    const state = { initialized: true };
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'shell_exec', arguments: { command: 'users:list' } } },
      shell,
      state,
    );
    expect(res.result.isError).toBeFalsy();
    const body = parseResultText(res);
    expect(body.code).toBe(0);
    expect(body.data).toEqual(['alice', 'bob']);
  });

  it('marks the tool result as an error when the Shell response has a non-zero code (e.g. permission denied)', async () => {
    const shell = makeShell('restricted');
    const state = { initialized: true };
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'shell_exec', arguments: { command: 'users:list' } } },
      shell,
      state,
    );
    expect(res.result.isError).toBe(true);
    const body = parseResultText(res);
    expect(body.code).toBe(3); // permission denied
  });

  it('rejects a missing/non-string command argument without calling exec', async () => {
    const shell = makeShell();
    const state = { initialized: true };
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'shell_exec', arguments: {} } },
      shell,
      state,
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/command.*required/i);
  });

  it('discovery via shell_exec("search ...") works — the RBAC-safe way an agent finds commands', async () => {
    const shell = makeShell();
    const state = { initialized: true };
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'shell_exec', arguments: { command: 'search list' } } },
      shell,
      state,
    );
    const body = parseResultText(res);
    expect(body.code).toBe(0);
    expect(body.data.some((d) => d.id === 'users:list')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Basic dispatch (regression)
// ---------------------------------------------------------------------------

describe('Shell MCP: basic dispatch', () => {
  it('unknown tool name returns a JSON-RPC error', async () => {
    const shell = makeShell();
    const state = { initialized: true };
    const res = await handleShellMCPRequest(
      { id: 1, method: 'tools/call', params: { name: 'nope' } },
      shell,
      state,
    );
    expect(res.error.code).toBe(-32602);
  });

  it('notifications return null (no response)', async () => {
    const shell = makeShell();
    const res = await handleShellMCPRequest({ method: 'notifications/initialized' }, shell);
    expect(res).toBeNull();
  });

  it('ping returns an empty result', async () => {
    const shell = makeShell();
    const res = await handleShellMCPRequest({ id: 1, method: 'ping' }, shell);
    expect(res.result).toEqual({});
  });

  it('unknown method returns a JSON-RPC error', async () => {
    const shell = makeShell();
    const res = await handleShellMCPRequest({ id: 1, method: 'foo/bar' }, shell);
    expect(res.error.code).toBe(-32601);
  });
});
