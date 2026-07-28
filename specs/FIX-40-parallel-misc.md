CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/parallel.js` YA tiene un fix previo (`parallelRace([])` cuelga). NO lo toques ni reviertas — es tuyo agregar 2 fixes MÁS al mismo archivo.

Una auditoría encontró 2 hallazgos LOW en `core/parallel.js` que te tocan a vos:

## Hallazgo 1: `withTimeout` no cancela la promesa subyacente
- Líneas ~221-229.
```js
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```
- Al expirar el timeout, se rechaza la promesa externa pero la tarea original sigue corriendo en background, consumiendo recursos silenciosamente.
- Fix: JavaScript no permite cancelar una Promise arbitraria de forma nativa sin cooperación del productor. El fix realista acá es: aceptá un parámetro opcional adicional, un `AbortSignal` (o una función `onTimeout` callback), que se dispare cuando el timeout expira, para que EL CALLER pueda reaccionar (p.ej. abortar un fetch subyacente si `promise` viene de algo que soporta `AbortController`). Documentá en el JSDoc que `withTimeout` no cancela la tarea por sí sola — solo dejar de esperarla — y que el caller es responsable de pasar cancelación real si la necesita. Si preferís una implementación más completa donde `withTimeout` reciba directamente un `AbortController` y lo aborte al expirar (en vez de solo la promesa), documentá cuál opción elegiste.

## Hallazgo 2: `parallelMerge`: firma del `scorer` difiere del JSDoc; `first-wins` no es "primero en terminar"
- Líneas ~27 vs ~51, ~78-83.
```js
* @param {Function} opts.scorer - Custom scorer: (result, index) => number (overrides confidence field)
```
```js
const confidence = scorer
  ? scorer(result, task)
  : (result?.confidence ?? 1) * task.weight;
```
- El JSDoc dice `(result, index) => number` pero el código real invoca `scorer(result, task)` — pasa el objeto `task` completo, no el índice numérico. Además, la estrategia `'first-wins'` se documenta/nombra como "primero en terminar" pero como todas las tasks resuelven vía `Promise.all`, en realidad es "primero en orden de array que tuvo éxito", no el más rápido cronológicamente.
- Fix: corregí el JSDoc para que coincida con la implementación real (`scorer: (result, task) => number`), Y corregí/clarificá el nombre o comentario de `'first-wins'` para que describa correctamente su semántica real (primero en orden de array, no primero en completarse) — si el nombre `'first-wins'` es parte de una API pública que no podés renombrar sin romper compatibilidad, dejá el nombre pero corregí el comentario/JSDoc para que sea honesto sobre el comportamiento real.

ARCHIVOS: Toca SOLO `core/parallel.js` y `tests/parallel.test.js`. NO toques el fix previo ya existente (`parallelRace([])`).

DEFINICIÓN DE HECHO:
1. Test o verificación documental (según qué approach elegiste) para el hallazgo 1 — si agregaste soporte de `AbortSignal`/callback, un test que confirma que se invoca al expirar el timeout.
2. Test que confirma que `scorer` en `parallelMerge` recibe efectivamente `(result, task)` como documentado ahora (coherencia código↔doc).
3. Confirmá que el fix previo (`parallelRace([])`) sigue funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-40-parallel-misc-REPORT.md` (qué cambiaste en cada hallazgo, decisiones tomadas, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
