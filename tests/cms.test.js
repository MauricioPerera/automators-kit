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

  it('a second CMS instance against already-persisted FileStorageAdapter data does not throw (restart survives)', async () => {
    const { FileStorageAdapter } = await import('../adapters/fs.js');
    const dir = './tmp-test-cms-restart-' + Date.now();
    try {
      const cms1 = new CMS(new FileStorageAdapter(dir), { secret: 'x' });
      await cms1.contentTypes.create({ name: 'Article', slug: 'article', fields: [] });
      await cms1.entries.create({ contentTypeSlug: 'article', title: 'Hello', content: {} }, 'author-1');
      await cms1.shutdown();

      // _ensureLoaded() restores persisted index defs before the constructor's
      // own createIndex() calls run -- those used to throw "Index already
      // exists on field: slug" on every second instantiation against the
      // same directory. Constructing here must not throw.
      let cms2;
      expect(() => { cms2 = new CMS(new FileStorageAdapter(dir), { secret: 'x' }); }).not.toThrow();
      expect(cms2.entries.col.find({}).toArray().length).toBe(1);
      await cms2.shutdown();
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// JWT secret hardening (FIX-13)
// ---------------------------------------------------------------------------

describe('JWT secret hardening (FIX-13)', () => {
  it('does not fall back to the public hardcoded secret when opts.secret is omitted', async () => {
    const a = new CMS(new MemoryStorageAdapter());
    await a.auth.init();
    expect(a.auth.secret).not.toBe('akit-dev-secret');
    expect(typeof a.auth.secret).toBe('string');
    expect(a.auth.secret.length).toBeGreaterThan(0);
    await a.shutdown();
  });

  it('two instances without opts.secret use distinct, non-hardcoded secrets', async () => {
    const a = new CMS(new MemoryStorageAdapter());
    const b = new CMS(new MemoryStorageAdapter());
    await a.auth.init();
    await b.auth.init();
    expect(a.auth.secret).not.toBe(b.auth.secret);
    expect(a.auth.secret).not.toBe('akit-dev-secret');
    expect(b.auth.secret).not.toBe('akit-dev-secret');
    await a.shutdown();
    await b.shutdown();
  });

  it('a token signed by a no-secret instance is NOT valid under the old hardcoded secret', async () => {
    // Instance with no explicit secret (random per-instance secret).
    const a = new CMS(new MemoryStorageAdapter());
    await a.auth.init();
    await a.users.register('x@t.com', 'pass12345678', { name: 'X', role: 'admin' });
    const { token } = await a.users.login('x@t.com', 'pass12345678');
    expect(token).toBeDefined();

    // Verifier armed with the OLD leaked hardcoded secret. If the token were
    // signed with that secret, the signature would verify. It must not.
    const leaked = new CMS(new MemoryStorageAdapter(), { secret: 'akit-dev-secret' });
    await leaked.auth.init();
    const forged = await leaked.auth._verifyJWT(token);
    expect(forged).toBeNull();
    await leaked.shutdown();
    await a.shutdown();
  });

  it('explicit opts.secret still works as before (configured behaviour preserved)', async () => {
    const cms2 = new CMS(new MemoryStorageAdapter(), { secret: 'my-explicit-secret' });
    await cms2.auth.init();
    expect(cms2.auth.secret).toBe('my-explicit-secret');
    await cms2.users.register('y@t.com', 'pass12345678', { name: 'Y', role: 'admin' });
    const { token, user } = await cms2.users.login('y@t.com', 'pass12345678');
    expect(token).toBeDefined();
    expect(user.role).toBe('admin');

    const verified = await cms2.users.verify(token);
    expect(verified).not.toBeNull();
    expect(verified.email).toBe('y@t.com');
    await cms2.shutdown();
  });
});

// ---------------------------------------------------------------------------
// EntryService :own scope authorization (FIX-30)
// ---------------------------------------------------------------------------

describe('EntryService :own scope authorization (FIX-30)', () => {
  let authorA, authorB, editor;

  beforeEach(async () => {
    await cms.contentTypes.create({
      name: 'Post', slug: 'post',
      fields: [{ name: 'title', type: 'text', required: true }],
    });
    authorA = await cms.users.register('a@t.com', 'pass12345678', { name: 'A', role: 'author' });
    authorB = await cms.users.register('b@t.com', 'pass12345678', { name: 'B', role: 'author' });
    editor = await cms.users.register('e@t.com', 'pass12345678', { name: 'E', role: 'editor' });
  });

  it('author can update/delete OWN entry when caller is passed', async () => {
    const entry = await cms.entries.create(
      { title: 'Mine', contentTypeSlug: 'post', content: { title: 'Mine' } },
      authorA._id,
    );
    const updated = await cms.entries.update(entry._id, { title: 'Mine 2' }, authorA);
    expect(updated.title).toBe('Mine 2');
    await cms.entries.delete(entry._id, authorA);
    expect(cms.entries.findById(entry._id)).toBeNull();
  });

  it('author CANNOT update another author\'s entry (rejected with authorization error)', async () => {
    const entry = await cms.entries.create(
      { title: 'B entry', contentTypeSlug: 'post', content: { title: 'B' } },
      authorB._id,
    );
    let err;
    try { await cms.entries.update(entry._id, { title: 'hacked' }, authorA); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message.toLowerCase()).toContain('author');
    // Entry must remain unchanged.
    expect(cms.entries.findById(entry._id).title).toBe('B entry');
  });

  it('author CANNOT delete another author\'s entry (rejected with authorization error)', async () => {
    const entry = await cms.entries.create(
      { title: 'B entry', contentTypeSlug: 'post', content: { title: 'B' } },
      authorB._id,
    );
    let err;
    try { await cms.entries.delete(entry._id, authorA); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message.toLowerCase()).toContain('author');
    expect(cms.entries.findById(entry._id)).not.toBeNull();
  });

  it('author CANNOT publish (no entries:publish permission, even on own entry)', async () => {
    const entry = await cms.entries.create(
      { title: 'Mine', contentTypeSlug: 'post', content: { title: 'Mine' } },
      authorA._id,
    );
    let err;
    try { await cms.entries.publish(entry._id, authorA); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message.toLowerCase()).toContain('denied');
    expect(cms.entries.findById(entry._id).status).toBe('draft');
  });

  it('editor (generic entries:write/delete) can mutate ANY author\'s entry', async () => {
    const entry = await cms.entries.create(
      { title: 'B entry', contentTypeSlug: 'post', content: { title: 'B' } },
      authorB._id,
    );
    const updated = await cms.entries.update(entry._id, { title: 'edited by editor' }, editor);
    expect(updated.title).toBe('edited by editor');
    await cms.entries.delete(entry._id, editor);
    expect(cms.entries.findById(entry._id)).toBeNull();
  });

  it('editor (generic entries:publish) can publish ANY author\'s entry', async () => {
    const entry = await cms.entries.create(
      { title: 'B entry', contentTypeSlug: 'post', content: { title: 'B' } },
      authorB._id,
    );
    const published = await cms.entries.publish(entry._id, editor);
    expect(published.status).toBe('published');
  });

  it('caller can be passed as a bare user-id string (looked up)', async () => {
    const entry = await cms.entries.create(
      { title: 'B entry', contentTypeSlug: 'post', content: { title: 'B' } },
      authorB._id,
    );
    let err;
    try { await cms.entries.update(entry._id, { title: 'x' }, authorA._id); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message.toLowerCase()).toContain('author');
  });

  it('omitting caller preserves legacy behaviour (no authorization check)', async () => {
    const entry = await cms.entries.create(
      { title: 'B entry', contentTypeSlug: 'post', content: { title: 'B' } },
      authorB._id,
    );
    // No caller → no check, mutates regardless of authorship (back-compat).
    const updated = await cms.entries.update(entry._id, { title: 'legacy' });
    expect(updated.title).toBe('legacy');
    await cms.entries.delete(entry._id);
    expect(cms.entries.findById(entry._id)).toBeNull();
  });
});
