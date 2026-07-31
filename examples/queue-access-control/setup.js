/**
 * Queue Access Control — HTTP/shell demo.
 *
 *   bun examples/queue-access-control/setup.js
 *
 * Combines core/shell.js's RBAC with core/queue.js: 3 agent sessions
 * (admin / reader / a custom "queue-operator") sharing the SAME
 * JobQueue, gated by DIFFERENT permissions -- core/queue.js itself has
 * no notion of who is calling `enqueue()`/`purge()`, and
 * examples/job-queue registers every queue command on createApp()'s
 * default 'admin' shell (full access, no restriction demonstrated at
 * all). Here the exact same commands are registered ONCE on a shared
 * CommandRegistry, and 3 Shell instances -- one per profile -- decide
 * for themselves what each caller may actually run.
 *
 * Reuses examples/job-queue's own handlers.js/tools.js, not duplicated.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { Shell, CommandRegistry } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { Router, json, cors } from '../../core/http.js';
import { buildJobHandlers } from '../job-queue/handlers.js';
import { buildQueueTools } from '../job-queue/tools.js';

const PORT = +(process.env.PORT || 3032);
const DB_PATH = process.env.DB_PATH || './examples/queue-access-control/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'queue-access-control-demo-secret',
});

const queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 100, backoffMs: 100, maxRetries: 3 });
const { handlers } = buildJobHandlers();
for (const [type, handler] of Object.entries(handlers)) queue.register(type, handler);
queue.start();

const tools = buildQueueTools(queue, app.cms.db);

// One CommandRegistry, one set of command definitions -- shared by every
// profile below. RBAC lives entirely in which Shell instance a caller
// gets routed to, not in the commands themselves.
const registry = new CommandRegistry();

registry.register('queue', 'enqueue-report', {
  description: 'Enqueue a report-generation job',
  params: [{ name: 'entryType', type: 'string' }, { name: 'delayMs', type: 'number' }],
}, async (args) => tools.enqueueReport(args));

registry.register('queue', 'enqueue-notification', {
  description: 'Enqueue a notification job',
  params: [{ name: 'to', type: 'string', required: true }, { name: 'message', type: 'string' }],
}, async (args) => tools.enqueueNotification(args));

// Verb 'status' deliberately matches AGENT_PROFILES.reader's built-in
// `*:status` wildcard -- a read-only monitoring agent can check a
// specific job with no custom permissions needed.
registry.register('queue', 'status', {
  description: "Check a job's status by id",
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.jobStatus(args.id || args._0));

// Verb 'list' likewise matches reader's `*:list`.
registry.register('queue', 'list', {
  description: 'List recent jobs',
  params: [{ name: 'status', type: 'string' }, { name: 'limit', type: 'number' }],
}, async (args) => tools.listJobs(args));

// 'stats' matches NEITHER reader's nor operator's built-in verb
// wildcards (list/get/search/describe/count/status for reader;
// list/get/create/update/delete/run for operator) -- only admin, or an
// explicit grant, can see aggregate counts. See README.
registry.register('queue', 'stats', { description: 'Aggregate queue stats' }, async () => tools.stats());

// 'retry'/'purge' don't match any built-in profile's verb set either --
// admin-only by construction, the same way a real destructive queue
// operation should be.
registry.register('queue', 'retry', {
  description: 'Re-enqueue a dead-letter job',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => tools.retryDead(args.id || args._0));

registry.register('queue', 'purge', {
  description: 'Delete completed jobs older than N ms',
  params: [{ name: 'olderThanMs', type: 'number' }],
}, async (args) => tools.purgeOld(args.olderThanMs));

const adminShell = new Shell({ registry, profile: 'admin' });
const readerShell = new Shell({ registry, profile: 'reader' });
// A realistic role that doesn't correspond to any built-in profile: can
// enqueue and monitor, but the built-in profiles have no "can create AND
// only this one namespace's destructive ops are off-limits" shape --
// explicit `permissions` always wins over `profile` (core/shell.js's own
// documented precedence), so this is how a real app expresses it.
const operatorShell = new Shell({
  registry,
  permissions: ['queue:enqueue-report', 'queue:enqueue-notification', 'queue:status', 'queue:list', 'queue:stats'],
});

const router = new Router();
router.use(cors());
router.route('/api/shell/admin', shellRoutes(adminShell));
router.route('/api/shell/reader', shellRoutes(readerShell));
router.route('/api/shell/operator', shellRoutes(operatorShell));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Queue access control demo running at http://localhost:${PORT}
  /api/shell/admin/exec     -- full access
  /api/shell/reader/exec    -- queue:status, queue:list only
  /api/shell/operator/exec  -- enqueue + monitor, no retry/purge

Try:
  POST /api/shell/reader/exec {"cmd":"queue:enqueue-report --entryType sales"}
    -> Permission denied
  POST /api/shell/operator/exec {"cmd":"queue:purge --olderThanMs 0"}
    -> Permission denied
See examples/queue-access-control/README.md for the full walkthrough.
`);
