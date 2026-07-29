/**
 * Shared handlers for the provider-fanout example: ask 3 redundant suppliers
 * for the same quote and pick a winner via core/parallel.js, with
 * core/connector.js handling each supplier's own retry/timeout.
 *
 * Two winner-picking modes map directly to core/parallel.js's two exports:
 *   - quoteFastest() -> parallelRace: first supplier to answer wins,
 *     failures are ignored unless every supplier fails.
 *   - quoteBest()    -> parallelMerge: all suppliers answer, then a
 *     strategy picks the winner (highest confidence, cheapest price, or
 *     majority consensus on price).
 */

import { parallelRace, parallelMerge } from '../../core/parallel.js';

/**
 * @param {Record<string, import('../../core/connector.js').Connector>} connectors
 *   Map of supplier id -> Connector already pointed at that supplier's `/quote`.
 */
export function buildFanoutTools(connectors) {
  const ids = Object.keys(connectors);

  function buildTasks() {
    return ids.map((id) => ({
      id,
      fn: async () => {
        const res = await connectors[id].get('/quote');
        if (!res.ok) throw new Error(`${id} responded ${res.status}`);
        return { output: res.data, confidence: res.data.confidence };
      },
    }));
  }

  return {
    /** First supplier to answer wins. Ignores failures unless all fail. */
    async quoteFastest({ timeout } = {}) {
      const result = await parallelRace(buildTasks(), { timeout });
      return {
        winner: result.resolved,
        winnerSupplier: result.winnerId >= 0 ? ids[result.winnerId] : null,
        duration: result.duration,
      };
    },

    /**
     * All suppliers answer, then a strategy picks the winner.
     * @param {object} opts
     * @param {'highest-confidence'|'consensus'|'first-wins'|'all'} opts.strategy
     * @param {boolean} opts.cheapest - When true, overrides strategy scoring
     *   to pick the lowest `price` instead of `confidence`.
     */
    async quoteBest({ strategy = 'highest-confidence', cheapest = false, timeout } = {}) {
      // Note: parallelMerge's default minConfidence (0) rejects a winner
      // whose score comes back negative — a scorer like `-price` would get
      // silently discarded as "below_threshold". Use a positive-valued
      // score instead (lower price -> higher score, always > 0).
      const scorer = cheapest ? (result) => 1 / result.output.price : undefined;
      const result = await parallelMerge(buildTasks(), { strategy, scorer, timeout });
      return {
        winner: result.resolved,
        allQuotes: result.results.map((r) => ({
          supplier: r.id,
          status: r.status,
          price: r.output?.price,
          confidence: r.confidence,
          error: r.error,
        })),
        conflicts: result.conflicts,
        duration: result.duration,
      };
    },
  };
}
