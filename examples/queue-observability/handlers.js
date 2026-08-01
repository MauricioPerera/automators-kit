/**
 * Job handlers covering all 3 terminal outcomes observe.js tracks:
 * completed, dead (exhausted retries), and failed (no registered
 * handler — demonstrated by enqueueing a type nothing registers, see
 * setup.js/the regression test, not defined here).
 */

// Tracks per-id attempt counts so 'flaky-once' fails deterministically
// exactly once per distinct id, not randomly.
const _attempts = new Map();

export async function alwaysOk() {
  return { ok: true };
}

export async function flakyOnce({ id }) {
  const n = (_attempts.get(id) || 0) + 1;
  _attempts.set(id, n);
  if (n === 1) throw new Error(`Transient failure for ${id}`);
  return { ok: true, attempt: n };
}

export async function alwaysDies() {
  throw new Error('This job type never succeeds');
}
