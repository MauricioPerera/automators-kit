/**
 * CMS Semantic Search — end-to-end regression test.
 * Mirrors examples/cms-semantic-search/setup.js's wiring: a raw CMS +
 * HookSystem + HNSWIndex, kept in sync via entry:after* hooks.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CMS } from '../core/cms.js';
import { HookSystem } from '../core/plugins.js';
import { HNSWIndex } from '../core/hnsw.js';
import { MemoryStorageAdapter } from '../core/db.js';
import { buildCmsSemanticSearchTools } from '../examples/cms-semantic-search/tools.js';

let cms, hnsw, tools;

async function seedArticle(title, body) {
  return cms.entries.create({ contentTypeSlug: 'article', title, content: { body }, status: 'published' }, 'demo-author');
}

beforeEach(async () => {
  cms = new CMS(new MemoryStorageAdapter(), { secret: 'test' });
  await cms.contentTypes.create({ name: 'Article', slug: 'article', fields: [{ name: 'body', type: 'text', required: true }] });
  hnsw = new HNSWIndex({ m: 8, efConstruction: 50, efSearch: 30 });
  tools = buildCmsSemanticSearchTools(cms, hnsw);
  const hooks = new HookSystem();
  cms.setHooks(hooks);
  hooks.on('entry:afterCreate', ({ entry }) => tools.indexEntry(entry));
  hooks.on('entry:afterUpdate', ({ entry }) => tools.indexEntry(entry));
  hooks.on('entry:afterDelete', ({ entry }) => tools.removeEntry(entry._id));
});

describe('CMS semantic search: the index stays in sync with the CMS entry lifecycle', () => {
  it('a newly created entry is searchable immediately, via the afterCreate hook, no manual reindex', async () => {
    const entry = await seedArticle('Wireless headphones review', 'bluetooth headphones with noise cancellation');
    const results = tools.search('wireless bluetooth audio', 5);
    expect(results.map((r) => r.id)).toContain(entry._id);
  });

  it('an entry that no longer matches after an update is not returned, and its new content is (afterUpdate re-indexes, does not duplicate)', async () => {
    const entry = await seedArticle('Sourdough bread recipe', 'crusty sourdough loaf baked at home');
    await cms.entries.update(entry._id, { title: 'Wireless router setup guide', content: { body: 'configuring a wireless bluetooth router' } });

    const results = tools.search('wireless bluetooth audio', 5);
    expect(results.map((r) => r.id)).toContain(entry._id);
    // Only one entry in the index for this id -- not a duplicate stale copy
    // left behind by the update.
    expect(hnsw.ids().filter((id) => id === entry._id).length).toBe(1);
  });

  it('a deleted entry is removed from search results (afterDelete)', async () => {
    const entry = await seedArticle('Budget wireless earbuds guide', 'cheap wireless bluetooth earbuds under fifty dollars');
    expect(tools.search('wireless bluetooth audio', 5).map((r) => r.id)).toContain(entry._id);

    await cms.entries.delete(entry._id);

    const results = tools.search('wireless bluetooth audio', 5);
    expect(results.map((r) => r.id)).not.toContain(entry._id);
    expect(hnsw.has(entry._id)).toBe(false);
  });
});

describe('CMS semantic search: reindexAll() catches an in-memory index up to persisted CMS state', () => {
  it('a fresh HNSWIndex (simulating a process restart) finds nothing until reindexAll() runs, then finds everything', async () => {
    const entry = await seedArticle('Wireless headphones review', 'bluetooth headphones with noise cancellation');

    // Simulate a restart: a brand new, empty index over the SAME CMS.
    const freshIndex = new HNSWIndex({ m: 8, efConstruction: 50, efSearch: 30 });
    const freshTools = buildCmsSemanticSearchTools(cms, freshIndex);

    expect(freshTools.search('wireless bluetooth audio', 5)).toEqual([]);
    const { indexed } = freshTools.reindexAll();
    expect(indexed).toBe(1);
    expect(freshTools.search('wireless bluetooth audio', 5).map((r) => r.id)).toContain(entry._id);
  });
});

describe('CMS semantic search: restarting a FileStorageAdapter-backed CMS does not throw (core/cms.js regression)', () => {
  it('a second CMS instance against already-persisted data constructs successfully', async () => {
    const { FileStorageAdapter } = await import('../adapters/fs.js');
    const dir = './tmp-test-cms-semantic-search-restart-' + Date.now();
    try {
      const cms1 = new CMS(new FileStorageAdapter(dir), { secret: 'x' });
      await cms1.contentTypes.create({ name: 'Article', slug: 'article', fields: [] });
      await cms1.entries.create({ contentTypeSlug: 'article', title: 'Hello', content: {} }, 'author-1');
      await cms1.shutdown();

      let cms2;
      expect(() => { cms2 = new CMS(new FileStorageAdapter(dir), { secret: 'x' }); }).not.toThrow();
      await cms2.shutdown();
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
