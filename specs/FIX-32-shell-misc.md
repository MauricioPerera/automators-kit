CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/shell.js` YA tiene 2 fixes previos (RBAC en history/context, prototype pollution en filtro JQ). NO los toques ni reviertas — es tuyo agregar 3 fixes MÁS al mismo archivo.

Una auditoría encontró 3 hallazgos LOW en `core/shell.js` que te tocan a vos:

## Hallazgo 1: `fromARDF` registra comandos desde descriptores externos sin validar `resource_id`
- Líneas ~325-343.
```js
fromARDF(descriptors, handlerFactory) {
  for (const desc of descriptors) {
    if (desc.resource_type !== 'tool') continue;
    const [ns, name] = (desc.resource_id || '').includes(':')
      ? desc.resource_id.split(':')
      : ['imported', desc.resource_id];
    ...
    this.register(ns, name, {...}, handlerFactory ? handlerFactory(desc) : async () => ({ error: 'No handler provided' }));
  }
```
- `ns`/`name` se derivan de `resource_id` sin sanitización (caracteres arbitrarios quedan registrables).
- Fix: validá `resource_id` contra un patrón razonable (p.ej. solo `[a-zA-Z0-9_:-]`) antes de usarlo para derivar `ns`/`name`; si no valida, saltá ese descriptor (con un log/warning) en vez de registrarlo.

## Hallazgo 2: Defaults permissivos: `permissions=['*']` y `profile='admin'` si no se especifica
- Líneas ~358-360.
```js
this.registry = opts.registry || new CommandRegistry();
this.permissions = opts.permissions || ['*'];
this.profile = opts.profile || 'admin';
```
- `new Shell()` sin opciones queda con acceso total y perfil admin — fail-open por defecto.
- Fix: cambiá el default de `profile` a `'restricted'` (fail-closed) cuando no se especifica. Esto es un cambio de comportamiento por defecto — revisá los tests existentes que instancien `Shell` sin `profile` explícito y ajustalos si dependían del default `admin` (agregá `profile: 'admin'` explícito en esos tests si la intención del test era probar comportamiento admin). Documentá en el REPORT cuántos tests tuviste que ajustar y por qué es seguro hacerlo (son tests, no código de producción que dependa del default).

## Hallazgo 3: `shell.exec`/`_execSingle` devuelve `err.message` crudo al caller
- Líneas ~448-449.
```js
} catch (err) {
  return this._response(1, null, err.message, input, start);
}
```
- El mensaje de error interno se refleja tal cual al agente consumidor, pudiendo filtrar detalles internos.
- Fix: en el catch, logueá `err.message` con `console.error` server-side y retorná un mensaje genérico (p.ej. `'Internal command error'`) en `_response`. Ojo: esto podría afectar tests que verifican el mensaje de error específico — ajustalos para verificar el mensaje genérico en vez del original, o agregá una opción de debug/verbose que preserve el detalle si el repo ya tiene un patrón similar (mirá si existe algo como `opts.debug` en la clase).

ARCHIVOS: Toca SOLO `core/shell.js` y `tests/shell.test.js`. NO toques los 2 fixes previos ya existentes (RBAC, JQ pollution).

DEFINICIÓN DE HECHO:
1. Test nuevo: `fromARDF` con un descriptor cuyo `resource_id` tiene caracteres inválidos NO lo registra (o lo registra saneado, documentá cuál).
2. Test nuevo: `new Shell(registry)` sin `profile` explícito tiene `profile === 'restricted'` (no admin).
3. Test nuevo: un handler que lanza con un mensaje interno específico (p.ej. `"ENOENT /secret/path"`) produce una respuesta de error GENÉRICA al caller (el string interno NO aparece en la respuesta).
4. Confirmá que los 2 fixes previos (RBAC, JQ pollution) siguen funcionando — corré esos tests y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline (ajustá tests existentes que dependían de los defaults viejos, documentando el ajuste).
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-32-shell-misc-REPORT.md` (qué cambiaste en cada hallazgo, tests ajustados/agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
