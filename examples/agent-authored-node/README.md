# Agent-Authored Node

Answers a real question from comparing Automators Kit to n8n: n8n ships a
CSV node out of the box, `core/nodes.js`'s 18 built-ins don't. Instead of
waiting for the framework to grow one, this example demonstrates building
it — an agent following a
[KDD](https://github.com/MauricioPerera/KDD) task contract for the
correctness-critical piece (kept external, not vendored into this repo —
see `kdd-external-contracts/csv-parse.md` in the sibling checkout),
validated against a frozen-oracle test suite
([`tests/csv.test.js`](../../tests/csv.test.js)) and the real CCDD gate
(measured complexity within budget) before this example ever used it.

The result — [`core/csv.js`](../../core/csv.js)'s `parseCsv` — is a real,
reusable core module, not throwaway example code. Once created and
validated, it doesn't need to exist again: any other workflow/example can
import it directly, the same way `core/portable-text.js` or
`core/connector.js` are reused across this repo. `nodes.js`'s
`csv.parse` wraps it via the same `WorkflowEngine.nodes.add()` extension
point every other custom node in this repo already uses (see
[`examples/content-render-workflow`](../content-render-workflow/),
[`examples/plugin-workflow-nodes`](../plugin-workflow-nodes/)) — no
`core/workflow.js` changes needed.

## Why a formal contract, not just example-level rigor

A naive `text.split(',')` CSV "parser" is a well-known footgun: real CSV
data routinely contains delimiters, embedded newlines, and literal quote
characters inside a field, escaped per RFC 4180. Getting this wrong
doesn't crash — it silently mis-splits rows, corrupting data downstream
with no visible error. That's the same class of risk
[`integrations/postgres-queue.js`](../../integrations/postgres-queue.js)'s
`claimJobs()` was contracted for (atomic multi-worker claiming) — a
subtle bug here is silent data corruption, not a crash, so it gets the
same frozen-oracle + gate discipline instead of ordinary example rigor.

## Run it

```bash
bun examples/agent-authored-node/setup.js
```

```bash
curl -X POST http://localhost:3028/api/workflows/webhook/leads \
  -H "X-Webhook-Secret: agent-authored-node-webhook-secret" -H "Content-Type: application/json" \
  -d '{"csv":"name,email,score\nAlice,alice@example.com,85\nBob,bob@example.com,50\nCarol,\"c, corp\"@example.com,72"}'
# webhook fires the workflow asynchronously -- poll leads:executions
```

## Verified live: a quoted field containing the delimiter survives the whole pipeline intact

```json
// leads:executions, after the curl above -- Carol's email contains a
// literal comma inside quotes; csv.parse keeps it as ONE field, not two
{
  "nodeResults": {
    "parse": {"data": [
      {"name": "Alice", "email": "alice@example.com", "score": "85"},
      {"name": "Bob", "email": "bob@example.com", "score": "50"},
      {"name": "Carol", "email": "c, corp@example.com", "score": "72"}
    ]},
    "qualified": {"data": [
      {"name": "Alice", "email": "alice@example.com", "score": "85"},
      {"name": "Carol", "email": "c, corp@example.com", "score": "72"}
    ]},
    "summary": {"data": "2 of 3 leads qualified (score >= 70)"}
  }
}
```

`qualified` is the **built-in** `filter` node, fed `csv.parse`'s output
via `{{parse}}` — the new node composes with the existing ones like any
other, not a bolted-on special case. Note the reference convention this
example's own build surfaced: a single-output node (like `csv.parse` or
the built-in `filter`/`set.value`) returns its value directly, so
downstream nodes reference it as `{{nodeId}}` (or `{{nodeId.someProp}}`
when the value itself has that property, e.g. `{{parse.length}}` — an
array's real `.length`) — never `{{nodeId.<declared output name>}}`. Only
multi-output nodes like `content.render` return an object keyed by each
output's name.

## Verified live: `csv.test.js`'s frozen oracle + the real gate

```bash
bun test tests/csv.test.js          # 12/12, the KDD-contracted oracle for parseCsv
```
`run_integration_gate` against `core/csv.js`'s `parseCsv`: cyclomatic 4,
nesting 1, 2 params, 9 lines — well within the contract's budget
(≤12/≤3/≤2/≤45).
