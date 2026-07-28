/**
 * Content Intake & Publishing Pipeline — runnable demo.
 *
 *   bun examples/content-pipeline/setup.js
 *
 * Starts a standalone server (separate port/data dir from the main app,
 * so it never collides with `bun server-bun.js`), wired up with the
 * pipeline from ./pipeline.js. See ./README.md for the full walkthrough
 * (curl commands, expected responses, and the live security checks).
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { setupContentPipeline, DEFAULT_WEBHOOK_SECRET } from './pipeline.js';

const PORT = +(process.env.PORT || 3001);
const DB_PATH = process.env.DB_PATH || './examples/content-pipeline/data';
const SECRET = process.env.JWT_SECRET || 'content-pipeline-demo-secret';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: SECRET,
  logger: true,
});

// Admin user for the /api/workflows/:id/run walkthrough in the README
// (created directly via cms.users, same pattern as seed.js — the HTTP
// /api/auth/register route intentionally can't self-assign the admin role).
const ADMIN_EMAIL = 'admin@content-pipeline.demo';
const ADMIN_PASSWORD = 'demo-admin-12345';
try {
  await app.cms.users.register(ADMIN_EMAIL, ADMIN_PASSWORD, { name: 'Demo Admin', role: 'admin' });
} catch (err) {
  console.log(`[setup] admin already exists: ${err.message}`);
}

const { intakeWorkflowId, publishWorkflowId } = await setupContentPipeline(app, {
  webhookSecret: WEBHOOK_SECRET,
});

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Content pipeline demo running at http://localhost:${PORT}
  intake workflow:  ${intakeWorkflowId}
  publish workflow: ${publishWorkflowId}
  webhook secret:   ${WEBHOOK_SECRET}
  admin login:      ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}

See examples/content-pipeline/README.md for the curl walkthrough.
`);
