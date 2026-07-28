CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/mcp.js` YA tiene un fix previo (validación de args + sanitización de usuarios). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS.

Una auditoría encontró un LOW en `core/mcp.js` que te toca a vos:

## Hallazgo: MCP handler de error filtra `err.message` al cliente
- Líneas ~277-282.
```js
} catch (err) {
  send(jsonrpcResponse(id, {
    content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
    isError: true,
  }));
}
```
- El mensaje de error interno se serializa al cliente MCP (el agente) sin sanitización — puede exponer internals (paths, detalles de adapters).
- Fix: logueá `err.message` con `console.error` server-side, y enviá al cliente un mensaje genérico (p.ej. `'Internal error processing tool call'`) en el `content`.

ARCHIVOS: Toca SOLO `core/mcp.js` y el archivo de test correspondiente (`tests/mcp.test.js`, creado por el dev previo). NO toques el fix previo ya existente (validación de args, sanitización de usuarios).

DEFINICIÓN DE HECHO:
1. Test nuevo: un handler de tool que lanza con un mensaje interno específico (p.ej. `"ENOENT /secret/path"`) produce una respuesta de error GENÉRICA (el string interno no aparece en el `content` de la respuesta).
2. Confirmá que el fix previo (validación de args, sanitización de usuarios) sigue funcionando — corré esos tests y no los rompiste.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-34-mcp-error-leak-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
