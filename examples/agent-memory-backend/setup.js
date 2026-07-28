/**
 * Agent Memory Backend — HTTP/shell demo.
 *
 *   bun examples/agent-memory-backend/setup.js
 *
 * Gives an agent persistent state (episodic + semantic memory, via
 * core/memory.js) that survives restarts, reachable through the agent
 * shell/HTTP for this demo — see mcp-server.js for the MCP (real AI
 * client) surface using the exact same handlers from tools.js.
 *
 * Also wires an hourly cron job that runs the heuristic dream cycle
 * (dedup near-identical memories) — the kind of self-maintenance a
 * long-running agent backend needs and a human wouldn't remember to do.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { AgentMemory } from '../../core/memory.js';
import { CronScheduler } from '../../core/cron.js';
import { buildMemoryHandlers } from './tools.js';

const PORT = +(process.env.PORT || 3003);
const DB_PATH = process.env.DB_PATH || './examples/agent-memory-backend/data';
const AGENT_ID = process.env.AGENT_ID || 'support-bot';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'agent-memory-demo-secret',
  logger: true,
});

// Memory is scoped by agentId (own DB collections, `_mem_sem_support-bot` /
// `_mem_ep_support-bot` / ...) — a different agentId is fully isolated
// memory, sharing the same underlying `db`/data file.
const memory = new AgentMemory(app.cms.db, { agentId: AGENT_ID });
const handlers = buildMemoryHandlers(memory);

app.shell.registry.register('memory', 'learn', {
  description: 'Record a completed task as episodic memory',
  params: [
    { name: 'task', type: 'string', required: true },
    { name: 'outcome', type: 'string' },
  ],
}, async (args) => handlers.learn({ task: args.task || args._0, outcome: args.outcome }));

app.shell.registry.register('memory', 'remember-error', {
  description: "Record a known error + fix as semantic memory",
  params: [
    { name: 'error', type: 'string', required: true },
    { name: 'solution', type: 'string', required: true },
  ],
}, async (args) => handlers.rememberError(args));

app.shell.registry.register('memory', 'recall', {
  description: 'Find memories relevant to a query',
  params: [
    { name: 'query', type: 'string', required: true },
    { name: 'limit', type: 'number' },
  ],
}, async (args) => handlers.recall({ query: args.query || args._0, limit: args.limit }));

app.shell.registry.register('memory', 'stats', {
  description: 'Memory counts by type',
}, async () => handlers.stats());

app.shell.registry.register('memory', 'dream', {
  description: 'Manually trigger the dedup/consolidation cycle',
}, async () => handlers.dream());

// Self-maintenance: dedup memories every hour. Heuristic mode (no `llmFn`
// configured on AgentMemory above) — safe to run unattended, no API calls.
const cron = new CronScheduler();
cron.add('memory-dream', '0 * * * *', async () => {
  const report = await handlers.dream();
  console.log(`[cron] memory dream: merged=${report.merged} removed=${report.removed}`);
});
cron.start();

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Agent memory backend demo running at http://localhost:${PORT}
  agent id: ${AGENT_ID}
  commands: memory:learn, memory:remember-error, memory:recall, memory:stats, memory:dream
  cron:     dedup runs hourly (heuristic, no LLM)

POST /api/shell/exec { "cmd": "memory:recall --query \\"...\\"" }
See examples/agent-memory-backend/README.md, and mcp-server.js for the MCP surface.
`);
