# Hybrid Catalog Search

A combination of 2 modules into a query neither can answer alone:
[`core/vector.js`](../../core/vector.js)'s cosine-similarity ranking, then
a **real** [`core/db.js`](../../core/db.js) `$lookup`/`$group`
aggregation joining in relational sales data. `core/vector.js` has no
notion of a database — it only ranks whatever vectors you give it.
[`examples/vector-memory`](../vector-memory/) and
[`examples/large-catalog-search`](../large-catalog-search/) rank by
similarity only, no relational data. `core/db.js`'s aggregation has no
notion of semantic ranking —
[`examples/doc-store-analytics`](../doc-store-analytics/)'s `topSellers()`
joins sales data via a real `$lookup`, but it's an unscoped `$group` over
*every* order, not "sales data for the top-K semantic matches of this
specific query." Like `doc-store-analytics`, this does **not** call
`createApp()` — reuses its `data.js` product/order generators directly
instead of duplicating them.

## Run it

```bash
bun examples/hybrid-catalog-search/setup.js
```

Indexes 500 synthetic products (`CATALOG_SIZE` env var) into both a
`DocStore` (products + orders, with real relational sales history) and a
`VectorStore` (semantic index of each product's name).

## Verified live: the join preserves the semantic ranking and adds real data

```bash
curl -s -X POST http://localhost:3028/api/shell/exec -d '{"cmd":"catalog:semantic-search --query \"wireless electronics\""}'
```
```json
[{"title":"wireless electronics item 195","score":0.7746},
 {"title":"wireless electronics item 295","score":0.7746},
 {"title":"wireless books item 298","score":0.71},
 "... 2 more"]
```

```bash
curl -s -X POST http://localhost:3028/api/shell/exec -d '{"cmd":"catalog:hybrid-search --query \"wireless electronics\""}'
```
```json
[{"title":"wireless electronics item 195","score":0.7746,"unitsSold":0,"orderCount":0},
 {"title":"wireless electronics item 295","score":0.7746,"unitsSold":0,"orderCount":0},
 {"title":"wireless books item 298","score":0.71,"unitsSold":12,"orderCount":3},
 "... 2 more"]
```

**Same ids, same order, same scores** — the real `$lookup`/`$group` join
(scoped to exactly those 5 ids via `$match: {productId: {$in: [...]}}`,
not a full-table scan) just adds `unitsSold`/`orderCount` on top. Most
results show `0` here — honest, not a bug: this synthetic catalog's
order generator skews sales toward a handful of products, so most of the
500-item catalog genuinely has no order history, and the join correctly
reports that as `0`/`0` rather than omitting the product or leaving the
fields `undefined`.

## Regression test

`tests/examples-hybrid-catalog-search.test.js` drives `tools.js`'s real
`buildHybridCatalogTools`. Covers: `hybridSearch()` returning the exact
same ranking (ids and scores, in the same order) as `semanticSearch()`
alone — proof the join never reorders results — a product with real
order history getting its actual `unitsSold`/`orderCount` from the join
(not a placeholder), and a product with zero order history correctly
getting `0`/`0` rather than being dropped from the results or left
`undefined`.
