---
type: 'Task Contract'
title: 'isValidSemver format validator'
description: 'Adds a semver format check to core/validate.js, wired into the existing FORMATS registry.'
tags: ['ccdd', 'validate', 'semver']

task: is-valid-semver
intent: "Register a semver format predicate in core/validate.js's FORMATS map."
target: core/validate.js
language: javascript
signature: "export function isValidSemver(value)"
test_command: "bun test tests/kdd-is-valid-semver.test.js"
budget:
  cyclomatic_max: 4
  nesting_max: 2
  lines_max: 20
  params_max: 1
tests: tests/kdd-is-valid-semver.test.js
tests_sha256: "a514d1a594c6a7d47c9549d773ffcfa4e5716a9e287c90ae388b14b8adeadf1a"
touch_only: ['core/validate.js']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: isValidSemver format validator

## Intent
`core/validate.js`'s `FORMATS` registry already covers `email`/`url`/`slug`/
`phone`/`color`/`time`/`date`/`uuid` but has no semantic-version check, a
real and commonly-needed one (e.g. validating a plugin manifest's `version`
field). See [architecture overview](../architecture/overview.md) for where
`validate.js` sits in the project.

## Interface
```
export function isValidSemver(value: unknown): boolean
```

## Invariants
- Never throws, for any input type (including `null`/`undefined`/objects).
- Returns `true` only for a string conforming to the semver 2.0.0 grammar
  (`MAJOR.MINOR.PATCH` with optional `-prerelease` and `+build` metadata).
- Numeric identifiers (major/minor/patch, and purely-numeric prerelease
  identifiers) reject leading zeros, per the semver spec.

## Examples
- `isValidSemver('1.2.3')` -> `true`
- `isValidSemver('1.0.0-beta+exp.sha.5114f85')` -> `true`
- `isValidSemver('1.2')` -> `false` (missing patch)
- `isValidSemver('01.2.3')` -> `false` (leading zero)
- `isValidSemver(null)` -> `false` (never throws)

## Do / Don't
- DO: keep it a pure, synchronous, dependency-free function.
- DO: register it in `FORMATS` as `semver: isValidSemver`, matching the
  existing entries' shape.
- DON'T: use a network-based or npm-package semver parser.
- DON'T: change the signature or behavior of any other `FORMATS` entry.

## Tests
(Tests live in `tests/kdd-is-valid-semver.test.js` -- written before this
contract, the frozen oracle sealed by `tests_sha256` above.)

## Constraints
- PARAR y reportar si el intent resulta imposible de cumplir sin violar
  `touch_only` o `forbids`.
- PARAR y reportar si se necesita conectividad de red.
