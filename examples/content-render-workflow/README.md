# Content Render Workflow

A combination of 2 modules into a real "author in markdown, a
webhook-triggered workflow renders and distributes it" pattern neither's
other example covers alone:
[`core/portable-text.js`](../../core/portable-text.js) rendering content
as a real [`core/workflow.js`](../../core/workflow.js) step.
[`examples/content-formats`](../content-formats/) never touches
workflows; [`examples/workflow-engine`](../workflow-engine/)'s custom
nodes are all HTTP-calling, not content-transforming.

`nodes.js`'s `content.render` is a real custom node — same shape as every
built-in in `core/nodes.js`, registered via
`WorkflowEngine.nodes.add()` (the same extension point
[`examples/plugin-workflow-nodes`](../plugin-workflow-nodes/) already
uses, no core changes needed here either). It parses markdown into
Portable Text blocks once and derives HTML, plain text, and word count
from the same parsed blocks, so a downstream node never has to re-parse
markdown itself.

## Run it

```bash
bun examples/content-render-workflow/setup.js
```

```bash
curl -X POST http://localhost:3027/api/workflows/webhook/posts \
  -H "X-Webhook-Secret: content-render-webhook-secret" -H "Content-Type: application/json" \
  -d '{"title":"Launch Day","markdown":"# Launch Day\n\nWe shipped **v2.0** today."}'
# webhook fires the workflow asynchronously -- poll posts:executions
```

## Verified live: real templating across a custom node and a built-in one

```json
// posts:executions, after the curl above
{
  "nodeResults": {
    "render": {"data": {
      "html": "<h1 id=\"launch-day\">Launch Day</h1>\n<p>We shipped <strong>v2.0</strong> today...",
      "plainText": "Launch Day\n\nWe shipped v2.0 today...",
      "wordCount": 17,
      "excerpt": "Launch Day\n\nWe shipped v2.0 today..."
    }},
    "summary": {"data": "\"Launch Day\" (17 words): Launch Day\n\nWe shipped v2.0 today..."}
  }
}
```

`summary` (a built-in `set.value` node) correctly interpolates
`{{render.wordCount}}` and `{{render.excerpt}}` via `workflow.js`'s own
`{{ref}}` machinery — proof the custom node's outputs compose with
built-ins exactly like any other node's would.

## A real, honest caveat found while building this: `plainText`/`excerpt` are not HTML-safe

Verified live, same workflow, a markdown body containing
`<script>alert(1)</script>`:

```
render.html:    <p>A test with &lt;script&gt;alert(1)&lt;/script&gt; inline text.</p>   <- escaped
render.excerpt: A test with <script>alert(1)</script> inline text.                       <- NOT escaped
summary.data:   "Security Note" (6 words): A test with <script>alert(1)</script> ...     <- NOT escaped
```

This is **not a bug** — `toPlainText()` correctly returns plain text,
which shouldn't be HTML-escaped (the 2026-07 audit's XSS fix lives
entirely in `toHTML()`'s renderers, verified still intact by
`examples/content-formats`). But it's a real, worth-knowing consequence
for *this* combination specifically: if a future step in a workflow like
this one takes `{{render.excerpt}}` and embeds it into an **HTML**
context (an HTML email body, a rendered admin page) without escaping it
itself, that reopens the exact XSS surface the audit closed for
`toHTML()`. Use `render.html` (or escape `excerpt` yourself) for anything
that ends up in an HTML context; `excerpt`/`plainText` are safe as-is
only for genuinely plain-text destinations (Slack, SMS, plain email,
logs).

## Regression test

`tests/examples-content-render-workflow.test.js` starts a real
`Bun.serve()` and polls for the webhook's fire-and-forget execution to
finish (same pattern as `tests/examples-workflow-engine.test.js`).
Covers: markdown correctly parsed into HTML/plain text/word count and
interpolated into a downstream built-in node, and — the finding above —
`html` escaping an inline `<script>` tag while `excerpt`/`summary` (and
anything downstream that interpolates them) carry it through unescaped,
verified through the real workflow, not just the node in isolation.
