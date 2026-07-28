CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/plugins.js` YA tiene 2 fixes previos (path traversal en plugins locales + bypass de capability de escritura). NO los toques ni reviertas — es tuyo agregar 2 fixes MÁS al mismo archivo, en zonas relacionadas pero distintas (manejo de errores).

Una auditoría encontró 2 hallazgos MEDIUM en `core/plugins.js` que te tocan a vos:

## Hallazgo 1: `HookSystem.execute` traga excepciones de handlers silenciosamente
- Líneas ~54-60.
```js
for (const { fn } of list) {
  try {
    const result = await fn(current);
    if (result !== undefined) current = result;
  } catch (err) {
    console.error(`[Hook] Error in ${name}:`, err.message);
  }
}
```
- Un hook que lanza (p.ej. un hook de validación que debería BLOQUEAR una operación) se ignora silenciosamente — la operación sigue como si el hook hubiera aprobado.
- Fix: agregá una opción configurable (p.ej. `opts.throwOnHookError`, default `false` para no romper retrocompatibilidad con hooks existentes que puedan fallar sin ser críticos) que, cuando está activada, hace que `execute` RE-LANCE el error del hook (abortando la cadena) en vez de tragarlo. Alternativa complementaria si preferís no romper nada por default: siempre acumulá los errores capturados en un array y devolvé (o expongas de alguna forma, mirá qué devuelve `execute` actualmente) tanto el `current` resultante como los `errors` recolectados, para que el caller PUEDA decidir si abortar — documentá cuál approach elegiste.

## Hallazgo 2: `loadPlugins` traga fallos de carga de plugins silenciosamente
- Líneas ~282-319.
```js
try {
  let pluginModule;
  if (pluginConfig.source === 'local' && pluginConfig.path) {
    pluginModule = await import(resolvedPath);
  } else { pluginModule = await import(name); }
  ...
  console.log(`[Plugins] Loaded: ${name} v${definition.version || '1.0.0'}`);
} catch (err) {
  console.error(`[Plugins] Failed to load '${name}':`, err.message);
}
```
- Si un plugin crítico falla al importar/inicializar, solo se loguea y el arranque continúa sin señal visible más allá del log.
- Fix: soportá un campo `pluginConfig.required` (booleano, default `false`/undefined = comportamiento actual sin cambios). Si un plugin con `required: true` falla al cargar, `loadPlugins` debe LANZAR (abortar el arranque) en vez de solo loguear — propagá el error hacia arriba con contexto claro de qué plugin falló y por qué.

ARCHIVOS: Toca SOLO `core/plugins.js` y `tests/plugins.test.js`. NO toques los 2 fixes previos ya existentes (path traversal, capability bypass).

DEFINICIÓN DE HECHO:
1. Test nuevo: con `throwOnHookError` activado (o el mecanismo equivalente que elegiste), un hook que lanza hace que `execute` propague/reporte el error en vez de tragarlo silenciosamente.
2. Test nuevo: sin esa opción (default), el comportamiento actual (loguear y continuar) sigue igual — no rompiste retrocompatibilidad.
3. Test nuevo: `loadPlugins` con un plugin `{ required: true, path: '...' }` que falla al importar hace que `loadPlugins` LANCE (o rechace la promesa) en vez de solo loguear.
4. Test nuevo: un plugin sin `required` (o `required: false`) que falla sigue comportándose como antes (solo log, arranque continúa).
5. Confirmá que los 2 fixes previos (path traversal, capability bypass) siguen funcionando — corré esos tests y no los rompiste.
6. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
7. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-27-plugins-error-handling-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
