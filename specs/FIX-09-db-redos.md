CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un HIGH que te toca arreglar a vos:

## Hallazgo: `$regex` con patrón arbitrario de usuario → ReDoS
- Archivo: core/db.js, líneas ~69-73 (operador `$regex` en `matchFilter`) y línea ~52 (`cond instanceof RegExp`).
- Evidencia:
```js
case '$regex': {
  const re = typeof target === 'string' ? new RegExp(target) : target;
  if (!re.test(String(val ?? ''))) return false;
  break;
}
```
- El operador `$regex` construye `new RegExp(target)` con el patrón crudo que llega en el filtro de una query. Si el filtro viene de input de usuario (API REST, query de cliente), un patrón catastrófico (`(a+)+$`) bloquea el event loop en `.test()` por minutos, sin límite de tamaño ni timeout.
- Escenario de explotación: request con `{ name: { $regex: "(a+)+$" } }` contra un documento con `name: "aaaaaaaaaaaaaaaaaaaaaaaa!"` → bloqueo de CPU.
- Fix: agregá una validación antes de compilar/usar el regex — límite de longitud del patrón (p.ej. 200 caracteres) Y una detección heurística de patrones catastróficos conocidos (grupos anidados con cuantificadores tipo `(x+)+`, `(x*)*`, `(x+)*`, `(x*)+` — podés chequear el patrón mismo con un regex simple que detecte esas construcciones antes de compilarlo). No hace falta un analizador de regex perfecto, un chequeo heurístico razonable + límite de longitud alcanza. Aplicá el MISMO chequeo tanto para `$regex` como para el caso `cond instanceof RegExp` en línea ~52 si ese camino también compila/usa un regex proveniente de filtro externo (mirá el código real para confirmar si aplica ahí también).
- Nota: `core/vector.js` tiene el MISMO patrón de vulnerabilidad en su propio `matchFilter`; otro dev lo está arreglando en paralelo ahí — NO toques `core/vector.js`, cada uno arregla su archivo aunque la lógica de la heurística pueda terminar pareciéndose.

ARCHIVOS: Toca SOLO `core/db.js` y `tests/db.test.js`. NO toques `core/vector.js`, `core/hnsw.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/db.test.js que confirma que un patrón `$regex` catastrófico (ej. `"(a+)+$"`) es rechazado ANTES de ejecutar `.test()` contra un string largo diseñado para disparar backtracking catastrófico. El test debe tener timeout bajo (p.ej. 2000ms) para que si el fix no funciona, el test falle por timeout en vez de colgar la suite entera.
2. Test que confirma que `$regex` con patrones normales (ej. `"^abc"`, `"[0-9]+"`) sigue funcionando exactamente igual que antes.
3. Test que confirma que un patrón demasiado largo (> el límite que elegiste) también es rechazado.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-09-db-redos-REPORT.md` (qué cambiaste, la heurística elegida y sus límites conocidos, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
