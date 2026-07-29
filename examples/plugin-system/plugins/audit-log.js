/**
 * Logs entry create/publish events into its OWN namespaced database
 * collection — requires `database:write` to be granted explicitly in the
 * loader config (setup.js), not something this plugin can grant itself.
 * `api.database.collection('events')` resolves to `plugin_audit-log_events`
 * in the real DocStore (core/plugins.js prefixes it), so it can never
 * collide with or reach the CMS's own `entries` collection.
 */

export const auditEvents = [];

export default {
  name: 'audit-log',
  version: '1.0.0',
  description: 'Logs entry create/publish events to its own database namespace.',
  setup(api) {
    const events = api.database.collection('events');

    api.hooks.on('entry:afterCreate', async ({ entry }) => {
      const record = { action: 'created', entryId: entry._id, title: entry.title, at: Date.now() };
      events.insert(record);
      auditEvents.push(record);
      api.logger.info(`logged: created "${entry.title}"`);
    });

    api.hooks.on('entry:afterPublish', async ({ entry }) => {
      const record = { action: 'published', entryId: entry._id, title: entry.title, at: Date.now() };
      events.insert(record);
      auditEvents.push(record);
      api.logger.info(`logged: published "${entry.title}"`);
    });
  },
};
