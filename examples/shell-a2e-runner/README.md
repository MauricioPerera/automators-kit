# Shell A2E Runner

Combines [`core/shell.js`](../../core/shell.js) with
[`core/a2e.js`](../../core/a2e.js): `pipeline:run` reaches through the
same command gateway [`examples/command-gateway`](../command-gateway/)
uses for CRUD into a real, parameterized
[`core/a2e.js`](../../core/a2e.js) `WorkflowExecutor` pipeline, chosen
and configured by the shell command's own args at call time. Distinct
from every other `a2e.js` example: `examples/a2e-pipeline`/
`a2e-vault-api`/`a2e-background` invoke pipelines directly from
`setup.js` code, never through a shell command; `examples/trigger-driven-a2e`
fires a2e pipelines from a webhook (`core/triggers.js`), not a shell
command.

`pipelines.js` holds pipeline **builders**, not fixed definitions — each
takes the shell command's own args and bakes them directly into a fresh
compact-JSON definition, the same "no per-call input, build a fresh
definition per fire" pattern `examples/a2e-vault-api` and
`examples/trigger-driven-a2e` already use for
`WorkflowExecutor.execute()`.

## A real bug found in this example's own first draft, not the product

The `pipeline:run` command originally had ONE `op` param doing double
duty: selecting *which* pipeline to run (`'calc'`) and, inside the
`calc` pipeline builder, also meant to carry the arithmetic operation
(`'multiply'`) — both read from `args.op`. Since `runPipeline(args.op, args)`
passes the whole `args` object through, `args.op` was always the
pipeline name, never the arithmetic operator, so `calc` silently always
defaulted to `add` regardless of what was requested. Caught before
running anything by re-reading the code; fixed by renaming the
arithmetic field to `operation` (matching `core/a2e.js`'s own
`Calculate` node field name), with a regression test asserting the
actual requested operation runs, not the pipeline selector.

## Run it

```bash
bun examples/shell-a2e-runner/setup.js
```

```bash
curl -X POST http://localhost:3037/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"pipeline:run --op text-transform --text \"hello world\" --format title"}'
curl -X POST http://localhost:3037/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"pipeline:run --op calc --a 10 --b 3 --operation multiply"}'
```

## Verified live

```json
{"results":{"input":"hello world","result":"Hello World"},"errors":{}}
{"results":{"a":10,"result":30},"errors":{}}
```
