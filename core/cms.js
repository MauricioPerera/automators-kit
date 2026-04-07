/**
 * CMS Core Services
 * Content types, entries, taxonomies, terms, users, roles.
 * Uses js-doc-store as database engine.
 */

import { DocStore, Auth, generateId, matchFilter } from './db.js';

// ---------------------------------------------------------------------------
// ROLE PERMISSIONS
// ---------------------------------------------------------------------------

export const ROLE_PERMISSIONS = {
  admin: [
    'users:read', 'users:write', 'users:delete',
    'content-types:read', 'content-types:write', 'content-types:delete',
    'entries:read', 'entries:write', 'entries:delete', 'entries:publish',
    'taxonomies:read', 'taxonomies:write', 'taxonomies:delete',
    'terms:read', 'terms:write', 'terms:delete',
    'api-keys:read', 'api-keys:write', 'api-keys:delete',
    'settings:read', 'settings:write',
  ],
  editor: [
    'content-types:read',
    'entries:read', 'entries:write', 'entries:delete', 'entries:publish',
    'taxonomies:read', 'taxonomies:write',
    'terms:read', 'terms:write', 'terms:delete',
  ],
  author: [
    'content-types:read',
    'entries:read', 'entries:write:own', 'entries:delete:own',
    'taxonomies:read',
    'terms:read',
  ],
  viewer: [
    'content-types:read',
    'entries:read',
    'taxonomies:read',
    'terms:read',
  ],
};

/**
 * Check if a user has a specific permission.
 * @param {{ role: string }} user
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(user, permission) {
  const perms = ROLE_PERMISSIONS[user.role] || [];
  if (perms.includes(permission)) return true;
  const base = permission.split(':').slice(0, 2).join(':');
  return perms.includes(base);
}

// ---------------------------------------------------------------------------
// SLUG GENERATION
// ---------------------------------------------------------------------------

function generateSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

// ---------------------------------------------------------------------------
// CONTENT VALIDATION
// ---------------------------------------------------------------------------

/**
 * Validate entry content against content type field definitions.
 * @param {object} content
 * @param {{ fields: Array<{name:string, type:string, required?:boolean, validation?:object}> }} contentType
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateContent(content, contentType) {
  const errors = [];
  for (const field of contentType.fields || []) {
    const value = content[field.name];

    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`Field '${field.name}' is required`);
      continue;
    }
    if (value === undefined || value === null) continue;

    switch (field.type) {
      case 'text': case 'textarea': case 'richtext': case 'markdown': case 'slug':
        if (typeof value !== 'string') errors.push(`Field '${field.name}' must be a string`);
        else {
          if (field.validation?.min && value.length < field.validation.min) errors.push(`Field '${field.name}' min ${field.validation.min} chars`);
          if (field.validation?.max && value.length > field.validation.max) errors.push(`Field '${field.name}' max ${field.validation.max} chars`);
        }
        break;
      case 'number':
        if (typeof value !== 'number') errors.push(`Field '${field.name}' must be a number`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') errors.push(`Field '${field.name}' must be a boolean`);
        break;
      case 'email':
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          errors.push(`Field '${field.name}' must be a valid email`);
        break;
      case 'url':
        if (typeof value !== 'string' || !/^https?:\/\/.+/.test(value))
          errors.push(`Field '${field.name}' must be a valid URL`);
        break;
      case 'select':
        if (field.validation?.options && !field.validation.options.includes(value))
          errors.push(`Field '${field.name}' must be one of: ${field.validation.options.join(', ')}`);
        break;
      case 'multiselect':
        if (!Array.isArray(value)) errors.push(`Field '${field.name}' must be an array`);
        else if (field.validation?.options && !value.every(v => field.validation.options.includes(v)))
          errors.push(`Field '${field.name}' contains invalid options`);
        break;
      case 'json':
        // Any value is valid
        break;
      case 'date': case 'datetime':
        if (typeof value !== 'string' && typeof value !== 'number')
          errors.push(`Field '${field.name}' must be a date`);
        break;
      case 'relation': case 'media':
        if (typeof value !== 'string') errors.push(`Field '${field.name}' must be a string ID`);
        break;
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CMS CLASS
// ---------------------------------------------------------------------------

export class CMS {
  /**
   * @param {object} adapter - Storage adapter (MemoryStorageAdapter, FileStorageAdapter, etc.)
   * @param {object} opts
   * @param {string} opts.secret - JWT secret key
   * @param {number} opts.tokenExpiry - Token expiry in seconds (default: 7 days)
   * @param {boolean} opts.autosave - Enable autosave (default: true)
   * @param {number} opts.autosaveInterval - Autosave interval in ms (default: 30000)
   */
  constructor(adapter, opts = {}) {
    this.db = new DocStore(adapter);
    this.auth = new Auth(this.db, {
      secret: opts.secret || 'akit-dev-secret',
      tokenExpiry: opts.tokenExpiry || 7 * 24 * 60 * 60,
    });

    // Autosave with throttle
    this._autosaveTimer = null;
    if (opts.autosave !== false) {
      const interval = opts.autosaveInterval || 30000;
      this._autosaveTimer = setInterval(() => {
        try { this.db.flush(); }
        catch (err) { console.error('[AKit] Autosave error:', err.message); }
      }, interval);
    }

    // Core collections with indices
    this._contentTypes = this.db.collection('contentTypes');
    this._contentTypes.createIndex('slug', { unique: true });

    this._entries = this.db.collection('entries');
    this._entries.createIndex('contentTypeSlug');
    this._entries.createIndex('status');
    this._entries.createIndex('authorId');

    this._taxonomies = this.db.collection('taxonomies');
    this._taxonomies.createIndex('slug', { unique: true });

    this._terms = this.db.collection('terms');
    this._terms.createIndex('taxonomySlug');
    this._terms.createIndex('slug');

    // Hooks — initialize eagerly so hooks work before plugins load
    this._hooks = null; // set via setHooks() in createApp

    // Services as namespaced methods
    this.contentTypes = new ContentTypeService(this);
    this.entries = new EntryService(this);
    this.taxonomies = new TaxonomyService(this);
    this.terms = new TermService(this);
    this.users = new UserService(this);
  }

  /** Flush all collections to storage */
  flush() {
    this.db.flush();
  }

  /** Graceful shutdown: flush, stop timers, cleanup auth */
  async shutdown() {
    if (this._autosaveTimer) {
      clearInterval(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    if (this.auth.destroy) this.auth.destroy();
    this.db.flush();
    if (this._hooks) await this._hooks.execute('system:shutdown', {});
  }

  /** Set hook system (called by plugins.js) */
  setHooks(hooks) {
    this._hooks = hooks;
  }

  /** Execute a hook if available */
  async hook(name, payload) {
    if (this._hooks) return this._hooks.execute(name, payload);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// CONTENT TYPE SERVICE
// ---------------------------------------------------------------------------

class ContentTypeService {
  constructor(cms) { this.cms = cms; }

  get col() { return this.cms._contentTypes; }

  async create(input) {
    const payload = await this.cms.hook('contentType:beforeCreate', { input });
    const data = payload.input || input;

    if (this.col.findOne({ slug: data.slug })) {
      throw new Error(`Content type '${data.slug}' already exists`);
    }

    const now = Date.now();
    const ct = this.col.insert({
      name: data.name,
      slug: data.slug,
      description: data.description || '',
      fields: data.fields || [],
      titleField: data.titleField || 'title',
      enableVersioning: data.enableVersioning ?? false,
      enableDrafts: data.enableDrafts ?? true,
      enableScheduling: data.enableScheduling ?? false,
      createdAt: now,
      updatedAt: now,
    });

    this.cms.flush();
    await this.cms.hook('contentType:afterCreate', { contentType: ct });
    return ct;
  }

  findAll() {
    return this.col.find({}).toArray();
  }

  findBySlug(slug) {
    return this.col.findOne({ slug }) || null;
  }

  findById(id) {
    return this.col.findById(id) || null;
  }

  async update(slugOrId, input) {
    const doc = this.col.findOne({ slug: slugOrId }) || this.col.findById(slugOrId);
    if (!doc) throw new Error(`Content type '${slugOrId}' not found`);

    const payload = await this.cms.hook('contentType:beforeUpdate', { id: doc._id, input });
    const data = payload.input || input;

    if (data.slug && data.slug !== doc.slug && this.col.findOne({ slug: data.slug })) {
      throw new Error(`Content type '${data.slug}' already exists`);
    }

    this.col.update({ _id: doc._id }, {
      $set: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.slug !== undefined && { slug: data.slug }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.fields !== undefined && { fields: data.fields }),
        ...(data.titleField !== undefined && { titleField: data.titleField }),
        ...(data.enableVersioning !== undefined && { enableVersioning: data.enableVersioning }),
        ...(data.enableDrafts !== undefined && { enableDrafts: data.enableDrafts }),
        ...(data.enableScheduling !== undefined && { enableScheduling: data.enableScheduling }),
        updatedAt: Date.now(),
      },
    });

    this.cms.flush();
    const updated = this.col.findById(doc._id);
    await this.cms.hook('contentType:afterUpdate', { contentType: updated });
    return updated;
  }

  async delete(slugOrId) {
    const doc = this.col.findOne({ slug: slugOrId }) || this.col.findById(slugOrId);
    if (!doc) throw new Error(`Content type '${slugOrId}' not found`);

    // Check for existing entries
    const entries = this.cms._entries.find({ contentTypeSlug: doc.slug }).count();
    if (entries > 0) throw new Error(`Cannot delete: ${entries} entries exist for this content type`);

    await this.cms.hook('contentType:beforeDelete', { id: doc._id, contentType: doc });
    this.col.removeById(doc._id);
    this.cms.flush();
    await this.cms.hook('contentType:afterDelete', { contentType: doc });
    return doc;
  }
}

// ---------------------------------------------------------------------------
// ENTRY SERVICE
// ---------------------------------------------------------------------------

class EntryService {
  constructor(cms) { this.cms = cms; }

  get col() { return this.cms._entries; }

  async create(input, authorId) {
    const payload = await this.cms.hook('entry:beforeCreate', { input, authorId });
    const data = payload.input || input;

    // Resolve content type
    const ct = data.contentTypeSlug
      ? this.cms.contentTypes.findBySlug(data.contentTypeSlug)
      : this.cms.contentTypes.findById(data.contentTypeId);

    if (!ct) throw new Error('Content type not found');

    // Validate content against type fields
    const validation = validateContent(data.content || {}, ct);
    if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join(', ')}`);

    // Generate slug
    const slug = data.slug || generateSlug(data.title);

    // Check slug uniqueness within content type
    if (this.col.findOne({ contentTypeSlug: ct.slug, slug })) {
      throw new Error(`Entry with slug '${slug}' already exists in '${ct.slug}'`);
    }

    const now = Date.now();
    const entry = this.col.insert({
      contentTypeId: ct._id,
      contentTypeSlug: ct.slug,
      title: data.title,
      slug,
      content: data.content || {},
      metadata: data.metadata || {},
      status: data.status || 'draft',
      authorId,
      taxonomyTerms: data.taxonomyTerms || [],
      version: 1,
      locale: data.locale || 'en',
      createdAt: now,
      updatedAt: now,
      publishedAt: data.status === 'published' ? now : undefined,
      scheduledAt: data.scheduledAt,
    });

    this.cms.flush();
    await this.cms.hook('entry:afterCreate', { entry });
    return entry;
  }

  findAll(filters = {}, sort = {}, pagination = {}) {
    const page = parseInt(filters.page || pagination.page) || 1;
    const limit = Math.min(parseInt(filters.limit || pagination.limit) || 20, 100);

    // Build query filter for js-doc-store
    const query = {};
    if (filters.contentType || filters.contentTypeSlug) query.contentTypeSlug = filters.contentType || filters.contentTypeSlug;
    if (filters.status) query.status = filters.status;
    if (filters.authorId) query.authorId = filters.authorId;
    if (filters.locale) query.locale = filters.locale;

    let cursor = this.col.find(query);

    // Sort
    const sortBy = filters.sortBy || sort.field || 'createdAt';
    const sortOrder = (filters.sortOrder || sort.order || 'desc') === 'desc' ? -1 : 1;
    cursor = cursor.sort({ [sortBy]: sortOrder });

    // Get total before pagination
    const allDocs = cursor.toArray();

    // Apply text search on results (filter in-memory)
    let docs = allDocs;
    if (filters.search) {
      const s = filters.search.toLowerCase();
      docs = docs.filter(d => d.title.toLowerCase().includes(s) || d.slug.toLowerCase().includes(s));
    }

    // Apply term filter
    if (filters.terms) {
      const termIds = filters.terms.split(',');
      docs = docs.filter(d => d.taxonomyTerms && termIds.some(t => d.taxonomyTerms.includes(t)));
    }

    const total = docs.length;
    const offset = (page - 1) * limit;
    const paged = docs.slice(offset, offset + limit);

    return {
      entries: paged,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    };
  }

  findById(id) {
    return this.col.findById(id) || null;
  }

  findBySlug(slug, contentTypeSlug) {
    return this.col.findOne({ slug, contentTypeSlug }) || null;
  }

  async update(id, input) {
    const doc = this.col.findById(id);
    if (!doc) throw new Error(`Entry '${id}' not found`);

    const payload = await this.cms.hook('entry:beforeUpdate', { id, input });
    const data = payload.input || input;

    // Validate content if provided
    if (data.content) {
      const ct = this.cms.contentTypes.findBySlug(doc.contentTypeSlug);
      if (ct) {
        const validation = validateContent(data.content, ct);
        if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }
    }

    // Check slug uniqueness if changing
    if (data.slug && data.slug !== doc.slug) {
      if (this.col.findOne({ contentTypeSlug: doc.contentTypeSlug, slug: data.slug })) {
        throw new Error(`Entry with slug '${data.slug}' already exists`);
      }
    }

    const updates = {};
    for (const key of ['title', 'slug', 'content', 'metadata', 'status', 'taxonomyTerms', 'locale', 'scheduledAt']) {
      if (data[key] !== undefined) updates[key] = data[key];
    }
    updates.updatedAt = Date.now();
    updates.version = (doc.version || 1) + 1;

    this.col.update({ _id: id }, { $set: updates });
    this.cms.flush();

    const updated = this.col.findById(id);
    await this.cms.hook('entry:afterUpdate', { entry: updated, previous: doc });
    return updated;
  }

  async delete(id) {
    const doc = this.col.findById(id);
    if (!doc) throw new Error(`Entry '${id}' not found`);

    await this.cms.hook('entry:beforeDelete', { id, entry: doc });
    this.col.removeById(id);
    this.cms.flush();
    await this.cms.hook('entry:afterDelete', { entry: doc });
    return doc;
  }

  async publish(id) {
    const doc = this.col.findById(id);
    if (!doc) throw new Error(`Entry '${id}' not found`);

    await this.cms.hook('entry:beforePublish', { id, entry: doc });
    this.col.update({ _id: id }, { $set: { status: 'published', publishedAt: Date.now(), updatedAt: Date.now() } });
    this.cms.flush();

    const updated = this.col.findById(id);
    await this.cms.hook('entry:afterPublish', { entry: updated });
    return updated;
  }

  async unpublish(id) {
    const doc = this.col.findById(id);
    if (!doc) throw new Error(`Entry '${id}' not found`);

    await this.cms.hook('entry:beforeUnpublish', { id, entry: doc });
    this.col.update({ _id: id }, { $set: { status: 'draft', updatedAt: Date.now() } });
    this.cms.flush();

    const updated = this.col.findById(id);
    await this.cms.hook('entry:afterUnpublish', { entry: updated });
    return updated;
  }
}

// ---------------------------------------------------------------------------
// TAXONOMY SERVICE
// ---------------------------------------------------------------------------

class TaxonomyService {
  constructor(cms) { this.cms = cms; }

  get col() { return this.cms._taxonomies; }

  async create(input) {
    const payload = await this.cms.hook('taxonomy:beforeCreate', { input });
    const data = payload.input || input;

    if (this.col.findOne({ slug: data.slug })) {
      throw new Error(`Taxonomy '${data.slug}' already exists`);
    }

    const now = Date.now();
    const tax = this.col.insert({
      name: data.name,
      slug: data.slug,
      description: data.description || '',
      hierarchical: data.hierarchical ?? false,
      createdAt: now,
      updatedAt: now,
    });

    this.cms.flush();
    await this.cms.hook('taxonomy:afterCreate', { taxonomy: tax });
    return tax;
  }

  findAll() {
    return this.col.find({}).toArray();
  }

  findBySlug(slug) {
    return this.col.findOne({ slug }) || null;
  }

  findById(id) {
    return this.col.findById(id) || null;
  }

  async update(slugOrId, input) {
    const doc = this.col.findOne({ slug: slugOrId }) || this.col.findById(slugOrId);
    if (!doc) throw new Error(`Taxonomy '${slugOrId}' not found`);

    const payload = await this.cms.hook('taxonomy:beforeUpdate', { id: doc._id, input });
    const data = payload.input || input;

    if (data.slug && data.slug !== doc.slug && this.col.findOne({ slug: data.slug })) {
      throw new Error(`Taxonomy '${data.slug}' already exists`);
    }

    const updates = {};
    for (const key of ['name', 'slug', 'description', 'hierarchical']) {
      if (data[key] !== undefined) updates[key] = data[key];
    }
    updates.updatedAt = Date.now();

    this.col.update({ _id: doc._id }, { $set: updates });
    this.cms.flush();

    const updated = this.col.findById(doc._id);
    await this.cms.hook('taxonomy:afterUpdate', { taxonomy: updated });
    return updated;
  }

  async delete(slugOrId) {
    const doc = this.col.findOne({ slug: slugOrId }) || this.col.findById(slugOrId);
    if (!doc) throw new Error(`Taxonomy '${slugOrId}' not found`);

    // Delete associated terms
    this.cms._terms.removeMany({ taxonomySlug: doc.slug });

    await this.cms.hook('taxonomy:beforeDelete', { id: doc._id, taxonomy: doc });
    this.col.removeById(doc._id);
    this.cms.flush();
    await this.cms.hook('taxonomy:afterDelete', { taxonomy: doc });
    return doc;
  }
}

// ---------------------------------------------------------------------------
// TERM SERVICE
// ---------------------------------------------------------------------------

class TermService {
  constructor(cms) { this.cms = cms; }

  get col() { return this.cms._terms; }

  async create(input) {
    const payload = await this.cms.hook('term:beforeCreate', { input });
    const data = payload.input || input;

    // Verify taxonomy exists
    const tax = this.cms.taxonomies.findBySlug(data.taxonomySlug);
    if (!tax) throw new Error(`Taxonomy '${data.taxonomySlug}' not found`);

    // Check slug uniqueness within taxonomy
    if (this.col.findOne({ taxonomySlug: data.taxonomySlug, slug: data.slug })) {
      throw new Error(`Term '${data.slug}' already exists in taxonomy '${data.taxonomySlug}'`);
    }

    const now = Date.now();
    const term = this.col.insert({
      name: data.name,
      slug: data.slug || generateSlug(data.name),
      taxonomyId: tax._id,
      taxonomySlug: tax.slug,
      description: data.description || '',
      parentId: data.parentId || null,
      count: 0,
      createdAt: now,
      updatedAt: now,
    });

    this.cms.flush();
    await this.cms.hook('term:afterCreate', { term });
    return term;
  }

  findByTaxonomy(taxonomySlug) {
    return this.col.find({ taxonomySlug }).toArray();
  }

  findById(id) {
    return this.col.findById(id) || null;
  }

  findBySlug(slug, taxonomySlug) {
    return this.col.findOne({ slug, taxonomySlug }) || null;
  }

  async update(id, input) {
    const doc = this.col.findById(id);
    if (!doc) throw new Error(`Term '${id}' not found`);

    const payload = await this.cms.hook('term:beforeUpdate', { id, input });
    const data = payload.input || input;

    if (data.slug && data.slug !== doc.slug) {
      if (this.col.findOne({ taxonomySlug: doc.taxonomySlug, slug: data.slug })) {
        throw new Error(`Term '${data.slug}' already exists`);
      }
    }

    const updates = {};
    for (const key of ['name', 'slug', 'description', 'parentId']) {
      if (data[key] !== undefined) updates[key] = data[key];
    }
    updates.updatedAt = Date.now();

    this.col.update({ _id: id }, { $set: updates });
    this.cms.flush();

    const updated = this.col.findById(id);
    await this.cms.hook('term:afterUpdate', { term: updated });
    return updated;
  }

  async delete(id) {
    const doc = this.col.findById(id);
    if (!doc) throw new Error(`Term '${id}' not found`);

    await this.cms.hook('term:beforeDelete', { id, term: doc });
    // Re-parent children to null
    const children = this.col.find({ parentId: id }).toArray();
    for (const child of children) {
      this.col.update({ _id: child._id }, { $set: { parentId: null } });
    }
    this.col.removeById(id);
    this.cms.flush();
    await this.cms.hook('term:afterDelete', { term: doc });
    return doc;
  }

  /** Build hierarchical tree from flat terms */
  buildTree(taxonomySlug) {
    const terms = this.findByTaxonomy(taxonomySlug);
    const map = new Map();
    const roots = [];

    for (const t of terms) {
      map.set(t._id, { ...t, children: [] });
    }

    for (const t of terms) {
      const node = map.get(t._id);
      if (t.parentId && map.has(t.parentId)) {
        map.get(t.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}

// ---------------------------------------------------------------------------
// USER SERVICE
// ---------------------------------------------------------------------------

class UserService {
  constructor(cms) { this.cms = cms; }

  /**
   * Register a new user.
   * @param {string} email @param {string} password @param {object} profile
   */
  async register(email, password, profile = {}) {
    const user = await this.cms.auth.register(email, password, {
      name: profile.name || email.split('@')[0],
      role: profile.role || 'viewer',
      avatar: profile.avatar || null,
      bio: profile.bio || null,
      isActive: true,
    });
    await this.cms.hook('user:afterCreate', { user });
    return this.safeUser(user);
  }

  /** Login and return token + user */
  async login(email, password) {
    let result;
    try {
      result = await this.cms.auth.login(email, password);
    } catch {
      throw new Error('Invalid credentials');
    }
    if (!result) throw new Error('Invalid credentials');

    // Check if user is active
    const user = this.cms.auth.getUserByEmail(email);
    if (user && user.isActive === false) throw new Error('Account is disabled');

    await this.cms.hook('user:afterLogin', { user });
    return { token: result.token, user: this.safeUser(result.user) };
  }

  /** Verify a JWT token */
  async verify(token) {
    return this.cms.auth.verify(token);
  }

  findAll(filters = {}) {
    const col = this.cms.auth._users || this.cms.db.collection('_users');
    let docs = col.find({}).toArray();
    if (filters.role) docs = docs.filter(d => d.role === filters.role);
    if (filters.isActive !== undefined) docs = docs.filter(d => d.isActive === filters.isActive);
    return docs.map(d => this.safeUser(d));
  }

  findById(id) {
    const col = this.cms.auth._users || this.cms.db.collection('_users');
    const doc = col.findById(id);
    return doc ? this.safeUser(doc) : null;
  }

  async update(id, input) {
    const col = this.cms.auth._users || this.cms.db.collection('_users');
    const doc = col.findById(id);
    if (!doc) throw new Error(`User '${id}' not found`);

    await this.cms.hook('user:beforeUpdate', { id, input });

    const updates = {};
    for (const key of ['name', 'role', 'avatar', 'bio', 'isActive']) {
      if (input[key] !== undefined) updates[key] = input[key];
    }
    updates.updatedAt = Date.now();

    col.update({ _id: id }, { $set: updates });
    this.cms.db.flush();

    // Handle password change
    if (input.password) {
      await this.cms.auth.resetPassword(id, input.password);
    }

    const updated = col.findById(id);
    await this.cms.hook('user:afterUpdate', { user: updated });
    return this.safeUser(updated);
  }

  async delete(id) {
    await this.cms.hook('user:beforeDelete', { id });
    this.cms.auth.deleteUser(id);
    this.cms.db.flush();
    await this.cms.hook('user:afterDelete', { id });
    return { id };
  }

  /** Strip sensitive fields from user */
  safeUser(user) {
    if (!user) return null;
    const { passwordHash, password, ...safe } = user;
    return safe;
  }
}
