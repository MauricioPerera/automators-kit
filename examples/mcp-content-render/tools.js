/**
 * MCP tools directly over core/portable-text.js — "let an AI client
 * render/normalize/query markdown itself." Distinct from every other
 * portable-text.js example: examples/mcp-cms exposes CMS entry CRUD as
 * MCP tools (entries may happen to STORE portable-text content, but
 * rendering itself isn't a tool); examples/content-render-workflow uses
 * portable-text.js as a core/workflow.js NODE, not an MCP tool;
 * examples/content-formats is HTTP/shell only, no MCP transport.
 */

import { fromMarkdown, toHTML, toPlainText, toMarkdown, findBlocks, wordCount } from '../../core/portable-text.js';

export function renderMarkdown({ markdown }) {
  const blocks = fromMarkdown(markdown);
  const plainText = toPlainText(blocks);
  return {
    html: toHTML(blocks),
    plainText,
    wordCount: wordCount(blocks),
    excerpt: plainText.length > 140 ? `${plainText.slice(0, 140)}...` : plainText,
  };
}

/** Parse then re-serialize -- normalizes formatting (heading levels, list
 * markers, etc.) to portable-text.js's own canonical markdown output. */
export function normalizeMarkdown({ markdown }) {
  const blocks = fromMarkdown(markdown);
  return { markdown: toMarkdown(blocks) };
}

export function findBlocksByType({ markdown, type }) {
  const blocks = fromMarkdown(markdown);
  return { blocks: findBlocks(blocks, type) };
}

export function buildMcpContentTools() {
  return {
    render_markdown: {
      description: 'Parse markdown and render HTML, plain text, word count, and a short excerpt from the same parsed blocks.',
      inputSchema: {
        type: 'object',
        properties: { markdown: { type: 'string' } },
        required: ['markdown'],
      },
      handler: async (args) => renderMarkdown(args),
    },
    normalize_markdown: {
      description: 'Parse markdown into blocks and re-serialize it back to markdown, normalizing formatting inconsistencies.',
      inputSchema: {
        type: 'object',
        properties: { markdown: { type: 'string' } },
        required: ['markdown'],
      },
      handler: async (args) => normalizeMarkdown(args),
    },
    find_blocks: {
      description: "Find all blocks of a given type in markdown (e.g. type='code' to extract every fenced code block, type='heading' for the outline).",
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          type: { type: 'string', description: "e.g. 'heading', 'code', 'quote', 'list', 'paragraph'" },
        },
        required: ['markdown', 'type'],
      },
      handler: async (args) => findBlocksByType(args),
    },
  };
}
