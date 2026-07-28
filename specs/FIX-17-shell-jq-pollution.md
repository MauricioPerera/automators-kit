CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/shell.js` YA tiene un fix previo (RBAC en `history`/`context`). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS, en zona distinta (el filtro JQ multi-select).

Una auditoría encontró un MEDIUM en `core/shell.js` que te toca a vos:

## Hallazgo: Prototype pollution vía filtro JQ multi-select con clave `__proto__`
- Líneas ~166-175.
```js
// Multi-select: [.a, .b, .c]
if (expression.startsWith('[') && expression.endsWith(']')) {
  const fields = expression.slice(1, -1).split(',').map(f => f.trim());
  const result = {};
  for (const f of fields) {
    const key = f.replace(/^\./, '');
    result[key] = resolvePath(data, key);
  }
  return result;
}
```
- `key` viene de la expresión de filtro (controlada por usuario). Para `key === '__proto__'`, `result[key] = ...` dispara el setter de `Object.prototype.__proto__` sobre `result`, reasignando su prototipo. Si `data` es controlado por el atacante y su `__proto__` tiene propiedades maliciosas, `result` las hereda. No contamina `Object.prototype` global, pero sí el objeto resultado que baja por el pipeline (un consumidor que haga `if (result.algo)` con fallback puede ser engañado).
- Fix: usá `Object.create(null)` para `result` en vez de `{}`, O rechazá/saltá claves `__proto__`/`constructor`/`prototype` antes de asignar. Elegí la opción que rompa menos el resto del código (si algo después espera que `result` tenga métodos de `Object.prototype` como `.hasOwnProperty`, `Object.create(null)` podría romperlo — mirá el código que consume el resultado de este filtro antes de decidir).

ARCHIVOS: Toca SOLO `core/shell.js` y `tests/shell.test.js`. NO toques el fix de RBAC ya existente (`history`/`context` gating).

DEFINICIÓN DE HECHO:
1. Test nuevo: aplicar el filtro multi-select `[__proto__]` (o equivalente) sobre un `data` con `data.__proto__ = { polluted: true }` NO hace que el `result` retornado herede `polluted` de forma explotable, ni contamina `Object.prototype` global (`({}).polluted === undefined` después).
2. Test que confirma que el multi-select normal (`[.a, .b, .c]` con campos legítimos) sigue funcionando igual que antes.
3. Confirmá que el fix de RBAC existente (`history`/`context`) sigue funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix RBAC existente.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-17-shell-jq-pollution-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
