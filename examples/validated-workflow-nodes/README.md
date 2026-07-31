# Validated Workflow Nodes

A combination of 2 modules catching a category of bug neither can catch
alone: a [`core/validate.js`](../../core/validate.js) schema gating a
[`core/workflow.js`](../../core/workflow.js) node's handler, so it only
ever runs on data that already passed validation —
[`examples/api-validation`](../api-validation/) and
[`examples/validated-webhooks`](../validated-webhooks/) only ever
validate the request body at the HTTP boundary, the *moment a workflow
starts*. Neither can catch bad data a workflow **produces for itself**
partway through — and `core/nodes.js`'s own `inputs` array
(`name`/`type`/`required`) is documentation only: reading
`NodeRegistry.execute()` confirms it calls `node.handler(inputs,
credentials)` directly, with no check against `node.inputs` at all.

No core changes needed — `validatedNode()` in [`nodes.js`](nodes.js) is
entirely a node-definition-level wrapper, the same extension point
[`examples/plugin-workflow-nodes`](../plugin-workflow-nodes/) and
[`examples/content-render-workflow`](../content-render-workflow/) already
use.

## The scenario

`order.applyDiscount` is a deliberately **unvalidated** transform node —
realistic, since most nodes in a real pipeline aren't the ones handling
money directly. Given `discountPercent: 150` (a perfectly valid trigger
payload by itself — just a number, nothing an HTTP-boundary validator
would ever reject), it silently computes a **negative** `discountedAmount`.
`order.charge` is wrapped with a `validate.js` schema
(`amount: { type: 'number', min: 0.01 }`, `currency: { enum: [...] }`) —
it catches that negative amount, or an unsupported currency, before any
charge logic runs at all.

## Run it

```bash
bun examples/validated-workflow-nodes/setup.js
```

## Verified live: validated blocks, unvalidated silently corrupts

```bash
curl -s -X POST http://localhost:3031/api/shell/exec -d '{"cmd":"order:run --amount 100 --discountPercent 150 --currency USD"}'
```
```json
{"status":"failed",
 "nodeResults":{
   "applyDiscount":{"status":"success","data":{"discountedAmount":-50}},
   "charge":{"status":"error","error":"Validation failed: amount must be >= 0.01"}},
 "errors":{"charge":"Validation failed: amount must be >= 0.01"}}
```

The **exact same input**, against the unvalidated `order.charge.unsafe`
node registered side by side for comparison:

```bash
curl -s -X POST http://localhost:3031/api/shell/exec -d '{"cmd":"order:run-unsafe --amount 100 --discountPercent 150 --currency USD"}'
```
```json
{"status":"success",
 "nodeResults":{
   "applyDiscount":{"status":"success","data":{"discountedAmount":-50}},
   "charge":{"status":"success","data":{"charged":true,"amount":-50,"currency":"USD","reference":"chg_..."}}}}
```

`status: "success"` while having "charged" **-50** — an unnoticed refund,
not a crash. That's the real value of the validation gate here: JS
doesn't type-check, so a naive handler usually doesn't blow up on bad
data, it just quietly proceeds with it. An invalid currency (`XYZ`)
against the validated node is caught the same way:
`"Validation failed: currency must be one of: USD, EUR, GBP"`.

The happy path (a sane 20% discount) runs end to end and charges the
correct discounted amount, `$80` on a `$100` order.

## Regression test

`tests/examples-validated-workflow-nodes.test.js` drives the real
`WorkflowEngine` + `NodeRegistry` + `validatedNode()` wiring. Covers: the
happy path charging the right amount; a >100% discount producing a
negative amount upstream that the validated node blocks with the exact
actionable message, while `applyDiscount`'s own (wrong) result is still
visible in `nodeResults` for debugging; an unsupported currency blocked
the same way; the identical bad input against the unvalidated node
"succeeding" while charging the negative amount, proving the gate — not
some other side effect — is what makes the difference; and
`validatedNode()` itself, confirmed to pass the real handler validate.js's
cleaned data (defaults applied) rather than the raw input, and to never
call the real handler at all when validation fails.
