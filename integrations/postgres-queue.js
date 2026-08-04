/**
 * PostgresJobQueue — a real, horizontally-scalable job queue backed by
 * Postgres. NOT a core/db.js DocStore adapter: db.js's adapter interface
 * (readJson/writeJson/readBin/writeBin/delete) is 100% synchronous
 * (verified: zero `await` near any adapter call in core/db.js), and
 * Postgres is inherently async. This module mirrors core/queue.js's
 * JobQueue public API shape instead -- same method names, same options,
 * same job-document fields -- but every method doing real I/O is `async`.
 *
 * Requires the optional `pg` dependency (see package.json's
 * optionalDependencies) -- not installed by default, since the rest of
 * automators-kit stays zero-dependency.
 *
 * What this adds over core/queue.js: core/queue.js's concurrency control
 * (`this._running`, a plain counter) only works within ONE process.
 * PostgresJobQueue lets N worker processes/machines safely pull from the
 * SAME queue via claimJobs()'s atomic `FOR UPDATE SKIP LOCKED` claim --
 * the actual reason this module exists.
 *
 * Usage:
 *   import { Pool } from 'pg';
 *   import { PostgresJobQueue } from 'automators-kit/integrations/postgres-queue.js';
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const queue = new PostgresJobQueue(pool, { concurrency: 5 });
 *   await queue.init();
 *   queue.register('send-email', async (data) => { await sendEmail(data); });
 *   await queue.enqueue('send-email', { to: 'a@b.com' });
 *   queue.start();
 */

import { generateId } from '../core/db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result JSONB,
  error TEXT,
  -- Fencing token, rotated on every claim. See claimJobs / _process: it is
  -- what stops a worker whose lease was taken away from writing a result over
  -- the worker that legitimately owns the job now.
  lease_token TEXT
);
ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS lease_token TEXT;
CREATE INDEX IF NOT EXISTS idx_queue_jobs_poll ON queue_jobs (status, run_at);

CREATE TABLE IF NOT EXISTS queue_dead (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data JSONB NOT NULL,
  attempts INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  error TEXT,
  died_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** Postgres row (snake_case) -> job doc shape matching core/queue.js's fields. */
function rowToJob(row) {
  return {
    _id: row.id,
    type: row.type,
    data: row.data,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxRetries: row.max_retries,
    runAt: +row.run_at,
    createdAt: +row.created_at,
    updatedAt: +row.updated_at,
    result: row.result,
    error: row.error,
    leaseToken: row.lease_token,
    id: row.id,
  };
}

/**
 * KDD-contracted (knowledge/contracts/postgres-job-queue.md, kept in a
 * sibling checkout outside this repo). Atomically claims up to `opts.limit`
 * due/reclaimable jobs, marking them 'processing' in the same statement --
 * see the contract for the full invariant list. `FOR UPDATE SKIP LOCKED`
 * is what makes this safe across concurrent callers (different processes
 * included): a locked row is skipped, not waited on, so two claimers never
 * receive the same job.
 */
export async function claimJobs(pool, opts) {
  const { rows } = await pool.query(
    `WITH claimed AS (
       SELECT id FROM queue_jobs
       WHERE (status = 'pending' AND run_at <= now())
          OR (status = 'processing' AND updated_at < now() - ($1 || ' milliseconds')::interval)
       ORDER BY priority DESC, created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE queue_jobs SET status = 'processing', updated_at = now(),
       lease_token = md5(random()::text || clock_timestamp()::text)
     WHERE id IN (SELECT id FROM claimed)
     RETURNING *`,
    [opts.leaseMs, opts.limit]
  );
  // RETURNING doesn't preserve the CTE's ORDER BY -- sort client-side.
  return rows.map(rowToJob).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

export class PostgresJobQueue {
  /**
   * @param {import('pg').Pool} pool - caller-owned connection pool
   * @param {object} opts
   * @param {number} opts.concurrency - max jobs claimed per poll (default: 5)
   * @param {number} opts.pollInterval - poll interval ms (default: 1000)
   * @param {number} opts.maxRetries - default max retries (default: 3)
   * @param {number} opts.backoffMs - base backoff ms (default: 1000)
   * @param {number} opts.leaseMs - stuck-processing reclaim threshold ms (default: 300000)
   */
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.concurrency = opts.concurrency || 5;
    this.pollInterval = opts.pollInterval || 1000;
    this.maxRetries = opts.maxRetries || 3;
    this.backoffMs = opts.backoffMs || 1000;
    this.leaseMs = opts.leaseMs ?? 300000;

    this._handlers = new Map();
    this._running = 0;
    this._timer = null;
    this._started = false;
  }

  /** Create the queue_jobs/queue_dead tables if they don't exist. Call once before start(). */
  async init() {
    await this.pool.query(SCHEMA);
  }

  /**
   * Register a job handler.
   * @param {string} type
   * @param {Function} handler - async (data, job) => result
   * @param {object} opts - { maxRetries, timeout }
   */
  register(type, handler, opts = {}) {
    this._handlers.set(type, { handler, ...opts });
    return this;
  }

  /**
   * Enqueue a job.
   * @param {string} type @param {object} data @param {object} opts - { delay, priority, maxRetries }
   * @returns {Promise<object>} the created job
   */
  async enqueue(type, data = {}, opts = {}) {
    const id = generateId();
    const now = new Date();
    const runAt = opts.delay ? new Date(now.getTime() + opts.delay) : now;
    const maxRetries = opts.maxRetries ?? this._handlers.get(type)?.maxRetries ?? this.maxRetries;
    const { rows } = await this.pool.query(
      `INSERT INTO queue_jobs (id, type, data, priority, max_retries, run_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, type, JSON.stringify(data), opts.priority || 0, maxRetries, runAt]
    );
    return rowToJob(rows[0]);
  }

  /** Schedule a delayed job. */
  async delay(type, data, delayMs) {
    return this.enqueue(type, data, { delay: delayMs });
  }

  /** Start processing jobs. */
  start() {
    if (this._started) return this;
    this._started = true;
    this._timer = setInterval(() => this._poll(), this.pollInterval);
    this._poll();
    return this;
  }

  /** Stop processing (in-flight jobs finish; the poll timer is cleared). */
  stop() {
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }

  /** Queue stats. */
  async stats() {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS n FROM queue_jobs GROUP BY status`
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const { rows: deadRows } = await this.pool.query('SELECT count(*)::int AS n FROM queue_dead');
    return {
      pending: byStatus.pending || 0,
      processing: byStatus.processing || 0,
      completed: byStatus.completed || 0,
      failed: byStatus.failed || 0,
      dead: deadRows[0].n,
      running: this._running,
    };
  }

  /** Recent jobs. */
  async list(opts = {}) {
    const limit = opts.limit || 50;
    if (opts.status) {
      const { rows } = await this.pool.query(
        'SELECT * FROM queue_jobs WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
        [opts.status, limit]
      );
      return rows.map(rowToJob);
    }
    const { rows } = await this.pool.query(
      'SELECT * FROM queue_jobs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return rows.map(rowToJob);
  }

  /** Dead letter jobs. */
  async deadLetter(limit = 50) {
    const { rows } = await this.pool.query(
      'SELECT * FROM queue_dead ORDER BY died_at DESC LIMIT $1',
      [limit]
    );
    return rows.map((r) => ({
      _id: r.id, id: r.id, type: r.type, data: r.data,
      attempts: r.attempts, maxRetries: r.max_retries, error: r.error, diedAt: +r.died_at,
    }));
  }

  /** Re-enqueue a dead-letter job. */
  async retry(jobId) {
    const { rows } = await this.pool.query('SELECT * FROM queue_dead WHERE id = $1', [jobId]);
    if (rows.length === 0) return null;
    const dead = rows[0];
    await this.pool.query('DELETE FROM queue_dead WHERE id = $1', [jobId]);
    return this.enqueue(dead.type, dead.data, { maxRetries: dead.max_retries });
  }

  /** Purge completed jobs older than ms. Returns the count purged. */
  async purge(olderThanMs = 86400000) {
    const { rowCount } = await this.pool.query(
      "DELETE FROM queue_jobs WHERE status = 'completed' AND updated_at < now() - ($1 || ' milliseconds')::interval",
      [olderThanMs]
    );
    return rowCount;
  }

  // --- internal ---

  async _poll() {
    if (!this._started) return;
    const room = this.concurrency - this._running;
    if (room <= 0) return;

    const jobs = await claimJobs(this.pool, { limit: room, leaseMs: this.leaseMs });
    for (const job of jobs) this._process(job);
  }

  async _process(job) {
    const handlerDef = this._handlers.get(job.type);
    if (!handlerDef) {
      await this.pool.query(
        "UPDATE queue_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
        [job._id, `No handler for type: ${job.type}`]
      );
      return;
    }

    this._running++;
    // CORRECTNESS (2026-08-03, full-codebase audit): claimJobs reclaims any row
    // whose `updated_at` is older than leaseMs, and `updated_at` was stamped
    // only at claim time and at completion -- so it could not distinguish a
    // DEAD worker from a SLOW one. Any handler outrunning leaseMs (default five
    // minutes) was re-claimed and re-executed. Worse than the in-process queue's
    // version of this bug (core/queue.js, fixed alongside): here the second run
    // happens in a DIFFERENT worker, genuinely in parallel, and FOR UPDATE SKIP
    // LOCKED does not help because the first worker holds no row lock while its
    // handler runs.
    //
    // Two mechanisms, because a heartbeat alone is not enough: it renews the
    // lease so a live-but-slow worker is not treated as dead, and the fencing
    // token makes every terminal write conditional on STILL owning the job --
    // so if this worker ever does stall past its lease and lose the job, its
    // late result cannot overwrite whichever worker legitimately owns it now.
    const heartbeat = setInterval(() => {
      this.pool.query(
        'UPDATE queue_jobs SET updated_at = now() WHERE id = $1 AND lease_token = $2',
        [job._id, job.leaseToken]
      ).catch(() => { /* a missed beat is recoverable; the next one renews */ });
    }, Math.max(Math.floor(this.leaseMs / 3), 1000));
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      const result = await this._invokeHandler(handlerDef, job);
      await this.pool.query(
        `UPDATE queue_jobs SET status = 'completed', result = $2, error = NULL,
         attempts = attempts + 1, updated_at = now() WHERE id = $1 AND lease_token = $3`,
        [job._id, JSON.stringify(result ?? null), job.leaseToken]
      );
    } catch (err) {
      const attempts = job.attempts + 1;
      if (attempts >= job.maxRetries) {
        // Delete FIRST, fenced, and dead-letter only if that delete actually
        // removed our row. Inserting first would dead-letter the job even when
        // the fenced delete turns out to be a no-op (we no longer own it),
        // leaving the job both alive in queue_jobs AND recorded as dead.
        // Ordering it this way makes losing the lease a clean no-op instead.
        const claimed = await this.pool.query(
          'DELETE FROM queue_jobs WHERE id = $1 AND lease_token = $2 RETURNING id',
          [job._id, job.leaseToken]
        );
        if (claimed.rowCount === 1) {
          await this.pool.query(
            `INSERT INTO queue_dead (id, type, data, attempts, max_retries, error)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [job._id, job.type, JSON.stringify(job.data), attempts, job.maxRetries, err.message]
          );
        }
      } else {
        const backoff = this.backoffMs * Math.pow(2, attempts);
        await this.pool.query(
          `UPDATE queue_jobs SET status = 'pending', error = $2, attempts = $3,
           run_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
           WHERE id = $1 AND lease_token = $5`,
          [job._id, err.message, attempts, backoff, job.leaseToken]
        );
      }
    } finally {
      clearInterval(heartbeat);
      this._running--;
    }
  }

  /** Same timeout-wrapping behavior as core/queue.js's _invokeHandler. */
  _invokeHandler(handlerDef, job) {
    const run = handlerDef.handler(job.data, job);
    if (!handlerDef.timeout) return run;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Handler timeout after ${handlerDef.timeout}ms`));
      }, handlerDef.timeout);
      Promise.resolve(run).then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
      );
    });
  }
}
