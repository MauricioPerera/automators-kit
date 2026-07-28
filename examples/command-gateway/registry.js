/**
 * Command Gateway — the curated, safe command surface.
 *
 * These are the ONLY operations any agent can reach through this gateway —
 * there's no raw DB access, no arbitrary query execution, nothing beyond
 * what's registered here. The RBAC boundary in setup.js then decides which
 * of these commands each persona's Shell instance is allowed to invoke.
 *
 * Shared by setup.js (the runnable demo) and
 * tests/examples-command-gateway.test.js so they can't drift apart.
 */

import { CommandRegistry } from '../../core/shell.js';

/**
 * @param {import('../../core/cms.js').CMS} cms
 * @returns {CommandRegistry}
 */
export function buildCommandRegistry(cms) {
  const registry = new CommandRegistry();

  registry.register('content', 'list', {
    description: 'List content entries, optionally filtered by status',
    params: [
      { name: 'status', type: 'string' },
      { name: 'limit', type: 'number', default: 20 },
    ],
  }, async (args) => {
    const { entries } = cms.entries.findAll({ status: args.status, limit: args.limit || 20, contentTypeSlug: 'note' });
    return entries.map((e) => ({ id: e._id, title: e.title, status: e.status }));
  });

  registry.register('content', 'search', {
    description: 'Full-text search over entry titles/slugs',
    params: [{ name: 'q', type: 'string', required: true }],
  }, async (args) => {
    const { entries } = cms.entries.findAll({ search: args.q || args._0, limit: 20, contentTypeSlug: 'note' });
    return entries.map((e) => ({ id: e._id, title: e.title, status: e.status }));
  });

  registry.register('content', 'create', {
    description: 'Create a draft content entry',
    params: [
      { name: 'title', type: 'string', required: true },
      { name: 'body', type: 'string', required: true },
    ],
  }, async (args) => {
    const entry = await cms.entries.create({
      contentTypeSlug: 'note',
      title: args.title,
      content: { title: args.title, body: args.body },
    });
    return { id: entry._id, title: entry.title, status: entry.status };
  });

  registry.register('content', 'publish', {
    description: 'Publish a draft entry',
    params: [{ name: 'id', type: 'string', required: true }],
  }, async (args) => {
    const entry = await cms.entries.publish(args.id || args._0);
    return { id: entry._id, status: entry.status };
  });

  // Destructive on purpose: this is the command that demonstrates why RBAC
  // matters here. Only the 'admin' persona in setup.js can reach it.
  registry.register('content', 'delete', {
    description: 'Permanently delete an entry',
    params: [{ name: 'id', type: 'string', required: true }],
    reversible: false,
  }, async (args) => {
    const id = args.id || args._0;
    await cms.entries.delete(id);
    return { deleted: id };
  });

  registry.register('system', 'health', {
    description: 'Entry counts by status',
  }, async () => {
    const { entries } = cms.entries.findAll({ limit: 100, contentTypeSlug: 'note' });
    return {
      total: entries.length,
      draft: entries.filter((e) => e.status === 'draft').length,
      published: entries.filter((e) => e.status === 'published').length,
    };
  });

  return registry;
}
