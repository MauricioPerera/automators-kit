/**
 * Validated Job Queue — HTTP/shell demo.
 *
 *   bun examples/validated-job-queue/setup.js
 *
 * Combines core/validate.js with core/queue.js: `jobs:enqueue-email`
 * goes through `createValidatedEnqueue()` instead of calling
 * `queue.enqueue()` directly — a malformed payload (bad email format, a
 * missing subject) is rejected immediately, with zero job document ever
 * created, instead of processing failing (and, for a permanently-bad
 * payload, exhausting every retry) for nothing.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { JobQueue } from '../../core/queue.js';
import { schemas } from './schemas.js';
import { createValidatedEnqueue } from './validated-queue.js';

const PORT = +(process.env.PORT || 3034);
const DB_PATH = process.env.DB_PATH || './examples/validated-job-queue/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'validated-job-queue-demo-secret',
  logger: true,
});

const queue = new JobQueue(app.cms.db, { concurrency: 3, pollInterval: 100, backoffMs: 100, maxRetries: 2 });
queue.register('send-email', async ({ to, subject }) => ({ sent: true, to, subject }));
queue.start();

const validatedEnqueue = createValidatedEnqueue(queue, schemas);

app.shell.registry.register('jobs', 'enqueue-email', {
  description: 'Enqueue a send-email job, rejected immediately (no job created) if the payload is malformed',
  params: [
    { name: 'to', type: 'string' },
    { name: 'subject', type: 'string' },
    { name: 'body', type: 'string' },
  ],
}, async (args) => {
  // A validation failure is an expected, actionable outcome for the
  // caller (fix your payload), not a server fault -- caught and returned
  // as ordinary data instead of left to throw, which core/shell.js masks
  // into a generic "Internal command error" with no detail (same
  // reasoning examples/mcp-job-queue documents for MCP tool errors).
  try {
    const job = validatedEnqueue('send-email', { to: args.to, subject: args.subject, body: args.body });
    return { ok: true, jobId: job._id, status: job.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.shell.registry.register('jobs', 'stats', { description: 'Queue stats' }, async () => queue.stats());

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Validated job queue demo running at http://localhost:${PORT}
  commands: jobs:enqueue-email, jobs:stats

Try (the second one is rejected immediately -- check jobs:stats before/after):
  POST /api/shell/exec {"cmd":"jobs:enqueue-email --to \\"a@b.com\\" --subject \\"Hi\\" --body \\"Hello\\""}
  POST /api/shell/exec {"cmd":"jobs:enqueue-email --to \\"not-an-email\\" --subject \\"\\" --body \\"Hello\\""}
See examples/validated-job-queue/README.md for the full walkthrough.
`);
