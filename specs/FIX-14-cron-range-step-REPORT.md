# FIX-14 — Cron parser: `rango/step` ignora el límite superior del rango

## Hallazgo (HIGH)
En `core/cron.js`, rama `part.includes('/')` de `parseField`: para un campo tipo `5-10/2`,
`range = '5-10'` y `parseInt('5-10')` → `5` (parseInt se detiene en el `-`). El límite
superior `10` se descartaba y el bucle avanzaba hasta `max` del campo (p.ej. 59 para minutos),
disparando 28 veces por hora en vez de 3.

## Cambio realizado — `core/cron.js` (rama `/` de `parseField`)
Se reemplazó el cálculo de `start` por un branching explícito según la forma de `range`:

- `range === '*'` → `start = min`, `upper = max` (comportamiento anterior, sin cambios).
- `range` contiene `-` (rango explícito `lo-hi`) → se parsean `lo` y `hi` por separado con
  `range.split('-').map(Number)`, validación `isNaN`/`lo > hi`, y se usa `hi` como cota
  superior del bucle en vez de `max`. **Este es el fix.**
- `range` sin `-` (bare `N/step`) → `start = parseInt(range)`, `upper = max` (comportamiento
  anterior, sin cambios — "desde N hasta el máximo del campo").

El bucle ahora itera `for (let i = start; i <= upper; i += stepN)`.

No se tocaron otras ramas de `parseField` ni otros archivos core.

## Tests agregados — `tests/cron.test.js`
1. **`parses explicit range/step, capped at range upper bound`** — `5-10/2 * * * *` produce
   exactamente `[5, 7, 9]` para minutos; verifica `has(11)===false`, `has(13)===false`,
   `has(59)===false`, `size===3`.
2. **`parses */N (star step) using full field range — unchanged`** — `*/15` sigue dando
   `[0, 15, 30, 45]`, `size===4` (usa min/max del campo completo).
3. **`parses N/step (bare, no explicit range) up to field max — unchanged`** — `5/2` da
   `5,7,...,59` (28 valores), confirmando que el caso sin guión sigue usando `max` como cota.

## Salida REAL de `bun test tests/`
```
 489 pass
 1 fail
 992 expect() calls
Ran 490 tests across 20 files. [4.09s]
```

El único fail es `memory.test.js` (`Dream Cycle > dream heuristic merges duplicates`),
flaky de timing, preexistente y no relacionado con este fix (no se tocó).

### Nota sobre una corrida intermedia
Una primera corrida mostró 2 fails transitorios en `tests/plugins.test.js`
(`createPluginAPI — capability bypass fixes (FIX-12)`). Son flaky dependientes de
orden/timing en archivos **no tocados** por este fix (`core/plugins.js`,
`tests/plugins.test.js` ya venían modificados `M` en el working tree al inicio de la
sesión). No aparecen en la corrida limpia final y son independientes de `cron.js`.

## Verificación aislada
`bun test tests/cron.test.js` → `22 pass, 0 fail, 53 expect() calls`.

## Definición de hecho
1. ✅ Test `5-10/2` → `[5,7,9]`, sin 11/13/…/59.
2. ✅ Test `*/15` → comportamiento anterior (`[0,15,30,45]`).
3. ✅ Test `5/2` (bare) → comportamiento anterior (hasta max del campo, 28 valores).
4. ✅ `bun test tests/` — 0 fallos nuevos respecto al baseline (único fail = memory flaky preexistente).
5. ✅ Salida real pegada arriba.