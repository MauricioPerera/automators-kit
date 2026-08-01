# CSV Bulk Import

Combines [`core/csv.js`](../../core/csv.js) with
[`core/cms.js`](../../core/cms.js): each CSV row becomes a real CMS
entry via `cms.entries.create()`, not a throwaway in-memory array like
[`examples/agent-authored-node`](../agent-authored-node/)'s `csv.parse`
workflow node. A real n8n-style "import a spreadsheet" pattern neither
existing example covers.

## Two real bugs found building this

**A real core/cms.js bug, fixed with your approval:** `validateContent()`
checked `typeof value !== 'number'` for a `number`-typed field — but
`typeof NaN === 'number'` is `true` in JavaScript. `Number('not-a-number')`
(`NaN`) sailed through validation as a "valid" number, silently creating
an entry with a broken `price`. Fixed to also require
`Number.isFinite(value)`; verified live before/after, plus a new
regression test in `tests/cms.test.js` (this had zero prior test
coverage for number-typed fields at all).

**A gotcha in this example's own `import.js`, not a core bug:**
`parseCsv()` returns every field as a **string** — there's no schema to
infer types from (see `core/csv.js`'s own contract). A numeric-looking
CSV cell like `"9.99"` still fails `cms.entries.create()`'s `number`
field validation unless the importer explicitly coerces it
(`Number(row.price)`) first. Coercion is the importer's job, not
`csv.js`'s or `cms.js`'s.

## Partial success, not all-or-nothing

A bulk import where one bad row aborts the other 999 is a bad UX n8n
users would never accept from a CSV node either — `importProductsCsv()`
catches failures per row (a duplicate title colliding on the
auto-generated slug, invalid data, ...) and reports them, instead of
throwing and discarding everything already imported.

## Run it

```bash
bun examples/csv-bulk-import/setup.js
```

```bash
# one duplicate title on purpose, to show partial-success reporting
curl -X POST http://localhost:3031/api/import/products -H "Content-Type: application/json" \
  -d '{"csv":"name,price,sku\nWidget,9.99,SKU-1\nGadget,19.99,SKU-2\nWidget,29.99,SKU-3\nBroken,notanumber,SKU-4"}'
```

## Verified live: 2 created, 2 reported failures, import keeps going

```json
{
  "created": 2,
  "failed": [
    {"row": {"name": "Widget", "price": "29.99", "sku": "SKU-3"}, "error": "Entry with slug 'widget' already exists in 'product'"},
    {"row": {"name": "Broken", "price": "notanumber", "sku": "SKU-4"}, "error": "Validation failed: Field 'price' must be a number"}
  ]
}
```

`products:list` afterward confirms `price` was stored as a real number
(`19.99`, not the string `"19.99"`) for both successfully created entries.
