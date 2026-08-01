/**
 * PostgresCollection — a real, cross-process-cached DocStore-Collection
 * equivalent, backed by Postgres, WITH genuine cache invalidation.
 *
 * NOT a change to core/db.js. Collection._ensureLoaded() loads its
 * adapter's data into an in-memory Map ONCE and never re-reads it --
 * flush() is a one-way trip back to storage, so there is no cache
 * invalidation or coherency protocol at all (see README's "Known
 * architectural limit" note). integrations/postgres-queue.js and
 * integrations/postgres-execution-log.js sidestep that problem entirely
 * by never caching -- every operation is a fresh Postgres round-trip.
 * This module does the opposite: it actually caches (for Collection-like
 * read speed) and actually keeps that cache correct across processes,
 * using Postgres's native LISTEN/NOTIFY as a real invalidation channel.
 *
 * Query semantics are not reinvented: core/db.js publicly exports
 * matchFilter/applyUpdate, and this module reuses them directly against
 * its own in-memory cache -- the same $gt/$in/$regex/... filter language
 * and the same $set/$inc/$push/... update operators Collection supports.
 *
 * How invalidation works:
 *   - init() loads every row into a local Map<id, doc>, then checks out
 *     ONE dedicated connection from the pool (pool.connect(), never
 *     released) and issues LISTEN doc_changes_<table>. This is the
 *     standard node-postgres pattern for a permanent listener -- a pool
 *     connection is normally returned after each query, so a long-lived
 *     LISTEN needs its own checked-out client.
 *   - Every write does its Postgres statement, then
 *     SELECT pg_notify('doc_changes_<table>', '{"op":...,"id":...}').
 *     The payload is always small and fixed-shape (op + id only, never
 *     the full doc) -- NOTIFY payloads are capped at 8000 bytes and a
 *     large document must never risk truncation.
 *   - On notification: op 'delete' removes the cache entry immediately;
 *     op 'upsert' re-fetches just that one row and replaces the cache
 *     entry. The cache stays fully populated at all times (no missing-id
 *     gaps for find() scans to fall into) -- there's only a brief,
 *     bounded staleness window during the upsert refetch round-trip.
 *   - The writing process updates its own cache synchronously at write
 *     time; it does not wait for its own notification to arrive.
 *
 * Known limitation, documented rather than solved: LISTEN/NOTIFY does
 * not queue or replay notifications for a connection that has dropped --
 * if a process's listen connection dies and reconnects, it can miss
 * whatever changed in between. There is no automatic reconnect wired up
 * here (out of scope for this pilot); the recovery path is calling
 * init() again, which reloads the entire cache from Postgres from
 * scratch and re-establishes LISTEN, so nothing stays silently stale
 * forever -- but a caller running this unattended for long periods needs
 * its own connection-health/reconnect strategy on top.
 *
 * Requires the optional `pg` dependency (see package.json's
 * optionalDependencies) -- not installed by default.
 *
 * Usage:
 *   import { Pool } from 'pg';
 *   import { PostgresCollection } from 'automators-kit/integrations/postgres-collection.js';
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const pages = new PostgresCollection(pool, 'content_pages');
 *   await pages.init();
 *   await pages.insert({ slug: 'hello', title: 'Hello', published: true });
 *   await pages.find({ published: true });
 *   await pages.close();
 */

import { generateId, matchFilter, applyUpdate } from '../core/db.js';

function channelFor(table) {
  return `doc_changes_${table}`;
}

export class PostgresCollection {
  /**
   * @param {import('pg').Pool} pool - caller-owned connection pool
   * @param {string} table - table name (also used to derive the NOTIFY channel)
   */
  constructor(pool, table) {
    this.pool = pool;
    this.table = table;
    this.channel = channelFor(table);
    this._cache = new Map(); // id -> doc
    this._listenClient = null;
  }

  /**
   * Creates the table if needed, loads every row into the local cache,
   * and (re)establishes the dedicated LISTEN connection. Safe to call
   * again later as a manual full resync (e.g. after a dropped listen
   * connection).
   */
  async init() {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS "${this.table}" (
         id TEXT PRIMARY KEY,
         data JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );

    const { rows } = await this.pool.query(`SELECT id, data FROM "${this.table}"`);
    this._cache.clear();
    for (const row of rows) this._cache.set(row.id, row.data);

    if (this._listenClient) {
      this._listenClient.removeAllListeners('notification');
      this._listenClient.release();
    }
    this._listenClient = await this.pool.connect();
    await this._listenClient.query(`LISTEN ${this.channel}`);
    this._listenClient.on('notification', (msg) => this._handleNotification(msg));
  }

  async _handleNotification(msg) {
    if (msg.channel !== this.channel) return;
    const payload = JSON.parse(msg.payload);
    if (payload.op === 'delete') {
      this._cache.delete(payload.id);
      return;
    }
    const { rows } = await this.pool.query(
      `SELECT data FROM "${this.table}" WHERE id = $1`,
      [payload.id]
    );
    if (rows.length === 0) this._cache.delete(payload.id);
    else this._cache.set(payload.id, rows[0].data);
  }

  async _notify(op, id) {
    await this.pool.query('SELECT pg_notify($1, $2)', [this.channel, JSON.stringify({ op, id })]);
  }

  /** Insert a document. Assigns _id via core/db.js's generateId() if not provided. */
  async insert(doc) {
    const newDoc = { ...doc };
    if (!newDoc._id) newDoc._id = generateId();
    await this.pool.query(
      `INSERT INTO "${this.table}" (id, data) VALUES ($1, $2)`,
      [newDoc._id, JSON.stringify(newDoc)]
    );
    this._cache.set(newDoc._id, newDoc);
    await this._notify('upsert', newDoc._id);
    return newDoc;
  }

  /** Read from the local cache -- no Postgres round-trip. */
  async findById(id) {
    return this._cache.get(id) ?? null;
  }

  /** Read from the local cache using core/db.js's matchFilter -- no Postgres round-trip. */
  async findOne(filter = {}) {
    for (const doc of this._cache.values()) {
      if (matchFilter(doc, filter)) return doc;
    }
    return null;
  }

  /** Read from the local cache using core/db.js's matchFilter -- no Postgres round-trip. */
  async find(filter = {}) {
    const results = [];
    for (const doc of this._cache.values()) {
      if (matchFilter(doc, filter)) results.push(doc);
    }
    return results;
  }

  /** Count matches in the local cache -- no Postgres round-trip. */
  async count(filter = {}) {
    let n = 0;
    for (const doc of this._cache.values()) {
      if (matchFilter(doc, filter)) n++;
    }
    return n;
  }

  /** Updates the first doc matching filter using core/db.js's applyUpdate. Returns 0 or 1. */
  async update(filter, updateSpec) {
    let target = null;
    for (const doc of this._cache.values()) {
      if (matchFilter(doc, filter)) { target = doc; break; }
    }
    if (!target) return 0;

    const newDoc = applyUpdate(target, updateSpec);
    newDoc._id = target._id;
    await this.pool.query(
      `UPDATE "${this.table}" SET data = $2, updated_at = now() WHERE id = $1`,
      [newDoc._id, JSON.stringify(newDoc)]
    );
    this._cache.set(newDoc._id, newDoc);
    await this._notify('upsert', newDoc._id);
    return 1;
  }

  /** Removes the first doc matching filter. Returns 0 or 1. */
  async remove(filter) {
    let target = null;
    for (const doc of this._cache.values()) {
      if (matchFilter(doc, filter)) { target = doc; break; }
    }
    if (!target) return 0;

    await this.pool.query(`DELETE FROM "${this.table}" WHERE id = $1`, [target._id]);
    this._cache.delete(target._id);
    await this._notify('delete', target._id);
    return 1;
  }

  /** Releases the dedicated listen connection back to the pool. */
  async close() {
    if (this._listenClient) {
      this._listenClient.removeAllListeners('notification');
      this._listenClient.release();
      this._listenClient = null;
    }
  }
}
