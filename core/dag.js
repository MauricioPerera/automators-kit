/**
 * Shared DAG level-scheduling (Kahn's algorithm), used by both
 * core/workflow.js and core/a2e.js for their DAG-parallel execution.
 *
 * The two engines were independent implementations of the exact same
 * scheduling algorithm, each also carrying its OWN, genuinely different
 * dependency-detection convention:
 *   - workflow.js scans `{{nodeId.field}}` template references in `inputs`
 *   - a2e.js scans `/workflow/<opId>` string references, plus `onError` and
 *     `Conditional` branch edges
 * That detection logic stays in each engine (it's not shared, and forcing
 * it into one shape would be the "unify everything" rewrite this project
 * deliberately avoided — see README.md's "Picking between similar-sounding
 * modules" note: workflow.js and a2e.js remain two separate engines).
 * This module is only the part that WAS byte-for-byte duplicated: turning
 * an id list + a dependency map into levels that can run in parallel.
 */

/**
 * @param {string[]} ids - All node/op ids, in their original definition
 *   order. Level membership preserves this order, so output is
 *   deterministic and matches array order for ids with no dependency
 *   relationship (same behavior both engines already had independently).
 * @param {Map<string, Set<string>>} deps - id -> Set of ids it depends on
 *   (must run before it). Ids with no entry are treated as having no deps.
 * @returns {string[][]|null} Array of levels (each an array of ids that can
 *   run in parallel), or `null` if `deps` describes a cycle — the caller
 *   decides the fallback (both current callers fall back to one id per
 *   level, i.e. fully sequential, in original array order).
 */
export function buildLevels(ids, deps) {
  const inDegree = new Map(ids.map((id) => [id, (deps.get(id) || new Set()).size]));
  const remaining = new Set(ids);
  const levels = [];

  while (remaining.size > 0) {
    const ready = ids.filter((id) => remaining.has(id) && inDegree.get(id) === 0);
    if (ready.length === 0) return null; // cycle
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const other of remaining) {
        if ((deps.get(other) || new Set()).has(id)) inDegree.set(other, inDegree.get(other) - 1);
      }
    }
  }

  return levels;
}
