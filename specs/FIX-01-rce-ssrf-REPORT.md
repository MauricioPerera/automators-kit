# FIX-01 — RCE (code.run) + SSRF (net-guard)

## Qué cambié

### Hallazgo 1 — RCE en `code.run` (opción (a): eliminar el nodo)

Decisión: **eliminar `code.run` de `BUILTIN_NODES`** (opción a), no opción (b).

Razones:
- La opción (b) exige documentar en `README.md`/`AGENTS.md` ("en README.md/AGENTS.md si mencionan code.run"), pero **esos archivos están fuera de la lista permitida** ("Toca SOLO core/nodes.js, core/triggers.js, core/net-guard.js, tests/nodes.test.js, tests/triggers.test.js"). Elegir (b) me obligaría a violar el alcance o a dejar la doc inconsistente.
- Además, (b) quita el denylist. El test existente `code.run blocks dangerous keywords` pasa hoy `process.exit()` al handler; sin denylist, `new Function` ejecutaría `process.exit()` de verdad (en Bun `process` es global) y mataría el runner de tests. Reescribir ese test para no llamar `process.exit()` es forzar el HECHO.
- (a) vive dentro del scope: un comentario corto en `core/nodes.js` (sin exponer el exploit) y editar los 2 tests que testean exactamente la feature removida.

Cambio en `core/nodes.js`: se eliminó el bloque `code.run` y se dejó un comentario explicando que el handler ejecutaba JS no confiable vía `new Function` con un denylist bypaseable, que un denylist nunca es sandbox real, y que un sandbox verdadero (isolates/worker restringido) es un cambio de arquitectura fuera de scope. Ejecutar código no confiable pasa a ser responsabilidad de quien registre su propio nodo; ya no es built-in.

### Hallazgo 2 — SSRF (nuevo `core/net-guard.js`, reusado por nodes + triggers)

Nuevo archivo `core/net-guard.js` con `assertPublicUrl(rawUrl)`:
- Parsea la URL; rechaza si el esquema no es `http:`/`https:`.
- Normaliza el hostname (quita corchetes IPv6).
- Rechaza `localhost`.
- IPv4 literal: bloquea loopback `127/8`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16`, y `0.0.0.0`. Valida octetos ≤255.
- IPv6 literal: bloquea `::1`, `::`, y link-local `fe80::/10` (primer hextet en `[0xfe80, 0xfebf]`).
- No hace resolución DNS (por scope/timing). Es mejora futura (ver abajo).

Uso:
- `core/nodes.js` `_executeApi`: `assertPublicUrl(url)` inmediatamente después de interpolar la URL y antes de `fetch`.
- `core/triggers.js` `register()`: para `TriggerType.POLL` se valida `assertPublicUrl(trigger.config.url)` **antes** de `_registered.set(...)`, de modo que una URL interna rechazada no deja nada registrado (sin poller, sin fetch recurrente).

## Tests agregados / modificados

`tests/nodes.test.js`:
- Removidos: `execute code.run (safe)`, `code.run blocks dangerous keywords` (testeaban la feature eliminada).
- Agregado: `code.run node is no longer a built-in (RCE removed)` — confirma `reg.has('code.run') === false` (HECHO 1: el RCE ya no existe).
- Agregados: `http.request rejects cloud metadata URL (169.254.169.254)`, `http.request rejects loopback URL (127.0.0.1)`, `http.request rejects non-http(s) scheme` (HECHO 2).

`tests/triggers.test.js`:
- Modificado: `poll trigger registers and cleans up` usaba `http://localhost:99999/fake` (ahora bloqueado por el guard). Cambiado a `https://example.com/feed.json` (público; `interval: 999999` → no fetchea).
- Agregados: `poll trigger rejects internal destination (169.254.169.254)`, `poll trigger rejects loopback destination (127.0.0.1)` — verifican que `register()` lanza error controlado y `tm.list().length === 0` (HECHO 3).

## HECHO — verificación

1. RCE: test `code.run node is no longer a built-in` pasa (antes el nodo existía y ejecutaba `new Function` sin advertencia; ahora no existe). ✓
2. SSRF nodes: `http.request` con `169.254.169.254` y `127.0.0.1` lanza error controlado (sin fetch real, sin colgar). ✓
3. SSRF triggers: poller con `config.url` interna es rechazado al registrar; `list().length === 0`. ✓
4. Suite: 0 fallos nuevos respecto al baseline. ✓
5. Salida real de `bun test tests/` (pegada abajo). ✓

## Salida REAL de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom

tests\memory.test.js:
315 |     expect(mem.stats().episodic).toBe(4);
316 |
317 |     // Dream without LLM (heuristic mode)
318 |     const report = await mem.dream();
319 |
320 |     expect(report.duration_ms).toBeGreaterThan(0);
                                     ^
error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received: 0

      at <anonymous> (D:\Repo\projecto\automators-kit\tests\memory.test.js:320:32)
(fail) Dream Cycle > dream heuristic merges duplicates [0.98ms]

tests\plugins.test.js:
[Hook] Error in err: boom

 446 pass
 1 fail
 842 expect() calls
Ran 447 tests across 20 files. [4.11s]
```

El único fail es `memory.test.js` (`dream heuristic merges duplicates`), el flaky de timing preexistente y conocido (no relacionado, no se tocó). Exit code 1 corresponde a ese único fail.

## Trade-offs

- **code.run (opción a vs b)**: elegí (a) por las razones de arriba. Costo: se remueve un nodo built-in que exponía "ejecutar JS" como feature. Es una decisión de producto que la consigna autorizaba explícitamente al ofrecer (a) como opción válida. Quien necesite ejecutar código puede registrar su propio nodo con handler propio, asumiendo el riesgo.
- **net-guard sin DNS**: valida solo el literal hostname/IP de la URL. Un hostname público que resuelve a una IP interna (DNS rebinding / CNAME a 169.254.x) **no** se atrapa. Esto es intencional (la consigna lo deja fuera de scope por timing/complejidad). **Mejora futura:** resolución DNS real del host y validación de las IPs resultantes antes del fetch, idealmente con un check en el momento de la conexión (TOCTOU). Documentado como mejora, no implementado.
- **No se tocó README.md/AGENTS.md** (fuera de scope): quedan mencionando `code.run` como nodo core. Si se quiere coherencia total de docs, otro dev con permiso sobre esos archivos debería limpiar las referencias en `AGENTS.md:177`, `AGENTS.md:307` y `README.md:130`.

## Archivos tocados (solo los permitidos)

- `core/nodes.js` (import net-guard, guard en `_executeApi`, eliminación de `code.run` + comentario)
- `core/triggers.js` (import net-guard, guard en `register` para POLL antes de registrar)
- `core/net-guard.js` (nuevo)
- `tests/nodes.test.js`
- `tests/triggers.test.js`

No se tocaron `core/a2e.js`, `core/db.js`, `core/portable-text.js`, `core/plugins.js`.

## Nota sobre el working tree

`core/db.js` y `tests/db.test.js` aparecen modificados en `git status` — son cambios de **otros devs en paralelo** (no los toqué; la consigna lo prohíbe). En una run intermedia con un error de sintaxis en `tests/nodes.test.js` (ya corregido) se observó un error `afterEach is not defined` en `db.test.js` por contaminación cruzada del archivo malformado; una vez corregida la sintaxis, ese error desaparece y `db.test.js` pasa limpio (verificado: `bun test tests/db.test.js` solo → 60 pass / 0 fail). La run final completa no muestra ese error.