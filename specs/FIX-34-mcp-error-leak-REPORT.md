# FIX-34 — MCP tool-error message leak (LOW)

## Hallazgo
`core/mcp.js` serializaba `err.message` al cliente MCP (el agente) sin
sanitización en el catch del loop stdio (y, por propagación, en el dispatcher
`handleMCPRequest` que dejaba escapar los errores del handler). Esto podía exponer
internals: paths de filesystem, detalles de adapters, stack info.

## Qué cambié (solo `core/mcp.js` + `tests/mcp.test.js`)
1. **Constante genérica** `TOOL_INTERNAL_ERROR_MESSAGE = 'Internal error processing tool call'`
   (cerca de `rpcToolError`).
2. **`handleMCPRequest` — case `tools/call`**: envolví `await tool.handler(args)`
   en `try/catch`. En catch: `console.error` server-side con el mensaje real
   (`[mcp] tool '<name>' failed: <err.message>`) + retorno
   `rpcToolError(id, TOOL_INTERNAL_ERROR_MESSAGE)`. El `err.message` ya NO viaja
   en el `content` del response.
3. **Loop stdio** (`createMCPServer`, catch externo): ahora loguea
   `console.error('[mcp] dispatch error: <err.message>')` y envía al cliente el
   mensaje genérico en lugar de `err.message`. (Defensivo: el dispatcher ya
   atrapa los handler errors; este catch cubre cualquier otra cosa que escape.)

### NO tocado
- Fix previo (validación de args con `validateToolArgs` + sanitización de
  usuarios con `sanitizeUser` / `SENSITIVE_USER_KEYS`): intacto, sin revertir.

## Tests agregados
- `MCP tool error sanitization > returns a generic error and does NOT leak the
  internal err.message`: registra un tool `boom` cuyo handler lanza
  `throw new Error('ENOENT /secret/path')` y verifica que:
  - `res.result.isError === true`
  - el `content[0].text` NO contiene `'ENOENT /secret/path'` ni `'/secret/path'`
  - el body parseado tiene `error` matcheando `/internal error processing tool call/i`

(13 tests en `tests/mcp.test.js`: 12 previos + 1 nuevo, todos pasan.)

## Salida REAL de `bun test tests/`
```
bun test v1.3.14 (0d9b296a)

tests\mcp.test.js:
[mcp] tool 'boom' failed: ENOENT /secret/path
 13 pass
 0 fail
 58 expect() calls

...

 585 pass
 1 fail
 1272 expect() calls
Ran 586 tests across 21 files. [5.88s]
```

El único `fail` es `tests/memory.test.js:320` — `Dream Cycle > dream heuristic
merges duplicates` (`expect(report.duration_ms).toBeGreaterThan(0)` recibió `0`).
Es el flaky de timing preexistente, NO relacionado con este fix.

## Verificación del HECHO
1. ✅ Test nuevo: handler que lanza `"ENOENT /secret/path"` → respuesta de error
   GENÉRICA; el string interno NO aparece en el `content`.
2. ✅ Fix previo (validación de args + sanitización de usuarios) sigue funcionando
   — sus 12 tests pasan sin cambios.
3. ✅ `bun test tests/`: 0 fallos nuevos respecto al baseline
   (baseline 570/569/1 fail → ahora 586/585/1 fail mismo memory flaky; +16 tests
   por el test nuevo de MCP y por tests agregados por el dev previo ya en el
   árbol, sin nuevos fallos).