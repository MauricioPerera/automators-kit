/**
 * Audit Plugin
 * Logs all CMS operations for accountability.
 */

import { Router, json } from '../../core/http.js';

export default {
  name: 'audit',
  version: '1.0.0',
  description: 'Audit logging for all CMS operations',

  setup(api) {
    const logs = api.database.createCollection('logs');

    function logAction(action, payload) {
      logs.insert({
        action,
        timestamp: Date.now(),
        data: sanitize(payload),
      });
    }

    // Entry hooks
    api.hooks.on('entry:afterCreate', (p) => logAction('entry.create', { id: p.entry?._id, title: p.entry?.title }));
    api.hooks.on('entry:afterUpdate', (p) => logAction('entry.update', { id: p.entry?._id, title: p.entry?.title }));
    api.hooks.on('entry:afterDelete', (p) => logAction('entry.delete', { id: p.entry?._id, title: p.entry?.title }));
    api.hooks.on('entry:afterPublish', (p) => logAction('entry.publish', { id: p.entry?._id }));
    api.hooks.on('entry:afterUnpublish', (p) => logAction('entry.unpublish', { id: p.entry?._id }));

    // Content type hooks
    api.hooks.on('contentType:afterCreate', (p) => logAction('contentType.create', { slug: p.contentType?.slug }));
    api.hooks.on('contentType:afterUpdate', (p) => logAction('contentType.update', { slug: p.contentType?.slug }));
    api.hooks.on('contentType:afterDelete', (p) => logAction('contentType.delete', { slug: p.contentType?.slug }));

    // Taxonomy hooks
    api.hooks.on('taxonomy:afterCreate', (p) => logAction('taxonomy.create', { slug: p.taxonomy?.slug }));
    api.hooks.on('taxonomy:afterDelete', (p) => logAction('taxonomy.delete', { slug: p.taxonomy?.slug }));

    // User hooks
    api.hooks.on('user:afterCreate', (p) => logAction('user.create', { email: p.user?.email }));
    api.hooks.on('user:afterLogin', (p) => logAction('user.login', { email: p.user?.email }));

    // Routes
    const r = new Router();

    r.get('/', async (ctx) => {
      const limit = parseInt(ctx.query.limit) || 50;
      const action = ctx.query.action;

      let filter = {};
      if (action) filter.action = action;

      const items = logs.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
      return json({ logs: items, total: items.length });
    });

    api.routes.register(r);
  },
};

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'password' || k === 'passwordHash' || k === 'token') continue;
    clean[k] = v;
  }
  return clean;
}
