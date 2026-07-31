/**
 * MCP Job Queue — end-to-end regression test.
 * Mirrors examples/mcp-job-queue/setup.js's wiring, via
 * handleMCPRequest() directly (pure dispatcher, no stdio -- same
 * convention as tests/examples-agent-memory-backend.test.js).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { JobQueue } from '../core/queue.js';
import { buildTools, handleMCPRequest } from '../core/mcp.js';
import { buildJobHandlers } from '../examples/job-queue/handlers.js';
import { buildQueueTools } from '../examples/job-queue/tools.js';
import { buildMcpTools } from '../examples/mcp-job-queue/tools.js';

let app, queue, mcpAllTools;

async function callMcp(name, args) {
  const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, mcpAllTools);
  expect(res.error).toBeUndefined();
  if (res.result.isError) return { isError: true, text: res.result.content[0].text };
  return JSON.parse(res.result.content[0].text);
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'mcp-job-queue-test-secret!!!' });
  queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 20, backoffMs: 20, maxRetries: 3 });
  const { handlers } = buildJobHandlers();
  for (const [type, handler] of Object.entries(handlers)) queue.register(type, handler);
  queue.start();

  const queueTools = buildQueueTools(queue, app.cms.db);
  mcpAllTools = { ...buildTools(app.cms), ...buildMcpTools(queueTools) };
});

describe('MCP job queue: tools/list exposes the queue tools alongside the base CMS tools', () => {
  it('lists enqueue_report, job_status, queue_stats', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, mcpAllTools);
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('enqueue_report');
    expect(names).toContain('job_status');
    expect(names).toContain('queue_stats');
    expect(names).toContain('list_entries'); // base CMS tool still present
  });
});

describe('MCP job queue: an agent can enqueue work and poll for it via MCP tool calls alone', () => {
  it('enqueue_report returns a jobId immediately, the job completes in the background, and job_status reflects it', async () => {
    const enqueued = await callMcp('enqueue_report', { entryType: 'sales', delayMs: 10 });
    expect(enqueued.status).toBe('pending');
    expect(typeof enqueued.jobId).toBe('string');

    await new Promise((resolve) => setTimeout(resolve, 150));

    const status = await callMcp('job_status', { jobId: enqueued.jobId });
    expect(status.found).toBe(true);
    expect(status.status).toBe('completed');
    expect(status.result.report).toContain('sales');
  });

  it('job_status for an unknown id returns { found: false }, not a thrown/masked error', async () => {
    const status = await callMcp('job_status', { jobId: 'nope' });
    expect(status).toEqual({ found: false, jobId: 'nope' });
  });

  it('job_status with a missing required field is rejected by inputSchema validation with a specific, non-generic message', async () => {
    const res = await handleMCPRequest({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'job_status', arguments: {} } }, mcpAllTools);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('jobId is required');
  });

  it('queue_stats reflects real counts through the same MCP tool call surface', async () => {
    await callMcp('enqueue_report', { entryType: 'ops', delayMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = await callMcp('queue_stats', {});
    expect(stats.completed).toBeGreaterThanOrEqual(1);
  });
});
