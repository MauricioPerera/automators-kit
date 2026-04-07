/**
 * Cron Scheduler
 * Simple cron-like scheduler for recurring jobs. Zero dependencies.
 * Supports: minutes, hours, day-of-month, month, day-of-week.
 *
 * Usage:
 *   const cron = new CronScheduler();
 *   cron.add('cleanup', '0 * * * *', async () => { ... }); // every hour
 *   cron.add('report', '0 9 * * 1', async () => { ... });  // Mon 9am
 *   cron.start();
 */

// ---------------------------------------------------------------------------
// CRON EXPRESSION PARSER
// ---------------------------------------------------------------------------

/**
 * Parse a 5-field cron expression: minute hour day-of-month month day-of-week
 * Supports: *, star/N, N, N-M, N,M,O
 * @param {string} expr
 * @returns {{ minute: Set, hour: Set, dom: Set, month: Set, dow: Set }}
 */
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: "${expr}" (need 5 fields)`);

  return {
    minute: parseField(parts[0], 0, 59),
    hour:   parseField(parts[1], 0, 23),
    dom:    parseField(parts[2], 1, 31),
    month:  parseField(parts[3], 1, 12),
    dow:    parseField(parts[4], 0, 6),  // 0=Sunday
  };
}

function parseField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [range, step] = part.split('/');
      const stepN = parseInt(step);
      if (isNaN(stepN) || stepN <= 0) throw new Error(`Invalid cron step: ${step}`);
      const start = range === '*' ? min : parseInt(range);
      for (let i = start; i <= max; i += stepN) values.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (isNaN(lo) || isNaN(hi) || lo > hi) throw new Error(`Invalid cron range: ${part}`);
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      const num = parseInt(part);
      if (isNaN(num) || num < min || num > max) throw new Error(`Cron value out of range: ${part} (${min}-${max})`);
      values.add(num);
    }
  }

  return values;
}

/**
 * Check if a Date matches a parsed cron schedule.
 */
function matchesCron(date, schedule) {
  return (
    schedule.minute.has(date.getMinutes()) &&
    schedule.hour.has(date.getHours()) &&
    schedule.dom.has(date.getDate()) &&
    schedule.month.has(date.getMonth() + 1) &&
    schedule.dow.has(date.getDay())
  );
}

// ---------------------------------------------------------------------------
// CRON SCHEDULER
// ---------------------------------------------------------------------------

export class CronScheduler {
  /**
   * @param {object} opts
   * @param {number} opts.tickInterval - Check interval ms (default: 60000 = 1 min)
   */
  constructor(opts = {}) {
    this.tickInterval = opts.tickInterval || 60000;
    /** @type {Map<string, { name: string, expr: string, schedule: object, handler: Function, active: boolean, lastRun: number|null, runs: number, errors: number }>} */
    this._tasks = new Map();
    this._timer = null;
    this._lastMinute = -1;
  }

  /**
   * Add a cron job.
   * @param {string} name - Unique job name
   * @param {string} expr - Cron expression (5 fields)
   * @param {Function} handler - async () => void
   */
  add(name, expr, handler) {
    this._tasks.set(name, {
      name,
      expr,
      schedule: parseCron(expr),
      handler,
      active: true,
      lastRun: null,
      runs: 0,
      errors: 0,
    });
    return this;
  }

  /** Remove a job */
  remove(name) {
    this._tasks.delete(name);
    return this;
  }

  /** Enable/disable a job */
  toggle(name, active) {
    const task = this._tasks.get(name);
    if (task) task.active = active ?? !task.active;
    return this;
  }

  /** Start the scheduler */
  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this._tick(), this.tickInterval);
    this._tick(); // immediate check
    return this;
  }

  /** Stop the scheduler */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }

  /** Get all jobs and their status */
  list() {
    return Array.from(this._tasks.values()).map(t => ({
      name: t.name,
      expr: t.expr,
      active: t.active,
      lastRun: t.lastRun,
      runs: t.runs,
      errors: t.errors,
    }));
  }

  /** Run a job manually */
  async run(name) {
    const task = this._tasks.get(name);
    if (!task) throw new Error(`Cron job '${name}' not found`);
    await this._execute(task);
  }

  // ─── INTERNAL ──────────────────────────────────────────────

  _tick() {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Avoid running twice in the same minute
    if (currentMinute === this._lastMinute) return;
    this._lastMinute = currentMinute;

    for (const task of this._tasks.values()) {
      if (!task.active) continue;
      if (matchesCron(now, task.schedule)) {
        this._execute(task);
      }
    }
  }

  async _execute(task) {
    try {
      await task.handler();
      task.lastRun = Date.now();
      task.runs++;
    } catch (err) {
      task.errors++;
      console.error(`[Cron] Error in '${task.name}':`, err.message);
    }
  }
}

// Export parser for testing
export { parseCron, matchesCron };
