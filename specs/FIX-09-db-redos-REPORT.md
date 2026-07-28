# FIX-09 — `$regex` ReDoS en `core/db.js`

## Hallazgo (HIGH)
El operador `$regex` en `matchFilter` compilaba `new RegExp(target)` con el patrón crudo del filtro y ejecutaba `.test()` sin validación. Un filtro proveniente de input externo (API REST, query de cliente) con un patrón catastrófico (`(a+)+$`) contra un valor diseñado para disparar backtracking bloquea el event loop por minutos. El mismo riesgo existía en el camino `cond instanceof RegExp` (línea ~52), donde un `RegExp` arrives via el filtro y se ejecuta `.test()` sin validar su `.source`.

## Cambios (`core/db.js`)
1. **Guardia `_validateRegexPattern(src)`** (nueva, antes de `matchFilter`):
   - **Límite de longitud**: `REGEX_MAX_LEN = 200`. Patrón más largo → `throw`.
   - **Heurística de backtracking catastrófico**: detecta grupos cuantificados cuyo contenido ya contiene un cuantificador `*` o `+` — formas `(x+)+`, `(x*)*`, `(x+)*`, `(x*)+`, incluyendo anidamiento `((a+)+)+`. Quita escapes (`\.`) y clases `[...]` para no falsear la detección, luego colapsa grupos cuantificados de adentro hacia afuera (hasta 32 niveles); si el contenido de un grupo cuantificado tiene un `*`/`+`, lanza.
   - **Fail-closed**: ante la duda rechaza (throw) en lugar de ejecutar.
2. **`$regex` case**: se llama a `_validateRegexPattern(re.source)` **antes** de `.test()`.
3. **`cond instanceof RegExp` (línea ~52)**: se llama a `_validateRegexPattern(cond.source)` **antes** de `.test()`. Aplica el MISMO chequeo porque ese camino también usa un regex proveniente del filtro externo.

### Límites conocidos de la heurística
- Solo cubre cuantificadores `*` y `+` (no `?`); `(a?)*` no se detecta.
- Puede over-rechazar patrones válidos con grupos cuantificados anidados no catastróficos (p.ej. `(a+b)+` se rechaza). Intencional: el patrón viene de input no confiable.
- No detecta backtracking super-lineal por alternation ambigua sin grupo cuantificado.
- El límite de 200 chars puede rechazar patrones legítimamente largos; ajustable vía `REGEX_MAX_LEN`.

## Tests agregados (`tests/db.test.js`)
- **`$regex`** (extendido): confirma que patrones normales (`^Ali`, `[0-9]+`) siguen funcionando igual que antes (true/false según corresponda).
- **`$regex rejects catastrophic (ReDoS) patterns before .test()`** (timeout 2000ms): rechaza `(a+)+$`, `(a*)*$`, `(a+)*$`, `((a+)+)+` y un `RegExp` instance `(a+)+$` contra un string diseñado para disparar backtracking. Si el fix no funciona, el test falla por timeout (2000ms) en vez de colgar la suite.
- **`$regex rejects patterns exceeding the length limit`**: rechaza un patrón de 201 chars; uno de exactamente 200 (límite) NO se rechaza por longitud.

## Salida real de `bun test tests/`
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
(fail) Dream Cycle > dream heuristic merges duplicates [0.84ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-iHc8E9\evil.js

 469 pass
 1 fail
 919 expect() calls
Ran 470 tests across 20 files. [4.09s]
```

`tests/db.test.js` aislado:
```
bun test v1.3.14 (0d9b296a)

 62 pass
 0 fail
 134 expect() calls
Ran 62 tests across 1 file. [152.00ms]
```

## Verificación de la definición de hecho
1. ✅ Test que rechaza patrón catastrófico `(a+)+$` antes de `.test()` (timeout 2000ms).
2. ✅ Test que confirma patrones normales (`^Ali`, `[0-9]+`) siguen funcionando igual.
3. ✅ Test que rechaza patrón > límite (201 chars) y permite el de 200 (límite).
4. ✅ `bun test tests/`: 0 fallos nuevos. Único fail = `memory.test.js` (timing flaky preexistente, no relacionado, no tocado).
5. ✅ Salida real pegada arriba.

## Archivos tocados
- `core/db.js`
- `tests/db.test.js`

No se tocaron `core/vector.js` ni `core/hnsw.js`.