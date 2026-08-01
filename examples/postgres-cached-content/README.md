# Postgres-Cached Content

Combines [`integrations/postgres-collection.js`](../../integrations/postgres-collection.js)
with [`core/http.js`](../../core/http.js)'s `Router`: a content-pages HTTP
API where every read (`GET /pages`, `GET /pages/:slug`) is a local
in-memory cache hit — no Postgres round trip — kept correct across
however many separate server processes point at the same `DATABASE_URL`
table via Postgres `LISTEN`/`NOTIFY`.

Distinct from every other example in this repo: there's no `DocStore`/CMS
involved at all. This is what a `Collection`-shaped API looks like when
`core/db.js`'s "single-process by design" limitation (see README's "Known
architectural limit" note) genuinely doesn't apply — `PostgresCollection`
was built specifically to close that gap for exactly this shape of
use case, without touching `core/db.js` itself.

## The actual point, run for real

`server.js` has no offline mode — it needs a real Postgres. Run two
instances, different ports, same `DATABASE_URL`:

```bash
PORT=3040 DATABASE_URL=postgres://user:pass@host:port/db bun examples/postgres-cached-content/server.js
PORT=3041 DATABASE_URL=postgres://user:pass@host:port/db bun examples/postgres-cached-content/server.js
```

Write via the first, read from the second — which never received the
write:

```bash
curl -X POST http://localhost:3040/pages -H "Content-Type: application/json" \
  -d '{"slug":"hello","title":"Hello","body":"first post","published":true}'
curl http://localhost:3041/pages/hello
```

## Verified live, two real separate OS processes over a real network

Spawned two actual `server.js` processes (not two instances in one test
process) against the VPS Supabase Postgres used for this session's other
Postgres pilots, connected over a real SSH tunnel — genuinely separate
machines' worth of network latency, not localhost-adjacent:

```
$ curl -X POST http://localhost:3040/pages ... {"slug":"hello",...}
{"slug":"hello","title":"Hello","body":"first post","published":true,"_id":"msakfn79-ekcz6h-1"}

$ curl http://localhost:3041/pages/hello   # 0.3s later — too soon
{"error":"No page with slug \"hello\""}

$ curl http://localhost:3041/pages/hello   # ~2s later
{"_id":"msakfn79-ekcz6h-1","body":"first post","slug":"hello","title":"Hello","published":true}
```

That 0.3s-too-soon read is the honest, documented trade-off
`PostgresCollection`'s own README/AGENTS.md entry describes: real
invalidation, not zero-latency replication — the write is durable in
Postgres immediately, but a sibling process's cache catches up on
`NOTIFY` delivery, which over a real network (SSH tunnel, in this case)
took closer to 1-2 seconds than the sub-50ms `waitFor` polling interval
the class-level test's `localhost`-adjacent connections see. `PUT`
(update) and `DELETE` propagated the same way, verified live in the same
run — server B's `GET` correctly showed the updated title, then 404'd
after the delete, without ever calling anything but its own read routes.

## Run it

```bash
POSTGRES_TEST_URL=postgres://user:pass@host:port/db bun test tests/examples-postgres-cached-content.test.js
```

Opt-in like `PostgresCollection`'s own test and the other `integrations/`
sidecars' tests — skips cleanly in the default `bun test tests/` run.
Covers plain CRUD through the router (a normal content API test) and,
separately, two real `Bun.serve()` instances against the same table
proving the cross-process story through actual HTTP requests, not just
at the `PostgresCollection` class level (`tests/integrations-postgres-collection.test.js`
already covers that layer — this test proves the same property survives
being wrapped in a real HTTP API).
