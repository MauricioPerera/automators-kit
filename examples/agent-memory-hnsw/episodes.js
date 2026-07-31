/**
 * Deterministic synthetic troubleshooting-memory entries — no Math.random,
 * so the same `n` always produces the same set (reproducible demo/tests).
 * Combines system/symptom/cause words so entries cluster the way real
 * agent memory would (many "database ... timeout ..." variants), which
 * matters for the ANN-vs-exact comparison this example is about — see
 * examples/large-catalog-search/catalog.js for the same rationale applied
 * to a product catalog instead of agent memory.
 *
 * @param {number} n
 * @returns {Array<{title: string, text: string}>}
 */
export function generateEpisodes(n) {
  const episodes = [];
  for (let i = 0; i < n; i++) {
    const system = SYSTEMS[i % SYSTEMS.length];
    const symptom = SYMPTOMS[Math.floor(i / SYSTEMS.length) % SYMPTOMS.length];
    const cause = CAUSES[Math.floor(i / (SYSTEMS.length * SYMPTOMS.length)) % CAUSES.length];
    episodes.push({
      title: `${system} ${symptom} #${i}`,
      text: `${system} showed ${symptom} in production, root cause was ${cause}, fixed after investigating logs`,
    });
  }
  return episodes;
}

const SYSTEMS = ['database', 'api-gateway', 'cache', 'queue-worker', 'auth-service', 'search-index', 'load-balancer', 'cron-scheduler', 'websocket-server', 'file-storage'];
const SYMPTOMS = ['high latency', 'connection timeouts', 'memory growth', 'intermittent 500s', 'stuck jobs', 'slow queries', 'connection refused', 'high CPU'];
const CAUSES = ['a missing index', 'connection pool exhaustion', 'a leaked event listener', 'clock skew between hosts', 'an unbounded retry loop', 'a stale cache entry', 'disk pressure'];
