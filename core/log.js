/**
 * Structured logging
 * Zero dependencies. Replaces ad-hoc `console.log/warn/error(...)` calls
 * with leveled, structured (JSON-per-line) entries carrying a `module` tag
 * and arbitrary extra fields — the kind of thing a log aggregator (Loki,
 * ELK, CloudWatch) can actually parse and query, instead of free-text.
 *
 * Usage:
 *   import { createLogger } from './core/log.js';
 *   const log = createLogger('workflow');
 *   log.info('execution started', { workflowId, executionId });
 *   log.error('execution failed', { workflowId, err });
 *
 * Output (one JSON object per line, to stdout/stderr by default):
 *   {"ts":"2026-08-01T12:00:00.000Z","level":"info","module":"workflow","msg":"execution started","workflowId":"wf1","executionId":"abc"}
 *
 * A custom `sink` (opts.sink) can redirect entries anywhere — a file, a
 * queue, a test-capture array — without changing any call site.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON.stringify replacer: Error objects serialize their own props (message/stack) by default. */
function _replacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function _defaultSink(entry) {
  const line = JSON.stringify(entry, _replacer);
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * @param {string} module - tag identifying the emitting module (e.g. 'http', 'workflow')
 * @param {object} [opts]
 * @param {(entry: object) => void} [opts.sink] - where entries go (default: console, by level)
 * @param {'debug'|'info'|'warn'|'error'} [opts.level] - minimum level emitted (default: 'info')
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
export function createLogger(module, opts = {}) {
  const sink = opts.sink || _defaultSink;
  const minLevel = LEVELS[opts.level] ?? LEVELS.info;

  function log(level, msg, fields) {
    if (LEVELS[level] < minLevel) return;
    sink({ ts: new Date().toISOString(), level, module, msg, ...(fields || {}) });
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}

export { LEVELS };
