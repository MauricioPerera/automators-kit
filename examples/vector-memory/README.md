# Vector Memory — semantic search for a personal assistant

Real cosine-similarity ranking over embeddings, via `core/vector.js`'s
`VectorStore` — different tool than
[`examples/agent-memory-backend`](../agent-memory-backend/) (`core/memory.js`),
which is keyword recall with no vectors at all. Use this one when "close in
meaning" matters more than "shares literal words"; use `agent-memory-backend`
when you don't want to deal with embeddings at all.

## The embedding

`core/vector.js` never calls an embedding API itself — it expects the caller
to bring vectors (see `Reranker.autoSearch`'s `embedFn` parameter in
`core/vector.js`). [`embed.js`](embed.js) is a **zero-dependency, offline,
deterministic** embedding (the "hashing trick": each word hashes into one of
64 buckets, the vector gets L2-normalized) — no API key, same output every
run, good enough to demonstrate real vector search mechanics with zero setup.

**It is not a real semantic model** — it has no notion of synonyms, only
word overlap. To get actual paraphrase/synonym-aware search, replace `embed()`
with a call to a real embeddings API (OpenAI `text-embedding-3-small`,
Cloudflare Workers AI, etc.) — same `(text) => number[]` signature, drop-in
replacement, nothing else in `tools.js`/`setup.js` needs to change.

## Run it

```bash
bun examples/vector-memory/setup.js
```

Starts on `http://localhost:3004`.

```bash
curl -s -X POST http://localhost:3004/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "notes:index --text \"The invoice PDF export is broken on Safari\" --tag bug"}'

curl -s -X POST http://localhost:3004/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "notes:index --text \"Recipe: how to make sourdough bread at home\" --tag cooking"}'

curl -s -X POST http://localhost:3004/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "notes:search --query \"Safari invoice export broken\""}'
# → the bug note ranks far above the recipe note (score ~0.74 vs ~0.26) —
#   real cosine similarity over the embedded vectors, not a text search.

curl -s -X POST http://localhost:3004/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "notes:search --query \"bread\" --tag bug"}'
# → metadata filter: only notes tagged 'bug' are considered, even if a
#   'cooking' note would otherwise score higher.

curl -s -X POST http://localhost:3004/api/shell/exec -H 'Content-Type: application/json' -d '{"cmd": "notes:stats"}'
```

## Regression test

`tests/examples-vector-memory.test.js` covers indexing, ranking (relevant
above irrelevant), metadata filtering by tag, `forget`, and that `embed()` is
deterministic and unit-normalized.

## A bug this example found (fixed)

Building this surfaced a real collision in `core/shell.js`: the built-in
command dispatch matched on `cmd.command` alone (`'search'`/`'describe'`/`'help'`),
**regardless of namespace** — so a registered `notes:search` command (or any
`<namespace>:search`/`:describe`/`:help`) silently never reached its own
handler; it always hit the shell's bare `search`/`describe`/`help` builtin
instead. This had been quietly broken in
[`examples/command-gateway`](../command-gateway/) too (`content:search` was
registered but unreachable) since neither example's original test happened
to exercise a namespaced command with exactly that name. Fixed: only a
bare, namespace-less `search`/`describe`/`help` is the builtin now. Covered
by 4 new tests in `tests/shell.test.js` plus a regression test added to
`tests/examples-command-gateway.test.js`.
