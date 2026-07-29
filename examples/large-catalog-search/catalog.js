/**
 * Deterministic synthetic product catalog — no Math.random, so the same `n`
 * always produces the same catalog (reproducible demo/tests, no seed to
 * manage). Combines category/adjective/brand words so products cluster the
 * way a real catalog would (many "wireless ... laptop" variants), which
 * matters for the ANN-vs-exact comparison this example is about: a
 * catalog of literally-random text wouldn't stress the index the same way.
 *
 * @param {number} n
 * @returns {Array<{id: string, text: string}>}
 */
export function generateCatalog(n) {
  const products = [];
  for (let i = 0; i < n; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const adj = ADJECTIVES[Math.floor(i / CATEGORIES.length) % ADJECTIVES.length];
    const brand = BRANDS[Math.floor(i / (CATEGORIES.length * ADJECTIVES.length)) % BRANDS.length];
    products.push({ id: `p${i}`, text: `${brand} ${adj} ${cat} model ${i}` });
  }
  return products;
}

const CATEGORIES = ['laptop', 'phone', 'headphones', 'camera', 'monitor', 'keyboard', 'mouse', 'tablet', 'speaker', 'router', 'printer', 'webcam'];
const ADJECTIVES = ['wireless', 'portable', 'compact', 'professional', 'budget', 'premium', 'rugged', 'ultra-thin', 'gaming', 'ergonomic'];
const BRANDS = ['acme', 'zenith', 'nova', 'vertex', 'pulse', 'orbit', 'crest', 'flux', 'apex', 'drift'];
