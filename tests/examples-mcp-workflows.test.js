/**
 * MCP Workflows — end-to-end regression test.
 * Mirrors examples/mcp-workflows/setup.js (reuses triage-workflow.js +
 * registry.js so the demo and test can't drift apart). Drives the pure
 * handleShellMCPRequest dispatcher (no stdio process needed for testing),
 * same testability shape as tests/examples-shell-mcp.test.js.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { handleShellMCPRequest } from '../core/shell-mcp.js';
import { TRIAGE_WORKFLOW_DEFINITION } from '../examples/mcp-workflows/triage-workflow.js';
import { registerWorkflowCommands } from '../examples/mcp-workflows/registry.js';

let app, state;

function parseResultText(res) {
  return JSON.parse(res.result.content[0].text);
}
async function call(name, args) {
  return handleShellMCPRequest(
    { jsonrpc: '2.0', id: Math.random(), method: 'tools/call', params: { name, arguments: args } },
    app.shell,
    state,
  );
}
async function runTriage(tickets) {
  return call('shell_exec', { command: `workflows:run-triage --ticketsJson '${JSON.stringify(tickets)}'` });
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'mcp-workflows-test-secret!!!' });
  app.workflowEngine.create(TRIAGE_WORKFLOW_DEFINITION);
  registerWorkflowCommands(app.shell, app.workflowEngine);
  state = { initialized: false };
  await handleShellMCPRequest({ jsonrpc: '2.0', id: 0, method: 'initialize' }, app.shell, state);
});

describe('MCP workflows: tools/list stays at exactly 2', () => {
  it('exposes only shell_help and shell_exec, regardless of the 5 registered workflows:* commands', async () => {
    const res = await handleShellMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, app.shell, state);
    expect(res.result.tools.map((t) => t.name)).toEqual(['shell_help', 'shell_exec']);
  });
});

describe('MCP workflows: discovery', () => {
  it('search finds the workflows:* commands', async () => {
    const body = parseResultText(await call('shell_exec', { command: 'search workflow' }));
    const ids = body.data.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['workflows:run-triage', 'workflows:list', 'workflows:executions']));
  });
});

describe('MCP workflows: real workflow.js executions through shell_exec', () => {
  it('escalates when at least one urgent ticket exists, and the execution is fetchable by its returned id', async () => {
    const body = parseResultText(await runTriage([
      { subject: 'Payment failed', priority: 'urgent' },
      { subject: 'Typo', priority: 'low' },
    ]));
    expect(body.code).toBe(0);
    expect(body.data.status).toBe('success');
    expect(body.data.urgentCount).toBe(1);
    expect(body.data.escalationMessage).toBe('Escalating 1 urgent ticket(s)');

    // Regression coverage for the core/workflow.js fix: run()'s returned
    // executionId must be real and independently fetchable, not undefined.
    expect(typeof body.data.executionId).toBe('string');
    const fetched = parseResultText(await call('shell_exec', { command: `workflows:execution --id ${body.data.executionId}` }));
    expect(fetched.data._id).toBe(body.data.executionId);
    expect(fetched.data.nodeResults.escalate.data).toBe('Escalating 1 urgent ticket(s)');
  });

  it('skips escalation entirely when there are zero urgent tickets (onFalse: skip)', async () => {
    const body = parseResultText(await runTriage([{ subject: 'Typo', priority: 'low' }]));
    expect(body.data.urgentCount).toBe(0);
    expect(body.data.escalationMessage).toBeNull();

    const fetched = parseResultText(await call('shell_exec', { command: `workflows:execution --id ${body.data.executionId}` }));
    expect(fetched.data.nodeResults.escalate).toBeUndefined();
  });

  it('workflows:list and workflows:executions reflect real engine state', async () => {
    const list = parseResultText(await call('shell_exec', { command: 'workflows:list' }));
    expect(list.data.some((w) => w.name === 'Ticket Triage')).toBe(true);
    const wfId = list.data.find((w) => w.name === 'Ticket Triage')._id;

    const executions = parseResultText(await call('shell_exec', { command: `workflows:executions --id ${wfId}` }));
    expect(executions.data.length).toBeGreaterThanOrEqual(2); // the 2 runs above
  });
});
