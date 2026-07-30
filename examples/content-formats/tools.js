/**
 * Shared handlers for the content-formats example: author once in Markdown,
 * store as structured Portable Text blocks, render to whichever format the
 * consuming channel needs (website HTML, git-friendly Markdown, plain-text
 * email/SMS), plus a custom block type rendered only in HTML.
 */

import {
  fromMarkdown, validateBlocks, toHTML, toMarkdown, toPlainText,
  extractText, wordCount,
} from '../../core/portable-text.js';

// A block type fromMarkdown never produces on its own (no markdown syntax
// maps to it) — added programmatically, the way a CMS editor UI would let
// an author insert a widget the plain markdown parser doesn't understand.
// Only toHTML needs a renderer for it; toMarkdown/toPlainText fall back to
// their default (silently dropped / empty), which is a real trade-off worth
// knowing before relying on a custom block outside the HTML channel.
const CUSTOM_RENDERERS = {
  callout: (b) => `<div class="callout callout-${b.data?.tone || 'info'}"><strong>${escapeAttr(b.data?.title || '')}</strong><p>${escapeAttr(b.data?.body || '')}</p></div>`,
};

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildContentTools() {
  return {
    /** Markdown in, { blocks, valid, errors } out — validated before storing. */
    importMarkdown(markdown) {
      const blocks = fromMarkdown(markdown);
      const { valid, errors } = validateBlocks(blocks);
      return { blocks, valid, errors };
    },

    /** Append a widget block the plain Markdown parser has no syntax for. */
    addCallout(blocks, { tone, title, body }) {
      return [...blocks, { type: 'custom', name: 'callout', data: { tone, title, body } }];
    },

    renderHTML(blocks) {
      return toHTML(blocks, CUSTOM_RENDERERS);
    },

    renderMarkdown(blocks) {
      return toMarkdown(blocks);
    },

    renderPlainText(blocks) {
      return toPlainText(blocks);
    },

    /** Reading-time estimate (200 wpm) + a short excerpt for previews/SEO. */
    stats(blocks) {
      const words = wordCount(blocks);
      const text = extractText(blocks);
      return {
        wordCount: words,
        readingTimeMin: Math.max(1, Math.round(words / 200)),
        excerpt: text.length > 160 ? text.slice(0, 157) + '...' : text,
      };
    },
  };
}
