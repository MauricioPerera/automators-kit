/**
 * Tests: core/memory.js — Agent Memory System
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { AgentMemory, MemoryType, TaskOutcome } from '../core/memory.js';
import { DocStore, MemoryStorageAdapter } from '../core/db.js';

let db, mem;

beforeEach(() => {
  db = new DocStore(new MemoryStorageAdapter());
  mem = new AgentMemory(db, { agentId: 'test-agent', userId: 'user1', dedupThreshold: 0.4 });
});

describe('Episodic Memory', () => {
  it('learnTask stores episode', () => {
    const ep = mem.learnTask({
      task: 'Implement JWT auth',
      outcome: TaskOutcome.SUCCESS,
      learnings: ['Use Web Crypto API', 'HMAC-SHA256 for signing'],
      language: 'javascript',
    });
    expect(ep._id).toBeDefined();
    expect(ep.type).toBe(MemoryType.EPISODE);
    expect(ep.task).toBe('Implement JWT auth');
  });

  it('getEpisodes filters by outcome', () => {
    mem.learnTask({ task: 'Task A', outcome: TaskOutcome.SUCCESS });
    mem.learnTask({ task: 'Task B', outcome: TaskOutcome.FAILURE });
    mem.learnTask({ task: 'Task C', outcome: TaskOutcome.SUCCESS });

    const successes = mem.getEpisodes(TaskOutcome.SUCCESS);
    expect(successes.length).toBe(2);

    const failures = mem.getEpisodes(TaskOutcome.FAILURE);
    expect(failures.length).toBe(1);
  });

  it('getProjectEpisodes filters by project', () => {
    mem.learnTask({ task: 'A', project: 'cms' });
    mem.learnTask({ task: 'B', project: 'api' });
    mem.learnTask({ task: 'C', project: 'cms' });

    expect(mem.getProjectEpisodes('cms').length).toBe(2);
  });
});

describe('Semantic Memory', () => {
  it('storeSnippet', () => {
    const s = mem.storeSnippet({
      code: 'const hash = await crypto.subtle.digest("SHA-256", data)',
      description: 'SHA-256 hashing with Web Crypto',
      language: 'javascript',
      tags: ['crypto', 'hash'],
    });
    expect(s.type).toBe(MemoryType.CODE_SNIPPET);
  });

  it('storeError', () => {
    const e = mem.storeError({
      error: 'TypeError: Cannot read property of undefined',
      solution: 'Add null check before accessing nested property',
      language: 'javascript',
    });
    expect(e.type).toBe(MemoryType.ERROR_SOLUTION);
  });

  it('storeApiKnowledge', () => {
    const k = mem.storeApiKnowledge({
      library: 'Web Crypto',
      function: 'crypto.subtle.sign',
      description: 'Sign data with HMAC',
      example: 'await crypto.subtle.sign("HMAC", key, data)',
    });
    expect(k.type).toBe(MemoryType.API_KNOWLEDGE);
  });

  it('storePattern', () => {
    const p = mem.storePattern({
      name: 'Builder Pattern',
      description: 'Fluent API for constructing complex objects',
      language: 'javascript',
    });
    expect(p.type).toBe(MemoryType.PATTERN);
  });

  it('storeDoc', () => {
    const d = mem.storeDoc({
      title: 'HNSW Algorithm',
      content: 'Hierarchical Navigable Small World graph...',
    });
    expect(d.type).toBe(MemoryType.DOCUMENTATION);
  });
});

describe('Recall', () => {
  beforeEach(() => {
    mem.learnTask({ task: 'Build authentication system', outcome: 'success', learnings: ['JWT tokens work well'] });
    mem.learnTask({ task: 'Implement database layer', outcome: 'success', learnings: ['Use in-memory first'] });
    mem.storeSnippet({ code: 'crypto.subtle.sign()', description: 'JWT signing with Web Crypto', language: 'javascript' });
    mem.storeError({ error: 'Token expired', solution: 'Check exp claim before validation' });
  });

  it('recall finds relevant memories', () => {
    const results = mem.recall('authentication JWT token');
    expect(results.length).toBeGreaterThan(0);
    // Should find the auth task and JWT snippet
    const texts = results.map(r => r.task || r.description || r.errorMessage || '');
    expect(texts.some(t => t.toLowerCase().includes('auth') || t.toLowerCase().includes('jwt'))).toBe(true);
  });

  it('recallError finds similar errors', () => {
    const results = mem.recallError('token expired error');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe(MemoryType.ERROR_SOLUTION);
  });

  it('recallSnippets filters by language', () => {
    mem.storeSnippet({ code: 'def sign():', description: 'Python signing', language: 'python' });
    const results = mem.recallSnippets('signing', 'javascript');
    expect(results.every(r => r.language === 'javascript')).toBe(true);
  });

  it('recall respects limit', () => {
    for (let i = 0; i < 20; i++) {
      mem.storeSnippet({ code: `code_${i}`, description: `Test snippet ${i}` });
    }
    expect(mem.recall('test snippet', 5).length).toBeLessThanOrEqual(5);
  });
});

describe('Working Memory', () => {
  it('setProject and getWorkingContext', () => {
    mem.setProject('automators-kit');
    expect(mem.getWorkingContext().currentProject).toBe('automators-kit');
  });

  it('setTask', () => {
    mem.setTask('Implement HNSW');
    expect(mem.getWorkingContext().currentTask).toBe('Implement HNSW');
  });

  it('openFile / closeFile', () => {
    mem.openFile('src/index.js');
    mem.openFile('src/db.js');
    expect(mem.getWorkingContext().openFiles).toEqual(['src/index.js', 'src/db.js']);
    mem.closeFile('src/index.js');
    expect(mem.getWorkingContext().openFiles).toEqual(['src/db.js']);
  });

  it('goals', () => {
    mem.addGoal('Ship v2.0');
    mem.addGoal('Write tests');
    expect(mem.getWorkingContext().goals.length).toBe(2);
    mem.completeGoal('Ship v2.0');
    expect(mem.getWorkingContext().goals.length).toBe(1);
  });

  it('logAction', () => {
    mem.logAction('Created file db.js');
    mem.logAction('Ran tests');
    expect(mem.getWorkingContext().recentActions.length).toBe(2);
    expect(mem.getWorkingContext().recentActions[0].action).toBe('Ran tests'); // most recent first
  });

  it('clearWorkingMemory', () => {
    mem.setProject('test');
    mem.setTask('task');
    mem.openFile('file.js');
    mem.clearWorkingMemory();
    const ctx = mem.getWorkingContext();
    expect(ctx.currentProject).toBeNull();
    expect(ctx.openFiles.length).toBe(0);
  });
});

describe('Stats & Maintenance', () => {
  it('stats returns counts', () => {
    mem.learnTask({ task: 'A' });
    mem.storeSnippet({ code: 'x', description: 'y' });
    mem.storeError({ error: 'e', solution: 's' });
    const s = mem.stats();
    expect(s.episodic).toBe(1);
    expect(s.semantic).toBe(2);
    expect(s.types.episodes).toBe(1);
    expect(s.types.snippets).toBe(1);
    expect(s.types.errors).toBe(1);
  });

  it('export and import', () => {
    mem.learnTask({ task: 'Export test' });
    mem.storeSnippet({ code: 'x', description: 'y' });
    const exported = mem.export();
    expect(exported.semantic.length).toBe(1);
    expect(exported.episodic.length).toBe(1);

    // Import into fresh memory (same scope)
    const db2 = new DocStore(new MemoryStorageAdapter());
    const mem2 = new AgentMemory(db2, { agentId: 'test-agent', userId: 'user1' });
    const count = mem2.import(exported);
    expect(count).toBe(2);
    expect(mem2.stats().episodic).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

describe('Scoping', () => {
  it('different agents have isolated memories', () => {
    const db = new DocStore(new MemoryStorageAdapter());
    const memA = new AgentMemory(db, { agentId: 'agent-a', userId: 'u1' });
    const memB = new AgentMemory(db, { agentId: 'agent-b', userId: 'u1' });

    memA.learnTask({ task: 'Task for A' });
    memB.learnTask({ task: 'Task for B' });

    expect(memA.getEpisodes().length).toBe(1);
    expect(memA.getEpisodes()[0].task).toBe('Task for A');
    expect(memB.getEpisodes().length).toBe(1);
    expect(memB.getEpisodes()[0].task).toBe('Task for B');
  });

  it('different users have isolated memories', () => {
    const db = new DocStore(new MemoryStorageAdapter());
    const memU1 = new AgentMemory(db, { agentId: 'agent', userId: 'user1' });
    const memU2 = new AgentMemory(db, { agentId: 'agent', userId: 'user2' });

    memU1.storeSnippet({ code: 'x', description: 'For user1' });
    memU2.storeSnippet({ code: 'y', description: 'For user2' });

    expect(memU1.stats().semantic).toBe(1);
    expect(memU2.stats().semantic).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('Deduplication', () => {
  it('saveOrUpdate creates new when no match', () => {
    const result = mem.saveOrUpdate('semantic', {
      type: MemoryType.CODE_SNIPPET,
      code: 'console.log("hello")',
      description: 'Print hello to console',
      tags: ['javascript'],
    });
    expect(result.deduplicated).toBe(false);
    expect(result.entry._id).toBeDefined();
  });

  it('saveOrUpdate merges when similar exists', () => {
    // Insert original
    mem.storeSnippet({
      code: 'console.log("hello world")',
      description: 'Print hello world to console',
      tags: ['javascript', 'logging'],
    });

    // Try to save similar
    const result = mem.saveOrUpdate('semantic', {
      type: MemoryType.CODE_SNIPPET,
      code: 'console.log("hello world")',
      description: 'Print hello world to the console output',
      tags: ['javascript', 'debug'],
    });

    // Should deduplicate
    expect(result.deduplicated).toBe(true);
    // Tags should be merged
    expect(result.entry.tags).toContain('logging');
    expect(result.entry.tags).toContain('debug');
    // Should still be only 1 entry
    expect(mem.stats().semantic).toBe(1);
  });

  it('saveOrUpdate creates new when below threshold', () => {
    mem.storeSnippet({ code: 'x', description: 'Completely different topic about databases' });
    const result = mem.saveOrUpdate('semantic', {
      type: MemoryType.CODE_SNIPPET,
      code: 'y',
      description: 'Something about quantum physics and space exploration',
      tags: ['science'],
    });
    expect(result.deduplicated).toBe(false);
    expect(mem.stats().semantic).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Dream Cycle
// ---------------------------------------------------------------------------

describe('Dream Cycle', () => {
  it('dream with too few entries returns early', async () => {
    mem.learnTask({ task: 'Only one task' });
    const report = await mem.dream();
    expect(report.kept).toBe(1);
    expect(report.merged).toBe(0);
    expect(report.log.some(l => l.message?.includes('Too few'))).toBe(true);
  });

  it('dream heuristic merges duplicates', async () => {
    // Create 3 similar episodes
    mem.learnTask({ task: 'Deploy to production using git push', learnings: ['Use main branch'], tags: ['deploy'] });
    mem.learnTask({ task: 'Deploy to production via git push origin main', learnings: ['Check CI first'], tags: ['deploy', 'git'] });
    mem.learnTask({ task: 'Deploy production: git push origin main', learnings: ['Wait for CI'], tags: ['deploy', 'production'] });
    // Create 1 unique episode
    mem.learnTask({ task: 'Setup database migrations', tags: ['database'] });

    expect(mem.stats().episodic).toBe(4);

    // Dream without LLM (heuristic mode)
    const report = await mem.dream();

    expect(report.duration_ms).toBeGreaterThan(0);
    expect(report.agentId).toBe('test-agent');
    expect(report.log.length).toBeGreaterThan(0);
    // Should have reduced entries
    expect(report.kept).toBeLessThan(4);
    expect(report.removed).toBeGreaterThan(0);
  });

  it('dream with LLM uses AI consolidation', async () => {
    // Mock LLM
    const mockLlm = async (prompt) => {
      // Extract IDs from prompt and return merge decision
      const idMatches = prompt.match(/ID: ([^\n]+)/g) || [];
      const ids = idMatches.map(m => m.replace('ID: ', '').trim());
      if (ids.length >= 2) {
        return JSON.stringify({
          keep: ids[0],
          remove: ids.slice(1),
          mergedContent: 'Consolidated memory',
          mergedTags: ['consolidated'],
        });
      }
      return '{}';
    };

    const db2 = new DocStore(new MemoryStorageAdapter());
    const mem2 = new AgentMemory(db2, { agentId: 'ai-agent', userId: 'u1', llmFn: mockLlm, dedupThreshold: 0.5 });

    mem2.learnTask({ task: 'Deploy app', tags: ['deploy'] });
    mem2.learnTask({ task: 'Deploy application', tags: ['deploy'] });
    mem2.learnTask({ task: 'Unique task about testing', tags: ['test'] });

    const report = await mem2.dream();
    expect(report.log.some(l => l.phase === 'consolidate')).toBe(true);
    expect(report.log.some(l => l.phase === 'verify')).toBe(true);
  });

  it('dream report has correct structure', async () => {
    mem.learnTask({ task: 'A' });
    mem.learnTask({ task: 'B' });
    const report = await mem.dream();

    expect(report.agentId).toBe('test-agent');
    expect(report.userId).toBe('user1');
    expect(typeof report.duration_ms).toBe('number');
    expect(typeof report.merged).toBe('number');
    expect(typeof report.removed).toBe('number');
    expect(typeof report.kept).toBe('number');
    expect(Array.isArray(report.log)).toBe(true);
  });
});
