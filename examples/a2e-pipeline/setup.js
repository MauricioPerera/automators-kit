/**
 * A2E Pipeline — HTTP/shell demo.
 *
 *   bun examples/a2e-pipeline/setup.js
 *
 * `a2e.js`'s own distinctive shape, front and center: a declarative
 * compact-JSON pipeline using `Loop` (batch-process signup records),
 * `Conditional` (branch on the acceptance rate), `StoreData` (persist
 * rejects into `/store`), a custom-handler op inside the Loop, and both
 * middleware classes (`AuditMiddleware` for the full operation trace,
 * `CacheMiddleware` for a deliberately slow lookup, measured).
 *
 * Building this found and fixed 2 real bugs in core/a2e.js itself (not
 * example-specific): `Loop` with sub-operations threw a ReferenceError on
 * its very first item (a `depth` variable was referenced outside its
 * scope), and `Conditional` executed BOTH branches every time (the taken
 * one twice) instead of only the chosen one — see README for the full
 * story with live-verified before/after numbers.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { WorkflowExecutor, AuditMiddleware, CacheMiddleware } from '../../core/a2e.js';
import { processSignup, summarizeResults, enrichCustomer } from './handlers.js';

const PORT = +(process.env.PORT || 3011);
const DB_PATH = process.env.DB_PATH || './examples/a2e-pipeline/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'a2e-pipeline-demo-secret',
  logger: true,
});

const SIGNUPS = [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Carol', email: 'not-an-email' },
  { name: 'Dave', email: 'dave@example.com' },
  { name: 'Eve', email: 'eve@example.com' },
];

const audit = new AuditMiddleware();
const pipeline = new WorkflowExecutor({ middleware: [audit] });
pipeline.registerHandler('ProcessSignup', processSignup);
pipeline.registerHandler('SummarizeResults', summarizeResults);

pipeline.load({
  operations: [
    { id: 'raw', op: 'SetData', value: SIGNUPS },
    { id: 'process', op: 'ProcessSignup', inputPath: '/loop/current' },
    { id: 'processed', op: 'Loop', inputPath: '/workflow/raw', operations: ['process'] },
    { id: 'summary', op: 'SummarizeResults', inputPath: '/workflow/processed' },
    { id: 'rejectedLog', op: 'StoreData', inputPath: '/workflow/summary/rejectedRecords', key: 'rejectedSignups' },
    { id: 'check', op: 'Conditional', condition: { path: '/workflow/summary/acceptanceRate', operator: '>=', value: 80 }, ifTrue: 'approved', ifFalse: 'review' },
    { id: 'approved', op: 'SetData', value: 'Batch approved automatically' },
    { id: 'review', op: 'SetData', value: 'Needs manual review' },
  ],
  execute: 'raw',
});

// Separate small executor dedicated to the CacheMiddleware demo — keeps the
// main pipeline focused, and lets the cache persist across repeated runs of
// this executor without re-running the whole signup batch each time.
const cache = new CacheMiddleware();
const enrichExecutor = new WorkflowExecutor({ middleware: [cache] });
enrichExecutor.registerHandler('EnrichCustomer', enrichCustomer);
enrichExecutor.load({
  operations: [{ id: 'enrich', op: 'EnrichCustomer', email: 'jane@vip.example.com' }],
  execute: 'enrich',
});

app.shell.registry.register('pipeline', 'run', {
  description: 'Run the signup batch pipeline (Loop + Conditional + StoreData)',
}, async () => {
  const r = await pipeline.execute();
  return {
    summary: r.results.summary,
    decision: r.results.check.conditionResult ? r.results.approved : r.results.review,
    errors: r.errors,
  };
});

app.shell.registry.register('pipeline', 'audit-log', { description: 'Full operation trace from the last run(s)' }, async () => audit.getLog());
app.shell.registry.register('pipeline', 'rejected', { description: 'Rejected signups persisted to /store by StoreData' }, async () => pipeline.state.store.rejectedSignups);

app.shell.registry.register('pipeline', 'enrich-benchmark', {
  description: 'Run the slow enrichment op twice — 2nd run should hit CacheMiddleware and be dramatically faster',
}, async () => {
  const t1 = performance.now();
  const r1 = await enrichExecutor.execute();
  const firstMs = performance.now() - t1;

  const t2 = performance.now();
  const r2 = await enrichExecutor.execute();
  const secondMs = performance.now() - t2;

  return {
    firstRunResult: r1.results.enrich,
    firstMs: Math.round(firstMs * 10) / 10,
    secondMs: Math.round(secondMs * 10) / 10,
    cacheStats: cache.stats(),
  };
});

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
A2E pipeline demo running at http://localhost:${PORT}
  commands: pipeline:run, pipeline:audit-log, pipeline:rejected, pipeline:enrich-benchmark

Try:
  POST /api/shell/exec {"cmd":"pipeline:run"}
  POST /api/shell/exec {"cmd":"pipeline:rejected"}
  POST /api/shell/exec {"cmd":"pipeline:enrich-benchmark"}
See examples/a2e-pipeline/README.md for the full walkthrough.
`);
