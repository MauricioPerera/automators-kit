# FIX-24 — a2e.js: DAG dynamic deps, CacheMiddleware, ReDoS guard

Archivos tocados: `core/a2e.js`, `tests/a2e.test.js`. No se tocaron los 2 fixes
previos (guard de profundidad de recursión, SSRF en ApiCall/ExecuteN8nWorkflow)
ni ningún otro archivo.

Orden de implementación: Hallazgo 2 (cache) → Hallazgo 3 (ReDoS) → Hallazgo 1
(DAG). Los 3 completados; ninguno parcial/bloqueado.

---

## Hallazgo 2 — CacheMiddleware cachea pero nunca restaura

**Diagnóstico.** `processConfig` marcaba `config._cached` en un hit, pero
`processResult` era un no-op que nunca escribía en `this._cache` → la feature de
cache estaba completamente rota (todo era miss). Además `_executeOp` no consumía
`config._cached`, así que aunque se guardara, el hit no hubiera servido.

**Fix (3 cambios mínimos en `core/a2e.js`).**
1. `CacheMiddleware.processConfig`: además de marcar `_cached`, guarda la `key`
   calculada en `config._cacheKey` para que `processResult` pueda reusarla. La
   `key` se calcula sobre el `config` limpio (copia fresca `{...op.config}` por
   ejecución), antes de inyectar los campos privados, así que los campos `_cacheKey`
   /`_cached` nunca contaminan la clave.
2. `CacheMiddleware.processResult(result, opType, config)`: ahora puebla el cache
   con `this._cache.set(config._cacheKey, { result, ts: Date.now() })`.
3. `_executeOp`: short-circuit — si `config._cached !== undefined` y el op no es
   `Conditional` ni `Loop`, usa el resultado cacheado y **no invoca el handler**.
   `Conditional`/`Loop` se excluyen deliberadamente: tienen side-effects dinámicos
   (ejecución de rama / iteración) que no deben saltearse. También se pasa `config`
   como 3er arg a `processResult` (backward-compatible: `AuditMiddleware` no define
   `processResult`).

**Test.** `CacheMiddleware (FIX-24)` — un handler custom `Counted` con contador; dos
`execute()` consecutivas con la misma `CacheMiddleware`. Verifica: `calls === 1`
(el handler NO se invoca la 2da vez), `r2.results.a === 'r1'` (valor cacheado
reusado), y `stats()` reporta 1 hit / 1 miss / size 1.

---

## Hallazgo 3 — ReDoS vía `RegExp` con input de usuario

**Diagnóstico.** `handleExtractText` y `handleValidateData` (case `custom`)
construían `new RegExp(config.pattern, ...)` sin límite. Patrones catastróficos
cuelgan el event loop.

**Fix.** Helper `_validateRegexPattern(src)` dentro de `core/a2e.js` (no toqué
`db.js`/`vector.js`, que tienen su propia implementación). Misma forma que el
guard de `core/db.js`: (1) rechaza patrones > 200 chars; (2) heurística
fail-closed de cuantificadores anidados tipo `(x+)+`/`(x*)*` — strip de escapes y
clases `[..]`, colapsa grupos cuantificados de adentro hacia afuera, y si el body
de un grupo cuantificado ya contiene `*`/`+`, lanza antes de compilar. Aplicado
antes de `new RegExp` en ambos sitios. Function declaration → hoisted, definida
en la sección HELPERS y usada arriba.

**Tests.** `ReDoS guard (FIX-24)`:
- patrón `(a+)+b` en `ExtractText` → `r.errors.nums` definido y matchea
  `/catastrophic|too long/i` (timeout 2000ms para que un fix roto falle rápido).
- patrón `(a+)+b` en `ValidateData` custom → idem sobre `r.errors.v`.
- patrón benigno `\\d+` sigue funcionando (no over-reject): `r.errors.nums`
  undefined y extrae `['100','200']`.

---

## Hallazgo 1 — DAG ignora dependencias dinámicas (Conditional/onError) → carrera

**Diagnóstico.** `buildDAG` (a) excluía la referencia `onError` como dependencia
(`if (op.onError === depId) continue`) y (b) no modelaba las ramas `ifTrue`/`ifFalse`
del `Conditional` como aristas. El executor paralelo podía correr un op que depende
dinámicamente de un `Conditional`/`onError` antes de que ese predecesor resolviera
→ lectura de `state` inconsistente (`undefined` silencioso).

**Approach elegido: modelado completo (no el simplificado secuencial).** Era
alcanzable sin tocar la lógica de `_executeOp` ni el guard de profundidad, y
preserva el paralelismo. El approach secuencial se descartó porque no ordena las
ramas (ops separados) respecto del `Conditional`.

**Fix en `buildDAG`:**
1. **onError como arista real**: se eliminó la línea `if (op.onError === depId)
   continue`. Ahora un op que referencia el `outputPath` de su propio fallback
   depende de ese fallback y corre después de que este resuelva. Es seguro: el
   fallback siempre ejecuta como op normal en su propio nivel, así que esperar por
   él no deadlockea; cualquier ciclo genuino cae al fallback secuencial
   (`buildDAG` devuelve `null`).
2. **Ramas `Conditional` como aristas**: para `op.type === 'Conditional'`, cada
   rama (`ifTrue`/`ifFalse`) que sea un opId existente y distinto del propio op se
   agrega como **dependiente** del `Conditional` (`graph.get(branchId).add(op.id)`),
   forzando a la rama a correr en un nivel posterior al `Conditional`. Self-branches
   se skippean (manejados por el guard de profundidad existente).

**Tests.** `DAG dynamic dependencies (FIX-24)`:
- **onError**: `risky` referencia `/workflow/safe` (outputPath de su fallback) y
  siempre falla, con `onError: 'safe'`; `safe` es un handler async lento (20ms).
  Sin el fix, `risky` corre en paralelo con `safe` (nivel 0) y lee `undefined`
  antes de que `safe` resuelva → error `'safe-not-ready'`. Con el fix, `risky`
  corre después de `safe`, lee el valor y luego falla con `'boom'`. El test
  verifica `r.errors.risky === 'boom'` (determinístico: `risky` es sync, `safe` es
  async de 20ms → sin el fix el sync gana la carrera y lee `undefined`).
- **Conditional**: registra el orden de ejecución del `Conditional` y de su rama
  `pass` (vía contadores en closures). Con el fix, la rama depende del
  `Conditional` y corre después (`passFirst.n > check.n`); sin el fix la rama
  queda en nivel 0 y corre antes. Determinístico porque los niveles se ejecutan
  secuencialmente (`await Promise.all` por nivel).

**Compatibilidad con tests existentes verificada:** los tests de `Conditional`
(true/false branch), del guard de profundidad (self-ref Conditional, self-ref
onError, nesting razonable) y de `buildDAG` (niveles paralelos, ciclo → null)
siguen pasando. El test de self-ref `onError: 'risky'` no se ve afectado porque
la auto-referencia ya se bloquea por `depId !== op.id` (no por la exclusión
removida).

---

## Fixes previos — confirmados intactos

Los 2 fixes previos (`core/a2e.js`) no se tocaron ni revirtieron:
- **Guard de profundidad de recursión** (`_executeOp`, `maxDepth`): los 3 tests de
  `Recursion depth guard` pasan.
- **SSRF en ApiCall/ExecuteN8nWorkflow** (`assertPublicUrl`): los 6 tests de
  `SSRF guard` pasan.

`bun test tests/a2e.test.js` → 45 pass / 0 fail (39 originales + 6 nuevos).

---

## Salida real de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

 561 pass
 1 fail
 1213 expect() calls
Ran 562 tests across 21 files. [6.05s]
```

El único fail es el preexistente y conocido
`tests/memory.test.js > Dream Cycle > dream heuristic merges duplicates`
(timing flaky, no relacionado, no tocado). **0 fallos nuevos respecto al
baseline.**

Nota sobre conteos: el baseline citado en el brief (490 tests) difiere del actual
(562) porque el working tree ya traía modificaciones de otros devs en múltiples
suites (ver `git status`); el delta relevante es +6 tests nuevos en `a2e.test.js`,
todos verdes, y ningún test previo recién roto.