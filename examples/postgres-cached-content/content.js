/**
 * Content pages router backed directly by a PostgresCollection instance
 * (integrations/postgres-collection.js) instead of core/db.js's DocStore --
 * every read here (list/get) is a local in-memory Map lookup, never a
 * Postgres round trip, and stays correct across however many separate
 * server processes point their own PostgresCollection at the same table
 * (see server.js/README.md for the live cross-process proof).
 */

import { json, error, notFound, Router } from '../../core/http.js';

/**
 * @param {import('../../integrations/postgres-collection.js').PostgresCollection} pages
 */
export function buildContentRouter(pages) {
  const r = new Router();

  r.get('/pages', async (ctx) => {
    const filter = ctx.query.published !== undefined
      ? { published: ctx.query.published === 'true' }
      : {};
    return json({ pages: await pages.find(filter) });
  });

  r.get('/pages/:slug', async (ctx) => {
    const page = await pages.findOne({ slug: ctx.params.slug });
    if (!page) return notFound(`No page with slug "${ctx.params.slug}"`);
    return json(page);
  });

  r.post('/pages', async (ctx) => {
    const body = await ctx.json();
    if (!body?.slug || !body?.title) return error('slug and title are required', 400);
    if (await pages.findOne({ slug: body.slug })) return error(`slug "${body.slug}" already exists`, 409);
    const page = await pages.insert({
      slug: body.slug,
      title: body.title,
      body: body.body ?? '',
      published: !!body.published,
    });
    return json(page, 201);
  });

  r.put('/pages/:slug', async (ctx) => {
    const body = await ctx.json();
    const set = {};
    for (const k of ['title', 'body', 'published']) {
      if (body?.[k] !== undefined) set[k] = body[k];
    }
    const updated = await pages.update({ slug: ctx.params.slug }, { $set: set });
    if (!updated) return notFound(`No page with slug "${ctx.params.slug}"`);
    return json(await pages.findOne({ slug: ctx.params.slug }));
  });

  r.delete('/pages/:slug', async (ctx) => {
    const removed = await pages.remove({ slug: ctx.params.slug });
    if (!removed) return notFound(`No page with slug "${ctx.params.slug}"`);
    return json({ removed: true });
  });

  return r;
}
