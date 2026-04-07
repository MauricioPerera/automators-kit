/**
 * HNSW Index (Hierarchical Navigable Small World)
 * Approximate nearest neighbor search in O(log n).
 * Port from minimemory (Rust) to vanilla JS. Zero dependencies.
 *
 * Usage:
 *   const hnsw = new HNSWIndex({ m: 16, efConstruction: 200, efSearch: 50 });
 *   hnsw.add('doc-1', [0.1, 0.2, ...]);
 *   const results = hnsw.search([0.15, 0.25, ...], 10);
 */

// ---------------------------------------------------------------------------
// DISTANCE FUNCTIONS
// ---------------------------------------------------------------------------

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom; // distance: 0 = identical
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

const DISTANCE_FNS = { cosine, euclidean };

// ---------------------------------------------------------------------------
// MIN-HEAP for candidates (sorted by distance ascending)
// ---------------------------------------------------------------------------

class MinHeap {
  constructor() { this.data = []; }
  get size() { return this.data.length; }
  peek() { return this.data[0]; }

  push(item) {
    this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].dist < this.data[parent].dist) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else break;
    }
  }

  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < this.data.length && this.data[l].dist < this.data[smallest].dist) smallest = l;
        if (r < this.data.length && this.data[r].dist < this.data[smallest].dist) smallest = r;
        if (smallest !== i) {
          [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
          i = smallest;
        } else break;
      }
    }
    return top;
  }
}

// MAX-HEAP (for maintaining top-K by worst distance)
class MaxHeap {
  constructor() { this.data = []; }
  get size() { return this.data.length; }
  peek() { return this.data[0]; }

  push(item) {
    this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].dist > this.data[parent].dist) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else break;
    }
  }

  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        let largest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < this.data.length && this.data[l].dist > this.data[largest].dist) largest = l;
        if (r < this.data.length && this.data[r].dist > this.data[largest].dist) largest = r;
        if (largest !== i) {
          [this.data[i], this.data[largest]] = [this.data[largest], this.data[i]];
          i = largest;
        } else break;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// HNSW INDEX
// ---------------------------------------------------------------------------

export class HNSWIndex {
  /**
   * @param {object} opts
   * @param {number} opts.m - Connections per node (default: 16)
   * @param {number} opts.efConstruction - Beam width during build (default: 200)
   * @param {number} opts.efSearch - Beam width during search (default: 50)
   * @param {string} opts.metric - Distance metric: 'cosine' | 'euclidean' (default: 'cosine')
   */
  constructor(opts = {}) {
    this.m = Math.max(opts.m || 16, 2);
    this.mMax0 = this.m * 2;
    this.efConstruction = opts.efConstruction || 200;
    this.efSearch = opts.efSearch || 50;
    this.ml = 1.0 / Math.log(this.m);
    this.distFn = DISTANCE_FNS[opts.metric || 'cosine'] || cosine;

    // Graph state
    this.levels = [];          // levels[l] = Map<nodeIdx, Set<neighborIdx>>
    this.vectors = [];         // vectors[nodeIdx] = Float32Array or number[]
    this.idToIdx = new Map();  // id -> nodeIdx
    this.idxToId = [];         // nodeIdx -> id
    this.entryPoint = -1;
    this.maxLevel = 0;
    this.nodeLevels = new Map(); // nodeIdx -> assigned level
    this.count = 0;
  }

  /** Number of vectors in the index */
  get size() { return this.count; }

  /**
   * Add a vector to the index.
   * @param {string} id
   * @param {number[]|Float32Array} vector
   */
  add(id, vector) {
    if (this.idToIdx.has(id)) return; // already exists

    const nodeIdx = this.idxToId.length;
    this.idToIdx.set(id, nodeIdx);
    this.idxToId.push(id);
    this.vectors.push(vector);
    this.count++;

    const nodeLevel = this._randomLevel();
    this.nodeLevels.set(nodeIdx, nodeLevel);

    // Ensure levels exist
    while (this.levels.length <= nodeLevel) {
      this.levels.push(new Map());
    }

    // First node — just set as entry point
    if (this.entryPoint === -1) {
      this.entryPoint = nodeIdx;
      this.maxLevel = nodeLevel;
      return;
    }

    // Navigate from top level to node's level (greedy, ef=1)
    let currentNearest = [this.entryPoint];

    for (let level = this.maxLevel; level > nodeLevel; level--) {
      const candidates = this._searchLayer(vector, currentNearest, 1, level);
      if (candidates.length > 0) {
        currentNearest = [candidates[0].idx];
      }
    }

    // Insert at each level from nodeLevel down to 0
    for (let level = Math.min(nodeLevel, this.maxLevel); level >= 0; level--) {
      const candidates = this._searchLayer(vector, currentNearest, this.efConstruction, level);
      const mLimit = level === 0 ? this.mMax0 : this.m;

      // Select best neighbors
      const neighbors = this._selectNeighbors(candidates, mLimit);

      // Set neighbors for this node
      this.levels[level].set(nodeIdx, new Set(neighbors));

      // Add reverse connections + pruning
      for (const neighborIdx of neighbors) {
        let nNeighbors = this.levels[level].get(neighborIdx);
        if (!nNeighbors) {
          nNeighbors = new Set();
          this.levels[level].set(neighborIdx, nNeighbors);
        }
        nNeighbors.add(nodeIdx);

        // Prune if exceeds mLimit
        if (nNeighbors.size > mLimit) {
          this._pruneNeighbors(neighborIdx, nNeighbors, mLimit, level);
        }
      }

      // Use candidates as entry for next level
      currentNearest = candidates.map(c => c.idx);
    }

    // Update entry point if higher level
    if (nodeLevel > this.maxLevel) {
      this.entryPoint = nodeIdx;
      this.maxLevel = nodeLevel;
    }
  }

  /**
   * Remove a vector from the index.
   * @param {string} id
   */
  remove(id) {
    const idx = this.idToIdx.get(id);
    if (idx === undefined) return false;

    // Remove from all levels
    for (const level of this.levels) {
      // Remove as neighbor from others
      const neighbors = level.get(idx);
      if (neighbors) {
        for (const n of neighbors) {
          const nSet = level.get(n);
          if (nSet) nSet.delete(idx);
        }
      }
      level.delete(idx);
    }

    this.idToIdx.delete(id);
    this.vectors[idx] = null;
    this.nodeLevels.delete(idx);
    this.count--;

    // Update entry point if removed
    if (this.entryPoint === idx) {
      this.entryPoint = -1;
      for (const [nIdx] of this.nodeLevels) {
        if (this.vectors[nIdx]) {
          this.entryPoint = nIdx;
          this.maxLevel = this.nodeLevels.get(nIdx) || 0;
          break;
        }
      }
    }

    return true;
  }

  /**
   * Search for k nearest neighbors.
   * @param {number[]|Float32Array} query
   * @param {number} k - Number of results
   * @returns {Array<{id: string, score: number, distance: number}>}
   */
  search(query, k = 10) {
    if (this.entryPoint === -1) return [];

    // Navigate from top to level 1 (greedy, ef=1)
    let currentNearest = [this.entryPoint];
    for (let level = this.maxLevel; level > 0; level--) {
      const candidates = this._searchLayer(query, currentNearest, 1, level);
      if (candidates.length > 0) {
        currentNearest = [candidates[0].idx];
      }
    }

    // Search level 0 with efSearch
    const ef = Math.max(this.efSearch, k);
    const candidates = this._searchLayer(query, currentNearest, ef, 0);

    // Return top-k
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, k).map(c => ({
      id: this.idxToId[c.idx],
      score: 1 - c.dist, // convert distance to similarity
      distance: c.dist,
    }));
  }

  /** Check if an ID exists */
  has(id) { return this.idToIdx.has(id); }

  /** Get all IDs */
  ids() { return Array.from(this.idToIdx.keys()); }

  /** Configure ef_search at runtime */
  setEfSearch(ef) { this.efSearch = Math.max(ef, 1); }

  /** Get index stats */
  stats() {
    return {
      count: this.count,
      levels: this.levels.length,
      m: this.m,
      efSearch: this.efSearch,
      entryPoint: this.entryPoint >= 0 ? this.idxToId[this.entryPoint] : null,
    };
  }

  // ─── INTERNAL ──────────────────────────────────────────────

  _randomLevel() {
    return Math.floor(-Math.log(Math.random()) * this.ml);
  }

  /**
   * Search a single layer — core HNSW algorithm.
   * @returns {Array<{idx: number, dist: number}>}
   */
  _searchLayer(query, entryPoints, ef, level) {
    const visited = new Set();
    const candidates = new MinHeap();
    const result = new MaxHeap();

    // Initialize with entry points
    for (const ep of entryPoints) {
      if (visited.has(ep)) continue;
      visited.add(ep);
      const vec = this.vectors[ep];
      if (!vec) continue;
      const dist = this.distFn(query, vec);
      candidates.push({ idx: ep, dist });
      result.push({ idx: ep, dist });
    }

    while (candidates.size > 0) {
      const current = candidates.pop();

      // If current is worse than worst in result and result is full, stop
      if (result.size >= ef && current.dist > result.peek().dist) break;

      // Explore neighbors
      const neighbors = this.levels[level]?.get(current.idx);
      if (!neighbors) continue;

      for (const neighborIdx of neighbors) {
        if (visited.has(neighborIdx)) continue;
        visited.add(neighborIdx);

        const vec = this.vectors[neighborIdx];
        if (!vec) continue;

        const dist = this.distFn(query, vec);
        const shouldAdd = result.size < ef || dist < result.peek().dist;

        if (shouldAdd) {
          candidates.push({ idx: neighborIdx, dist });
          result.push({ idx: neighborIdx, dist });

          if (result.size > ef) result.pop();
        }
      }
    }

    return result.data;
  }

  /** Select best neighbors (closest by distance) */
  _selectNeighbors(candidates, m) {
    const sorted = [...candidates].sort((a, b) => a.dist - b.dist);
    return sorted.slice(0, m).map(c => c.idx);
  }

  /** Prune neighbors to keep only closest m */
  _pruneNeighbors(nodeIdx, neighborSet, m) {
    const vec = this.vectors[nodeIdx];
    if (!vec) return;

    const scored = [];
    for (const n of neighborSet) {
      const nVec = this.vectors[n];
      if (!nVec) continue;
      scored.push({ idx: n, dist: this.distFn(vec, nVec) });
    }

    scored.sort((a, b) => a.dist - b.dist);
    neighborSet.clear();
    for (let i = 0; i < Math.min(m, scored.length); i++) {
      neighborSet.add(scored[i].idx);
    }
  }
}
