/**
 * Content Formats — HTTP/shell demo.
 *
 *   bun examples/content-formats/setup.js
 *
 * "Author once in Markdown, publish everywhere" — core/portable-text.js
 * storing content as structured JSON blocks (not raw HTML, not raw
 * Markdown) so the SAME article renders to HTML for the website, Markdown
 * for a git-based archive/newsletter, and plain text for an email/SMS
 * preview, plus a reading-time/excerpt for a listing page.
 *
 * Also demonstrates a custom block type (`callout`) the plain-Markdown
 * parser has no syntax for — added programmatically, the way a CMS editor
 * UI would let an author insert a widget.
 */

import { createApp } from '../../index.js';
import { FileStorageAdapter } from '../../adapters/fs.js';
import { buildContentTools } from './tools.js';

const PORT = +(process.env.PORT || 3012);
const DB_PATH = process.env.DB_PATH || './examples/content-formats/data';

const app = await createApp({
  adapter: new FileStorageAdapter(DB_PATH),
  secret: process.env.JWT_SECRET || 'content-formats-demo-secret',
  logger: true,
});

if (!app.cms.contentTypes.findBySlug('article')) {
  await app.cms.contentTypes.create({
    name: 'Article',
    slug: 'article',
    fields: [
      { name: 'blocks', label: 'Content (Portable Text blocks)', type: 'json', required: true },
    ],
  });
}

const tools = buildContentTools();

app.shell.registry.register('content', 'import', {
  description: 'Import a Markdown draft as a new article (validates the parsed blocks before storing)',
  params: [
    { name: 'title', type: 'string', required: true },
    { name: 'markdown', type: 'string', required: true },
    { name: 'calloutTitle', type: 'string' },
    { name: 'calloutBody', type: 'string' },
    { name: 'calloutTone', type: 'string' },
  ],
}, async (args) => {
  const { blocks, valid, errors } = tools.importMarkdown(args.markdown);
  if (!valid) return { imported: false, errors };

  const finalBlocks = args.calloutBody
    ? tools.addCallout(blocks, { tone: args.calloutTone || 'info', title: args.calloutTitle, body: args.calloutBody })
    : blocks;

  const entry = await app.cms.entries.create(
    { contentTypeSlug: 'article', title: args.title, content: { blocks: finalBlocks } },
    'demo-author',
  );
  return { imported: true, id: entry._id, blockCount: finalBlocks.length };
});

app.shell.registry.register('content', 'render', {
  description: 'Render a stored article to a given format',
  params: [
    { name: 'id', type: 'string', required: true },
    { name: 'format', type: 'string', required: true, description: 'html | markdown | plaintext' },
  ],
}, async (args) => {
  const entry = app.cms.entries.findById(args.id);
  if (!entry) return { error: 'Article not found' };
  const blocks = entry.content.blocks;
  switch (args.format) {
    case 'html': return { format: 'html', output: tools.renderHTML(blocks) };
    case 'markdown': return { format: 'markdown', output: tools.renderMarkdown(blocks) };
    case 'plaintext': return { format: 'plaintext', output: tools.renderPlainText(blocks) };
    default: return { error: `Unknown format: ${args.format}` };
  }
});

app.shell.registry.register('content', 'stats', {
  description: 'Word count, reading time, and a short excerpt for a stored article',
  params: [{ name: 'id', type: 'string', required: true }],
}, async (args) => {
  const entry = app.cms.entries.findById(args.id);
  if (!entry) return { error: 'Article not found' };
  return tools.stats(entry.content.blocks);
});

Bun.serve({ fetch: app.handle, port: PORT });

console.log(`
Content formats demo running at http://localhost:${PORT}
  commands: content:import, content:render, content:stats

Try:
  POST /api/shell/exec {"cmd":"content:import --title \\"Hello\\" --markdown \\"# Hi\\n\\nSome **bold** text.\\""}
  POST /api/shell/exec {"cmd":"content:render --id <id from above> --format html"}
See examples/content-formats/README.md for the full walkthrough.
`);
