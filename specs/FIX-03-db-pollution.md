CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline conocido: 421 pass / 1 fail (`memory.test.js`, timing flaky en `dream()`, PREEXISTENTE y no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un CRITICAL que te toca arreglar a vos:

## Hallazgo: Prototype pollution vía operadores de update ($set, $unset, $inc, $push)
- Archivo: core/db.js, funciones `_setNestedValue` (líneas ~139-148), `_getNestedValue` (~125-137), `_deleteNestedValue` (~150-159), usadas por `applyUpdate` (~165+) para los operadores `$set`/`$unset`/`$inc`/`$push`.
- Ninguna de las 3 funciones filtra segmentos de path peligrosos. Un update como `{"$set": {"__proto__.polluted": true}}` hace que `_setNestedValue` navegue `current['__proto__']` (que en un objeto plano ES el `Object.prototype` real, no una copia) y le asigne `polluted = true` — contamina `Object.prototype` GLOBALMENTE, afecta a TODO objeto plano del proceso, no solo al documento que se estaba actualizando.
- Mismo riesgo con `constructor.prototype.X` como path.

Fix: en las 3 funciones, al iterar los segmentos del path (`parts`), rechazar o saltear cualquier segmento que sea exactamente `__proto__`, `constructor` o `prototype` (case-sensitive, son los 3 nombres peligrosos reales en JS). Decisión de comportamiento: preferí lanzar un error explícito (p.ej. `throw new Error('Invalid path segment: __proto__')`) en vez de silenciosamente ignorar el segmento — es más seguro que un update "parcialmente aplicado" silencioso, y hace obvio el intento malicioso en los logs. Si algún test existente depende de que un `$set` con esos nombres NO tire error, ajustá tu approach y documentalo en el REPORT.

ARCHIVOS: Toca SOLO `core/db.js` y `tests/db.test.js`. NO toques `core/nodes.js`, `core/triggers.js`, `core/a2e.js`, `core/portable-text.js`, `core/plugins.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/db.test.js que confirma que `applyUpdate(doc, {"$set": {"__proto__.polluted": true}}))` (o el equivalente que uses para llamar la función real, mirá cómo se testea `$set` ya en el archivo) NO contamina `Object.prototype` — después de la llamada, `({}).polluted` debe seguir siendo `undefined`.
2. Test equivalente para `constructor.prototype.X` si aplica al mismo mecanismo.
3. Confirmá que los `$set`/`$unset`/`$inc`/`$push` normales (paths legítimos tipo `"a.b.c"`) siguen funcionando exactamente igual.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia — el veredicto es la suite, no un contrato).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-03-db-pollution-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
