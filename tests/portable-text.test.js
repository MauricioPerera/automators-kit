/**
 * Tests: core/portable-text.js
 */

import { describe, it, expect } from 'bun:test';
import { toHTML, toMarkdown, toPlainText, fromMarkdown, validateBlocks, extractText, findBlocks, wordCount } from '../core/portable-text.js';

const SAMPLE_BLOCKS = [
  { type: 'heading', level: 2, text: 'Hello World' },
  { type: 'paragraph', text: 'This is **bold** and *italic* text.' },
  { type: 'image', src: '/photo.jpg', alt: 'A photo', caption: 'Nice pic' },
  { type: 'code', language: 'javascript', code: 'console.log("hi")' },
  { type: 'list', style: 'bullet', items: ['Item A', 'Item B', 'Item C'] },
  { type: 'quote', text: 'To be or not to be', attribution: 'Shakespeare' },
  { type: 'divider' },
];

describe('toHTML', () => {
  it('renders heading with id', () => {
    const html = toHTML([{ type: 'heading', level: 2, text: 'Hello World' }]);
    expect(html).toContain('<h2');
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('Hello World');
  });

  it('renders paragraph with inline marks', () => {
    const html = toHTML([{ type: 'paragraph', text: 'Use **bold** and *italic*' }]);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders image with figure/caption', () => {
    const html = toHTML([{ type: 'image', src: '/img.jpg', alt: 'Alt', caption: 'Cap' }]);
    expect(html).toContain('<figure>');
    expect(html).toContain('src="/img.jpg"');
    expect(html).toContain('alt="Alt"');
    expect(html).toContain('<figcaption>Cap</figcaption>');
  });

  it('renders code block', () => {
    const html = toHTML([{ type: 'code', language: 'js', code: 'let x = 1;' }]);
    expect(html).toContain('<pre><code');
    expect(html).toContain('language-js');
    expect(html).toContain('let x = 1;');
  });

  it('renders bullet list', () => {
    const html = toHTML([{ type: 'list', style: 'bullet', items: ['A', 'B'] }]);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>A</li>');
  });

  it('renders numbered list', () => {
    const html = toHTML([{ type: 'list', style: 'number', items: ['First', 'Second'] }]);
    expect(html).toContain('<ol>');
  });

  it('renders blockquote', () => {
    const html = toHTML([{ type: 'quote', text: 'Quote text', attribution: 'Author' }]);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<footer>Author</footer>');
  });

  it('renders divider', () => {
    expect(toHTML([{ type: 'divider' }])).toContain('<hr />');
  });

  it('renders embed', () => {
    const html = toHTML([{ type: 'embed', url: 'https://youtube.com/watch?v=123' }]);
    expect(html).toContain('data-url="https://youtube.com/watch?v=123"');
  });

  it('renders table', () => {
    const html = toHTML([{ type: 'table', rows: [['H1', 'H2'], ['A', 'B']] }]);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>');
    expect(html).toContain('<td>');
  });

  it('escapes HTML in content', () => {
    const html = toHTML([{ type: 'code', code: '<script>alert("xss")</script>' }]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('handles unknown block type', () => {
    const html = toHTML([{ type: 'unknown_widget' }]);
    expect(html).toContain('<!-- unknown block');
  });

  it('custom renderer', () => {
    const html = toHTML([{ type: 'custom', name: 'banner', data: { text: 'Hi' } }], {
      banner: (b) => `<div class="banner">${b.data.text}</div>`,
    });
    expect(html).toContain('<div class="banner">Hi</div>');
  });

  it('returns empty for non-array', () => {
    expect(toHTML(null)).toBe('');
    expect(toHTML('string')).toBe('');
  });
});

describe('toMarkdown', () => {
  it('renders heading', () => {
    expect(toMarkdown([{ type: 'heading', level: 3, text: 'Title' }])).toContain('### Title');
  });

  it('renders paragraph', () => {
    expect(toMarkdown([{ type: 'paragraph', text: 'Hello' }])).toContain('Hello');
  });

  it('renders code block', () => {
    const md = toMarkdown([{ type: 'code', language: 'python', code: 'print(1)' }]);
    expect(md).toContain('```python');
    expect(md).toContain('print(1)');
  });

  it('renders bullet list', () => {
    const md = toMarkdown([{ type: 'list', style: 'bullet', items: ['A', 'B'] }]);
    expect(md).toContain('- A');
    expect(md).toContain('- B');
  });

  it('renders numbered list', () => {
    const md = toMarkdown([{ type: 'list', style: 'number', items: ['A', 'B'] }]);
    expect(md).toContain('1. A');
    expect(md).toContain('2. B');
  });

  it('renders divider', () => {
    expect(toMarkdown([{ type: 'divider' }])).toContain('---');
  });

  it('renders table', () => {
    const md = toMarkdown([{ type: 'table', rows: [['A', 'B'], ['1', '2']] }]);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
  });
});

describe('toPlainText', () => {
  it('strips all formatting', () => {
    const text = toPlainText([
      { type: 'heading', text: 'Title' },
      { type: 'paragraph', text: 'Hello **bold** world' },
    ]);
    expect(text).toContain('Title');
    expect(text).toContain('Hello bold world');
    expect(text).not.toContain('**');
  });

  it('extracts code', () => {
    expect(toPlainText([{ type: 'code', code: 'x = 1' }])).toContain('x = 1');
  });

  it('extracts list items', () => {
    expect(toPlainText([{ type: 'list', items: ['A', 'B'] }])).toContain('A');
  });
});

describe('fromMarkdown', () => {
  it('parses heading', () => {
    const blocks = fromMarkdown('## Hello');
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].level).toBe(2);
    expect(blocks[0].text).toBe('Hello');
  });

  it('parses paragraph', () => {
    const blocks = fromMarkdown('Just some text here.');
    expect(blocks[0].type).toBe('paragraph');
  });

  it('parses code block', () => {
    const blocks = fromMarkdown('```js\nconsole.log(1)\n```');
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].language).toBe('js');
    expect(blocks[0].code).toBe('console.log(1)');
  });

  it('parses bullet list', () => {
    const blocks = fromMarkdown('- A\n- B\n- C');
    expect(blocks[0].type).toBe('list');
    expect(blocks[0].items.length).toBe(3);
  });

  it('parses blockquote', () => {
    const blocks = fromMarkdown('> To be or not to be');
    expect(blocks[0].type).toBe('quote');
  });

  it('parses divider', () => {
    expect(fromMarkdown('---')[0].type).toBe('divider');
  });

  it('parses image', () => {
    const blocks = fromMarkdown('![Alt text](/img.jpg)');
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].src).toBe('/img.jpg');
  });

  it('roundtrips markdown', () => {
    const md = '## Title\n\nSome paragraph text.\n\n- A\n- B\n\n---\n';
    const blocks = fromMarkdown(md);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const back = toMarkdown(blocks);
    expect(back).toContain('Title');
    expect(back).toContain('- A');
  });
});

describe('validateBlocks', () => {
  it('valid blocks pass', () => {
    expect(validateBlocks(SAMPLE_BLOCKS).valid).toBe(true);
  });

  it('missing type fails', () => {
    expect(validateBlocks([{}]).valid).toBe(false);
  });

  it('heading without text fails', () => {
    expect(validateBlocks([{ type: 'heading' }]).valid).toBe(false);
  });

  it('image without src fails', () => {
    expect(validateBlocks([{ type: 'image' }]).valid).toBe(false);
  });

  it('non-array fails', () => {
    expect(validateBlocks('string').valid).toBe(false);
  });
});

describe('Helpers', () => {
  it('extractText', () => {
    const text = extractText(SAMPLE_BLOCKS);
    expect(text).toContain('Hello World');
    expect(text).toContain('bold');
  });

  it('findBlocks by type', () => {
    expect(findBlocks(SAMPLE_BLOCKS, 'heading').length).toBe(1);
    expect(findBlocks(SAMPLE_BLOCKS, 'list').length).toBe(1);
  });

  it('wordCount', () => {
    const count = wordCount(SAMPLE_BLOCKS);
    expect(count).toBeGreaterThan(10);
  });
});
