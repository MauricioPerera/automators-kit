CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/a2e.js` YA tiene 2 fixes previos (guard de profundidad de recursión + SSRF en ApiCall/ExecuteN8nWorkflow). NO los toques ni reviertas — es tuyo agregar 3 fixes MÁS al mismo archivo. Es una tarea grande con 3 sub-hallazgos de dificultad DISTINTA — priorizalos en este orden (2 y 3 son más chicos y seguros, 1 es más grande/riesgoso).

## Hallazgo 2 (hacé este primero — más chico): `CacheMiddleware` cachea en `processConfig` pero nunca restaura el resultado
- Líneas ~721-739.
```js
processConfig(config, opType) {
  const key = `${opType}:${JSON.stringify(config)}`;
  const cached = this._cache.get(key);
  if (cached && Date.now() - cached.ts < this._ttl) {
    this.hits++;
    config._cached = cached.result;
  } else {
    this.misses++;
  }
  return config;
}
processResult(result, opType) {
  return result;
}
```
- El "hit" marca `config._cached` pero nada lo usa; `processResult` nunca guarda nada en `this._cache`. La feature de cache está completamente rota — no cachea nada.
- Fix: en `processResult`, guardá `this._cache.set(key, {result, ts: Date.now()})` (necesitarás la misma `key` que se calculó en `processConfig` — mirá cómo pasar ese dato entre ambos hooks, probablemente vía el propio `config` o una estructura de instancia). En `processConfig`, cuando hay un hit válido, el mecanismo debe hacer que el handler NO se ejecute y se use el resultado cacheado directamente — mirá cómo `_executeOp` en la clase principal consume `config._cached` (si no lo consume actualmente, puede que necesites tocar también cómo el middleware se engancha ahí, pero NO toques la lógica de `_executeOp` que ya tiene el guard de profundidad — solo lo estrictamente necesario para que el cache funcione).

## Hallazgo 3 (segundo — chico): ReDoS vía `RegExp` construido con input de usuario
- Líneas ~364-371, ~388-390.
```js
const re = new RegExp(config.pattern, config.flags || 'g');
```
```js
case 'custom': {
  const re = new RegExp(config.pattern || '.*');
```
- `config.pattern`/`config.flags` vienen de la definición de operación sin límite. Patrones catastróficos cuelgan el event loop.
- Fix: agregá el mismo tipo de guard usado en `core/db.js` y `core/vector.js` para `$regex` (límite de longitud de patrón + heurística de cuantificadores anidados tipo `(x+)+`) ANTES de construir el `RegExp`. Si preferís reusar lógica compartida creando un helper, hacelo DENTRO de `core/a2e.js` (no toques `core/db.js`/`core/vector.js`, cada uno tiene su propia implementación ya hecha por otros devs).

## Hallazgo 1 (último — más grande, con cláusula de honestidad): El DAG ignora dependencias dinámicas (Conditional/onError) → carrera en ejecución paralela
- Líneas ~80-96 (`buildDAG`), ~575-585 (ejecución por niveles).
```js
const refs = configStr.match(/\/workflow\/([a-zA-Z0-9_-]+)/g) || [];
...
if (op.onError === depId) continue;   // se salta onError como dependencia
```
```js
for (const level of levels) {
  await Promise.all(level.map(opId => this._executeOp(opId, executionId)));
}
```
- `buildDAG` excluye deliberadamente las referencias `onError` y no modela las ramas de `Conditional` como aristas del grafo. El executor paralelo puede correr un op que depende de la salida de un `Conditional`/`onError` antes de que ese predecesor real haya resuelto, dando lecturas de `state` inconsistentes (`undefined` silencioso).
- Fix: modelá `onError` como una arista de dependencia real en `buildDAG` (no la excluyas), y para `Conditional`, agregá como dependencia cualquier op que la rama `ifTrue`/`ifFalse` pueda ejecutar (si es determinable estáticamente desde `config`). Si el modelado completo resulta demasiado complejo dado el tiempo disponible, una alternativa más simple y segura: ejecutá los ops de tipo `Conditional` y cualquier op con `onError` configurado de forma SECUENCIAL (no en el `Promise.all` paralelo del nivel), incluso si eso reduce el paralelismo — es más conservador y evita la carrera sin necesitar modelar el grafo completo. Documentá cuál approach tomaste.

ARCHIVOS: Toca SOLO `core/a2e.js` y `tests/a2e.test.js`. NO toques los 2 fixes previos ya existentes (profundidad de recursión, SSRF).

DEFINICIÓN DE HECHO (por hallazgo):
1. (Hallazgo 2) Test que confirma que una segunda ejecución idéntica de una operación cacheada usa el resultado cacheado (podés verificar que el handler subyacente NO se vuelve a invocar la segunda vez — con un contador/spy si el patrón de test lo permite).
2. (Hallazgo 3) Test que confirma que un patrón catastrófico en `config.pattern` es rechazado antes de compilar el regex, con timeout bajo en el test (2000ms) para que un fix roto falle rápido.
3. (Hallazgo 1) Test que confirma que un op dependiente de la rama de un `Conditional` (o de un `onError`) SIEMPRE ve el estado ya actualizado cuando se ejecuta (no una condición de carrera) — el test concreto depende del approach que elegiste, documentalo.
4. Confirmá que los 2 fixes previos siguen funcionando — corré esos tests y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI (por hallazgo individual): si el Hallazgo 1 (DAG) resulta demasiado complejo incluso con el approach simplificado (secuencial en vez de modelado completo), documentalo como PARCIAL/BLOQUEADO en el REPORT con evidencia, pero COMPLETÁ los hallazgos 2 y 3 igual — no dejes la tarea entera bloqueada por el más difícil.

ENTREGA: `specs/FIX-24-a2e-dag-cache-redos-REPORT.md` (qué cambiaste en cada uno de los 3 hallazgos, decisiones tomadas, tests agregados, salida real de bun test, y cuál quedó parcial si aplica). Al terminar respondé SOLO: LISTO + 1 línea con el resumen de los 3.
