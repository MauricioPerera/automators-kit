/**
 * Notifies (mock) when an entry is published. Only declares `entries:read`
 * — no database access at all. `capabilityCheck.hasDatabaseAccess` proves
 * that live, not just by reading the loader config: core/plugins.js's
 * createPluginAPI() only adds `api.database` to the api object AT ALL when
 * `database:write` was granted — an ungranted plugin doesn't get a stub
 * that throws on use, it gets no `database` property whatsoever.
 */

export const sentNotifications = [];
export const capabilityCheck = {};

export default {
  name: 'webhook-notifier',
  version: '1.0.0',
  description: 'Notifies (mock) when an entry is published. Needs only entries:read.',
  setup(api) {
    capabilityCheck.hasDatabaseAccess = api.database !== undefined;

    api.hooks.on('entry:afterPublish', async ({ entry }) => {
      // Looks the entry back up via the granted service instead of trusting
      // the hook payload alone — proves entries:read actually works, not
      // just that the hook fired.
      const fresh = api.services.entries.findById(entry._id);
      sentNotifications.push({ entryId: fresh._id, title: fresh.title, notifiedAt: Date.now() });
      api.logger.info(`(mock) notified: "${fresh.title}" published`);
    });
  },
};
