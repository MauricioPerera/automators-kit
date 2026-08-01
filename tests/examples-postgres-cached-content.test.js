/**
 * Postgres-Cached Content — end-to-end regression test against a REAL
 * Postgres. Mirrors examples/postgres-cached-content/server.js (reuses
 * content.js's buildContentRouter so the demo and the test can't drift
 * apart) but spawns TWO real HTTP servers on random ports, each with its
 * own PostgresCollection instance against the SAME table -- the actual
 * point of this example is cross-process cache coherence, so a test
 * against a single instance wouldn't prove anything integrations/
 * postgres-collection.test.js doesn't already prove at the class level.
 *
 * Opt-in, NOT part of the default `bun test tests/` run: skips cleanly
 * unless POSTGRES_TEST_URL is set, same as the other integrations-postgres-*
 * and this module's own primitive test.
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/examples-postgres-cached-content.test.js
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

async function waitFor(check, { timeoutMs = 5000, intervalMs = 30 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

if (!POSTGRES_TEST_URL) {
  describe('Postgres-Cached Content', () => {
    it.skip('skipped: set POSTGRES_TEST_URL to run against a real Postgres', () => {});
  });
} else {
  const { Pool } = await import('pg');
  const { PostgresCollection } = await import('../integrations/postgres-collection.js');
  const { buildContentRouter } = await import('../examples/postgres-cached-content/content.js');

  const TABLE = 'content_pages';
  let pool, servers;

  async function spawnInstance() {
    const pages = new PostgresCollection(pool, TABLE);
    await pages.init();
    const router = buildContentRouter(pages);
    const server = Bun.serve({ fetch: router.handle, port: 0 });
    return { pages, server, baseUrl: `http://localhost:${server.port}` };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_TEST_URL, max: 10 });
    const setup = new PostgresCollection(pool, TABLE);
    await setup.init();
    await setup.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE}"`);
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await s.pages.close();
      s.server.stop(true);
    }
  });

  describe('Postgres-Cached Content: HTTP CRUD over PostgresCollection', () => {
    it('POST/GET/PUT/DELETE work through the router, exactly like a normal content API', async () => {
      const a = await spawnInstance();
      servers.push(a);

      const created = await fetch(`${a.baseUrl}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'hello', title: 'Hello', body: 'v1', published: true }),
      });
      expect(created.status).toBe(201);

      const got = await (await fetch(`${a.baseUrl}/pages/hello`)).json();
      expect(got.title).toBe('Hello');

      const dup = await fetch(`${a.baseUrl}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'hello', title: 'Dup' }),
      });
      expect(dup.status).toBe(409);

      const updated = await (await fetch(`${a.baseUrl}/pages/hello`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'v2' }),
      })).json();
      expect(updated.body).toBe('v2');

      const list = await (await fetch(`${a.baseUrl}/pages?published=true`)).json();
      expect(list.pages.length).toBe(1);

      const del = await fetch(`${a.baseUrl}/pages/hello`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect((await fetch(`${a.baseUrl}/pages/hello`)).status).toBe(404);
    });
  });

  describe('Postgres-Cached Content: the actual point -- cross-process cache coherence over real HTTP', () => {
    it("a write via server A's HTTP API is visible on server B's HTTP API with B never querying Postgres for it", async () => {
      const a = await spawnInstance();
      const b = await spawnInstance();
      servers.push(a, b);

      await fetch(`${a.baseUrl}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'shared', title: 'v1', published: true }),
      });

      const seenByB = await waitFor(async () => {
        const res = await fetch(`${b.baseUrl}/pages/shared`);
        if (res.status !== 200) return null;
        const body = await res.json();
        return body.title === 'v1' ? body : null;
      });
      expect(seenByB.title).toBe('v1');

      await fetch(`${a.baseUrl}/pages/shared`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'v2' }),
      });
      await waitFor(async () => {
        const res = await fetch(`${b.baseUrl}/pages/shared`);
        const body = await res.json();
        return body.title === 'v2';
      });

      await fetch(`${a.baseUrl}/pages/shared`, { method: 'DELETE' });
      await waitFor(async () => (await fetch(`${b.baseUrl}/pages/shared`)).status === 404);
    });
  });
}
