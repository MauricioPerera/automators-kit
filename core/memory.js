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
   * @param {number} opts.maxWorkingMemory - Max items in working memory (default: 50)
   * @param {number} opts.decayRate - Score decay per hour (default: 0.01)
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.maxWorkingMemory = opts.maxWorkingMemory || 50;
    this.decayRate = opts.decayRate || 0.01;

    // Collections
    this._semantic = db.collection('_memory_semantic');
    this._episodic = db.collection('_memory_episodic');
    this._working = db.collection('_memory_working');

    // Indices
    try { this._semantic.createIndex('type'); } catch {}
    try { this._semantic.createIndex('language'); } catch {}
    try { this._episodic.createIndex('outcome'); } catch {}
    try { this._episodic.createIndex('project'); } catch {}
    try { this._working.createIndex('key', { unique: true }); } catch {}

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
          const boostedScore = decayedScore * (1 + doc.accessCount * 0.1);
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

  _setWorking(key, value) {
    const existing = this._working.findOne({ key });
    if (existing) {
      this._working.update({ _id: existing._id }, { $set: { value, updatedAt: Date.now() } });
    } else {
      this._working.insert({ key, value, updatedAt: Date.now() });
    }
  }
}
