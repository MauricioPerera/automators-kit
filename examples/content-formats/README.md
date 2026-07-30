# Content Formats

"Author once in Markdown, publish everywhere" — `core/portable-text.js`
storing content as structured JSON blocks (not raw HTML, not raw
Markdown), so the same article renders to HTML for the website, Markdown
for a git-based archive/newsletter, and plain text for an email/SMS
preview, plus a reading-time estimate and excerpt for a listing page.

Also demonstrates a custom block type (`callout`) the plain-Markdown
parser has no syntax for — added programmatically, the way a CMS editor
UI would let an author insert a widget — via `toHTML`'s `customRenderers`
hook.

## Run it

```bash
bun examples/content-formats/setup.js
```

Starts on `http://localhost:3012`.

```bash
curl -s -X POST http://localhost:3012/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:import --title \"Hello\" --markdown \"# Hi\n\nSome **bold** text.\n\n- one\n- two\" --calloutTitle \"Note\" --calloutBody \"This is important\" --calloutTone \"warn\""}'
# → {"imported":true,"id":"...","blockCount":4}

curl -s -X POST http://localhost:3012/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:render --id <id> --format html"}'
# → <h1 id="hi">Hi</h1><p>Some <strong>bold</strong> text.</p><ul>...</ul>
#   <div class="callout callout-warn"><strong>Note</strong><p>This is important</p></div>

curl -s -X POST http://localhost:3012/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:render --id <id> --format markdown"}'
# → # Hi\n\nSome **bold** text.\n\n- one\n- two\n\n   (no callout — see below)

curl -s -X POST http://localhost:3012/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "content:stats --id <id>"}'
# → {"wordCount":6,"readingTimeMin":1,"excerpt":"Hi\n\nSome bold text.\n\none\ntwo"}
```

## 2 real things confirmed live while building this, worth knowing

### `toHTML`'s `customRenderers` hook does NOT auto-escape

`core/portable-text.js`'s built-in renderers (`paragraph`, `heading`, ...)
escape their input via `escHtml` before applying `**bold**`/`` `code` ``
marks — the 2026-07 audit's stored-XSS fix, confirmed still intact by
sending a real `<script>` tag through a normal paragraph and checking the
output contains `&lt;script&gt;`, not a live tag.

A **custom** renderer passed to `toHTML(blocks, customRenderers)` is a raw
escape hatch: it gets the block object and returns a string that's
inserted as-is, with zero framework-level escaping. Verified by writing
an intentionally unsafe callout renderer that interpolated
`b.data.body` directly — the `<script>` tag came through completely
unescaped in the output. This example's real `callout` renderer
(`tools.js`) escapes its own values explicitly for exactly this reason —
if you write a custom renderer, that responsibility is yours, the same
way it already is for anyone writing a new built-in renderer inside
`core/portable-text.js` itself.

### A custom block only renders where you gave it a renderer

`toMarkdown`/`toPlainText` have no equivalent hook for the `custom` block
type — a `callout` block silently contributes nothing to those formats
(`toMarkdown`: an empty string via its `default` case; `toPlainText`: the
block is dropped entirely, filtered out before the final join). Confirmed
live: the same article's Markdown and plain-text renders never mention
the callout's text at all. If a custom block carries content that MUST
survive every format, it needs its own case added to `toMarkdown`/
`toPlainText` too — `toHTML`'s `customRenderers` param only covers HTML.

## Regression test

`tests/examples-content-formats.test.js` is pure in-process
(`core/portable-text.js` does no I/O). Covers: Markdown import producing
valid blocks, the same article rendering correctly across all 3 formats,
`validateBlocks` rejecting a malformed block, the callout custom renderer
(present in HTML, absent from Markdown/plaintext), the unsafe-renderer
XSS proof above, the built-in renderers' XSS safety on a script tag typed
as plain text, and the word-count/reading-time/excerpt stats.
