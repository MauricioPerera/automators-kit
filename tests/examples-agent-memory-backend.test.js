/**
 * Agent Memory Backend — end-to-end regression test.
 * Covers both surfaces built from tools.js's shared handlers:
 *   - the agent shell / HTTP (mirrors setup.js's registered commands)
 *   - MCP, via handleMCPRequest() directly (pure dispatcher, no stdio —
 *     mirrors mcp-server.js's tool wiring)
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { AgentMemory } from '../core/memory.js';
import { buildTools, handleMCPRequest } from '../core/mcp.js';
import { buildMemoryHandlers, buildMcpTools } from '../examples/agent-memory-backend/tools.js';

let app;
let memory;
let handlers;
let mcpAllTools;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function callMcp(name, args) {
  const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, mcpAllTools);
  expect(res.error).toBeUndefined();
  return JSON.parse(res.result.content[0].text);
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'memory-backend-test-secret!!!' });

  memory = new AgentMemory(app.cms.db, { agentId: 'support-bot-test' });
  handlers = buildMemoryHandlers(memory);

  app.shell.registry.register('memory', 'learn', { description: 'learn' }, async (args) => handlers.learn({ task: args.task || args._0, outcome: args.outcome }));
  app.shell.registry.register('memory', 'remember-error', { description: 'remember-error' }, async (args) => handlers.rememberError(args));
  app.shell.registry.register('memory', 'recall', { description: 'recall' }, async (args) => handlers.recall({ query: args.query || args._0, limit: args.limit }));
  app.shell.registry.register('memory', 'stats', { description: 'stats' }, async () => handlers.stats());
  app.shell.registry.register('memory', 'dream', { description: 'dream' }, async () => handlers.dream());

  mcpAllTools = { ...buildTools(app.cms), ...buildMcpTools(handlers) };
});

describe('Agent memory backend: shell/HTTP surface', () => {
  it('remembers an error and recalls it later by a related query', async () => {
    const remembered = await app.handle(req('memory:remember-error --error "ECONNRESET on payment webhook" --solution "retry with exponential backoff, cap 5"'));
    const rememberedBody = await remembered.json();
    expect(rememberedBody.code).toBe(0);

    const recalled = await app.handle(req('memory:recall --query "payment webhook connection error"'));
    const recalledBody = await recalled.json();
    expect(recalledBody.code).toBe(0);
    expect(recalledBody.data.length).toBeGreaterThan(0);
    expect(recalledBody.data[0].source).toBe('semantic');
    expect(recalledBody.data[0].solution).toContain('exponential backoff');
  });

  it('learns a completed task as episodic memory and it shows up in stats', async () => {
    const learned = await app.handle(req('memory:learn --task "Migrated auth to JWT" --outcome success'));
    const learnedBody = await learned.json();
    expect(learnedBody.code).toBe(0);
    expect(learnedBody.data.outcome).toBe('success');

    const stats = await app.handle(req('memory:stats'));
    const statsBody = await stats.json();
    expect(statsBody.data.episodic).toBeGreaterThan(0);
  });

  it('dream (heuristic dedup) runs without an LLM configured and returns a report', async () => {
    const res = await app.handle(req('memory:dream'));
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(typeof body.data.merged).toBe('number');
    expect(typeof body.data.duration_ms).toBe('number');
  });
});

describe('Agent memory backend: MCP surface (same handlers, no stdio)', () => {
  it('tools/list includes both the base CMS tools and the memory tools', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, mcpAllTools);
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('recall_memory');
    expect(names).toContain('learn_task');
    expect(names).toContain('list_entries'); // base CMS tool, still present
  });

  it('learn_task then recall_memory finds it via MCP tools/call', async () => {
    await callMcp('learn_task', { task: 'Debugged a flaky webhook test', outcome: 'success', learnings: ['add retry with backoff'] });
    const recalled = await callMcp('recall_memory', { query: 'flaky webhook test' });
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled.some((r) => r.source === 'episodic')).toBe(true);
  });

  it('rejects a tool call missing a required argument', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember_error', arguments: { error: 'only error, no solution' } } }, mcpAllTools);
    expect(res.result.isError).toBe(true);
  });
});

describe('Agent memory backend: isolation between agentIds', () => {
  it('a different agentId on the same db sees none of the first agent\'s memories', async () => {
    const otherAgent = new AgentMemory(app.cms.db, { agentId: 'other-bot-test' });
    const otherHandlers = buildMemoryHandlers(otherAgent);
    const result = await otherHandlers.recall({ query: 'payment webhook connection error' });
    expect(result.length).toBe(0);
  });
});
