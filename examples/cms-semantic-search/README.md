# CMS Semantic Search

A combination of 2 modules keeping a search index in sync with a real
content lifecycle: [`core/cms.js`](../../core/cms.js)'s `entry:afterCreate`
/ `afterUpdate` / `afterDelete` hooks driving
[`core/hnsw.js`](../../core/hnsw.js)'s `HNSWIndex` live.
[`examples/hybrid-catalog-search`](../hybrid-catalog-search/) and
[`examples/agent-memory-hnsw`](../agent-memory-hnsw/) index synthetic,
generated data — nothing ever gets created/edited/deleted through them.
[`examples/mcp-cms`](../mcp-cms/) exposes real CMS entries, but its only
"search" is the built-in title/slug substring filter, no ranking.

Does **not** call `createApp()` — that only exposes its internal
`HookSystem` to *plugins*, not to a setup script directly. A raw `CMS` +
`HookSystem` + `Shell` is all this needs.

## Run it

```bash
bun examples/cms-semantic-search/setup.js
```

## Found and fixed a real core bug: CMS could never survive a restart

Building this the honest way — restart the server against its own
already-persisted data, the way a real deploy would — crashed immediately,
before the server even started:

```
error: Index already exists on field: slug
      at createIndex (core/db.js:906:17)
      at new CMS (core/cms.js:228:24)
```

Root cause: `Collection._ensureLoaded()` restores persisted index
definitions from disk *before* `CMS`'s constructor runs its own
`createIndex()` calls for the same fields — so every field CMS declares an
index on collides with the index that was just silently restored,
throwing on the very first line that touches an indexed collection. This
wasn't a novel design flaw: `core/credentials.js`, `core/memory.js`, and
`core/workflow.js` already guard their own constructor's `createIndex()`
calls with `try {} catch {}` for exactly this reason — `core/cms.js` was
the one module that never got the same treatment. In practice this meant
**every example in this repo using `createApp()` + `FileStorageAdapter`
has never been able to survive a real process restart** — it went
unnoticed because every prior live-verification pass in this project
wiped `data/` between runs instead of restarting against existing data.

Fixed with your explicit approval: wrapped `core/cms.js`'s 7
`createIndex()` calls in `try {} catch {}`, mirroring the exact pattern
already used elsewhere. Verified live, before and after:

```bash
bun examples/cms-semantic-search/setup.js   # create 3 articles, stop it
bun examples/cms-semantic-search/setup.js   # restart against the same data/ -- used to crash here
```
```
CMS semantic search demo running at http://localhost:3030
  ...
```

Starts clean. `tests/cms.test.js` and
`tests/examples-cms-semantic-search.test.js` both cover this with a real
`FileStorageAdapter` restart, not just the fix's happy path.

## Verified live: the index tracks create/update/delete correctly

```bash
curl -s -X POST http://localhost:3030/api/shell/exec -d '{"cmd":"article:search --query \"wireless bluetooth audio\""}'
```
```json
[{"title":"Budget wireless earbuds guide","score":0.5115},
 {"title":"Wireless headphones review","score":0.3835},
 {"title":"Sourdough bread recipe","score":0.2551}]
```

Delete the earbuds article, search again — it's gone, not stale:

```bash
curl -s -X POST http://localhost:3030/api/shell/exec -d '{"cmd":"article:delete --id <id>"}'
curl -s -X POST http://localhost:3030/api/shell/exec -d '{"cmd":"article:search --query \"wireless bluetooth audio\""}'
```
```json
[{"title":"Wireless headphones review","score":0.3835},
 {"title":"Sourdough bread recipe","score":0.2551}]
```

## Not a bug: the HNSW index itself still doesn't persist

`HNSWIndex` is in-memory only — a documented gotcha from
`examples/agent-memory-hnsw`/`examples/large-catalog-search`, still true
here. Restarting the *process* now works (the core bug above was about
`CMS` crashing, not about the index surviving), but the in-memory HNSW
graph is genuinely empty again on every fresh process — verified live:
right after a restart, `stats()` still reports the correct
`cmsEntries: 3` (from the CMS's own persisted data) alongside
`indexedEntries: 0` until `reindexAll()` runs. `setup.js` calls
`reindexAll()` unconditionally on startup for exactly this reason — skip
it and every entry created before that restart becomes unsearchable
until it's individually updated again.

## Regression test

`tests/examples-cms-semantic-search.test.js` drives the real `CMS` +
`HookSystem` + `HNSWIndex` wiring. Covers: a newly created entry is
searchable immediately with no manual reindex; an updated entry's new
content replaces its old embedding (not a duplicate — `hnsw.ids()` has
exactly one entry for that id); a deleted entry disappears from both
search results and `hnsw.has()`; and a fresh index (simulating a restart)
finds nothing until `reindexAll()` runs, then finds everything.
`tests/cms.test.js` separately covers the core `createIndex()` restart
fix directly, against a real `FileStorageAdapter`.
