/**
 * Command Gateway with scoped RBAC — runnable demo.
 *
 *   bun examples/command-gateway/setup.js
 *
 * One CommandRegistry (registry.js — the curated, safe command surface: no
 * raw DB access, only `content:*`/`system:*`), mounted at 4 separate HTTP
 * endpoints, each backed by its own Shell instance with a different
 * permission scope. Same commands exist everywhere; what each persona can
 * actually reach differs:
 *
 *   /api/gateway/admin    — everything, including the destructive content:delete
 *   /api/gateway/editor   — list/search/create/publish, NOT delete (custom
 *                            permissions, not one of the 4 built-in profiles)
 *   /api/gateway/support  — read-only (AGENT_PROFILES.reader)
 *   /api/gateway/public   — search/describe/help only (AGENT_PROFILES.restricted)
 *
 * See ./README.md for the curl walkthrough per persona.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { Shell } from '../../core/shell.js';
import { shellRoutes } from '../../routes/shell.js';
import { buildCommandRegistry } from './registry.js';

const PORT = +(process.env.PORT || 3002);
const DB_PATH = process.env.DB_PATH || './examples/command-gateway/data';
const SECRET = process.env.JWT_SECRET || 'command-gateway-demo-secret';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: SECRET,
  logger: true,
});

await app.cms.contentTypes.create({
  name: 'Note',
  slug: 'note',
  description: 'Simple notes for the command gateway demo',
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'body', label: 'Body', type: 'textarea', required: true },
  ],
}).catch((err) => console.log(`[setup] content type already exists: ${err.message}`));

const registry = buildCommandRegistry(app.cms);

// Hand-picked scope for 'editor': everything except content:delete. Not one
// of the 4 built-in AGENT_PROFILES — explicit `permissions` always wins over
// `profile`, so a gateway can be scoped to exactly what one persona needs.
const EDITOR_PERMISSIONS = ['content:list', 'content:search', 'content:create', 'content:publish', 'system:health'];

const personas = {
  admin: new Shell({ registry, profile: 'admin' }),
  editor: new Shell({ registry, profile: 'editor', permissions: EDITOR_PERMISSIONS }),
  support: new Shell({ registry, profile: 'reader' }),
  public: new Shell({ registry, profile: 'restricted' }),
};

for (const [name, shell] of Object.entries(personas)) {
  app.router.route(`/api/gateway/${name}`, shellRoutes(shell));
}

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Command gateway demo running at http://localhost:${PORT}
  /api/gateway/admin    — full access, including content:delete
  /api/gateway/editor   — list/search/create/publish, no delete
  /api/gateway/support  — read-only
  /api/gateway/public   — search/describe/help only

Each endpoint has its OWN command history (per-Shell instance) — e.g.
GET /api/gateway/editor/history only shows what the editor persona ran.

See examples/command-gateway/README.md for the curl walkthrough.
`);
