/**
 * Shell MCP (Task registry) — end-to-end regression test.
 * Mirrors examples/shell-mcp/setup.js (reuses registry.js's
 * registerTaskCommands so the demo and test can't drift apart). Drives the
 * pure handleShellMCPRequest dispatcher (no stdio process), same
 * testability shape as tests/shell-mcp.test.js.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { Shell } from '../core/shell.js';
import { handleShellMCPRequest } from '../core/shell-mcp.js';
import { TASK_CONTENT_TYPE, registerTaskCommands } from '../examples/shell-mcp/registry.js';

let app, shell, state;

function parseResultText(res) {
  return JSON.parse(res.result.content[0].text);
}
async function call(name, args) {
  return handleShellMCPRequest(
    { jsonrpc: '2.0', id: Math.random(), method: 'tools/call', params: { name, arguments: args } },
    shell,
    state,
  );
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'shell-mcp-test-secret!!!' });
  await app.cms.contentTypes.create(TASK_CONTENT_TYPE);
  shell = new Shell({ profile: 'admin' });
  registerTaskCommands(shell, app.cms);
  state = { initialized: false };
  await handleShellMCPRequest({ jsonrpc: '2.0', id: 0, method: 'initialize' }, shell, state);
});

describe('Shell MCP (tasks): tools/list stays at exactly 2', () => {
  it('exposes only shell_help and shell_exec, regardless of the 4 registered tasks:* commands', async () => {
    const res = await handleShellMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, shell, state);
    expect(res.result.tools.map((t) => t.name)).toEqual(['shell_help', 'shell_exec']);
  });
});

describe('Shell MCP (tasks): discovery', () => {
  it('search finds the tasks:* commands by description', async () => {
    const res = await call('shell_exec', { command: 'search task' });
    const body = parseResultText(res);
    expect(body.code).toBe(0);
    const ids = body.data.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['tasks:create', 'tasks:list', 'tasks:complete', 'tasks:delete']));
  });

  it('describe returns the real param schema for a command', async () => {
    const res = await call('shell_exec', { command: 'describe tasks:create' });
    const body = parseResultText(res);
    expect(body.data.params).toEqual([{ name: 'title', type: 'string', required: true }]);
  });
});

describe('Shell MCP (tasks): real CRUD through shell_exec', () => {
  it('creates, lists, completes, and deletes a task end-to-end', async () => {
    const created = parseResultText(await call('shell_exec', { command: 'tasks:create --title "Ship it"' }));
    expect(created.code).toBe(0);
    expect(created.data.done).toBe(false);
    const id = created.data.id;

    const afterCreate = parseResultText(await call('shell_exec', { command: 'tasks:list' }));
    expect(afterCreate.data.some((t) => t.id === id && !t.done)).toBe(true);

    const completed = parseResultText(await call('shell_exec', { command: `tasks:complete --id ${id}` }));
    expect(completed.data.done).toBe(true);
    expect(completed.data.title).toBe('Ship it'); // title survives the content merge

    const deleted = parseResultText(await call('shell_exec', { command: `tasks:delete --id ${id}` }));
    expect(deleted.data.deletedId).toBe(id);

    const afterDelete = parseResultText(await call('shell_exec', { command: 'tasks:list' }));
    expect(afterDelete.data.some((t) => t.id === id)).toBe(false);
  });

  it('--confirm previews a destructive command through the MCP layer without running it, matching the newly-fixed shell.js behavior', async () => {
    const created = parseResultText(await call('shell_exec', { command: 'tasks:create --title "Do not delete me yet"' }));
    const id = created.data.id;

    const preview = parseResultText(await call('shell_exec', { command: `tasks:delete --id ${id} --confirm` }));
    expect(preview.data.mode).toBe('confirm');
    expect(preview.data.requiresConfirmation).toBe(true);

    const stillThere = parseResultText(await call('shell_exec', { command: 'tasks:list' }));
    expect(stillThere.data.some((t) => t.id === id)).toBe(true); // --confirm did NOT delete it

    const forReal = parseResultText(await call('shell_exec', { command: `tasks:delete --id ${id}` }));
    expect(forReal.data.deletedId).toBe(id); // re-issuing without --confirm actually deletes
  });
});
