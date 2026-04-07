/**
 * Search Plugin
 * Full-text search over entries.
 */

import { Router, json, error } from '../../core/http.js';

export default {
  name: 'search',
  version: '1.0.0',
  description: 'Full-text search over entries',

  setup(api) {
    api.hooks.on('entry:afterCreate', (payload) => updateSearchIndex(api, payload.entry));
    api.hooks.on('entry:afterUpdate', (payload) => updateSearchIndex(api, payload.entry));
    api.hooks.on('entry:afterDelete', (payload) => removeFromIndex(api, payload.entry));

    const r = new Router();

    r.get('/', async (ctx) => {
      const q = ctx.query.q;
      if (!q) return error('Query parameter "q" is required', 400);

      const limit = parseInt(ctx.query.limit) || 20;
      const contentType = ctx.query.contentType;

      const entries = api.services.entries.col.find({}).toArray();
      const results = [];

      const terms = q.toLowerCase().split(/\s+/);

      for (const entry of entries) {
        if (contentType && entry.contentTypeSlug !== contentType) continue;

        // Search in title, slug, and content values
        const searchable = [
          entry.title || '',
          entry.slug || '',
          ...Object.values(entry.content || {}).filter(v => typeof v === 'string'),
        ].join(' ').toLowerCase();

        const matchCount = terms.filter(t => searchable.includes(t)).length;
        if (matchCount > 0) {
          results.push({ entry, score: matchCount / terms.length });
        }
      }

      results.sort((a, b) => b.score - a.score);

      return json({
        results: results.slice(0, limit).map(r => ({
          ...r.entry,
          _searchScore: r.score,
        })),
        total: results.length,
        query: q,
      });
    });

    api.routes.register(r);
  },
};

function updateSearchIndex(api, entry) {
  // Placeholder for future index-based search
  api.logger.info(`Indexed: ${entry.title}`);
}

function removeFromIndex(api, entry) {
  api.logger.info(`Removed from index: ${entry.title}`);
}
