/**
 * Revisions Plugin
 * Tracks content revision history for entries.
 */

import { Router, json, error } from '../../core/http.js';

export default {
  name: 'revisions',
  version: '1.0.0',
  description: 'Content revision history',

  setup(api) {
    const revisions = api.database.createCollection('revisions');

    // Save revision before each update
    api.hooks.on('entry:beforeUpdate', (payload) => {
      const current = api.services.entries.findById(payload.id);
      if (!current) return payload;

      revisions.insert({
        entryId: current._id,
        version: current.version || 1,
        title: current.title,
        content: current.content,
        metadata: current.metadata,
        status: current.status,
        authorId: current.authorId,
        createdAt: Date.now(),
      });

      return payload;
    });

    // Routes
    const r = new Router();

    // List revisions for an entry
    r.get('/entry/:id', async (ctx) => {
      const items = revisions.find({ entryId: ctx.params.id })
        .sort({ createdAt: -1 })
        .toArray();
      return json({ revisions: items });
    });

    // Get specific revision
    r.get('/id/:id', async (ctx) => {
      const rev = revisions.findById(ctx.params.id);
      if (!rev) return error('Revision not found', 404);
      return json({ revision: rev });
    });

    // Restore a revision
    r.post('/id/:id/restore', async (ctx) => {
      const rev = revisions.findById(ctx.params.id);
      if (!rev) return error('Revision not found', 404);

      const entry = await api.services.entries.update(rev.entryId, {
        title: rev.title,
        content: rev.content,
        metadata: rev.metadata,
      });

      return json({ entry, restoredFrom: rev._id });
    });

    api.routes.register(r);
  },
};
