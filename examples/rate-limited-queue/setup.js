/**
 * Rate-Limited Queue — HTTP demo.
 *
 *   bun examples/rate-limited-queue/setup.js
 *
 * Combines core/http.js's rateLimit() with core/queue.js's JobQueue: a
 * public "generate report" endpoint that kicks work off the request path
 * (examples/job-queue's pattern), but with no limiter on the enqueue
 * caller a single client could flood the queue with unbounded jobs --
 * examples/job-queue never guards intake, and examples/api-gateway's
 * rateLimit() only ever protects fast inline handlers, never a queue.
 * Here the limiter sits directly in front of enqueue(), so a client that
 * exceeds it gets 429 BEFORE a job is ever created -- the queue itself
 * never sees the excess load.
 *
 * Like examples/hybrid-catalog-search, this does not call createApp() --
 * a bare Router + DocStore + JobQueue is all this needs.
 */

import { Router, json, cors, rateLimit } from '../../core/http.js';
import { DocStore, FileStorageAdapter } from '../../core/db.js';
import { JobQueue } from '../../core/queue.js';
import { buildReportHandler } from './handlers.js';
import { buildRateLimitedQueueTools } from './tools.js';

const PORT = +(process.env.PORT || 3029);
const DB_PATH = process.env.DB_PATH || './examples/rate-limited-queue/data';
const RATE_LIMIT_MAX = +(process.env.RATE_LIMIT_MAX || 3);
const RATE_LIMIT_WINDOW_MS = +(process.env.RATE_LIMIT_WINDOW_MS || 10000);

const db = new DocStore(new FileStorageAdapter(DB_PATH));
const queue = new JobQueue(db, { concurrency: 2, pollInterval: 100, backoffMs: 100, maxRetries: 3 });

const { handler, rendered } = buildReportHandler({ delayMs: +(process.env.REPORT_DELAY_MS || 50) });
queue.register('generate-report', handler);
queue.start();

const tools = buildRateLimitedQueueTools(queue, db);

const limiter = rateLimit({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });

const reportsRouter = new Router();
reportsRouter.use(limiter);
reportsRouter.post('/', async (ctx) => {
  const body = await ctx.json().catch(() => ({}));
  const { jobId, status } = tools.enqueueReport({ topic: body.topic || 'untitled' });
  return json({ jobId, status }, 202);
});
reportsRouter.get('/:id', async (ctx) => {
  const job = tools.jobStatus(ctx.params.id);
  if (!job) return json({ error: 'Not found' }, 404);
  return json(job);
});

const router = new Router();
router.use(cors());
router.route('/api/reports', reportsRouter);
router.get('/api/stats', async () => json(tools.stats()));
router.get('/api/rendered', async () => json(rendered));
router.setNotFound(() => json({ error: 'Not found' }, 404));

Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Rate-limited queue demo running at http://localhost:${PORT}
  POST /api/reports         {"topic":"..."}   (rate limited: ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS}ms per IP)
  GET  /api/reports/:id                       job status
  GET  /api/stats                             queue stats (pending/processing/completed/failed/dead)
  GET  /api/rendered                          what the mock report handler actually rendered

Try:
  for i in 1 2 3 4; do curl -si -X POST http://localhost:${PORT}/api/reports -d '{"topic":"t"}' | grep -E "HTTP|X-RateLimit|error"; done
See examples/rate-limited-queue/README.md for the full walkthrough.
`);
