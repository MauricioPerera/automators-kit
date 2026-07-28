CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline conocido: 421 pass / 1 fail (`memory.test.js`, timing flaky en `dream()`, PREEXISTENTE y no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un CRITICAL que te toca arreglar a vos:

## Hallazgo: Recursión sin límite en el ejecutor DAG (a2e) → hang / stack overflow
- Archivo: core/a2e.js, método `_executeOp` (líneas ~603-675) y `_executeLoop` (líneas ~678-699).
- `_executeOp` se llama recursivamente a sí mismo en 3 lugares: (1) rama de `Conditional` vía `result.executeOperationId`, (2) fallback `onError`, (3) cada sub-operación dentro de `_executeLoop`.
- No hay contador de profundidad ni límite. Una definición de operaciones donde, por ejemplo, un `Conditional` cuya rama apunte de vuelta al propio Conditional, o un `onError` que se referencia a sí mismo, o un `Loop` cuyas `operations` incluyan su propio opId, produce recursión infinita que cuelga el proceso o agota el stack (crashea el runtime ENTERO, no solo esa ejecución).

Fix: agregá un parámetro `depth` (o similar) a `_executeOp`, incrementado en cada llamada recursiva (las 3 vías), con un límite máximo configurable (default razonable, p.ej. 50 — mirá si la clase ya tiene un lugar de config tipo `this.maxDepth` o constructor options para seguir el patrón existente del archivo). Al superar el límite: no colgar ni tirar una excepción no controlada que rompa el proceso — registrar el error en `this.errors[opId]` (mismo patrón que el resto del método usa para errores) y retornar, igual que cuando `!handler`.

ARCHIVOS: Toca SOLO `core/a2e.js` y `tests/a2e.test.js`. NO toques `core/nodes.js`, `core/triggers.js`, `core/db.js`, `core/portable-text.js`, `core/plugins.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/a2e.test.js que arma un ciclo real (p.ej. un `Conditional` cuyo `executeOperationId` apunte a sí mismo, o un `onError` autoreferenciado) y confirma que la ejecución TERMINA (no cuelga) con un error registrado en `errors`, no un stack overflow no controlado. El test debe tener un timeout razonable para que si el fix no funciona, el test FALLE por timeout en vez de colgar la suite entera.
2. Confirmá que las ejecuciones normales (sin ciclos, con anidamiento razonable de Conditional/Loop/onError) siguen funcionando igual que antes — no debe romper ningún test existente por el límite de profundidad siendo demasiado bajo.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia — el veredicto es la suite, no un contrato).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima (p.ej. algún test existente depende genuinamente de una profundidad de recursión mayor a la que elegiste como límite, y no podés resolverlo sin subir el límite a un valor que ya no protege contra el hang) → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-02-a2e-recursion-REPORT.md` (qué cambiaste, el límite elegido y por qué, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
