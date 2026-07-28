CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Ya existe `core/net-guard.js` con `export function assertPublicUrl(rawUrl)` que valida que una URL no apunte a loopback/RFC1918/link-local/metadata cloud y lanza error si es insegura. Reusalo (importalo), NO reimplementes la lógica.

Una auditoría encontró un MEDIUM en `core/connector.js` que te toca a vos:

## Hallazgo: `Connector` no valida destinos internos (SSRF genérico)
- Líneas ~63-75, ~107-112.
```js
url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
...
new URL(url); // validate
...
const response = await fetch(url, { method, headers, body: fetchBody, signal: controller.signal });
```
- `new URL()` solo valida formato, no esquema/host. Un `path` absoluto (`startsWith('http')`) reemplaza el `baseUrl` — si `path` viene de datos externos, hay SSRF. `baseUrl`/`path` no se filtran contra localhost/IPs internas.
- Fix: a diferencia de los otros fixes SSRF ya aplicados en `nodes.js`/`triggers.js`/`a2e.js` (que SIEMPRE bloquean destinos internos porque ahí la URL viene de definiciones de workflow no confiables), este `Connector` es una clase de propósito general que un desarrollador de la app instancia directamente con un `baseUrl` propio (potencialmente legítimo, tipo `http://localhost:PUERTO` para desarrollo local) — bloquear SIEMPRE localhost rompería ese caso de uso legítimo. Por eso: agregá un flag opcional en el constructor/opciones del Connector (p.ej. `opts.blockInternalHosts` o similar, default `false` para no romper retrocompatibilidad) que, cuando esté activado, llama `assertPublicUrl(url)` antes del `fetch`. Documentá en el JSDoc de la clase que los callers que construyan un Connector con `baseUrl`/`path` proveniente de fuentes NO confiables (workflows de usuario, input externo) DEBEN activar ese flag.

ARCHIVOS: Toca SOLO `core/connector.js` y `tests/connector.test.js`. NO toques `core/net-guard.js` (solo importalo).

DEFINICIÓN DE HECHO:
1. Test nuevo: un `Connector` creado CON el flag de bloqueo activado rechaza una request a un destino interno (p.ej. `169.254.169.254`) con error controlado, sin hacer el fetch real.
2. Test nuevo: un `Connector` creado SIN el flag (comportamiento default) sigue permitiendo requests a localhost/destinos internos igual que antes (no rompiste el caso de uso legítimo de desarrollo).
3. Test que confirma que requests a destinos públicos normales siguen funcionando en ambos modos.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-26-connector-ssrf-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
