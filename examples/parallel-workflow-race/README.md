# Parallel Workflow Race

Combines [`core/parallel.js`](../../core/parallel.js) with
[`core/workflow.js`](../../core/workflow.js): 3 concurrent executions of
the **same** workflow definition (one per scoring "model"), raced via
`parallelMerge`'s `highest-confidence` strategy. Distinct from
[`examples/provider-fanout`](../provider-fanout/) (races raw
`core/connector.js` calls, not real workflow executions) and every other
`workflow.js` example (each fires exactly one execution per trigger,
never concurrent runs of the same definition).

Relies on `WorkflowEngine.execute()` having no shared mutable state
across concurrent calls on one engine instance — verified true earlier
this session (unlike `core/a2e.js`'s `WorkflowExecutor`, which needed a
real fix for exactly this).

## Run it

```bash
bun examples/parallel-workflow-race/setup.js
```

```bash
curl -X POST http://localhost:3035/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"leads:race --leadId lead-42"}'
curl -X POST http://localhost:3035/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"leads:executions"}'
```

## Verified live: 3 genuinely concurrent executions, deterministic winner, no cross-contamination

```json
{
  "winner": {"model":"C","leadId":"lead-42","score":10},
  "allResults": [
    {"model":"A","confidence":0.6,"score":7},
    {"model":"B","confidence":0.75,"score":9},
    {"model":"C","confidence":0.85,"score":10}
  ]
}
```

`leads:executions` confirms all 3 executions share the same (or a
1ms-apart) `startedAt` timestamp — genuinely concurrent, not sequential.
Model C's fixed 0.85 confidence always wins deterministically (no
randomness), so this is safe to assert on in tests, not just observe.
The regression test also fires 2 concurrent races for **different**
leads and confirms neither's scores leak into the other's results.
