# Redundant-Provider Fanout

"Ask 3 redundant suppliers for the same quote and take the best or fastest
answer" — `core/parallel.js` (`parallelRace` / `parallelMerge`) doing the
orchestration, `core/connector.js` doing each supplier call (its own
timeout/retries, so one slow or dead supplier never blocks the others).
The same shape applies to any redundant-API scenario: multiple price
feeds, multiple LLM providers, multiple mirrors of the same service.

Runs **fully offline**: [`mocks.js`](mocks.js) stands in for 3 suppliers
on the same server, with configurable price/latency/failure per supplier
so the demo is deterministic. Point the `Connector`s in `setup.js` at real
supplier APIs in production; `tools.js`'s fanout code doesn't change at
all.

## Run it

```bash
bun examples/provider-fanout/setup.js
```

Starts on `http://localhost:3006`. Default suppliers: `supplier-a`
(60ms, price 42, confidence 0.7), `supplier-b` (220ms, price 35,
confidence 0.9), `supplier-c` (30ms, price 50, confidence 0.5).

### Fastest wins (`parallelRace`)

```bash
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "fanout:quote-fastest"}'
# → supplier-c wins (fastest at 30ms), regardless of price/confidence.
```

### Best wins by strategy (`parallelMerge`)

```bash
# Default strategy: highest confidence field wins.
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "fanout:quote-best"}'
# → supplier-b wins (confidence 0.9).

# Override scoring to pick the lowest price instead.
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "fanout:quote-best --cheapest true"}'
# → supplier-b wins again here (also the cheapest by default, 35).
```

### A supplier failing doesn't block the others

```bash
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "fanout:configure --supplier supplier-c --failCount 3"}'
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "fanout:quote-fastest"}'
# → supplier-c's failures exceed its Connector's retries (1); the race
#   ignores it and falls to the next-fastest surviving supplier.
curl -s -X POST http://localhost:3006/api/shell/exec -H 'Content-Type: application/json' \
  -d '{"cmd": "fanout:reset"}'
```

## A gotcha found while building this

`parallelMerge`'s `highest-confidence` strategy has a `minConfidence`
option that defaults to `0`, and discards the winner as
`below_threshold` if its score comes out negative. A first attempt at the
`cheapest` override used `scorer: (r) => -r.output.price` (negate the
price so "lower is better" sorts to the top) — every quote scored below
0 and `quoteBest({ cheapest: true })` silently returned `winner: null`.
Fixed by using `1 / price` instead: same ordering, always positive.
`quoteBest`'s custom scorer must return a **positive** score, not just a
correctly-*ordered* one — worth knowing before writing your own scorer
for this module. Covered by a dedicated test in
`tests/examples-provider-fanout.test.js`.

## Regression test

`tests/examples-provider-fanout.test.js` starts a REAL `Bun.serve()` (not
just an in-process `Router.handle()` call) because `Connector` uses real
`fetch()` under the hood. Covers the race picking the fastest supplier, a
failing supplier being excluded without blocking the race, all-suppliers-
failing resolving to no winner, the default confidence-based merge
winner, the `cheapest` scoring override, and a single transient failure
being absorbed by `core/connector.js`'s own retry before the fanout logic
ever sees it as an error.
