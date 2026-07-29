/**
 * A zero-dependency, offline, deterministic text embedding — the "hashing
 * trick" (feature hashing): each word gets hashed into one of `dim` buckets,
 * weighted, and the resulting vector is L2-normalized. No network call, no
 * API key, same output every run — good enough to demonstrate real cosine
 * similarity ranking over multi-dimensional vectors without any setup.
 *
 * It is NOT a real semantic embedding model: it has no notion of synonyms
 * or meaning, only word-overlap (two texts sharing more distinctive words
 * score higher). For actual semantic search (paraphrases, synonyms), swap
 * this for a real embedding API — core/vector.js already expects exactly
 * this shape (`embedFn: async (text) => number[]`, see `Reranker.autoSearch`
 * in core/vector.js) so swapping in `openai.com/v1/embeddings` or Workers AI
 * is a drop-in replacement, not a redesign. See README.md.
 *
 * @param {string} text
 * @param {number} dim
 * @returns {number[]}
 */
export function embed(text, dim = 64) {
  const vec = new Array(dim).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];

  for (const word of words) {
    const bucket = _hash(word) % dim;
    vec[bucket] += 1;
    // A second, differently-hashed bucket per word gives the hashing trick
    // a bit more resolution (fewer accidental collisions dominating).
    const bucket2 = _hash(word + '#2') % dim;
    vec[bucket2] += 0.5;
  }

  return _normalize(vec);
}

function _hash(str) {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function _normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
