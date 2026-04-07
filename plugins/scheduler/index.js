/**
 * Scheduler Plugin
 * Publishes entries at their scheduled time.
 */

export default {
  name: 'scheduler',
  version: '1.0.0',
  description: 'Scheduled publishing for entries',

  setup(api) {
    let timer = null;
    const INTERVAL = parseInt(api.config.get('interval', '60000')); // default: 1 minute

    function checkScheduled() {
      const now = Date.now();
      const pending = api.services.entries.col
        .find({ status: 'draft' })
        .toArray()
        .filter(e => e.scheduledAt && e.scheduledAt <= now);

      for (const entry of pending) {
        try {
          api.services.entries.publish(entry._id);
          api.logger.info(`Published scheduled entry: ${entry.title}`);
        } catch (err) {
          api.logger.error(`Failed to publish ${entry._id}: ${err.message}`);
        }
      }
    }

    // Start scheduler on system ready
    api.hooks.on('system:ready', () => {
      timer = setInterval(checkScheduled, INTERVAL);
      api.logger.info(`Scheduler started (interval: ${INTERVAL}ms)`);
    });

    // Stop on shutdown
    api.hooks.on('system:shutdown', () => {
      if (timer) clearInterval(timer);
      api.logger.info('Scheduler stopped');
    });
  },
};
