/**
 * Parallel Merge
 * Execute N async tasks in parallel and merge results with configurable strategy.
 * Inspired by OSWP (Open Shadow Workspace Protocol).
 * Zero dependencies.
 *
 * Usage:
 *   const result = await parallelMerge([fn1, fn2, fn3], { strategy: 'highest-confidence' });
 *   const result = await parallelRace([fn1, fn2, fn3], { timeout: 5000 });
 */

// ---------------------------------------------------------------------------
// PARALLEL MERGE
// ---------------------------------------------------------------------------

/**
 * Execute N async functions in parallel and merge results.
 *
 * @param {Array<Function|{fn: Function, id?: string, weight?: number}>} tasks
 *   Array of async functions, or objects with { fn, id, weight }.
 *   Each fn receives no args and returns { output, confidence? } or any value.
 *
 * @param {object} opts
 * @param {string} opts.strategy - 'first-wins' | 'highest-confidence' | 'consensus' | 'all' (default: 'highest-confidence')
 * @param {number} opts.timeout - Per-task timeout in ms (default: 30000)
 * @param {number} opts.minConfidence - Minimum confidence to accept (default: 0)
 * @param {Function} opts.scorer - Custom scorer: (result, index) => number (overrides confidence field)
 *
 * @returns {Promise<{ resolved: any, results: Array, conflicts: Array, strategy: string, duration: number }>}
 */
export async function parallelMerge(tasks, opts = {}) {
  const strategy = opts.strategy || 'highest-confidence';
  const timeout = opts.timeout || 30000;
  const minConfidence = opts.minConfidence || 0;
  const scorer = opts.scorer || null;
  const start = performance.now();

  // Normalize tasks
  const normalized = tasks.map((t, i) => {
    if (typeof t === 'function') return { fn: t, id: `task-${i}`, weight: 1 };
    return { fn: t.fn, id: t.id || `task-${i}`, weight: t.weight || 1 };
  });

  // Execute all with timeout
  const promises = normalized.map(async (task) => {
    try {
      const raw = task.fn();
      const result = await withTimeout(raw instanceof Promise ? raw : Promise.resolve(raw), timeout);
      const output = result?.output !== undefined ? result.output : result;
      const confidence = scorer
        ? scorer(result, task)
        : (result?.confidence ?? 1) * task.weight;
      return { id: task.id, output, confidence, weight: task.weight, raw: result, error: null, status: 'completed' };
    } catch (err) {
      return { id: task.id, output: null, confidence: 0, raw: null, error: err.message, status: 'failed' };
    }
  });

  const results = await Promise.all(promises);
  const completed = results.filter(r => r.status === 'completed');
  const failed = results.filter(r => r.status === 'failed');

  if (completed.length === 0) {
    return {
      resolved: null,
      results,
      conflicts: [{ type: 'all_failed', errors: failed.map(f => f.error) }],
      strategy,
      duration: Math.round(performance.now() - start),
    };
  }

  // Apply strategy
  let resolved;
  let conflicts = [];

  switch (strategy) {
    case 'first-wins': {
      // First completed (they all resolved at same time via Promise.all,
      // so "first" = first in array order that succeeded)
      resolved = completed[0].output;
      break;
    }

    case 'highest-confidence': {
      const sorted = [...completed].sort((a, b) => b.confidence - a.confidence);
      const best = sorted[0];

      if (best.confidence < minConfidence) {
        conflicts.push({
          type: 'below_threshold',
          best: best.confidence,
          threshold: minConfidence,
          id: best.id,
        });
        resolved = null;
      } else {
        resolved = best.output;
      }

      // Check for close contenders (confidence gap < 0.1)
      if (sorted.length >= 2 && Math.abs(sorted[0].confidence - sorted[1].confidence) < 0.1) {
        conflicts.push({
          type: 'close_confidence',
          candidates: sorted.slice(0, 2).map(r => ({ id: r.id, confidence: r.confidence })),
        });
      }
      break;
    }

    case 'consensus': {
      // Group by output value, pick the group with most votes
      const groups = new Map();
      for (const r of completed) {
        const key = JSON.stringify(r.output);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }

      let bestGroup = null;
      let maxVotes = 0;
      for (const [key, members] of groups) {
        const votes = members.reduce((sum, m) => sum + m.weight, 0);
        if (votes > maxVotes) {
          maxVotes = votes;
          bestGroup = { key, members, votes };
        }
      }

      resolved = bestGroup ? bestGroup.members[0].output : null;

      // Conflict if no clear majority
      if (groups.size > 1 && bestGroup.votes <= completed.length / 2) {
        conflicts.push({
          type: 'no_majority',
          groups: Array.from(groups.entries()).map(([k, m]) => ({
            output: JSON.parse(k),
            votes: m.length,
            ids: m.map(r => r.id),
          })),
        });
      }
      break;
    }

    case 'all':
    default: {
      // Return all results (no merge)
      resolved = completed.map(r => r.output);
      break;
    }
  }

  return {
    resolved,
    results,
    conflicts,
    strategy,
    duration: Math.round(performance.now() - start),
  };
}

// ---------------------------------------------------------------------------
// PARALLEL RACE — first successful result wins
// ---------------------------------------------------------------------------

/**
 * Race N tasks — return the first successful result.
 * Unlike Promise.race, ignores failures unless all fail.
 *
 * @param {Array<Function>} tasks
 * @param {object} opts - { timeout }
 * @returns {Promise<{ resolved: any, winnerId: number, duration: number }>}
 */
export async function parallelRace(tasks, opts = {}) {
  const timeout = opts.timeout || 30000;
  const start = performance.now();

  return new Promise((resolve) => {
    let settled = false;
    let failures = 0;

    tasks.forEach((fn, i) => {
      let raw;
      try {
        raw = typeof fn === 'function' ? fn() : fn.fn();
      } catch (err) {
        failures++;
        if (failures === tasks.length && !settled) {
          settled = true;
          resolve({ resolved: null, winnerId: -1, duration: Math.round(performance.now() - start) });
        }
        return;
      }
      withTimeout(raw instanceof Promise ? raw : Promise.resolve(raw), timeout)
        .then(result => {
          if (!settled) {
            settled = true;
            resolve({
              resolved: result?.output !== undefined ? result.output : result,
              winnerId: i,
              duration: Math.round(performance.now() - start),
            });
          }
        })
        .catch(() => {
          failures++;
          if (failures === tasks.length && !settled) {
            settled = true;
            resolve({ resolved: null, winnerId: -1, duration: Math.round(performance.now() - start) });
          }
        });
    });
  });
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
