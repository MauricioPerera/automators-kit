/**
 * Registers a NEW workflow node type — text.wordCount — via the
 * `nodes:register` capability (core/plugins.js's createPluginAPI). Requires
 * `nodes:register` to be granted explicitly in the loader config
 * (setup.js), same as every other capability: a plugin cannot self-escalate
 * what it can touch.
 */

export const registeredNodeTypes = [];

export default {
  name: 'word-counter',
  version: '1.0.0',
  description: 'Registers a text.wordCount node type for use in real workflow.js workflows.',
  setup(api) {
    api.nodes.register({
      type: 'text.wordCount',
      name: 'Word Count',
      category: 'custom',
      description: 'Counts words in a text input',
      inputs: [{ name: 'text', type: 'string', required: true }],
      outputs: [{ name: 'count', type: 'number' }],
      handler: async (inputs) => (inputs.text || '').trim().split(/\s+/).filter(Boolean).length,
    });
    registeredNodeTypes.push('text.wordCount');
    api.logger.info('registered text.wordCount node type');
  },
};
