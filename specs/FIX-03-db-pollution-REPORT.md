# FIX-03 — Prototype pollution en operadores de update

## Hallazgo (de la auditoría)
`core/db.js` exponía `_setNestedValue`, `_getNestedValue` y `_deleteNestedValue` sin filtrar
segmentos de path peligrosos. Un update como `{"$set": {"__proto__.polluted": true}}`
hacía que `_setNestedValue` navegara `current['__proto__']` (que en un objeto plano es el
`Object.prototype` real) y le asignara `polluted = true`, contaminando `Object.prototype`
GLOBALMENTE y afectando a todo objeto plano del proceso. Mismo riesgo con
`constructor.prototype.X`.

## Cambios (solo `core/db.js`)
Reestructuré las 3 funciones para validar **todos** los segmentos del path **antes** de
navegar/asignar. Decisión de comportamiento: **throw explícito** (no ignorar silenciosamente),
para que el intento malicioso sea obvio en logs y nunca quede un update "parcialmente
aplicado".

```js
const DANGEROUS_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function _checkPathSegment(seg) {
  if (DANGEROUS_SEGMENTS.has(seg)) {
    throw new Error(`Invalid path segment: ${seg}`);
  }
}
```

- `_getNestedValue`: valida cada `p` antes de `current = current[p]`. Reescrita a un solo
  bucle (`path.split('.')` ya cubre el caso sin punto), sin cambio observable de comportamiento.
- `_setNestedValue`: valida **antes** del bucle de navegación → el throw ocurre antes de
  cualquier asignación, así que ni siquiera momentáneamente se contamina.
- `_deleteNestedValue`: valida antes de navegar.

Case-sensitive (son los 3 nombres peligrosos reales de JS). El check corre antes de toda
navegación, así que `$inc` (que llama `_getNestedValue` primero) y `$push` también se
protegen vía el `_getNestedValue` inicial y, si llegaran al set, vía `_setNestedValue`.

### Nota de alcance / decisión documentada
`_getNestedValue` se usa también en lecturas (`matchFilter`, índices, agregación, sort,
proyección). Consecuencia deliberada: cualquier path de lectura/escritura que contenga
`__proto__`/`constructor`/`prototype` ahora lanza. Ningún test existente ni uso legítimo
usaba esos nombres como campos de documento (son inherentemente peligrosos), así que no
rompe nada. Se prefirió el throw consistente sobre un comportamiento "lectura permite /
escritura bloquea" que dejaría un vector inconsistente.

No se tocó `core/nodes.js`, `core/triggers.js`, `core/a2e.js`, `core/portable-text.js`,
`core/plugins.js` (trabajo en paralelo de otros devs).

## Tests agregados (solo `tests/db.test.js`)
- Importé `applyUpdate` (ya exportado por `core/db.js`) y `afterEach` de `bun:test`.
- Nuevo `describe('Prototype pollution protection', ...)` con `beforeEach`/`afterEach`
  que limpian `Object.prototype.polluted` para aislar estado global entre tests.

Tests:
1. `$set` con `__proto__.polluted` → lanza y `({}).polluted` sigue `undefined`.
2. `$set` con `constructor.prototype.polluted` → lanza y `({}).polluted` sigue `undefined`.
3. `$unset` con `__proto__` → lanza y no contamina.
4. `$inc` con `__proto__` → lanza y no contamina.
5. `$push` con `constructor.prototype` → lanza y no contamina.
6. Segmento peligroso en posición intermedia (`a.__proto__.polluted`) → lanza y no contamina.
7. **Operadores legítimos siguen funcionando igual**: `$set`/`$inc`/`$push`/`$unset` con
   paths anidados normales (`a.b.c`, `score.n`, `tags.items`, `a.b`) + aserción de no
   contaminación colateral.
8. `Collection.update` (vía `db.collection().update`) con path peligroso → lanza y no
   contamina el proceso.

## Verificación
Definición de hecho cumplida:
1. ✅ Test `$set {"__proto__.polluted": true}` no contamina `Object.prototype` (`({}).polluted` undefined).
2. ✅ Test equivalente `constructor.prototype.X`.
3. ✅ `$set`/`$unset`/`$inc`/`$push` normales (paths `a.b.c`, etc.) siguen funcionando igual.
4. ✅ `bun test tests/`: 0 fallos nuevos respecto al baseline.
5. ✅ Salida real pegada abajo.

### `bun test tests/` (salida real)
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
(fail) Dream Cycle > dream heuristic merges duplicates [0.86ms]

tests\plugins.test.js:
[Hook] Error in err: boom

 436 pass
 1 fail
 816 expect() calls
Ran 437 tests across 20 files. [4.05s]
```

### `bun test tests/db.test.js` (salida real)
```
bun test v1.3.14 (0d9b296a)

 60 pass
 0 fail
 125 expect() calls
Ran 60 tests across 1 file. [184.00ms]
```

## Nota sobre el único fail
`memory.test.js` > "Dream Cycle > dream heuristic merges duplicates": `duration_ms` da 0
por timing flaky de `dream()`. Es el fallo **preexistente** del baseline (421 pass / 1 fail
según el contexto), no relacionado con este fix y fuera de los archivos que toqué
(`core/db.js` + `tests/db.test.js`). No se modificó.