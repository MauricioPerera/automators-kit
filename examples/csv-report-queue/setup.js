/**
 * CSV Report Queue — HTTP/shell demo.
 *
 *   bun examples/csv-report-queue/setup.js
 *
 * Combines core/csv.js with core/queue.js: a sales CSV is aggregated
 * into a summary report inside a background job — `reports:submit`
 * returns a job id immediately instead of blocking the request while a
 * (potentially large) CSV is parsed and aggregated, the "kick off +
 * poll" pattern (examples/job-queue) applied to CSV analytics/ETL
 * specifically, distinct from examples/csv-bulk-import's synchronous
 * CSV-to-CMS-entries import.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { computeSalesReport } from './report.js';

const PORT = +(process.env.PORT || 3038);
const DB_PATH = process.env.DB_PATH || './examples/csv-report-queue/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'csv-report-queue-demo-secret',
  logger: true,
});

const queue = new JobQueue(app.cms.db, { concurrency: 2, pollInterval: 100, backoffMs: 100, maxRetries: 1 });
queue.register('generate-sales-report', async ({ csv }) => computeSalesReport(csv));
queue.start();

app.shell.registry.register('reports', 'submit', {
  description: 'Enqueue a sales CSV for background aggregation (columns: product,category,amount)',
  params: [{ name: 'csv', type: 'string', required: true }],
}, async (args) => {
  const job = queue.enqueue('generate-sales-report', { csv: args.csv });
  return { jobId: job._id, status: job.status };
});

app.shell.registry.register('reports', 'status', {
  description: "Check a report job's status/result by id",
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => queue.list({ limit: 200 }).find((j) => j._id === (args.id || args._0)) || null);

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
CSV report queue demo running at http://localhost:${PORT}
  commands: reports:submit, reports:status

Try:
  POST /api/shell/exec {"cmd":"reports:submit --csv \\"product,category,amount\\nWidget,tools,10\\nGadget,tools,20\\nDesk,furniture,150\\n\\""}
  POST /api/shell/exec {"cmd":"reports:status --id <jobId from above>"}
See examples/csv-report-queue/README.md for the full walkthrough.
`);
