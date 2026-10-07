# FIX-11 — SSRF en `core/a2e.js` (`ApiCall` y `ExecuteN8nWorkflow`)

> Seguimiento local 2026-10-07: el cambio (b) original no impedía filtrar la
> clave del servidor. Se rectifica abajo y se documentan la corrección del
> primer destino, los redirects y la evidencia nueva al final del informe.
> El scope y los resultados originales siguientes son históricos.

**Scope:** `core/a2e.js` y `tests/a2e.test.js` únicamente. No se tocó el guard de profundidad de recursión preexistente (`this.maxDepth` / `depth` en `_executeOp`), ni `core/nodes.js`, `core/triggers.js`, `core/net-guard.js`, `core/plugins.js`. Se importó y reusó `assertPublicUrl` de `core/net-guard.js` sin reimplementar lógica.

## Verificación del código real vs. evidencia de auditoría

El código real coincide con la evidencia del reporte (con la salvedad ya advertida del bug de copy-paste: en el código real las variables son `n8nUrl` y `apiKey`, no dos `const n8nUrl`). Líneas confirmadas antes de editar:

- `handleApiCall` (~167–184): `const url = resolvePath(state, config.url);` → `await fetch(url, opts)`.
- `handleExecuteN8nWorkflow` (~186–197):
  - `const n8nUrl = config.n8nUrl || process.env.N8N_URL || 'http://localhost:5678';`
  - `const apiKey = config.n8nApiKey || process.env.N8N_API_KEY || '';`  ← **patrón exacto que describe el reporte: la key SÍ se tomaba de `config.n8nApiKey`**.
  - `await fetch(`${n8nUrl}/api/v1/workflows/${config.workflowId}/run`, { headers: { 'X-N8N-API-KEY': apiKey, ... } })`

No hubo discrepancia sustancial. No se abortó.

## Hallazgo 1 — SSRF + API key configurable en `ExecuteN8nWorkflow`

### Cambio (a): validación de `n8nUrl` con `assertPublicUrl`
Se agregó `assertPublicUrl(n8nUrl);` **antes** del `fetch`. Si `n8nUrl` apunta a loopback / RFC1918 / link-local / metadata cloud (p.ej. `169.254.169.254`), se lanza un error controlado que el executor captura y registra en `errors[opId]`; el `fetch` nunca se ejecuta.

**Decisión sobre la tensión localhost:** el default histórico era `http://localhost:5678`, que `assertPublicUrl` bloquea (hostname `localhost`). Elegí **bloquear siempre** (sin allowlist) por dos razones:
1. El instructivo pide reusar `assertPublicUrl` y no reimplementar lógica; un allowlist de excepción sería lógica nueva fuera de `net-guard` (scope creep) y requeriría tocar `core/net-guard.js`, que está fuera de mi scope.
2. El vector de seguridad es justamente que un `n8nUrl` controlado por el atacante no alcance servicios internos; permitir localhost por config reabre el vector SSRF que se está cerrando.

**Trade-off documentado para operadores legítimos:** quien despliegue un n8n co-ubicado en localhost ya no podrá usar el default ni apuntar a `localhost`/`127.0.0.1`. Deberá exponer n8n tras una URL pública (o un hostname público que el operador controle) y setear `N8N_URL`. Es un cambio de comportamiento intencional y documentado; no se consideró abortar porque el fix sigue siendo alcanzable y el allowlist era opcional ("tu decisión, documentala").

### Cambio (b): la API key ya no se toma de `config.*`
Se cambió:
```js
const apiKey = config.n8nApiKey || process.env.N8N_API_KEY || '';
```
por:
```js
const apiKey = process.env.N8N_API_KEY || '';
```
El campo `config.n8nApiKey` deja de ser leído, pero **esto no impide filtrar la clave del servidor**: en el commit `727ac0e1857df07a9fd60952775cd1291a408051`, el primer request todavía adjunta `N8N_API_KEY` de env al `config.n8nUrl` elegido por el caller. La afirmación anterior de confidencialidad era incorrecta. Además, `safeFetch` no retiraba `X-N8N-API-KEY` en redirects entre orígenes. Ambos caminos requieren corrección; ver el seguimiento al final.

## Hallazgo 2 — SSRF en `ApiCall`

Se agregó `assertPublicUrl(url);` **antes** del `await fetch(url, opts)`. `config.url` puede ser un literal o resolverse desde `state` (posiblemente de un trigger externo); con el guard, un destino interno bloqueado lanza error controlado y no se realiza el `fetch`. Mismo vector y mismo guard que `core/nodes.js`.

## Tests agregados (`tests/a2e.test.js`)

Se instaló un helper `installFetchSpy()` que reemplaza `globalThis.fetch` por un spy que registra llamadas y devuelve una respuesta sintética, restaurando el original al terminar. Así se prueba tanto el rechazo (el spy **no** es llamado) como el camino permitido (el spy sí es llamado).

1. **`ApiCall` rechaza destino interno `169.254.169.254` sin hacer fetch** — `errors.api` contiene `net-guard` y `spy.calls.length === 0`.
2. **`ApiCall` permite destino público y hace el fetch** — `https://example.com` pasa el guard, `spy.calls.length === 1`. (Test de no-regresión del comportamiento legítimo.)
3. **`ExecuteN8nWorkflow` rechaza `n8nUrl` interno `169.254.169.254` sin fetch** — `errors.wf` contiene `net-guard`, `spy.calls.length === 0`.
4. **`ExecuteN8nWorkflow` rechaza el default `localhost:5678`** (cuando no hay `n8nUrl`/`N8N_URL`) — documenta el cambio de comportamiento del default; `errors.wf` contiene `net-guard`, sin fetch.
5. **`config.n8nApiKey` ya no se usa como fuente de key** — con `n8nApiKey: 'LEAKED-KEY'` en config y sin `N8N_API_KEY` en env, el header `X-N8N-API-KEY` enviado es `''`, no `'LEAKED-KEY'`.
6. **`N8N_API_KEY` de env sí se usa con `n8nUrl` público** — no-regresión: el header enviado es `'env-secret'`.

Los tests que mutan `process.env` (`N8N_API_KEY`, `N8N_URL`) usan `beforeEach`/`afterEach` para dejar el entorno como estaba.

## Guard de profundidad de recursión (preexistente) — no tocado

No se modificó `this.maxDepth`, el parámetro `depth` de `_executeOp`, ni los tests del bloque `Recursion depth guard`. Se corrieron y siguen pasando (3/3), confirmando que el fix no rompió el guard.

## Salida real de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom

tests\memory.test.js:
315 |     expect(mem.stats().episodic).toBe(4);
316 |
317 |     // Dream without LLM (heuristic mode)
318 |     const report = await mem.dream();
319 |
320 |     expect(report.duration_ms).toBeGreaterThan(0);
                                     ^
error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received: 0

      at <anonymous> (<checkout>/tests/memory.test.js:320:32)
(fail) Dream Cycle > dream heuristic merges duplicates [0.85ms]

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: <temp>/akit-plugins-outside-WssMvw/evil.js

 475 pass
 1 fail
 936 expect() calls
Ran 476 tests across 20 files. [4.32s]
```

**Resumen:** 475 pass, 1 fail. El único fail es `memory.test.js` ("dream heuristic merges duplicates", `duration_ms` = 0) — el fallo preexistente y conocido de timing flaky, no relacionado con este fix y excluido del baseline. **0 fallos nuevos** respecto al baseline. Los 7 tests nuevos de SSRF pasan (a2e.test.js solo: 39 pass, 0 fail).

## Seguimiento local: clave del servidor vinculada al origen (2026-10-07)

Base verificada: `master` en `727ac0e1857df07a9fd60952775cd1291a408051`.
Rama de corrección: `fix/a2e-n8n-key-origin`, preparada en un clon aislado.
Los cambios ajenos del checkout existente se conservaron.

### Decisión y contrato de credenciales

El único origen autorizado para recibir la clave del servidor es el de
`N8N_URL` del **entorno del servidor**. `config.n8nUrl` sigue eligiendo un
destino público, pero no crea confianza. Se valida y compara el origen del
request completo, usando el parser URL y `assertPublicUrl` existentes:
esquema, hostname normalizado y puerto efectivo. Los paths no son una
frontera de confianza. Puertos predeterminados explícitos y cambios de
mayúsculas del hostname equivalen al mismo origen; un subdominio, otro
puerto o un cambio HTTP/HTTPS son orígenes distintos.

| Configuración / destino | Resultado |
| --- | --- |
| `N8N_URL` público válido + clave, destino del mismo origen | POST con `X-N8N-API-KEY` del servidor |
| Destino público de otro origen | POST sin esa cabecera |
| Falta `N8N_URL`, es vacío o inválido, y caller da URL pública | POST sin esa cabecera, incluso si existe clave |
| Falta clave, con destino público permitido | POST sin esa cabecera |
| Falta URL de caller y servidor | El default localhost sigue bloqueado por el guard |
| Destino interno, esquema no permitido o DNS interno | Error del guard antes del fetch de ese destino |
| Redirect dentro del mismo origen | Conserva la cabecera y el comportamiento de método/body existente |
| Redirect a otro origen | Retira la cabecera, sin volver a adjuntarla aunque la cadena regrese al origen inicial |

Omitir la cabecera cuando no hay autorización conserva las solicitudes
públicas sin clave ya permitidas. El servidor remoto puede rechazar una
solicitud sin autenticar; no se inventa un fallback que envíe la clave.
Un operador que configure explícitamente un origen HTTP puede autorizarlo,
como antes; no se impone HTTPS a ese contrato. Una redirección HTTPS a HTTP
cambia de origen y pierde la cabecera.

### Archivos y alcance

- `core/a2e.js`: vincula la clave a `N8N_URL` del servidor antes del primer
  envío. Solo usa `N8N_API_KEY` del entorno; no incorpora credenciales de
  `config.*` ni una integración con vault inexistente en este handler.
- `core/net-guard.js`: añade `x-n8n-api-key` a la lista existente de
  cabeceras retiradas en redirects entre orígenes, sin alterar el guard
  DNS/SSRF ni el algoritmo de redirects. Este cambio de una línea amplía el
  scope histórico de FIX-11 para cerrar el segundo camino pedido en este
  seguimiento; protege también a otros callers de `safeFetch` que usen la
  misma cabecera como objeto de headers.
- `tests/a2e.test.js` y `tests/net-guard.test.js`: 45 casos nuevos; se
  ajustan las expectativas antiguas de cabecera vacía y de envío de la
  clave a cualquier URL pública sin `N8N_URL`. Esta última codificaba el
  defecto, y ahora exige autorización del origen por el servidor.
- Este informe rectifica la afirmación incorrecta del cambio (b).

Las rutas públicas de A2E, la autenticación global, el guard de recursión,
la resolución de payload y el formato de respuestas siguen sus contratos.
La validación DNS y la validación por cada hop siguen pasando por
`safeFetch`. No se añade dependencia ni configuración de producción.

Se leyeron `AGENTS.md` y el spec/report de FIX-11. No existen
`.agents/skills`, contratos `knowledge/contracts/` ni un validador
determinista aplicable a FIX-11 en este pin. `AGENTS.md` conserva KDD como
metodología externa para contratos específicos de otras integraciones.
No se crearon ni adoptaron nuevas bases metodológicas ni contratos KDD.

### Evidencia reproducible sin servicios externos

Los tests pertinentes inyectan tanto `fetch` como DNS mediante
`_setDnsModuleForTests`, y restauran ambos al terminar. Solo usan claves
ficticias (`fake-server-key`, `fake-caller-key`, `fake-n8n-key`). Cubren
primer origen distinto, puertos predeterminados y distintos, esquemas,
hostname engañoso, configuración ausente/inválida, todos los redirects
301/302/303/307/308, cadenas que salen y regresan, y bloqueo DNS/interno.
Los tests del guard prueban casing de cabecera y que no se mutan los
headers entregados por el caller.

El runner local `../evidence/offline-preload.js` elimina las variables
N8N y `POSTGRES_TEST_URL` antes de importar tests, sustituye también el
import DNS lazy y bloquea fetch externo. El fetch nativo queda limitado
a loopback, donde la suite crea sus propios servidores mock, y no sigue
redirects automáticamente. No se leyó ni usó
ninguna clave real, `.env` o dato de producción. No hubo requests a n8n,
servicios externos de prueba ni Postgres real.

Resultados reales (salidas completas preservadas como evidencia local;
las rutas de máquina del log histórico se omitieron de este informe):

```text
Baseline, core y tests originales:
bun test --preload ../evidence/offline-preload.js tests/
 1458 pass
 5 skip
 0 fail
 3689 expect() calls
Ran 1463 tests across 85 files. [54.82s]

Regresiones actualizadas contra el core original:
bun test --preload ../evidence/offline-preload.js tests/a2e.test.js tests/net-guard.test.js
 119 pass
 32 fail
 381 expect() calls
Ran 151 tests across 2 files. [1119.00ms]

Mismas regresiones contra el core corregido:
 151 pass
 0 fail
 418 expect() calls
Ran 151 tests across 2 files. [475.00ms]

Pruebas pertinentes autónomas, sin preload (env N8N eliminada antes):
bun test tests/a2e.test.js tests/net-guard.test.js
 151 pass
 0 fail
 418 expect() calls
Ran 151 tests across 2 files. [461.00ms]

Suite completa con la corrección:
bun test --preload ../evidence/offline-preload.js tests/
 1503 pass
 5 skip
 0 fail
 3891 expect() calls
Ran 1508 tests across 85 files. [51.81s]
```

Las cinco omisiones son las mismas pruebas de integraciones Postgres del
baseline. El guard de profundidad preexistente pasa. `git diff --check`
no reporta errores. No hay fallos nuevos en la suite offline.

### Revisión independiente

Un revisor separado inspeccionó el diff y contrastó los logs, sin editar
archivos ni repetir la suite completa. Concluyó que no hay hallazgos
bloqueantes ni defectos accionables. Ejecutó 12 checks adicionales con
DNS/fetch simulados y clave ficticia: **12 pass, 0 fail**, cubriendo
userinfo, query, fragment, hostname escapado, Unicode/punycode, IPv4
hexadecimal, IPv6 expandida, trailing dot, backslash y configuración
inválida/interna. Estos checks complementarios no se cuentan como casos
de la suite de 1508 tests. El resultado textual de la revisión se preservó
como evidencia local.

### Límites

- Se demuestra comportamiento local con mocks y regresiones, no un
  despliegue vulnerable, una explotación ni una filtración real.
- Se confía en que el operador controla `N8N_URL` y el origen autorizado.
  La comparación no restringe paths ni workflow IDs dentro de ese origen,
  ni cambia quién puede invocar la ruta pública A2E.
- DNS rebinding y el fail-open de DNS en runtimes sin `node:dns` son
  límites preexistentes de `net-guard` y no se resuelven aquí.
- La suite completa se ejecutó con aislamiento de red, no contra servicios
  vivos ni la integración opcional Postgres.
- Durante la preparación y validación local no se hizo publicación,
  deploy, rotación ni cambio de secretos o configuración de producción.
  La publicación posterior autorizada se limita a una PR borrador.

## CI reproducible en la PR borrador (2026-10-07)

El workflow `.github/workflows/test.yml` ejecuta la suite en eventos
`pull_request` hacia `master` (incluidas PRs borrador) y `push` a
`master`. Usa el runner estándar `ubuntu-24.04`, un timeout de 10 minutos,
Bun `1.3.14` y actions fijadas por SHA. No instala dependencias: la suite
predeterminada no necesita paquetes externos; los imports opcionales de
Postgres solo se ejecutan con `POSTGRES_TEST_URL`.

Se verificaron las versiones y sus fuentes oficiales:
[checkout v6](https://github.com/actions/checkout/tree/d23441a48e516b6c34aea4fa41551a30e30af803),
[setup-bun v2.2.0](https://github.com/oven-sh/setup-bun/tree/0c5077e51419868618aeaa5fe8019c62421857d6)
y [Bun 1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14).
Los permisos del workflow se limitan a `contents: read`; checkout no
persiste credenciales, setup-bun recibe token vacío y el cache está
desactivado. No se usan secretos del repositorio, `pull_request_target`,
servicios externos ni configuración de producción.

El preload `.github/ci/offline-preload.js` conserva el comportamiento del
runner de aislamiento local: elimina las variables N8N y Postgres sin
leer sus valores, sustituye DNS por una IP pública ficticia y bloquea el
fetch nativo fuera de loopback, incluidos redirects automáticos. Los
tests conservan sus mocks específicos y las credenciales ficticias de las
regresiones. Este aislamiento cubre DNS/fetch de la suite actual; **no es
un sandbox de red del sistema operativo**, ni verifica que cada servidor
de loopback sea propiedad de un test.

No se cambiaron pruebas ni código de aplicación para introducir CI. Las
cinco pruebas opcionales de integración Postgres conservan sus skips
explícitos; no se añade un servicio ni credenciales reales.

Validación local del comando exacto del workflow, con Bun 1.3.14:

```text
bun test --preload ./.github/ci/offline-preload.js tests/
 1503 pass
 5 skip
 0 fail
 3891 expect() calls
Ran 1508 tests across 85 files. [51.26s]
```

La revisión independiente de CI no encontró defectos accionables ni
bloqueantes. El resultado remoto y su SHA exacto se registran en la
descripción de la PR después de verificar que el run llegue a estado
terminal. No se modifican protecciones, permisos de repositorio ni
controles de seguridad.
