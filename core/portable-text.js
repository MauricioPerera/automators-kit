/**
 * Portable Text
 * Structured rich content as JSON blocks — inspired by EmDash/Sanity.
 * Agnostic to rendering: transform to HTML, Markdown, plain text, or any format.
 * Zero dependencies.
 *
 * Block format:
 *   { type: 'paragraph', text: 'Hello **world**', marks: [...] }
 *   { type: 'heading', level: 2, text: 'Title' }
 *   { type: 'image', src: '/img.jpg', alt: 'desc', caption: 'Photo' }
 *   { type: 'code', language: 'js', code: 'console.log(1)' }
 *   { type: 'list', style: 'bullet', items: ['A', 'B', 'C'] }
 *   { type: 'quote', text: 'To be or not to be', attribution: 'Shakespeare' }
 *   { type: 'divider' }
 *   { type: 'embed', url: 'https://youtube.com/watch?v=...' }
 *   { type: 'table', rows: [['H1','H2'],['A','B']] }
 *   { type: 'custom', name: 'my-widget', data: {...} }
 */

// ---------------------------------------------------------------------------
// BLOCK TYPES REGISTRY
// ---------------------------------------------------------------------------

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'image', 'code', 'list',
  'quote', 'divider', 'embed', 'table', 'custom',
]);

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

/**
 * Validate a Portable Text document (array of blocks).
 * @param {Array} blocks
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBlocks(blocks) {
  const errors = [];
  if (!Array.isArray(blocks)) return { valid: false, errors: ['Blocks must be an array'] };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || typeof b !== 'object') { errors.push(`Block ${i}: must be an object`); continue; }
    if (!b.type) { errors.push(`Block ${i}: missing type`); continue; }

    switch (b.type) {
      case 'heading':
        if (!b.text || typeof b.text !== 'string') errors.push(`Block ${i}: heading requires text`);
        if (b.level && (b.level < 1 || b.level > 6)) errors.push(`Block ${i}: heading level must be 1-6`);
        break;
      case 'paragraph':
        if (b.text === undefined && b.children === undefined) errors.push(`Block ${i}: paragraph requires text or children`);
        break;
      case 'image':
        if (!b.src || typeof b.src !== 'string') errors.push(`Block ${i}: image requires src`);
        break;
      case 'code':
        if (b.code === undefined) errors.push(`Block ${i}: code requires code`);
        break;
      case 'list':
        if (!Array.isArray(b.items)) errors.push(`Block ${i}: list requires items array`);
        break;
      case 'quote':
        if (!b.text) errors.push(`Block ${i}: quote requires text`);
        break;
      case 'table':
        if (!Array.isArray(b.rows)) errors.push(`Block ${i}: table requires rows array`);
        break;
      case 'embed':
        if (!b.url) errors.push(`Block ${i}: embed requires url`);
        break;
      case 'divider':
        break; // no required fields
      case 'custom':
        if (!b.name) errors.push(`Block ${i}: custom block requires name`);
        break;
      default:
        // Allow unknown types (extensible)
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// INLINE MARKS (bold, italic, link, code, etc)
// ---------------------------------------------------------------------------

/**
 * Parse inline marks from text with simple markdown-like syntax.
 * Supports: **bold**, *italic*, `code`, [link](url)
 * @param {string} text
 * @returns {string} HTML
 */
function renderInlineMarks(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

// ---------------------------------------------------------------------------
// RENDER TO HTML
// ---------------------------------------------------------------------------

/** @type {Record<string, (block: object) => string>} */
const HTML_RENDERERS = {
  paragraph: (b) => `<p>${renderInlineMarks(b.text || '')}</p>`,
  heading: (b) => {
    const level = b.level || 2;
    const id = (b.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `<h${level} id="${id}">${renderInlineMarks(b.text || '')}</h${level}>`;
  },
  image: (b) => {
    const alt = b.alt ? ` alt="${escHtml(b.alt)}"` : '';
    const cap = b.caption ? `<figcaption>${escHtml(b.caption)}</figcaption>` : '';
    return `<figure><img src="${escHtml(b.src)}"${alt} />${cap}</figure>`;
  },
  code: (b) => {
    const lang = b.language ? ` class="language-${escHtml(b.language)}"` : '';
    return `<pre><code${lang}>${escHtml(b.code || '')}</code></pre>`;
  },
  list: (b) => {
    const tag = b.style === 'number' ? 'ol' : 'ul';
    const items = (b.items || []).map(i => `<li>${renderInlineMarks(typeof i === 'string' ? i : i.text || '')}</li>`).join('');
    return `<${tag}>${items}</${tag}>`;
  },
  quote: (b) => {
    const attr = b.attribution ? `<footer>${escHtml(b.attribution)}</footer>` : '';
    return `<blockquote><p>${renderInlineMarks(b.text || '')}</p>${attr}</blockquote>`;
  },
  divider: () => '<hr />',
  embed: (b) => `<div class="embed" data-url="${escHtml(b.url || '')}"><a href="${escHtml(b.url || '')}">${escHtml(b.url || '')}</a></div>`,
  table: (b) => {
    const rows = (b.rows || []).map((row, i) => {
      const tag = i === 0 && b.header !== false ? 'th' : 'td';
      const cells = (row || []).map(c => `<${tag}>${escHtml(String(c || ''))}</${tag}>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table>${rows}</table>`;
  },
};

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render blocks to HTML.
 * @param {Array} blocks
 * @param {Record<string, Function>} customRenderers - Override or add renderers for custom block types
 * @returns {string}
 */
export function toHTML(blocks, customRenderers = {}) {
  if (!Array.isArray(blocks)) return '';
  const renderers = { ...HTML_RENDERERS, ...customRenderers };
  return blocks.map(b => {
    const renderer = renderers[b.type];
    if (renderer) return renderer(b);
    if (b.type === 'custom' && renderers[b.name]) return renderers[b.name](b);
    return `<!-- unknown block: ${escHtml(b.type || '')} -->`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// RENDER TO MARKDOWN
// ---------------------------------------------------------------------------

/**
 * Render blocks to Markdown.
 * @param {Array} blocks
 * @returns {string}
 */
export function toMarkdown(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => {
    switch (b.type) {
      case 'paragraph': return (b.text || '') + '\n';
      case 'heading': return '#'.repeat(b.level || 2) + ' ' + (b.text || '') + '\n';
      case 'image': return `![${b.alt || ''}](${b.src || ''})${b.caption ? '\n*' + b.caption + '*' : ''}\n`;
      case 'code': return '```' + (b.language || '') + '\n' + (b.code || '') + '\n```\n';
      case 'list': {
        const prefix = b.style === 'number' ? (i) => `${i + 1}. ` : () => '- ';
        return (b.items || []).map((item, i) => prefix(i) + (typeof item === 'string' ? item : item.text || '')).join('\n') + '\n';
      }
      case 'quote': return '> ' + (b.text || '') + (b.attribution ? '\n> — ' + b.attribution : '') + '\n';
      case 'divider': return '---\n';
      case 'embed': return `[${b.url}](${b.url})\n`;
      case 'table': {
        const rows = b.rows || [];
        if (rows.length === 0) return '';
        const header = '| ' + rows[0].join(' | ') + ' |';
        const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
        const body = rows.slice(1).map(r => '| ' + r.join(' | ') + ' |').join('\n');
        return header + '\n' + sep + '\n' + body + '\n';
      }
      default: return '';
    }
  }).join('\n');
}

// ---------------------------------------------------------------------------
// RENDER TO PLAIN TEXT
// ---------------------------------------------------------------------------

/**
 * Render blocks to plain text (strip all formatting).
 * @param {Array} blocks
 * @returns {string}
 */
export function toPlainText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => {
    switch (b.type) {
      case 'paragraph': case 'heading': case 'quote': return stripMarks(b.text || '');
      case 'code': return b.code || '';
      case 'list': return (b.items || []).map(i => typeof i === 'string' ? i : i.text || '').join('\n');
      case 'table': return (b.rows || []).map(r => r.join('\t')).join('\n');
      case 'image': return b.alt || b.caption || '';
      default: return '';
    }
  }).filter(Boolean).join('\n\n');
}

function stripMarks(text) {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1');
}

// ---------------------------------------------------------------------------
// MARKDOWN TO BLOCKS (simple parser)
// ---------------------------------------------------------------------------

/**
 * Parse Markdown into Portable Text blocks (basic conversion).
 * @param {string} markdown
 * @returns {Array}
 */
export function fromMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];
  const lines = markdown.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line
    if (!line.trim()) { i++; continue; }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++; continue;
    }

    // Divider
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: 'divider' });
      i++; continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const language = line.slice(3).trim() || undefined;
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const text = quoteLines.join('\n');
      const attrMatch = text.match(/\n— (.+)$/);
      blocks.push({
        type: 'quote',
        text: attrMatch ? text.replace(attrMatch[0], '') : text,
        ...(attrMatch ? { attribution: attrMatch[1] } : {}),
      });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s/, ''));
        i++;
      }
      blocks.push({ type: 'list', style: 'bullet', items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''));
        i++;
      }
      blocks.push({ type: 'list', style: 'number', items });
      continue;
    }

    // Image
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      blocks.push({ type: 'image', alt: imgMatch[1], src: imgMatch[2] });
      i++; continue;
    }

    // Paragraph (collect consecutive non-special lines)
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !lines[i].startsWith('> ') && !/^[-*+]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i]) && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// SEARCH HELPERS
// ---------------------------------------------------------------------------

/**
 * Extract all searchable text from blocks.
 * @param {Array} blocks
 * @returns {string}
 */
export function extractText(blocks) {
  return toPlainText(blocks);
}

/**
 * Find blocks of a specific type.
 * @param {Array} blocks
 * @param {string} type
 * @returns {Array}
 */
export function findBlocks(blocks, type) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(b => b.type === type);
}

/**
 * Count words in all text blocks.
 * @param {Array} blocks
 * @returns {number}
 */
export function wordCount(blocks) {
  const text = toPlainText(blocks);
  return text.split(/\s+/).filter(Boolean).length;
}
