/**
 * Agent Memory Backend — transport-agnostic operations.
 *
 * `buildMemoryHandlers(memory)` wraps an `AgentMemory` instance (core/memory.js)
 * into plain async functions with no knowledge of HTTP, the agent shell, or
 * MCP. `buildMcpTools(handlers)` adapts those into the `{description,
 * inputSchema, handler}` shape `createMCPServer`'s `extraTools` expects.
 *
 * Shared by setup.js (shell/HTTP demo), mcp-server.js (stdio MCP server),
 * and tests/examples-agent-memory-backend.test.js — one source of truth for
 * what "remembering" and "recalling" mean here.
 */

/**
 * @param {import('../../core/memory.js').AgentMemory} memory
 */
export function buildMemoryHandlers(memory) {
  return {
    /** Record a completed task as an episodic memory. */
    learn: async (args) => {
      const episode = memory.learnTask({
        task: args.task,
        outcome: args.outcome || 'success',
        learnings: args.learnings || [],
        project: args.project,
      });
      return { id: episode._id, task: episode.task, outcome: episode.outcome };
    },

    /** Record a known error + its fix as semantic memory. */
    rememberError: async (args) => {
      const doc = memory.storeError({
        error: args.error,
        solution: args.solution,
        language: args.language,
      });
      return { id: doc._id, errorMessage: doc.errorMessage, solution: doc.solution };
    },

    /** Find memories (semantic + episodic) relevant to a query. */
    recall: async (args) => {
      const results = memory.recall(args.query, args.limit || 5);
      return results.map((r) => ({
        id: r._id,
        source: r._source, // 'semantic' | 'episodic'
        score: Number((r._score || 0).toFixed(3)),
        summary: r.task || r.errorMessage || r.description || r.title || '(no summary)',
        solution: r.solution,
      }));
    },

    /** Memory counts by type. */
    stats: async () => memory.stats(),

    /**
     * Consolidate: merge near-duplicate memories. Heuristic mode (no LLM
     * configured) — keeps the newest of each duplicate cluster, merges tags.
     */
    dream: async () => {
      const report = await memory.dream();
      return { merged: report.merged, removed: report.removed, kept: report.kept, duration_ms: report.duration_ms };
    },
  };
}

/**
 * Adapt transport-agnostic handlers into MCP `extraTools` for createMCPServer.
 * @param {ReturnType<typeof buildMemoryHandlers>} handlers
 */
export function buildMcpTools(handlers) {
  return {
    learn_task: {
      description: 'Record a completed task as episodic memory (what was done, and how it went).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What the task was' },
          outcome: { type: 'string', description: "'success' | 'failure' | 'partial'" },
          learnings: { type: 'array', description: 'Key things learned, as an array of strings' },
          project: { type: 'string' },
        },
        required: ['task'],
      },
      handler: handlers.learn,
    },
    remember_error: {
      description: 'Record a known error and its fix as semantic (reusable) memory.',
      inputSchema: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          solution: { type: 'string' },
          language: { type: 'string' },
        },
        required: ['error', 'solution'],
      },
      handler: handlers.rememberError,
    },
    recall_memory: {
      description: 'Search remembered tasks and error solutions relevant to a query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      handler: handlers.recall,
    },
    memory_stats: {
      description: 'Counts of stored memories by type.',
      inputSchema: { type: 'object', properties: {} },
      handler: handlers.stats,
    },
    dream: {
      description: 'Consolidate memory: merge near-duplicate entries (heuristic, no LLM required).',
      inputSchema: { type: 'object', properties: {} },
      handler: handlers.dream,
    },
  };
}
