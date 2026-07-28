CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline conocido: 421 pass / 1 fail (`memory.test.js`, timing flaky en `dream()`, PREEXISTENTE y no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró 2 hallazgos CRITICAL que te toca arreglar a vos:

## Hallazgo 1: RCE en nodo `code.run`
- Archivo: core/nodes.js, líneas ~229-250 (definición del nodo `code.run` dentro de `BUILTIN_NODES`)
- El handler usa `new Function(...)` con un denylist de substrings (`process`, `eval`, `Function`, etc.) como "sandbox". Es trivialmente bypaseable: `try { null.x } catch(e) { const F = e.constructor.constructor; const g = F('return glo'+'balThis')(); return g['pro'+'cess'].env }` no contiene ninguna palabra bloqueada y da acceso a `process.env`/RCE total.
- Un denylist de texto NUNCA es una sandbox real (hay demasiadas formas de llegar al constructor de Function sin nombrarlo). Implementar una sandbox real (V8 isolates, worker con permisos restringidos) está FUERA de tu scope — es un cambio de arquitectura grande.
- Tenés 2 opciones válidas, elegí la que rompa menos el resto del repo (mirá cómo se usa `code.run` en tests/nodes.test.js e integration.test.js antes de decidir):
  (a) Eliminar el nodo `code.run` de `BUILTIN_NODES` (con un comentario corto explicando por qué, sin exponer detalles del exploit).
  (b) Dejarlo pero quitar el denylist falso y documentar explícitamente (en el JSDoc del nodo y en README.md/AGENTS.md si mencionan `code.run`) que ejecuta código NO sandboxeado y solo debe usarse con definiciones de workflow de fuentes confiables — igual que un `eval` documentado, no fingir seguridad que no existe.
  NO inventes una tercera opción de sandbox custom "casera" (regex más estricto, otro denylist) — ambas fallan igual.

## Hallazgo 2: SSRF sin validar destino
- Archivo: core/nodes.js, `_executeApi` (líneas ~114-165) — usa `fetch(url, ...)` donde `url = interpolate(node.url || inputs.url, ...)`, sin validar el destino.
- Archivo: core/triggers.js, poller (líneas ~56-81) — `fetch(trigger.config.url, ...)` dentro de un `setInterval`, mismo problema pero persistente (se repite cada `interval` ms).
- Ambos permiten que una definición de workflow (controlada por quien la arma, no necesariamente confiable) haga que el SERVIDOR golpee `http://169.254.169.254/latest/meta-data/...` (cloud metadata) o `http://localhost:PUERTO/...` (servicios internos).
- Fix: creá un helper reusado por AMBOS archivos (nuevo archivo `core/net-guard.js`, exportá algo como `assertPublicUrl(url)` que tire error si el host resuelve a loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254.0.0/16, fe80::/10), o el esquema no es http/https. Usalo ANTES de cada `fetch` en `_executeApi` (nodes.js) y en el poller (triggers.js).
- Ojo: NO necesitás resolución DNS real (evitá timing/complejidad); validar el hostname/IP literal en la URL alcanza para el fix — si querés ir más allá con resolución DNS real, documentalo como mejora futura en el REPORT, no es requisito.

ARCHIVOS: Toca SOLO `core/nodes.js`, `core/triggers.js`, `core/net-guard.js` (nuevo), y `tests/nodes.test.js` + `tests/triggers.test.js` (para agregar los tests de regresión). NO toques `core/a2e.js`, `core/db.js`, `core/portable-text.js`, `core/plugins.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/nodes.test.js que reproduce el RCE original (o confirma que `code.run` ya no existe / ya no ejecuta con new Function sin advertencia) y falla ANTES del fix / pasa DESPUÉS.
2. Test nuevo en tests/nodes.test.js que confirma que `_executeApi`/`http.request` rechaza una URL a `169.254.169.254` o `127.0.0.1` con error controlado (no cuelga, no hace el fetch real).
3. Test nuevo en tests/triggers.test.js que confirma que el poller rechaza/no registra un trigger con `config.url` apuntando a un destino interno.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline (421 pass / 1 fail conocido en memory.test.js).
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia — el veredicto es la suite, no un contrato).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No loguees secretos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima documentable (p.ej. tests existentes dependen de que `code.run` ejecute código arbitrario y quitarlo rompe una feature documentada que no podés resolver sin decisión de producto) → PARÁ, documentalo con evidencia en el REPORT y respondé BLOQUEADO + 1 línea. No inventes tests ni fuerces el HECHO.

ENTREGA: `specs/FIX-01-rce-ssrf-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test, trade-offs — en particular cuál de las 2 opciones de code.run elegiste y por qué). Al terminar respondé SOLO: LISTO + 1 línea.
