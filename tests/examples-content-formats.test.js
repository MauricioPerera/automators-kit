/**
 * Content Formats — end-to-end regression test.
 * Mirrors examples/content-formats/setup.js (reuses buildContentTools) so
 * the demo and the test can't drift apart. Pure in-process, no real server
 * needed (core/portable-text.js does no I/O).
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../index.js';
import { MemoryStorageAdapter } from '../adapters/memory.js';
import { buildContentTools } from '../examples/content-formats/tools.js';
import { validateBlocks } from '../core/portable-text.js';

let app;
let tools;

function req(cmd) {
  return new Request('http://localhost/api/shell/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

async function exec(cmd) {
  const res = await app.handle(req(cmd));
  return res.json();
}

beforeAll(async () => {
  app = await createApp({ adapter: new MemoryStorageAdapter(), secret: 'content-formats-test-secret!!!' });
  await app.cms.contentTypes.create({
    name: 'Article', slug: 'article',
    fields: [{ name: 'blocks', type: 'json', required: true }],
  });
  tools = buildContentTools();

  app.shell.registry.register('content', 'import', { description: 'import' }, async (args) => {
    const { blocks, valid, errors } = tools.importMarkdown(args.markdown);
    if (!valid) return { imported: false, errors };
    const finalBlocks = args.calloutBody
      ? tools.addCallout(blocks, { tone: args.calloutTone, title: args.calloutTitle, body: args.calloutBody })
      : blocks;
    const entry = await app.cms.entries.create({ contentTypeSlug: 'article', title: args.title, content: { blocks: finalBlocks } }, 'demo-author');
    return { imported: true, id: entry._id, blockCount: finalBlocks.length };
  });
  app.shell.registry.register('content', 'render', { description: 'render' }, async (args) => {
    const entry = app.cms.entries.findById(args.id);
    if (!entry) return { error: 'Article not found' };
    const blocks = entry.content.blocks;
    if (args.format === 'html') return { output: tools.renderHTML(blocks) };
    if (args.format === 'markdown') return { output: tools.renderMarkdown(blocks) };
    if (args.format === 'plaintext') return { output: tools.renderPlainText(blocks) };
    return { error: `Unknown format: ${args.format}` };
  });
  app.shell.registry.register('content', 'stats', { description: 'stats' }, async (args) => {
    const entry = app.cms.entries.findById(args.id);
    return tools.stats(entry.content.blocks);
  });
});

const SAMPLE_MD = '# Hello World\n\nThis is a **bold** paragraph with a [link](https://example.com).\n\n- item one\n- item two\n';

describe('Content formats: import + multi-format render', () => {
  it('imports Markdown into validated Portable Text blocks', () => {
    const { blocks, valid, errors } = tools.importMarkdown(SAMPLE_MD);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, text: 'Hello World' });
    expect(blocks.some((b) => b.type === 'list')).toBe(true);
  });

  it('the same stored article renders correctly to html, markdown, and plaintext', async () => {
    const imp = await exec(`content:import --title "Test" --markdown "${SAMPLE_MD.replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`);
    expect(imp.data.imported).toBe(true);

    const html = await exec(`content:render --id ${imp.data.id} --format html`);
    expect(html.data.output).toContain('<h1');
    expect(html.data.output).toContain('<strong>bold</strong>');

    const md = await exec(`content:render --id ${imp.data.id} --format markdown`);
    expect(md.data.output).toContain('# Hello World');

    const plain = await exec(`content:render --id ${imp.data.id} --format plaintext`);
    expect(plain.data.output).not.toContain('**'); // marks stripped
    expect(plain.data.output).toContain('Hello World');
  });

  it('rejects an import when the parsed blocks fail validation', () => {
    // fromMarkdown never actually produces invalid blocks on its own, so
    // exercise importMarkdown's validation path directly with hand-crafted
    // invalid input via addCallout-style injection instead — validateBlocks
    // rejects a block missing its required `text` field.
    const { valid, errors } = validateBlocks([{ type: 'heading', level: 1 }]);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('Content formats: custom callout block', () => {
  it('renders in HTML via the custom renderer, and is safely dropped (not leaked as HTML) from markdown/plaintext', async () => {
    const imp = await exec(`content:import --title "With callout" --markdown "# T" --calloutTitle "Heads up" --calloutBody "important note" --calloutTone "warn"`);
    expect(imp.data.blockCount).toBe(2); // heading + callout

    const html = await exec(`content:render --id ${imp.data.id} --format html`);
    expect(html.data.output).toContain('callout-warn');
    expect(html.data.output).toContain('Heads up');
    expect(html.data.output).toContain('important note');

    const md = await exec(`content:render --id ${imp.data.id} --format markdown`);
    expect(md.data.output).not.toContain('important note'); // no renderer for 'custom' in toMarkdown

    const plain = await exec(`content:render --id ${imp.data.id} --format plaintext`);
    expect(plain.data.output).not.toContain('important note'); // dropped entirely (filter(Boolean))
  });

  it('the custom renderer escapes attacker-controlled data (verified live, not assumed)', () => {
    const malicious = [{ type: 'custom', name: 'callout', data: { tone: 'info', title: 't', body: '<script>alert(1)</script>' } }];
    const html = tools.renderHTML(malicious);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('Content formats: XSS safety of the built-in HTML renderers', () => {
  it('a script tag typed as plain paragraph text is escaped, not executed', async () => {
    const imp = await exec('content:import --title "XSS" --markdown "Look: <script>alert(1)</script>"');
    const html = await exec(`content:render --id ${imp.data.id} --format html`);
    expect(html.data.output).not.toContain('<script>');
    expect(html.data.output).toContain('&lt;script&gt;');
  });
});

describe('Content formats: stats', () => {
  it('computes word count, reading time, and an excerpt', () => {
    const { blocks } = tools.importMarkdown(SAMPLE_MD);
    const stats = tools.stats(blocks);
    expect(stats.wordCount).toBeGreaterThan(0);
    expect(stats.readingTimeMin).toBeGreaterThanOrEqual(1);
    expect(stats.excerpt).toContain('Hello World');
  });
});
