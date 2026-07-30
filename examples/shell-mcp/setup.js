/**
 * Shell MCP Server — stdio demo.
 *
 *   bun examples/shell-mcp/setup.js
 *
 * Ports the Agent-Shell 2-tool MCP pattern (shell_help + shell_exec) onto a
 * real task-management command registry: no matter how many tasks:*
 * commands are registered, an MCP client only ever sees 2 tools (~600
 * constant tokens), discovering the rest at runtime via
 * shell_exec("search ...") / shell_exec("describe ...") instead of one
 * schema per command in tools/list. Contrast with examples/mcp-cms
 * (core/mcp.js's alternative pattern: one MCP tool per capability, with a
 * real per-tool JSON schema each).
 *
 * Talks JSON-RPC 2.0 over stdio, not HTTP — plug it into a real MCP client
 * (Claude Desktop, `pool mcp add`, etc.) to drive it for real, or see
 * README.md for a raw stdio walkthrough (no client needed).
 *
 * IMPORTANT: nothing in this file (or anything it imports) may write to
 * stdout — that stream is the JSON-RPC wire format once
 * createShellMCPServer() is listening. Startup/diagnostic output goes to
 * stderr only (createShellMCPServer() already does this itself).
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { Shell } from '../../core/shell.js';
import { createShellMCPServer } from '../../core/shell-mcp.js';
import { TASK_CONTENT_TYPE, registerTaskCommands } from './registry.js';

const DB_PATH = process.env.DB_PATH || './examples/shell-mcp/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'shell-mcp-demo-secret',
});

await app.cms.contentTypes.create(TASK_CONTENT_TYPE).catch((err) => {
  console.error(`[setup] content type already exists: ${err.message}`);
});

const shell = new Shell({ profile: 'admin' });
registerTaskCommands(shell, app.cms);

createShellMCPServer(shell);
