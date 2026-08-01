/**
 * PostgresCollection — end-to-end regression test against a REAL Postgres.
 *
 * Opt-in, NOT part of the default `bun test tests/` run: skips cleanly
 * unless POSTGRES_TEST_URL is set, so the project's existing deterministic
 * offline suite is unaffected. To run:
 *
 *   POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/integrations-postgres-collection.test.js
 *
 * Requires the optional `pg` dependency (see package.json's
 * optionalDependencies) -- not installed by default.
 *
 * Waits poll for the expected state instead of sleeping a fixed delay:
 * NOTIFY delivery is asynchronous, and over a real network connection
 * (e.g. an SSH tunnel to a remote Postgres) round-trip time is variable
 * -- a fixed sleep tuned for localhost is flaky under load.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

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
  describe('PostgresCollection', () => {
    it.skip('skipped: set POSTGRES_TEST_URL to run against a real Postgres', () => {});
  });
} else {
  const { Pool } = await import('pg');
  const { PostgresCollection } = await import('../integrations/postgres-collection.js');

  const TABLE = 'content_pages';
  let pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_TEST_URL, max: 10 });
    // Ensure the table exists without leaving a permanent LISTEN connection
    // checked out of the pool (that would block pool.end() in afterAll).
    const setup = new PostgresCollection(pool, TABLE);
    await setup.init();
    await setup.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${TABLE}"`);
  });

  describe('PostgresCollection: CRUD mirrors Collection\'s query/update semantics (matchFilter/applyUpdate)', () => {
    it('insert -> findById/findOne/find (with matchFilter operators) -> update (applyUpdate) -> remove', async () => {
      const pages = new PostgresCollection(pool, TABLE);
      await pages.init();

      const hello = await pages.insert({ slug: 'hello', title: 'Hello', views: 3, published: true });
      await pages.insert({ slug: 'draft', title: 'Draft', views: 0, published: false });

      expect((await pages.findById(hello._id)).slug).toBe('hello');
      expect((await pages.findOne({ slug: 'draft' })).published).toBe(false);

      const published = await pages.find({ published: true });
      expect(published.length).toBe(1);
      expect(published[0].slug).toBe('hello');

      const popular = await pages.find({ views: { $gt: 1 } });
      expect(popular.length).toBe(1);
      expect(popular[0].slug).toBe('hello');

      expect(await pages.count({})).toBe(2);

      const updated = await pages.update({ slug: 'hello' }, { $inc: { views: 1 }, $set: { title: 'Hello!' } });
      expect(updated).toBe(1);
      const reFetched = await pages.findOne({ slug: 'hello' });
      expect(reFetched.views).toBe(4);
      expect(reFetched.title).toBe('Hello!');

      const removed = await pages.remove({ slug: 'draft' });
      expect(removed).toBe(1);
      expect(await pages.findOne({ slug: 'draft' })).toBeNull();
      expect(await pages.count({})).toBe(1);

      await pages.close();
    });
  });

  describe('PostgresCollection: real cross-process cache invalidation via LISTEN/NOTIFY', () => {
    it("instance B's cache reflects instance A's writes without B ever manually re-reading (the whole point)", async () => {
      const a = new PostgresCollection(pool, TABLE);
      const b = new PostgresCollection(pool, TABLE);
      await a.init();
      await b.init();

      const doc = await a.insert({ slug: 'shared', title: 'v1', published: true });

      // B never called insert/find against Postgres for this doc -- only NOTIFY
      // delivered it into B's local cache.
      const seenByB = await waitFor(async () => {
        const found = await b.findById(doc._id);
        return found && found.title === 'v1' ? found : null;
      });
      expect(seenByB.title).toBe('v1');

      await a.update({ slug: 'shared' }, { $set: { title: 'v2' } });
      await waitFor(async () => {
        const found = await b.findById(doc._id);
        return found && found.title === 'v2' ? found : null;
      });

      await a.remove({ slug: 'shared' });
      await waitFor(async () => (await b.findById(doc._id)) === null);

      await a.close();
      await b.close();
    });

    it('a dropped listen connection loses live updates, but calling init() again resyncs the cache from scratch', async () => {
      const a = new PostgresCollection(pool, TABLE);
      const b = new PostgresCollection(pool, TABLE);
      await a.init();
      await b.init();

      // Simulate B's permanent listen connection dying.
      b._listenClient.removeAllListeners('notification');
      b._listenClient.release();
      b._listenClient = null;

      const doc = await a.insert({ slug: 'missed', title: 'while-disconnected', published: true });

      // Give any (non-existent) notification a moment to NOT arrive.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await b.findById(doc._id)).toBeNull(); // genuinely missed -- documented limitation

      await b.init(); // full resync + fresh LISTEN
      expect((await b.findById(doc._id)).title).toBe('while-disconnected');

      await a.close();
      await b.close();
    });
  });
}
