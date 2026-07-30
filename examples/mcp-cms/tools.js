/**
 * A custom MCP tool for the mcp-cms example, merged alongside the 20 base
 * CMS tools via buildAllTools(cms, extraTools). Demonstrates a *compound*
 * operation none of the 20 base tools can do alone: publish an entry AND
 * compute reading stats from its Portable Text content in one round trip.
 */

import { wordCount, extractText } from '../../core/portable-text.js';

/**
 * @param {import('../../core/cms.js').CMS} cms
 */
export function buildExtraTools(cms) {
  return {
    publish_with_stats: {
      description: 'Publish an entry and return word count + a short excerpt computed from its Portable Text blocks',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Entry id' } },
        required: ['id'],
      },
      handler: async ({ id }) => {
        const entry = await cms.entries.publish(id);
        const blocks = entry.content?.blocks;
        if (!Array.isArray(blocks)) return { entry, stats: null };
        const words = wordCount(blocks);
        const text = extractText(blocks);
        return {
          entry,
          stats: {
            wordCount: words,
            readingTimeMin: Math.max(1, Math.round(words / 200)),
            excerpt: text.length > 160 ? text.slice(0, 157) + '...' : text,
          },
        };
      },
    },
  };
}
