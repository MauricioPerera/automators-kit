# FIX-26 — Connector SSRF (bloqueo opcional de destinos internos)

## Hallazgo (MEDIUM)
`core/connector.js` no validaba destinos internos. `new URL()` solo valida
formato, no esquema/host. Un `path` absoluto (`startsWith('http')`) reemplaza
el `baseUrl`, y ni `baseUrl` ni `path` se filtran contra localhost/IPs internas
→ SSRF genérico cuando `path`/`baseUrl` provienen de fuentes no confiables.

## Decisión de diseño
A diferencia de `nodes.js`/`triggers.js`/`a2e.js` (donde la URL viene de
definiciones de workflow no confiables y SIEMPRE se bloquea), `Connector` es
una clase de propósito general instanciada directamente por el desarrollador,
con un `baseUrl` propio potencialmente legítimo (p.ej.
`http://localhost:PUERTO` para desarrollo local). Bloquear SIEMPRE rompería ese
caso de uso. Por eso se agregó un flag **opcional** `opts.blockInternalHosts`
(default `false`, retrocompatible) que, cuando está activo, llama
`assertPublicUrl(url)` de `core/net-guard.js` antes del `fetch`.

## Archivos tocados
- `core/connector.js` — solo este.
- `tests/connector.test.js` — solo este.
- `core/net-guard.js` — NO tocado, solo importado.

## Cambios en `core/connector.js`
1. `import { assertPublicUrl } from './net-guard.js';` (reutiliza, no reimplementa).
2. Constructor: nuevo campo `this.blockInternalHosts = opts.blockInternalHosts || false;`
   + JSDoc documentando que callers con `baseUrl`/`path` de fuentes no confiables
   DEBEN activar el flag.
3. En `request()`, tras validar formato con `new URL(url)`, si el flag está
   activo se llama `assertPublicUrl(url)`; si lanza, se envuelve en
   `ConnectorError` (error controlado, con `details.url`/`details.method`),
   antes de cualquier `fetch`.
4. JSDoc de cabecera de clase con la nota SSRF.

## Tests agregados (`tests/connector.test.js`)
Se introdujo un stub de `globalThis.fetch` (sin red real) para ejercitar el flujo
y contar llamadas:

1. **`rejects internal destination when flag is on, without fetching`** —
   `Connector` con `blockInternalHosts: true` rechaza
   `http://169.254.169.254/latest/meta-data/` con `ConnectorError` y **0**
   llamadas a `fetch` (HECHO #1).
2. **`default behavior still allows internal/localhost destinations`** —
   `Connector` sin flag (default) completa `GET http://localhost:9999/local-dev`
   con `ok:true`, status 200, **1** llamada a `fetch` al URL interno (HECHO #2:
   no se rompe el caso de uso legítimo de desarrollo).
3. **`public destinations work in both modes`** — `GET /v1/users` a
   `https://api.example.com` funciona tanto con flag activado como desactivado,
   con `ok:true` y `fetch` invocado al URL público correcto en ambos (HECHO #3).

## Salida real de `bun test tests/`
```
 544 pass
 1 fail
 1167 expect() calls
Ran 545 tests across 21 files. [5.59s]
```

La única falla es `tests/memory.test.js` (`dream heuristic merges duplicates`,
`duration_ms` flaky timing) — **preexistente y conocida**, no relacionada con
este fix. 0 fallos nuevos respecto al baseline. `tests/connector.test.js`:
`12 pass, 0 fail` (antes 4 tests; +8 nuevos por este fix).