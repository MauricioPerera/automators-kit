CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/a2e.js` YA tiene 3 fixes previos (profundidad de recursión, SSRF, cache/ReDoS/DAG). NO los toques ni reviertas — es tuyo agregar 1 fix MÁS al mismo archivo.

Una auditoría encontró un LOW en `core/a2e.js` que te toca a vos:

## Hallazgo: `Math.max(...nums)` / `Math.min(...nums)` sobre arrays enormes desborda el stack
- Líneas ~411-414.
```js
case 'max': return Math.max(...nums);
case 'min': return Math.min(...nums);
```
- El spread de un array arbitrariamente grande coloca cada elemento como argumento en el stack; arrays > ~100k elementos pueden agotarlo (`RangeError: Maximum call stack size exceeded`).
- Fix: reemplazá el spread por `nums.reduce((a, b) => Math.max(a, b), -Infinity)` y `nums.reduce((a, b) => Math.min(a, b), Infinity)` respectivamente — mismo resultado, sin desbordar el stack.

ARCHIVOS: Toca SOLO `core/a2e.js` y `tests/a2e.test.js`. NO toques los 3 fixes previos ya existentes (profundidad, SSRF, cache/ReDoS/DAG).

DEFINICIÓN DE HECHO:
1. Test nuevo: la operación `Calculate` con `operation: 'max'` (y `'min'`) sobre un array de al menos 200,000 números NO lanza `RangeError` y devuelve el resultado correcto.
2. Test que confirma que `max`/`min` sobre arrays chicos normales sigue funcionando igual que antes.
3. Confirmá que los 3 fixes previos siguen funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-38-a2e-math-spread-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
