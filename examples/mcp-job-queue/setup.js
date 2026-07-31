/**
 * MCP Job Queue — stdio MCP server entry point.
 *
 *   bun examples/mcp-job-queue/setup.js
 *
 * Combines core/mcp.js with core/queue.js: an AI agent enqueues
 * background work and polls for its result directly through MCP tool
 * calls -- examples/job-queue only ever exposes this over HTTP/shell, no
 * MCP transport exists for it; examples/mcp-cms/examples/agent-memory-backend
 * expose CMS entries and agent memory over MCP, never a JobQueue.
 *
 * Reuses examples/job-queue's own handlers.js/tools.js (the same mock
 * report/notification/flaky job handlers and enqueue/status/stats logic)
 * instead of duplicating them -- the only new code here is the MCP tool
 * shape (tools.js in this directory) and this wiring.
 *
 * Talks JSON-RPC 2.0 over stdio, not HTTP -- plug it into a real MCP
 * client (Claude Desktop, `pool mcp add`, etc.), or see README.md for a
 * raw stdio walkthrough (no client needed).
 *
 * IMPORTANT: nothing in this file (or anything it imports) may write to
 * stdout -- that stream is the JSON-RPC wire format once
 * createMCPServer() is listening. Startup/diagnostic output goes to
 * stderr only.
 *
 * Configure in an MCP client:
 * {
 *   "mcpServers": {
 *     "automators-kit-job-queue": {
 *       "command": "bun",
 *       "args": ["examples/mcp-job-queue/setup.js"],
 *       "cwd": "/path/to/automators-kit"
 *     }
 *   }
 * }
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { createMCPServer } from '../../core/mcp.js';
import { buildJobHandlers } from '../job-queue/handlers.js';
import { buildQueueTools } from '../job-queue/tools.js';
import { buildMcpTools } from './tools.js';

const DB_PATH = process.env.DB_PATH || './examples/mcp-job-queue/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'mcp-job-queue-demo-secret',
});

// Fast poll/backoff for the demo, same as examples/job-queue.
const queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 100, backoffMs: 100, maxRetries: 3 });
const { handlers } = buildJobHandlers();
for (const [type, handler] of Object.entries(handlers)) queue.register(type, handler);
queue.start();

const queueTools = buildQueueTools(queue, app.cms.db);

createMCPServer(app.cms, buildMcpTools(queueTools));
