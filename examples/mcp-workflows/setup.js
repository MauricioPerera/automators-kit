/**
 * MCP Workflows — stdio demo.
 *
 *   bun examples/mcp-workflows/setup.js
 *
 * Combines core/shell-mcp.js's 2-tool MCP gateway (shell_help/shell_exec,
 * constant ~600-token cost) with a REAL core/workflow.js WorkflowEngine
 * execution — "let an AI agent run and inspect actual workflow.js
 * executions," not demonstrated by either module's other example
 * (examples/mcp-cms exposes CMS operations, not workflow runs;
 * examples/workflow-engine is HTTP/webhook-driven, no MCP at all).
 *
 * One small, real workflow (Ticket Triage, see triage-workflow.js) is
 * registered at setup time — authoring the DAG stays a human/setup-time
 * concern; the agent only ever runs and inspects it via workflows:*
 * commands (registry.js).
 *
 * JSON-RPC 2.0 over stdio, not HTTP — nothing here (or anything it
 * imports) may write to stdout, same constraint as examples/shell-mcp.
 */

import { createApp } from '../../index.js';
import { MemoryStorageAdapter } from '../../adapters/memory.js';
import { createShellMCPServer } from '../../core/shell-mcp.js';
import { TRIAGE_WORKFLOW_DEFINITION } from './triage-workflow.js';
import { registerWorkflowCommands } from './registry.js';

// In-memory: this demo has nothing worth persisting across restarts (the
// workflow definition is re-created fresh each run) and a stdio MCP server
// has no obvious place to point --db-path at from a client config.
const app = await createApp({
  adapter: new MemoryStorageAdapter(),
  secret: process.env.JWT_SECRET || 'mcp-workflows-demo-secret',
});

app.workflowEngine.create(TRIAGE_WORKFLOW_DEFINITION);
registerWorkflowCommands(app.shell, app.workflowEngine);

createShellMCPServer(app.shell);
