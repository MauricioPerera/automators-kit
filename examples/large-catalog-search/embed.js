/**
 * Same zero-dependency, offline, deterministic "hashing trick" embedding as
 * examples/vector-memory/embed.js — see that file's doc comment for the
 * full explanation. Duplicated here (not imported cross-example) to keep
 * each example self-contained, matching the rest of examples/.
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
