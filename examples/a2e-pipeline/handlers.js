/**
 * Custom operation handlers for the a2e-pipeline example, registered via
 * `WorkflowExecutor.registerHandler()`. Same call signature as every
 * built-in a2e.js operation: `(config, state) -> result`.
 */

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Validates + normalizes a single signup record. Meant to be the sole
 * sub-operation of a `Loop` (`/loop/current` is the current item) — see
 * this example's README for why a single custom op per item is the right
 * shape for a Loop, not a Conditional branching to two different op ids.
 */
export function processSignup(config, state) {
  const record = get(state, config.inputPath);
  if (!record || typeof record.email !== 'string' || !EMAIL_RE.test(record.email)) {
    return { status: 'rejected', name: record?.name, reason: 'invalid email' };
  }
  return { status: 'accepted', name: record.name, email: record.email.toLowerCase() };
}

/**
 * Deliberately slow (simulated) customer enrichment lookup — used to
 * demonstrate CacheMiddleware live: called with the same config twice
 * across two separate `execute()` runs on the same executor, the second
 * run should be dramatically faster (cache hit, handler never runs again).
 */
export function enrichCustomer(config) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ email: config.email, segment: config.email.endsWith('@vip.example.com') ? 'vip' : 'standard' }), 150);
  });
}

/**
 * Summarizes a Loop's aggregated result array (each item shaped
 * `{ process: {status, ...} }`, since `process` is the sub-operation id).
 */
export function summarizeResults(config, state) {
  const items = get(state, config.inputPath) || [];
  const accepted = items.filter((i) => i.process?.status === 'accepted');
  const rejected = items.filter((i) => i.process?.status === 'rejected');
  return {
    total: items.length,
    accepted: accepted.length,
    rejected: rejected.length,
    acceptanceRate: items.length ? Math.round((accepted.length / items.length) * 100) : 0,
    acceptedEmails: accepted.map((i) => i.process.email),
    rejectedRecords: rejected.map((i) => ({ name: i.process.name, reason: i.process.reason })),
  };
}

function get(state, path) {
  if (!path) return undefined;
  const parts = path.replace(/^\//, '').split('/');
  let current = state;
  for (const p of parts) {
    if (current == null) return undefined;
    current = /^\d+$/.test(p) ? current[parseInt(p)] : current[p];
  }
  return current;
}
