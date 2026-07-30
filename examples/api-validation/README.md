# API Validation

`core/validate.js` standalone, no CMS: a signup API with request body
validation (`validateBody`) and query-param validation with automatic
coercion (`validateQuery`) — no content types, no CMS layer at all,
just `Router` + `validate.js` (the module that replaces Zod for HTTP
request validation in this kit).

Demonstrates required/type/min-max, built-in `format` validators
(`email`), a `pattern` RegExp, `enum`, nested `object.properties`, an
`array` of typed `items`, static and function `default`s, `opts.partial`
for updates, and a cross-field `$refine` rule.

## Run it

```bash
bun examples/api-validation/setup.js
```

Starts on `http://localhost:3014`.

### Every violated rule reported at once

```bash
curl -X POST http://localhost:3014/signup -H 'Content-Type: application/json' \
  -d '{"name":"A","email":"not-an-email","age":5,"address":{"zip":"abc"}}'
```

```json
{"error":"name must be at least 2 characters; email must be a valid email; age must be >= 13; address.city is required; address.zip has invalid format"}
```

### A cross-field rule no single field's type/format check can express

```bash
curl -X POST http://localhost:3014/signup -H 'Content-Type: application/json' \
  -d '{"name":"Kid Admin","email":"kid@example.com","age":15,"role":"admin","address":{"city":"X"}}'
# → {"error":"admins must be at least 18 years old"}   ($refine, not a per-field rule)
```

### Query params: coerced from strings, defaults applied

```bash
curl "http://localhost:3014/users?page=1&limit=1"
# → {"page":1,"limit":1,...}   — "1" and "1" (strings from the URL) arrive
#   as real numbers, because listUsersQuerySchema declares them type:'number'
```

## A real gotcha found (and fixed) while building this

`validate()` applies a schema's `default` values — including **function**
defaults like `createdAt: { default: () => new Date().toISOString() }` —
on every call, `opts.partial: true` included, for any field the input is
missing. A first version of this example's `PATCH /signup/:id` handler
naively merged the *whole* validated result back onto the existing
record:

```js
const result = validate(signupSchema, body, { partial: true });
const updated = { ...existing, ...result.data };   // WRONG
```

Confirmed live: `PATCH /signup/1` with only `{"age":30}` silently
**regenerated `createdAt` to the current time**, even though the caller
never mentioned it — because `createdAt` was absent from the partial
body, so `validate()` ran its function default again. Verified with an
isolated repro before touching the fix:

```js
const first = validate(schema, { name: 'Ana' });
const second = validate(schema, { name: 'Ana 2' }, { partial: true });
// first.data.createdAt !== second.data.createdAt — a fresh timestamp both times
```

Fixed by only applying the keys the caller's own request body actually
contained, not the full validated result:

```js
const updated = { ...existing };
for (const key of Object.keys(body)) updated[key] = result.data[key];
```

This isn't a bug in `core/validate.js` — defaults filling in missing
values is exactly what it's documented to do, on every call, by design.
It's a real footgun for anyone reusing a create-schema for partial
updates: any field with a `default` (especially a function default like a
timestamp) needs this same care, or its own dedicated update schema that
omits it entirely.

## Regression test

`tests/examples-api-validation.test.js` is pure in-process (`Router.handle`
directly, no real `Bun.serve()` needed). Covers: defaults + nested/array
fields on a valid signup, all violated rules reported together on an
invalid one, the `$refine` cross-field block, query-param coercion and
defaults, the `createdAt` partial-update gotcha above (both the fixed
handler behavior and an isolated repro proving `validate()` itself
regenerates the default), and that `opts.partial` skips required checks
without loosening type/format validation for fields that ARE present.
