/**
 * Tests: core/cms.js
 * CMS services: content types, entries, taxonomies, terms, users
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { CMS } from '../core/cms.js';
import { MemoryStorageAdapter } from '../core/db.js';

let cms;

beforeEach(async () => {
  cms = new CMS(new MemoryStorageAdapter(), { secret: 'test-secret-key!!!' });
  await cms.auth.init();
});

// ---------------------------------------------------------------------------
// Content Types
// ---------------------------------------------------------------------------

describe('ContentTypes', () => {
  it('create and findBySlug', async () => {
    const ct = await cms.contentTypes.create({
      name: 'Post', slug: 'post', fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richtext' },
      ],
    });
    expect(ct.slug).toBe('post');
    expect(ct.fields.length).toBe(2);

    const found = cms.contentTypes.findBySlug('post');
    expect(found.name).toBe('Post');
  });

  it('duplicate slug throws', async () => {
    await cms.contentTypes.create({ name: 'A', slug: 'dup' });
    try {
      await cms.contentTypes.create({ name: 'B', slug: 'dup' });
      expect(true).toBe(false);
    } catch (e) {
      expect(e.message).toContain('already exists');
    }
  });

  it('findAll returns all', async () => {
    await cms.contentTypes.create({ name: 'Post', slug: 'post' });
    await cms.contentTypes.create({ name: 'Page', slug: 'page' });
    expect(cms.contentTypes.findAll().length).toBe(2);
  });

  it('update', async () => {
    await cms.contentTypes.create({ name: 'Post', slug: 'post' });
    const updated = await cms.contentTypes.update('post', { description: 'Blog posts' });
    expect(updated.description).toBe('Blog posts');
  });

  it('delete fails with entries', async () => {
    await cms.contentTypes.create({ name: 'Post', slug: 'post', fields: [{ name: 'title', type: 'text', required: true }] });
    await cms.users.register('a@t.com', 'pass12345678', { name: 'A', role: 'admin' });
    const user = cms.auth.getUserByEmail('a@t.com');
    await cms.entries.create({ title: 'Test', contentTypeSlug: 'post', content: { title: 'Test' } }, user._id);
    try {
      await cms.contentTypes.delete('post');
      expect(true).toBe(false);
    } catch (e) {
      expect(e.message).toContain('entries exist');
    }
  });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

describe('Entries', () => {
  let authorId;

  beforeEach(async () => {
    await cms.contentTypes.create({
      name: 'Post', slug: 'post', fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richtext' },
      ],
    });
    const user = await cms.users.register('author@t.com', 'pass12345678', { name: 'Author', role: 'author' });
    authorId = user._id;
  });

  it('create entry', async () => {
    const entry = await cms.entries.create({
      title: 'Hello World',
      contentTypeSlug: 'post',
      content: { title: 'Hello World', body: '<p>Test</p>' },
    }, authorId);
    expect(entry.title).toBe('Hello World');
    expect(entry.slug).toBe('hello-world');
    expect(entry.status).toBe('draft');
    expect(entry.version).toBe(1);
  });

  it('findAll with pagination', async () => {
    for (let i = 0; i < 25; i++) {
      await cms.entries.create({
        title: `Post ${i}`,
        contentTypeSlug: 'post',
        content: { title: `Post ${i}` },
      }, authorId);
    }
    const result = cms.entries.findAll({ contentType: 'post', limit: '10', page: '2' });
    expect(result.entries.length).toBe(10);
    expect(result.total).toBe(25);
    expect(result.page).toBe(2);
    expect(result.hasNext).toBe(true);
  });

  it('findAll with search', async () => {
    await cms.entries.create({ title: 'JavaScript Tips', contentTypeSlug: 'post', content: { title: 'JS' } }, authorId);
    await cms.entries.create({ title: 'Python Guide', contentTypeSlug: 'post', content: { title: 'Py' } }, authorId);
    const result = cms.entries.findAll({ search: 'javascript' });
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].title).toBe('JavaScript Tips');
  });

  it('update entry', async () => {
    const entry = await cms.entries.create({ title: 'Draft', contentTypeSlug: 'post', content: { title: 'Draft' } }, authorId);
    const updated = await cms.entries.update(entry._id, { title: 'Final' });
    expect(updated.title).toBe('Final');
    expect(updated.version).toBe(2);
  });

  it('publish and unpublish', async () => {
    const entry = await cms.entries.create({ title: 'Pub', contentTypeSlug: 'post', content: { title: 'Pub' } }, authorId);
    expect(entry.status).toBe('draft');

    const published = await cms.entries.publish(entry._id);
    expect(published.status).toBe('published');
    expect(published.publishedAt).toBeDefined();

    const unpublished = await cms.entries.unpublish(entry._id);
    expect(unpublished.status).toBe('draft');
  });

  it('delete entry', async () => {
    const entry = await cms.entries.create({ title: 'Del', contentTypeSlug: 'post', content: { title: 'Del' } }, authorId);
    await cms.entries.delete(entry._id);
    expect(cms.entries.findById(entry._id)).toBeNull();
  });

  it('duplicate slug throws', async () => {
    await cms.entries.create({ title: 'Same', slug: 'same-slug', contentTypeSlug: 'post', content: { title: 'Same' } }, authorId);
    try {
      await cms.entries.create({ title: 'Same', slug: 'same-slug', contentTypeSlug: 'post', content: { title: 'Same' } }, authorId);
      expect(true).toBe(false);
    } catch (e) {
      expect(e.message).toContain('already exists');
    }
  });

  it('validates content against type', async () => {
    try {
      await cms.entries.create({ title: 'Bad', contentTypeSlug: 'post', content: { title: 123 } }, authorId);
      expect(true).toBe(false);
    } catch (e) {
      expect(e.message).toContain('must be a string');
    }
  });
});

// ---------------------------------------------------------------------------
// Taxonomies & Terms
// ---------------------------------------------------------------------------

describe('Taxonomies & Terms', () => {
  it('create taxonomy and terms', async () => {
    const tax = await cms.taxonomies.create({ name: 'Category', slug: 'category', hierarchical: true });
    expect(tax.slug).toBe('category');

    const t1 = await cms.terms.create({ name: 'Tech', slug: 'tech', taxonomySlug: 'category' });
    const t2 = await cms.terms.create({ name: 'JS', slug: 'js', taxonomySlug: 'category', parentId: t1._id });

    const terms = cms.terms.findByTaxonomy('category');
    expect(terms.length).toBe(2);

    const tree = cms.terms.buildTree('category');
    expect(tree.length).toBe(1); // root: Tech
    expect(tree[0].children.length).toBe(1); // child: JS
    expect(tree[0].children[0].name).toBe('JS');
  });

  it('delete taxonomy cascades terms', async () => {
    await cms.taxonomies.create({ name: 'Tag', slug: 'tag' });
    await cms.terms.create({ name: 'A', slug: 'a', taxonomySlug: 'tag' });
    await cms.terms.create({ name: 'B', slug: 'b', taxonomySlug: 'tag' });

    await cms.taxonomies.delete('tag');
    expect(cms.terms.findByTaxonomy('tag').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe('Users', () => {
  it('register and login', async () => {
    const user = await cms.users.register('admin@t.com', 'admin12345678', { name: 'Admin', role: 'admin' });
    expect(user.email).toBe('admin@t.com');
    expect(user.passwordHash).toBeUndefined(); // safeUser strips it

    const result = await cms.users.login('admin@t.com', 'admin12345678');
    expect(result.token).toBeDefined();
    expect(result.user.role).toBe('admin');
  });

  it('findAll and findById', async () => {
    await cms.users.register('u1@t.com', 'pass12345678', { name: 'U1' });
    await cms.users.register('u2@t.com', 'pass12345678', { name: 'U2' });
    const all = cms.users.findAll();
    expect(all.length).toBe(2);

    const found = cms.users.findById(all[0]._id);
    expect(found).not.toBeNull();
  });

  it('update user role', async () => {
    const user = await cms.users.register('up@t.com', 'pass12345678', { name: 'Up' });
    const updated = await cms.users.update(user._id, { role: 'editor' });
    expect(updated.role).toBe('editor');
  });

  it('delete user', async () => {
    const user = await cms.users.register('del@t.com', 'pass12345678', { name: 'Del' });
    await cms.users.delete(user._id);
    expect(cms.users.findById(user._id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Autosave & Shutdown
// ---------------------------------------------------------------------------

describe('CMS lifecycle', () => {
  it('shutdown stops timers and flushes', async () => {
    const cms2 = new CMS(new MemoryStorageAdapter(), { secret: 'test', autosave: true, autosaveInterval: 100 });
    await cms2.auth.init();
    expect(cms2._autosaveTimer).not.toBeNull();
    await cms2.shutdown();
    expect(cms2._autosaveTimer).toBeNull();
  });
});
