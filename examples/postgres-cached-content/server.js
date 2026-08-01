/**
 * Postgres-Cached Content -- HTTP demo.
 *
 *   DATABASE_URL=postgres://user:pass@host:port/db PORT=3040 bun examples/postgres-cached-content/server.js
 *
 * Combines integrations/postgres-collection.js (built to close the
 * db.js/Collection "no cache invalidation across processes" gap) with
 * core/http.js's Router -- a content-pages API where every read is a
 * local in-memory cache hit, kept correct across HOWEVER MANY separate
 * server processes point at the same DATABASE_URL/table via Postgres
 * LISTEN/NOTIFY. Unlike every other example in this repo, there is no
 * DocStore/CMS involved at all: this is what a Collection-shaped API
 * looks like when db.js's single-process limitation genuinely doesn't
 * apply.
 *
 * Run TWO instances (different PORT, same DATABASE_URL) to see the
 * actual point live: a write via one instance shows up in the other's
 * GET response without that instance ever querying Postgres for it.
 * See README.md for the full walkthrough.
 */

import { Pool } from 'pg';
import { PostgresCollection } from '../../integrations/postgres-collection.js';
import { buildContentRouter } from './content.js';

const PORT = +(process.env.PORT || 3040);
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_TEST_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL (or POSTGRES_TEST_URL) is required -- this example needs a real Postgres, it has no offline mode.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const pages = new PostgresCollection(pool, 'content_pages');
await pages.init();

const router = buildContentRouter(pages);
Bun.serve({ fetch: router.handle, port: PORT });

console.log(`
Postgres-cached content demo running at http://localhost:${PORT}

Try:
  curl -X POST http://localhost:${PORT}/pages -H "Content-Type: application/json" \\
    -d '{"slug":"hello","title":"Hello","body":"first post","published":true}'
  curl http://localhost:${PORT}/pages/hello
  curl http://localhost:${PORT}/pages?published=true

Run a SECOND instance on another port against the SAME DATABASE_URL:
  PORT=3041 DATABASE_URL=$DATABASE_URL bun examples/postgres-cached-content/server.js
Then GET /pages/hello on the second instance's port -- it'll show up
without that process ever having called POST itself. See README.md.
`);
