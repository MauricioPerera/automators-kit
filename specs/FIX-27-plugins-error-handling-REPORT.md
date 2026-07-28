# FIX-27 — Error handling en `core/plugins.js`

Archivos tocados: `core/plugins.js`, `tests/plugins.test.js`. Nada más.
Fixes previos (path traversal FIX-05, capability bypass FIX-12) NO se tocaron ni revirtieron.

## Hallazgo 1 — `HookSystem.execute` tragaba excepciones de handlers

**Approach elegido:** opción configurable `opts.throwOnHookError` (default `false`).
No se alteró el tipo de retorno de `execute` (sigue devolviendo el `payload` final),
por lo que es 100% retrocompatible.

Cambio en `core/plugins.js` (`HookSystem.execute`):

```js
async execute(name, payload, opts = {}) {
  const list = this._hooks.get(name);
  if (!list || list.length === 0) return payload;

  const throwOnHookError = opts && opts.throwOnHookError === true;
  let current = payload;
  for (const { fn } of list) {
    try {
      const result = await fn(current);
      if (result !== undefined) current = result;
    } catch (err) {
      console.error(`[Hook] Error in ${name}:`, err.message);
      if (throwOnHookError) {
        throw err; // aborta la cadena; el hook ya no se vuelve aprobación implícita
      }
    }
  }
  return current;
}
```

- Default (`throwOnHookError` ausente / `false`): loguea y continúa la cadena —
  comportamiento previo intacto (retrocompatible).
- `throwOnHookError: true`: re-lanza el error del handler, abortando la cadena
  en ese punto. Los handlers posteriores (prioridad mayor) NO se ejecutan.
  Un hook de validación que lanza para BLOQUEAR una operación ahora efectivamente
  la bloquea, en vez de ser tragado como aprobación tácita.

## Hallazgo 2 — `loadPlugins` tragaba fallos de carga de plugins

Cambio en `core/plugins.js` (`loadPlugins`, bloque `catch`):

```js
} catch (err) {
  console.error(`[Plugins] Failed to load '${name}':`, err.message);
  if (pluginConfig.required === true) {
    throw new Error(`Required plugin '${name}' failed to load: ${err.message}`, { cause: err });
  }
}
```

- Default (`required` ausente / `false`): solo loguea y el arranque continúa —
  comportamiento previo intacto (retrocompatible).
- `required: true`: `loadPlugins` lanza (rechaza la promesa) con contexto del
  plugin que falló y por qué (mensaje original preservado en `cause`), abortando
  el arranque en vez de arrancar degradado sin señal visible.

## Tests agregados (`tests/plugins.test.js`)

Bloque `HookSystem — error propagation (FIX-27)`:
1. `with throwOnHookError, a throwing hook aborts the chain and re-throws` —
   verifica que `execute(..., { throwOnHookError: true })` rechaza con el error
   del handler y que los handlers posteriores no corren (HECHO #1).
2. `default behavior (no opts) still logs and continues — backward compatible` —
   sin la opción, la cadena sobrevive (HECHO #2).
3. `throwOnHookError: false explicitly keeps swallowing` — explícito `false`
   también traga (retrocompatible).

Bloque `loadPlugins — required plugin failures (FIX-27)`:
4. `a required local plugin that fails to import makes loadPlugins throw` —
   `{ required: true, path: '...' }` con import fallido => `loadPlugins` rechaza
   con `/Required plugin 'critical' failed to load/` y no registra el plugin (HECHO #3).
5. `a non-required plugin that fails is only logged; boot continues` — sin
   `required`, `loadPlugins` resuelve y continúa (HECHO #4).
6. `required: false explicitly keeps the old swallow-and-continue behavior` —
   explícito `false` también traga (retrocompatible).

## Fixes previos verificados (HECHO #5)

Los tests de `createPluginAPI — capability bypass fixes (FIX-12)` y
`loadPlugins — local path traversal guard (FIX-05)` corrieron dentro del bloque
de `plugins.test.js` (28/28 pass). No se rompieron.

## Salida real de `bun test tests/` (HECHO #6, #7)

```
550 pass
1 fail
1177 expect() calls
Ran 551 tests across 21 files. [5.96s]
```

El único fail es `Dream Cycle > dream heuristic merges duplicates` en
`tests/memory.test.js` — el flaky preexistente y conocido, no relacionado con
este cambio. **0 fallos nuevos respecto al baseline.**