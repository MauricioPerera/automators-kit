CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró un MEDIUM en `core/parallel.js` que te toca a vos:

## Hallazgo: `parallelRace([])` con arreglo vacío cuelga indefinidamente
- Líneas ~179-214.
```js
return new Promise((resolve) => {
  let settled = false;
  let failures = 0;

  tasks.forEach((fn, i) => {
    ...
  });
});
```
- Con `tasks = []`, `forEach` no invoca ningún callback, `resolve` nunca se llama, la promesa queda pending para siempre. `parallelMerge` (mirá su código) ya maneja el caso vacío correctamente; `parallelRace` no.
- Fix: al inicio de `parallelRace` (antes de crear la Promise, o justo al entrar al executor), si `tasks.length === 0`, resolvé inmediatamente con un valor sensato — mirá qué forma de resultado usa la función en el caso normal (ganador con `resolved`/`winnerId`/`duration` según la evidencia) y devolvé algo coherente para el caso vacío (p.ej. `{ resolved: null, winnerId: -1, duration: 0 }`, ajustá los nombres de campo a lo que el código real use).

ARCHIVOS: Toca SOLO `core/parallel.js` y `tests/parallel.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo: `await parallelRace([])` resuelve (no cuelga) en un tiempo razonable — usá un timeout de test bajo (2000ms) para que si el fix no funciona, el test falle rápido por timeout en vez de colgar la suite entera.
2. Test que confirma que `parallelRace` con tasks normales (no vacío) sigue funcionando igual que antes.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-29-parallel-race-empty-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
