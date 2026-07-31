/**
 * A real custom core/workflow.js node backed by core/portable-text.js —
 * `content.render` parses a markdown string into Portable Text blocks and
 * renders HTML + plain text + word count from the SAME parsed blocks, so
 * a workflow step can publish/notify without re-parsing markdown itself.
 * Same node-definition shape as every built-in in core/nodes.js
 * (examples/workflow-engine's `notify.email` custom node), registered via
 * `WorkflowEngine.nodes.add()` — no core changes needed, this extension
 * point already exists.
 */

import { fromMarkdown, toHTML, toPlainText, wordCount } from '../../core/portable-text.js';

export const contentRenderNode = {
  type: 'content.render',
  name: 'Render Markdown Content',
  category: 'custom',
  description: 'Parses markdown into Portable Text blocks, renders HTML + plain text + word count',
  inputs: [{ name: 'markdown', type: 'string', required: true }],
  outputs: [
    { name: 'html', type: 'string' },
    { name: 'plainText', type: 'string' },
    { name: 'wordCount', type: 'number' },
    { name: 'excerpt', type: 'string' },
  ],
  handler: async (inputs) => {
    const blocks = fromMarkdown(inputs.markdown);
    const plainText = toPlainText(blocks);
    return {
      html: toHTML(blocks),
      plainText,
      wordCount: wordCount(blocks),
      excerpt: plainText.length > 140 ? `${plainText.slice(0, 140)}...` : plainText,
    };
  },
};
