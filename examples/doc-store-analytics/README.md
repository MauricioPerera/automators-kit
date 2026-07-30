# DocStore Analytics

"You don't need the whole CMS to get a document database + HTTP API."
Every other example in this repo calls `createApp()`. This one doesn't —
it's `core/db.js`'s `DocStore` (MongoDB-style queries, 26 operators,
indices, aggregation with `$group`/`$lookup`) wired directly to
`core/http.js`'s `Router` and `core/shell.js`'s `Shell`: 3 à la carte
modules, zero CMS, zero content types, zero auth layer.

An inventory + orders analytics service: query products with real
operators, run a `$group` report by category, join top-selling products
back to their details with `$lookup` (a real join, not a manual
post-processing step), and measure an indexed vs. non-indexed lookup live.

## Run it

```bash
bun examples/doc-store-analytics/setup.js
```

Starts on `http://localhost:3013`, empty until you seed it.

```bash
curl -s -X POST http://localhost:3013/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "db:seed --n 8000"}'
# → {"products":8000,"orders":24000}   (deterministic — same n, same data every run)

curl -s http://localhost:3013/reports/by-category
# → [{"_id":"electronics","count":1600,"avgPrice":88.75,"totalStock":28000}, ...]

curl -s http://localhost:3013/reports/top-sellers?limit=3
# → each result: {"_id":"<productId>","unitsSold":12000,"product":{"sku":"SKU-1004",...}}
#   $lookup already joined the product doc — no separate query needed.
```

### Indexed vs non-indexed, measured (real numbers from an 8000-product seed)

```bash
curl -s -X POST http://localhost:3013/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "db:benchmark --sku SKU-8998"}'
```

```json
{ "unindexedMs": 1.334, "indexedMs": 0.062, "matchesWithoutIndex": 1, "matchesWithIndex": 1 }
```

~21x faster after `createIndex('sku', { unique: true })` — one call,
persisted, no query syntax change.

## The point of this example

Every other example here goes through `createApp()`, which sets up the
full CMS (content types, entries, auth, roles) whether you need it or
not. This one proves the pieces are genuinely separable: `Router` +
`DocStore` + `Shell` is a complete, working HTTP service on its own — no
CMS import at all in `setup.js`. If your use case is "I need a document
store and an HTTP API, not a whole content management system," this is
the shape to start from.

## Regression test

`tests/examples-doc-store-analytics.test.js` is pure in-process (no real
`Bun.serve()` needed — `DocStore`/`Router`/`Shell` have no real network
I/O). Covers: deterministic seed generation, raw REST product lookup (200
and 404), the `$lt` low-stock query sorted correctly, `$group` category
aggregation (sums match the seed exactly), `$lookup` joining top sellers
to their product details, the index-creation benchmark, export/import
round-tripping every document into a fresh store, and reaching the same
report through the agent shell as through a direct call.
