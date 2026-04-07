/**
 * Job Queue
 * In-memory async job processor with retries, backoff, dead letter, concurrency.
 * Zero dependencies.
 *
 * Usage:
 *   const queue = new JobQueue(db, { concurrency: 3 });
 *   queue.register('send-email', async (data) => { await sendEmail(data); });
 *   queue.enqueue('send-email', { to: 'a@b.com', subject: 'Hi' });
 *   queue.start();
 */

import { generateId } from './db.js';

// ---------------------------------------------------------------------------
// JOB QUEUE
// ---------------------------------------------------------------------------

export class JobQueue {
  /**
   * @param {import('./db.js').DocStore} db - DocStore instance for persistence
   * @param {object} opts
   * @param {number} opts.concurrency - Max parallel jobs (default: 5)
   * @param {number} opts.pollInterval - Poll interval ms (default: 1000)
   * @param {number} opts.maxRetries - Default max retries (default: 3)
   * @param {number} opts.backoffMs - Base backoff ms (default: 1000)
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.concurrency = opts.concurrency || 5;
    this.pollInterval = opts.pollInterval || 1000;
    this.maxRetries = opts.maxRetries || 3;
    this.backoffMs = opts.backoffMs || 1000;

    this._jobs = db.collection('_queue_jobs');
    this._dead = db.collection('_queue_dead');
    this._handlers = new Map();
    this._running = 0;
    this._timer = null;
    this._started = false;
    this._dirty = false;
    this._flushTimer = null;
  }

  /**
   * Register a job handler.
   * @param {string} type - Job type name
   * @param {Function} handler - async (data, job) => result
   * @param {object} opts - { maxRetries, timeout }
   */
  register(type, handler, opts = {}) {
    this._handlers.set(type, { handler, ...opts });
    return this;
  }

  /**
   * Enqueue a job.
   * @param {string} type - Job type (must have a registered handler)
   * @param {object} data - Job payload
   * @param {object} opts - { delay, priority, maxRetries }
   * @returns {object} The created job
   */
  enqueue(type, data = {}, opts = {}) {
    const now = Date.now();
    const job = this._jobs.insert({
      type,
      data,
      status: 'pending',
      priority: opts.priority || 0,
      attempts: 0,
      maxRetries: opts.maxRetries ?? this._handlers.get(type)?.maxRetries ?? this.maxRetries,
      runAt: opts.delay ? now + opts.delay : now,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null,
    });
    this._markDirty();

    // Process immediately if started
    if (this._started) this._poll();
    return job;
  }

  /**
   * Schedule a delayed job.
   * @param {string} type @param {object} data @param {number} delayMs
   */
  delay(type, data, delayMs) {
    return this.enqueue(type, data, { delay: delayMs });
  }

  /** Throttled flush — batches writes instead of flushing per-enqueue */
  _markDirty() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this.db.flush();
      this._flushTimer = null;
    }, 500);
  }

  /** Start processing jobs */
  start() {
    if (this._started) return;
    this._started = true;
    this._timer = setInterval(() => this._poll(), this.pollInterval);
    this._poll(); // immediate first poll
    return this;
  }

  /** Stop processing (running jobs finish) */
  stop() {
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }

  /** Get queue stats */
  stats() {
    const pending = this._jobs.count({ status: 'pending' });
    const processing = this._jobs.count({ status: 'processing' });
    const completed = this._jobs.count({ status: 'completed' });
    const failed = this._jobs.count({ status: 'failed' });
    const dead = this._dead.count();
    return { pending, processing, completed, failed, dead, running: this._running };
  }

  /** Get recent jobs */
  list(opts = {}) {
    const limit = opts.limit || 50;
    const status = opts.status;
    const filter = status ? { status } : {};
    return this._jobs.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  /** Get dead letter jobs */
  deadLetter(limit = 50) {
    return this._dead.find({}).sort({ diedAt: -1 }).limit(limit).toArray();
  }

  /** Retry a dead letter job */
  retry(jobId) {
    const dead = this._dead.findById(jobId);
    if (!dead) return null;
    this._dead.removeById(jobId);
    return this.enqueue(dead.type, dead.data, { maxRetries: dead.maxRetries });
  }

  /** Purge completed jobs older than ms */
  purge(olderThanMs = 86400000) {
    const cutoff = Date.now() - olderThanMs;
    const old = this._jobs.find({
      status: 'completed',
      updatedAt: { $lt: cutoff },
    }).toArray();
    for (const job of old) this._jobs.removeById(job._id);
    this.db.flush();
    return old.length;
  }

  // ─── INTERNAL ──────────────────────────────────────────────

  async _poll() {
    if (!this._started) return;
    if (this._running >= this.concurrency) return;

    const now = Date.now();
    const available = this._jobs.find({
      status: 'pending',
      runAt: { $lte: now },
    }).sort({ priority: -1, createdAt: 1 }).limit(this.concurrency - this._running).toArray();

    for (const job of available) {
      this._process(job);
    }
  }

  async _process(job) {
    const handlerDef = this._handlers.get(job.type);
    if (!handlerDef) {
      this._jobs.update({ _id: job._id }, { $set: { status: 'failed', error: `No handler for type: ${job.type}`, updatedAt: Date.now() } });
      return;
    }

    // Mark as processing
    this._jobs.update({ _id: job._id }, { $set: { status: 'processing', updatedAt: Date.now() } });
    this._running++;

    try {
      const result = await handlerDef.handler(job.data, job);
      this._jobs.update({ _id: job._id }, { $set: {
        status: 'completed', result, error: null,
        attempts: job.attempts + 1, updatedAt: Date.now(),
      }});
    } catch (err) {
      const attempts = job.attempts + 1;
      if (attempts >= job.maxRetries) {
        // Move to dead letter
        this._dead.insert({
          ...job, attempts, status: 'dead',
          error: err.message, diedAt: Date.now(),
        });
        this._jobs.removeById(job._id);
      } else {
        // Retry with exponential backoff
        const backoff = this.backoffMs * Math.pow(2, attempts);
        this._jobs.update({ _id: job._id }, { $set: {
          status: 'pending', error: err.message,
          attempts, runAt: Date.now() + backoff, updatedAt: Date.now(),
        }});
      }
    } finally {
      this._running--;
      this.db.flush();
    }
  }
}
