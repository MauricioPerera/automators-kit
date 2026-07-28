# FIX-32 — core/shell.js misc hardening (3 hallazgos LOW)

Archivos tocados: `core/shell.js`, `tests/shell.test.js`. Los 2 fixes previos (RBAC en history/context, prototype pollution en filtro JQ) NO fueron tocados.

## Hallazgo 1 — `fromARDF` valida `resource_id`

**Cambio** (`core/shell.js`, `CommandRegistry.fromARDF`): antes de derivar `ns`/`name` se valida `resource_id` contra `/^[a-zA-Z0-9_:-]+$/`. Si no valida, se saltea el descriptor con `console.warn` (no se registra).

- Descriptor con `resource_id: 'evil/../etc'` → NO se registra (skip + warn).
- Descriptor con `resource_id: 'also bad with spaces'` → NO se registra.
- Descriptor válido `good:cmd` y `standalone` (sin colon → `imported:standalone`) → se registran normalmente.

Decisión: skip saneado (no se registra nada derivado de caracteres inválidos). El comportamiento de import sin colon (`imported:<id>`) se mantiene.

## Hallazgo 2 — Default profile fail-closed

**Cambio** (`core/shell.js`, constructor): `this.profile = opts.profile || 'restricted'` (era `'admin'`). Agregado `this.debug = !!opts.debug` para el Hallazgo 3.

- `new Shell()` sin `profile` → `profile === 'restricted'`.
- `permissions` default sigue siendo `['*']` (NO se tocó — el hallazgo pedía solo `profile`).

**Tests ajustados: 0.** Ningún test existente dependía del default `admin`. `profile` solo se usa en el texto de `help()` (línea `current: ${this.profile}`); la aplicación real de permisos usa `this.permissions`, que los tests existentes ya pasan explícitamente (`AGENT_PROFILES.*`) o implícitamente vía `['*']`. El test `Token efficiency > help is constant` compara dos shells ambos con `new Shell()` (ambos ahora `restricted`), diff de longitud sigue siendo 0 < 100. Es seguro: los tests ya pasaban permissions explícitos donde el acceso importaba; el default solo cambió una etiqueta de display.

## Hallazgo 3 — Error genérico al caller

**Cambio** (`core/shell.js`, `exec` catch): se loguea `err.message` con `console.error` (server-side) y se retorna `'Internal command error'` al caller. Se agregó `opts.debug` (patrón sugerido por el hallazgo — no existía): cuando `debug: true`, se preserva `err.message` en la respuesta.

- Handler que lanza `new Error('ENOENT /secret/path')` → respuesta `error: 'Internal command error'`; el string interno NO aparece.
- Con `debug: true` → respuesta `error: 'ENOENT /secret/path'` (preservado).

**Tests ajustados: 0.** Ningún test existente verificaba mensajes de error crudo de handlers que lanzan (verificado con grep: solo asserts de `'Permission denied'` y `parse().error`).

## Tests nuevos (7)

- `FIX-32: fromARDF resource_id validation`
  - skip de descriptors con `resource_id` inválido (no registrados, 2 warns).
  - import válido sin colon → `imported:<id>`.
- `FIX-32: fail-closed default profile`
  - `new Shell()` → `profile === 'restricted'`.
  - profile explícito se respeta (admin/operator).
  - `help()` muestra `current: restricted`.
- `FIX-32: generic error messages on handler throw`
  - throw `ENOENT /secret/path` → `error === 'Internal command error'`, sin leak.
  - `debug: true` preserva el mensaje interno.

## Fixes previos intactos

Tests RBAC (`restricted cannot run history/context`, `admin/operator can run history/context`) y JQ pollution (`[__proto__] multi-select does not pollute...`) corren y pasan sin modificación.

## Salida real de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom
[Cron] Error in 'j': boom

tests\memory.test.js:
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 7 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 8 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 9 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-0G6bf1\evil.js
[Hook] Error in block: validation-blocked
[Hook] Error in err: boom
[Hook] Error in err: boom
[Plugins] Failed to load 'critical': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-VhjUhN\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-YE7Spg\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional2': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-GxUGzK\nope\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'

tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 580 pass
 0 fail
 1262 expect() calls
Ran 580 tests across 21 files. [5.88s]
```

0 fallos nuevos respecto al baseline. El test flaky preexistente de `memory.test.js` pasó en esta ejecución (no fue tocado).