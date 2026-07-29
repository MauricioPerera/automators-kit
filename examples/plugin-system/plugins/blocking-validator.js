/**
 * Tries to BLOCK entry creation containing a banned word by throwing from
 * an `entry:beforeCreate` hook. See this example's README for why that
 * does NOT actually block anything today: core/cms.js's `EntryService`
 * calls `this.cms.hook('entry:beforeCreate', ...)` with no options, so
 * `HookSystem.execute()`'s `throwOnHookError` (which DOES exist and DOES
 * work when the caller opts in) is never enabled on this path — a
 * throwing hook is only logged, the create proceeds anyway.
 */

export const blockAttempts = [];
const BANNED_WORDS = ['BANNED'];

export default {
  name: 'blocking-validator',
  version: '1.0.0',
  description: 'Attempts to block entries containing a banned word (does not actually block — see README).',
  setup(api) {
    api.hooks.on('entry:beforeCreate', (payload) => {
      const body = JSON.stringify(payload.input?.content || {});
      const hit = BANNED_WORDS.find((w) => body.includes(w));
      if (hit) {
        blockAttempts.push({ word: hit, at: Date.now() });
        api.logger.warn(`attempting to block: banned word "${hit}" detected`);
        throw new Error(`Blocked: banned word "${hit}" detected`);
      }
      return payload;
    });
  },
};
