/**
 * Memory Consolidation Queue — HTTP/shell demo.
 *
 *   bun examples/memory-consolidation-queue/setup.js
 *
 * Combines core/memory.js with core/queue.js: `memory.dream()` (the
 * heuristic near-duplicate consolidation cycle, documented as O(n^2)
 * comparisons over stored memories) runs as a background job instead of
 * blocking the caller. examples/agent-memory-backend already exposes
 * `dream` two ways — a direct shell/MCP call and an hourly
 * `core/cron.js` job — but neither is durable/retryable/off-the-request-
 * path the way a queued job is: a manual "consolidate now" trigger here
 * returns immediately with a job id instead of blocking on however long
 * dream() takes, and if a real LLM-powered consolidation
 * (`opts.llmFn`) call fails partway, the queue's own retry/backoff
 * applies automatically — a bare cron handler doesn't get that for
 * free.
 *
 * Reuses examples/agent-memory-backend's own `buildMemoryHandlers`
 * directly (learn/rememberError/recall/stats) for everything EXCEPT
 * dream, which this example replaces with a queued version instead of
 * duplicating memory.js's own logic.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { AgentMemory } from '../../core/memory.js';
import { JobQueue } from '../../core/queue.js';
import { buildMemoryHandlers } from '../agent-memory-backend/tools.js';

const PORT = +(process.env.PORT || 3036);
const DB_PATH = process.env.DB_PATH || './examples/memory-consolidation-queue/data';
const AGENT_ID = process.env.AGENT_ID || 'consolidation-demo-agent';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'memory-consolidation-queue-demo-secret',
  logger: true,
});

const memory = new AgentMemory(app.cms.db, { agentId: AGENT_ID });
const handlers = buildMemoryHandlers(memory);

const queue = new JobQueue(app.cms.db, { concurrency: 1, pollInterval: 100, backoffMs: 200, maxRetries: 2 });
// concurrency: 1 -- dream() reads+rewrites the whole memory collection;
// two concurrent consolidation passes racing each other would be a
// correctness risk memory.js was never designed to guard against, not
// something this example needs to solve to make its point.
queue.register('consolidate-memory', async () => handlers.dream());
queue.start();

app.shell.registry.register('memory', 'learn', { description: 'Record a completed task', params: [{ name: 'task', type: 'string', required: true }, { name: 'outcome', type: 'string' }] }, async (args) => handlers.learn({ task: args.task || args._0, outcome: args.outcome }));
app.shell.registry.register('memory', 'remember-error', { description: 'Record a known error + fix', params: [{ name: 'error', type: 'string', required: true }, { name: 'solution', type: 'string', required: true }] }, async (args) => handlers.rememberError(args));
app.shell.registry.register('memory', 'stats', { description: 'Memory counts' }, async () => handlers.stats());

app.shell.registry.register('memory', 'consolidate', {
  description: 'Enqueue a background memory consolidation pass (does NOT block waiting for it)',
}, async () => {
  const job = queue.enqueue('consolidate-memory', {});
  return { jobId: job._id, status: job.status };
});

app.shell.registry.register('memory', 'consolidate-status', {
  description: "Check a consolidation job's status/result by id",
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => queue.list({ limit: 200 }).find((j) => j._id === (args.id || args._0)) || null);

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Memory consolidation queue demo running at http://localhost:${PORT}
  commands: memory:learn, memory:remember-error, memory:stats, memory:consolidate, memory:consolidate-status

Try:
  POST /api/shell/exec {"cmd":"memory:learn --task \\"Fix login bug\\" --outcome success"}
  POST /api/shell/exec {"cmd":"memory:consolidate"}
  POST /api/shell/exec {"cmd":"memory:consolidate-status --id <jobId from above>"}
See examples/memory-consolidation-queue/README.md for the full walkthrough.
`);
