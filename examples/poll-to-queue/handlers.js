/**
 * The process-incident job handler — deliberately controllable per item id
 * so retries/backoff/dead-letter are demonstrable for one specific
 * incident without affecting the others (same "isolated failure" spirit
 * as core/queue.js's own per-job retry accounting).
 */

export function buildIncidentHandlers() {
  const processed = [];
  const failNextFor = new Map(); // itemId -> remaining fail count

  const handlers = {
    'process-incident': async (data) => {
      const remaining = failNextFor.get(data.id) || 0;
      if (remaining > 0) {
        failNextFor.set(data.id, remaining - 1);
        throw new Error(`Simulated failure processing incident '${data.id}' (${remaining - 1} more queued)`);
      }
      processed.push(data);
      return { processed: true, id: data.id };
    },
  };

  return {
    handlers,
    processed,
    failNextFor: (id, n) => failNextFor.set(id, n),
  };
}
