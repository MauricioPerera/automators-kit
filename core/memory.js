/**
 * Agent Memory System
 * Semantic + Episodic + Working memory for AI agents.
 * Port from minimemory (Rust) to vanilla JS. Zero dependencies.
 *
 * Usage:
 *   const mem = new AgentMemory(db);
 *   mem.learnTask({ task: 'Implement auth', outcome: 'success', learnings: [...] });
 *   mem.storeSnippet({ code: '...', description: '...', language: 'javascript' });
 *   mem.storeError({ error: '...', solution: '...' });
 *   const relevant = mem.recall('authentication patterns');
 *   const context = mem.getWorkingContext();
 */

import { generateId } from './db.js';

// ---------------------------------------------------------------------------
// MEMORY TYPES
// ---------------------------------------------------------------------------

export const MemoryType = {
  EPISODE: 'episode',
  CODE_SNIPPET: 'code_snippet',
  API_KNOWLEDGE: 'api_knowledge',
  PATTERN: 'pattern',
  ERROR_SOLUTION: 'error_solution',
  DOCUMENTATION: 'documentation',
  PROJECT_CONTEXT: 'project_context',
};

export const TaskOutcome = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL: 'partial',
  CANCELLED: 'cancelled',
};

// ---------------------------------------------------------------------------
// AGENT MEMORY
// ---------------------------------------------------------------------------

export class AgentMemory {
  /**
   * @param {import('./db.js').DocStore} db - DocStore instance
   * @param {object} opts
   * @param {string} opts.agentId - Agent ID for scoping (default: 'default')
   * @param {string} opts.userId - User ID for scoping (default: null)
   * @param {number} opts.maxWorkingMemory - Max items in working memory (default: 50)
   * @param {number} opts.decayRate - Score decay per hour (default: 0.01)
   * @param {number} opts.dedupThreshold - Similarity threshold for dedup (default: 0.85)
   * @param {Function} opts.similarityFn - (textA, textB) => score 0-1 (for dedup without vectors)
   * @param {Function} opts.llmFn - async (prompt) => string (for dream consolidation)
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.agentId = opts.agentId || 'default';
    this.userId = opts.userId || null;
    this.maxWorkingMemory = opts.maxWorkingMemory || 50;
    this.decayRate = opts.decayRate || 0.01;
    this.dedupThreshold = opts.dedupThreshold || 0.85;
    this._similarityFn = opts.similarityFn || null;
    this._llmFn = opts.llmFn || null;

    // Scoped collection names (PHP-style isolation)
    const scope = this.agentId + (this.userId ? `-${this.userId}` : '');
    this._semantic = db.collection(`_mem_sem_${scope}`);
    this._episodic = db.collection(`_mem_ep_${scope}`);
    this._working = db.collection(`_mem_wk_${scope}`);

    // Indices
    try { this._semantic.createIndex('type'); } catch {}
    try { this._semantic.createIndex('language'); } catch {}
    try { this._episodic.createIndex('outcome'); } catch {}
    try { this._episodic.createIndex('project'); } catch {}
    try { this._working.createIndex('key', { unique: true }); } catch {}

    // Limits
    this._maxContentSize = 1024 * 1024; // 1MB per entity
    this._maxTags = 50;

    // Working context (in-memory, ephemeral)
    this._context = {
      currentProject: null,
      currentTask: null,
      openFiles: [],
      goals: [],
      recentActions: [],
      notes: {},
    };
  }

  // ─── EPISODIC MEMORY (task experiences) ─────────────────────

  /**
   * Learn from a completed task.
   * @param {object} episode
   * @param {string} episode.task - Task description
   * @param {string} episode.outcome - 'success' | 'failure' | 'partial'
   * @param {string[]} episode.learnings - Key learnings
   * @param {string[]} episode.steps - Steps taken
   * @param {string[]} episode.errors - Errors encountered
   * @param {string} episode.code - Code written/modified
   * @param {string} episode.language - Programming language
   * @param {string} episode.project - Project name
   * @param {number} episode.durationSecs - Time taken
   * @param {string[]} episode.tags - Tags
   */
  learnTask(episode) {
    this._validateEntry(episode);
    const entry = this._episodic.insert({
      type: MemoryType.EPISODE,
      task: episode.task,
      code: episode.code || '',
      outcome: episode.outcome || TaskOutcome.SUCCESS,
      steps: episode.steps || [],
      learnings: episode.learnings || [],
      errors: episode.errors || [],
      language: episode.language || 'unknown',
      project: episode.project || this._context.currentProject,
      durationSecs: episode.durationSecs || null,
      tags: episode.tags || [],
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
    });
    this.db.flush();
    return entry;
  }

  /**
   * Get episodes by outcome.
   * @param {string} outcome - 'success' | 'failure' | 'partial'
   * @param {number} limit
   */
  getEpisodes(outcome, limit = 20) {
    const filter = outcome ? { outcome } : {};
    return this._episodic.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
  }

  /**
   * Get episodes for a project.
   */
  getProjectEpisodes(project, limit = 20) {
    return this._episodic.find({ project }).sort({ timestamp: -1 }).limit(limit).toArray();
  }

  // ─── SEMANTIC MEMORY (knowledge) ────────────────────────────

  /**
   * Store a code snippet.
   */
  storeSnippet(snippet) {
    this._validateEntry(snippet);
    return this._semantic.insert({
      type: MemoryType.CODE_SNIPPET,
      code: snippet.code,
      description: snippet.description || '',
      language: snippet.language || 'unknown',
      dependencies: snippet.dependencies || [],
      useCase: snippet.useCase || '',
      qualityScore: snippet.qualityScore || 0.5,
      tags: snippet.tags || [],
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  /**
   * Store API knowledge.
   */
  storeApiKnowledge(knowledge) {
    this._validateEntry(knowledge);
    return this._semantic.insert({
      type: MemoryType.API_KNOWLEDGE,
      library: knowledge.library,
      function: knowledge.function || '',
      description: knowledge.description || '',
      example: knowledge.example || '',
      parameters: knowledge.parameters || [],
      version: knowledge.version || null,
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  /**
   * Store an error and its solution.
   */
  storeError(errorSol) {
    this._validateEntry(errorSol);
    return this._semantic.insert({
      type: MemoryType.ERROR_SOLUTION,
      errorMessage: errorSol.error || errorSol.errorMessage,
      errorType: errorSol.errorType || 'unknown',
      rootCause: errorSol.rootCause || '',
      solution: errorSol.solution,
      fixedCode: errorSol.fixedCode || null,
      language: errorSol.language || 'unknown',
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  /**
   * Store a code pattern.
   */
  storePattern(pattern) {
    this._validateEntry(pattern);
    return this._semantic.insert({
      type: MemoryType.PATTERN,
      name: pattern.name,
      description: pattern.description || '',
      code: pattern.code || '',
      language: pattern.language || 'unknown',
      useCase: pattern.useCase || '',
      tags: pattern.tags || [],
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  /**
   * Store documentation.
   */
  storeDoc(doc) {
    this._validateEntry(doc);
    return this._semantic.insert({
      type: MemoryType.DOCUMENTATION,
      title: doc.title,
      content: doc.content,
      source: doc.source || '',
      tags: doc.tags || [],
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  // ─── RECALL (search across memories) ────────────────────────

  /**
   * Recall memories by text search (simple keyword matching).
   * For semantic search with embeddings, use vector store externally.
   * @param {string} query - Search text
   * @param {number} limit
   * @param {object} filters - { type, language, project, outcome }
   */
  recall(query, limit = 10, filters = {}) {
    limit = Math.min(Math.max(limit, 1), 200); // bounded: 1-200
    const queryLower = query.toLowerCase();
    const terms = queryLower.split(/\s+/).filter(Boolean);

    // Search across both collections
    const results = [];

    const searchCollection = (col, source) => {
      const docs = col.find(filters.type ? { type: filters.type } : {}).toArray();
      for (const doc of docs) {
        const searchable = this._extractSearchable(doc);
        const score = this._scoreMatch(terms, searchable);
        if (score > 0) {
          // Apply time decay
          const hoursSince = (Date.now() - doc.timestamp) / 3600000;
          const decayedScore = score * Math.exp(-this.decayRate * hoursSince);
          // Boost by access count
          let boostedScore = decayedScore * (1 + Math.min(doc.accessCount * 0.1, 2));
          // Correction boost: corrections surface above regular memories (2x)
          if (doc.category === 'correction' || doc.type === 'correction') boostedScore *= 2;
          results.push({ ...doc, _source: source, _score: boostedScore });
        }
      }
    };

    searchCollection(this._semantic, 'semantic');
    searchCollection(this._episodic, 'episodic');

    // Apply additional filters
    let filtered = results;
    if (filters.language) filtered = filtered.filter(r => r.language === filters.language);
    if (filters.project) filtered = filtered.filter(r => r.project === filters.project);
    if (filters.outcome) filtered = filtered.filter(r => r.outcome === filters.outcome);

    // Sort by score and return top N
    filtered.sort((a, b) => b._score - a._score);
    const top = filtered.slice(0, limit);

    // Update access counts
    for (const item of top) {
      const col = item._source === 'semantic' ? this._semantic : this._episodic;
      col.update({ _id: item._id }, { $inc: { accessCount: 1 }, $set: { lastAccessed: Date.now() } });
    }

    return top;
  }

  /**
   * Find similar errors to a given error message.
   */
  recallError(errorMessage, limit = 5) {
    return this.recall(errorMessage, limit, { type: MemoryType.ERROR_SOLUTION });
  }

  /**
   * Find relevant snippets for a use case.
   */
  recallSnippets(useCase, language, limit = 5) {
    return this.recall(useCase, limit, { type: MemoryType.CODE_SNIPPET, language });
  }

  /**
   * Find relevant past experiences.
   */
  recallExperiences(taskDescription, limit = 5) {
    return this.recall(taskDescription, limit, { type: MemoryType.EPISODE });
  }

  // ─── WORKING MEMORY (current context) ───────────────────────

  /** Set current project */
  setProject(name) {
    this._context.currentProject = name;
    this._setWorking('currentProject', name);
  }

  /** Set current task */
  setTask(description) {
    this._context.currentTask = description;
    this._setWorking('currentTask', description);
  }

  /** Add an open file to context */
  openFile(path) {
    if (!this._context.openFiles.includes(path)) {
      this._context.openFiles.push(path);
      if (this._context.openFiles.length > this.maxWorkingMemory) {
        this._context.openFiles.shift();
      }
    }
  }

  /** Remove a file from context */
  closeFile(path) {
    this._context.openFiles = this._context.openFiles.filter(f => f !== path);
  }

  /** Add a goal */
  addGoal(goal) {
    this._context.goals.push({ text: goal, addedAt: Date.now() });
  }

  /** Complete a goal */
  completeGoal(goalText) {
    this._context.goals = this._context.goals.filter(g => g.text !== goalText);
  }

  /** Log a recent action */
  logAction(action) {
    this._context.recentActions.unshift({ action, timestamp: Date.now() });
    if (this._context.recentActions.length > this.maxWorkingMemory) {
      this._context.recentActions.pop();
    }
  }

  /** Set a note in working memory */
  setNote(key, value) {
    this._context.notes[key] = value;
    this._setWorking(key, value);
  }

  /** Get the full working context */
  getWorkingContext() {
    return { ...this._context };
  }

  /** Clear working memory */
  clearWorkingMemory() {
    this._context = {
      currentProject: null,
      currentTask: null,
      openFiles: [],
      goals: [],
      recentActions: [],
      notes: {},
    };
    this._working.removeMany({});
    this.db.flush();
  }

  // ─── STATS ─────────────────────────────────────────────────

  stats() {
    return {
      semantic: this._semantic.count(),
      episodic: this._episodic.count(),
      working: {
        project: this._context.currentProject,
        task: this._context.currentTask,
        openFiles: this._context.openFiles.length,
        goals: this._context.goals.length,
        recentActions: this._context.recentActions.length,
      },
      types: {
        episodes: this._episodic.count({ type: MemoryType.EPISODE }),
        snippets: this._semantic.count({ type: MemoryType.CODE_SNIPPET }),
        errors: this._semantic.count({ type: MemoryType.ERROR_SOLUTION }),
        patterns: this._semantic.count({ type: MemoryType.PATTERN }),
        apiKnowledge: this._semantic.count({ type: MemoryType.API_KNOWLEDGE }),
        docs: this._semantic.count({ type: MemoryType.DOCUMENTATION }),
      },
    };
  }

  // ─── MAINTENANCE ───────────────────────────────────────────

  /**
   * Prune old, low-value memories.
   * @param {number} maxAge - Max age in ms (default: 30 days)
   * @param {number} minAccess - Min access count to keep (default: 0)
   */
  prune(maxAge = 30 * 24 * 60 * 60 * 1000, minAccess = 0) {
    const cutoff = Date.now() - maxAge;
    let pruned = 0;

    for (const col of [this._semantic, this._episodic]) {
      const old = col.find({
        timestamp: { $lt: cutoff },
        accessCount: { $lte: minAccess },
      }).toArray();

      for (const doc of old) {
        col.removeById(doc._id);
        pruned++;
      }
    }

    this.db.flush();
    return pruned;
  }

  /**
   * Export all memories as JSON.
   */
  export() {
    return {
      semantic: this._semantic.find({}).toArray(),
      episodic: this._episodic.find({}).toArray(),
      working: this.getWorkingContext(),
      exportedAt: Date.now(),
    };
  }

  /**
   * Import memories from JSON.
   */
  import(data) {
    let count = 0;
    for (const doc of data.semantic || []) {
      try { this._semantic.insert(doc); count++; } catch {}
    }
    for (const doc of data.episodic || []) {
      try { this._episodic.insert(doc); count++; } catch {}
    }
    this.db.flush();
    return count;
  }

  // ─── INTERNAL ──────────────────────────────────────────────

  _extractSearchable(doc) {
    const fields = [
      doc.task, doc.code, doc.description, doc.solution,
      doc.errorMessage, doc.rootCause, doc.useCase,
      doc.library, doc.function, doc.example,
      doc.name, doc.title, doc.content,
      ...(doc.learnings || []),
      ...(doc.steps || []),
      ...(doc.errors || []),
      ...(doc.tags || []),
      ...(doc.parameters || []),
      ...(doc.dependencies || []),
    ].filter(Boolean);
    return fields.join(' ').toLowerCase();
  }

  _scoreMatch(terms, text) {
    let matched = 0;
    for (const term of terms) {
      if (text.includes(term)) matched++;
    }
    return terms.length > 0 ? matched / terms.length : 0;
  }

  /** Validate entry content size and tags before save */
  _validateEntry(entry) {
    const content = entry.task || entry.code || entry.description || entry.content || entry.errorMessage || '';
    if (typeof content === 'string' && content.length > this._maxContentSize) {
      throw new Error(`Content exceeds max size (${this._maxContentSize} bytes)`);
    }
    if (Array.isArray(entry.tags) && entry.tags.length > this._maxTags) {
      entry.tags = entry.tags.slice(0, this._maxTags);
    }
  }

  _setWorking(key, value) {
    const existing = this._working.findOne({ key });
    if (existing) {
      this._working.update({ _id: existing._id }, { $set: { value, updatedAt: Date.now() } });
    } else {
      this._working.insert({ key, value, updatedAt: Date.now() });
    }
  }

  // ─── DEDUPLICATION ─────────────────────────────────────────

  /**
   * Save or update: if similar entry exists (above threshold), merge. Otherwise create new.
   * Uses keyword similarity by default, or opts.similarityFn for vector-based.
   * @param {string} collection - 'semantic' or 'episodic'
   * @param {object} entry - Entry data
   * @returns {{ entry: object, deduplicated: boolean }}
   */
  saveOrUpdate(collection, entry) {
    this._validateEntry(entry);
    const col = collection === 'episodic' ? this._episodic : this._semantic;
    const searchable = this._extractSearchable(entry);
    const terms = searchable.split(/\s+/).filter(Boolean);

    // Find most similar existing entry
    let bestMatch = null;
    let bestScore = 0;

    const existing = col.find({}).toArray();
    for (const doc of existing) {
      let score;
      if (this._similarityFn) {
        score = this._similarityFn(searchable, this._extractSearchable(doc));
      } else {
        // Keyword-based similarity (Jaccard-like)
        const docText = this._extractSearchable(doc);
        const docTerms = new Set(docText.split(/\s+/));
        const matched = terms.filter(t => docTerms.has(t)).length;
        score = terms.length > 0 ? matched / Math.max(terms.length, docTerms.size) : 0;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = doc;
      }
    }

    // Above threshold: merge into existing
    if (bestMatch && bestScore >= this.dedupThreshold) {
      const mergedTags = [...new Set([...(bestMatch.tags || []), ...(entry.tags || [])])];
      const updates = {
        ...entry,
        tags: mergedTags,
        accessCount: (bestMatch.accessCount || 0) + 1,
        updatedAt: Date.now(),
      };
      // Keep original timestamp and ID
      delete updates._id;
      delete updates.timestamp;

      col.update({ _id: bestMatch._id }, { $set: updates });
      this.db.flush();
      return { entry: { ...bestMatch, ...updates }, deduplicated: true, mergedWith: bestMatch._id };
    }

    // Below threshold: create new
    entry.timestamp = Date.now();
    entry.accessCount = 0;
    const inserted = col.insert(entry);
    this.db.flush();
    return { entry: inserted, deduplicated: false };
  }

  // ─── DREAM CYCLE (AI consolidation) ───────────────────────

  /**
   * Dream: 4-phase memory consolidation inspired by php-agent-memory.
   * Phase 1: Orient — inventory what exists
   * Phase 2: Analyze — find duplicate clusters
   * Phase 3: Consolidate — merge/remove via LLM (or heuristic if no LLM)
   * Phase 4: Verify — validate integrity
   *
   * @returns {Promise<DreamReport>}
   */
  async dream() {
    const start = performance.now();
    const log = [];
    const phase = (name) => log.push({ phase: name, ts: Date.now() });

    // Phase 1: Orient
    phase('orient');
    const semCount = this._semantic.count();
    const epCount = this._episodic.count();
    const total = semCount + epCount;
    log.push({ message: `Inventory: ${epCount} episodic, ${semCount} semantic, ${total} total` });

    if (total < 2) {
      log.push({ message: 'Too few entities to consolidate' });
      return this._dreamReport(log, start, { merged: 0, removed: 0, kept: total });
    }

    // Phase 2: Analyze — find duplicate clusters
    phase('analyze');
    const epDups = this._findDuplicateClusters(this._episodic);
    const semDups = this._findDuplicateClusters(this._semantic);
    const totalDups = epDups.length + semDups.length;
    log.push({ message: `Found ${totalDups} duplicate clusters (${epDups.length} episodic, ${semDups.length} semantic)` });

    // Phase 3: Consolidate
    phase('consolidate');
    let merged = 0, removed = 0;

    if (this._llmFn) {
      // AI-powered consolidation
      const result = await this._llmConsolidate(epDups, semDups, log);
      merged = result.merged;
      removed = result.removed;
    } else {
      // Heuristic: merge duplicates keeping the newest, remove others
      for (const cluster of [...epDups, ...semDups]) {
        const col = cluster[0]._source === 'episodic' ? this._episodic : this._semantic;
        // Sort by timestamp desc, keep newest
        cluster.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const keeper = cluster[0];
        const mergedTags = [...new Set(cluster.flatMap(e => e.tags || []))];
        col.update({ _id: keeper._id }, { $set: { tags: mergedTags, updatedAt: Date.now() } });

        for (let i = 1; i < cluster.length; i++) {
          col.removeById(cluster[i]._id);
          removed++;
        }
        merged++;
      }
      log.push({ message: `Heuristic: merged=${merged}, removed=${removed}` });
    }

    // Phase 4: Verify
    phase('verify');
    const postTotal = this._semantic.count() + this._episodic.count();
    const delta = total - postTotal;
    log.push({ message: `Post-dream: ${postTotal} entities (delta: -${delta})` });

    this.db.flush();
    return this._dreamReport(log, start, { merged, removed, kept: postTotal });
  }

  /**
   * Find clusters of similar entries within a collection.
   * @returns {Array<Array<object>>} Array of clusters (each cluster = array of similar docs)
   */
  _findDuplicateClusters(col) {
    const docs = col.find({}).toArray();
    const clusters = [];
    const used = new Set();
    const colName = col === this._episodic ? 'episodic' : 'semantic';

    for (let i = 0; i < docs.length; i++) {
      if (used.has(docs[i]._id)) continue;
      const cluster = [{ ...docs[i], _source: colName }];
      const textA = this._extractSearchable(docs[i]);
      const termsA = textA.split(/\s+/).filter(Boolean);

      for (let j = i + 1; j < docs.length; j++) {
        if (used.has(docs[j]._id)) continue;
        const textB = this._extractSearchable(docs[j]);

        let score;
        if (this._similarityFn) {
          score = this._similarityFn(textA, textB);
        } else {
          const termsB = new Set(textB.split(/\s+/));
          const matched = termsA.filter(t => termsB.has(t)).length;
          score = termsA.length > 0 ? matched / Math.max(termsA.length, termsB.size) : 0;
        }

        if (score >= this.dedupThreshold) {
          cluster.push({ ...docs[j], _source: colName });
          used.add(docs[j]._id);
        }
      }

      if (cluster.length > 1) {
        used.add(docs[i]._id);
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * LLM-powered consolidation: ask the LLM to merge/remove/keep.
   */
  async _llmConsolidate(epDups, semDups, log) {
    let merged = 0, removed = 0;

    for (const [label, clusters, col] of [
      ['episodic', epDups, this._episodic],
      ['semantic', semDups, this._semantic],
    ]) {
      if (clusters.length === 0) continue;

      for (const cluster of clusters) {
        const items = cluster.map(e => ({
          id: e._id,
          content: e.task || e.code || e.description || e.errorMessage || e.content || e.name || '',
          tags: e.tags || [],
          type: e.type || 'unknown',
        }));

        const prompt = `You are a memory consolidation system. Given these ${items.length} similar entries, decide what to do.
Return JSON: { "keep": "id_to_keep", "remove": ["id1","id2"], "mergedContent": "combined content", "mergedTags": ["tag1","tag2"] }

Entries:
${items.map(i => `- ID: ${i.id}\n  Content: ${i.content}\n  Tags: ${i.tags.join(', ')}`).join('\n')}

Rules:
- Keep the most informative entry
- Merge unique information from removed entries into mergedContent
- Combine all unique tags
- Remove duplicates and outdated info`;

        try {
          const response = await this._llmFn(prompt);
          const decision = JSON.parse(response.replace(/```json\n?|\n?```/g, '').trim());

          if (decision.keep && decision.remove?.length > 0) {
            // Apply merge
            const keeper = cluster.find(e => e._id === decision.keep);
            if (keeper) {
              const contentField = keeper.task ? 'task' : keeper.description ? 'description' : keeper.content ? 'content' : 'task';
              col.update({ _id: decision.keep }, { $set: {
                [contentField]: decision.mergedContent || keeper[contentField],
                tags: decision.mergedTags || keeper.tags,
                updatedAt: Date.now(),
              }});
              merged++;
            }

            for (const removeId of decision.remove) {
              if (cluster.some(e => e._id === removeId)) {
                col.removeById(removeId);
                removed++;
              }
            }
          }
        } catch (err) {
          // LLM failed, fallback to heuristic
          log.push({ message: `LLM error for ${label} cluster: ${err.message}, using heuristic` });
          cluster.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          const mergedTags = [...new Set(cluster.flatMap(e => e.tags || []))];
          col.update({ _id: cluster[0]._id }, { $set: { tags: mergedTags, updatedAt: Date.now() } });
          for (let i = 1; i < cluster.length; i++) {
            col.removeById(cluster[i]._id);
            removed++;
          }
          merged++;
        }
      }

      log.push({ message: `${label}: merged=${merged}, removed=${removed}` });
    }

    return { merged, removed };
  }

  _dreamReport(log, start, stats) {
    return {
      agentId: this.agentId,
      userId: this.userId,
      log,
      ...stats,
      duration_ms: Math.round(performance.now() - start),
      timestamp: Date.now(),
    };
  }
}
