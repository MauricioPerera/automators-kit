/**
 * Vector Memory — end-to-end regression test.
 * Mirrors examples/vector-memory/setup.js (reuses buildVectorTools + embed)
 * so the demo and the test can't drift apart. Uses VectorStore's own
 * MemoryStorageAdapter (in-process, no disk) for speed/isolation.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter as CmsMemoryAdapter } from '../adapters/memory.js';
import { VectorStore, MemoryStorageAdapter as VectorMemoryAdapter } from '../core/vector.js';
import { buildVectorTools } from '../examples/vector-memory/tools.js';
import { embed } from '../examples/vector-memory/embed.js';

let app;
let store;
let tools;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function exec(cmd) {
  const res = await app.handle(req(cmd));
  return res.json();
}

beforeAll(async () => {
  app = await createApp({ adapter: new CmsMemoryAdapter(), secret: 'vector-memory-test-secret!!!' });
  store = new VectorStore(new VectorMemoryAdapter(), 64);
  tools = buildVectorTools(store);

  app.shell.registry.register('notes', 'index', { description: 'index' }, async (args) => tools.index(args));
  app.shell.registry.register('notes', 'search', { description: 'search' }, async (args) => tools.search({ query: args.query || args._0, limit: args.limit, tag: args.tag }));
  app.shell.registry.register('notes', 'forget', { description: 'forget' }, async (args) => tools.forget({ id: args.id || args._0 }));
  app.shell.registry.register('notes', 'stats', { description: 'stats' }, async () => tools.stats());
});

describe('embed()', () => {
  it('is deterministic — same text always produces the same vector', () => {
    expect(embed('hello world')).toEqual(embed('hello world'));
  });

  it('produces a unit-normalized vector of the requested dimension', () => {
    const v = embed('some text here', 32);
    expect(v.length).toBe(32);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe('Vector memory: index + search', () => {
  it('finds a note by close word-overlap with the query', async () => {
    await exec('notes:index --text "The invoice PDF export is broken on Safari" --tag bug');
    await exec('notes:index --text "Recipe: how to make sourdough bread at home" --tag cooking');

    const res = await exec('notes:search --query "Safari invoice export broken"');
    expect(res.code).toBe(0);
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data[0].text).toContain('Safari');
    expect(res.data[0].tag).toBe('bug');
  });

  it('ranks the more word-overlapping note above an unrelated one', async () => {
    const res = await exec('notes:search --query "PDF export Safari"');
    const texts = res.data.map((r) => r.text);
    const bugIdx = texts.findIndex((t) => t.includes('Safari'));
    const cookingIdx = texts.findIndex((t) => t.includes('sourdough'));
    expect(bugIdx).toBeGreaterThanOrEqual(0);
    if (cookingIdx !== -1) expect(bugIdx).toBeLessThan(cookingIdx);
  });

  it('filters by tag metadata', async () => {
    const res = await exec('notes:search --query "bread" --tag bug');
    expect(res.data.every((r) => r.tag === 'bug')).toBe(true);
  });

  it('stats reflects the indexed count', async () => {
    const res = await exec('notes:stats');
    expect(res.data.count).toBe(2);
  });

  it('forget removes a note so it no longer appears in search', async () => {
    const indexed = await exec('notes:index --text "Temporary note to delete" --tag scratch');
    const before = await exec('notes:search --query "temporary note delete" --limit 10');
    expect(before.data.some((r) => r.id === indexed.data.id)).toBe(true);

    await exec(`notes:forget ${indexed.data.id}`);
    const after = await exec('notes:search --query "temporary note delete" --limit 10');
    expect(after.data.some((r) => r.id === indexed.data.id)).toBe(false);
  });
});
