CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría encontró 2 hallazgos MEDIUM en `core/workflow.js` que te tocan a vos:

## Hallazgo 1: `masterKey` por defecto débil para el vault de credenciales
- Línea ~40.
```js
this._vault = new CredentialVault(db, opts.masterKey || 'default-key');
```
- Si no se pasa `masterKey`, el vault se inicializa con la clave literal `'default-key'`, pública en el código fuente. Fix: si `opts.masterKey` no está definido, generá una clave aleatoria criptográficamente segura (Web Crypto) por instancia en vez del string hardcodeado — mismo patrón que uses/veas en el fix del JWT secret de `core/cms.js` si querés consistencia (no necesitás leer ese archivo, es solo referencia conceptual). Documentá el trade-off (clave no persistente entre restarts si no se configura explícita).

## Hallazgo 2: `_getFromContext` permite traversal por `__proto__`
- Líneas ~286-316.
```js
_getFromContext(path, context) {
  const parts = path.split('.');
  let current = context;
  for (const p of parts) {
    if (current == null) return undefined;
    current = current[p];
  }
  return current;
}
```
- Una referencia tipo `{{__proto__.constructor.name}}` recorre la cadena de prototipo de `context`. Fix: en el loop, si algún segmento `p` es `__proto__`, `constructor` o `prototype`, retorná `undefined` inmediatamente (no navegues ese segmento) en vez de continuar la resolución.

ARCHIVOS: Toca SOLO `core/workflow.js` y `tests/workflow.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo: crear un `Workflow`/`CredentialVault` sin `opts.masterKey` explícito y confirmar que NO usa la clave hardcodeada `'default-key'` (podés verificar que dos instancias sin masterKey no producen el mismo resultado de cifrado para el mismo input, o que un cifrado hecho a mano con `'default-key'` no coincide con lo que produce la instancia).
2. Test nuevo: `{{__proto__.constructor.name}}` (o el path equivalente que uses para invocar `_getFromContext` directamente si es testeable, o a través de la interpolación pública del workflow) retorna `undefined`/no resuelve a un valor real de la cadena de prototipos.
3. Test que confirma que referencias normales (`{{someField.nested}}`) siguen funcionando igual que antes.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-23-workflow-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
