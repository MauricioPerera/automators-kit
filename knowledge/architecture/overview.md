---
type: 'Architecture'
title: 'automators-kit: arquitectura general'
description: 'Toolkit JS/Bun de cero dependencias: CMS headless, motor de workflows (dos motores distintos), agent shell con RBAC, busqueda vectorial y servidor MCP, compuestos via createApp().'
tags: ['architecture', 'overview', 'core', 'zero-dependency']
---

# automators-kit: arquitectura general

Toolkit de automatizacion en JavaScript puro (ESM), sin dependencias de npm,
pensado para correr sobre Bun (runtime principal), Node.js 20+ o Deno. La
identidad del proyecto es "zero-dependency, hackeable" — cada modulo de
`core/` es legible e independiente, y se compone, no se reemplaza.

## Los modulos de `core/`

Alrededor de 23 modulos independientes, cada uno con su propia
responsabilidad y su propio archivo de tests en `tests/<modulo>.test.js`.
Ejemplos representativos (no exhaustivo — ver el codigo fuente en `core/`
para la lista real y actual):

- `db.js` — `DocStore`/`Collection`, motor documental con indices,
  agregacion (`$lookup`/`$group`/etc.) y adaptadores de storage
  (`FileStorageAdapter`/`MemoryStorageAdapter`).
- `cms.js` — CMS headless sobre `db.js`: content types, entries, taxonomias,
  auth, RBAC de CMS.
- `workflow.js` — motor de workflows declarativo (`WorkflowEngine`), disparado
  por `triggers.js` (webhook/cron/poll/manual), ejecuta un DAG de nodos
  registrados en `nodes.js`.
- `a2e.js` — un SEGUNDO motor de ejecucion, deliberadamente distinto de
  `workflow.js`: formato JSON compacto, `WorkflowExecutor.execute()` sin
  input por llamada (a diferencia de `workflow.js`), sin trigger propio.
  Los dos motores coexisten a proposito — ver
  `knowledge/contracts/` para ejemplos de como se combinan sin unificarse.
- `shell.js` — agent shell con RBAC real (`AGENT_PROFILES`: admin/operator/
  reader/restricted, mas listas de `permissions` custom), comandos
  `namespace:command` sobre un `CommandRegistry`.
- `vector.js` / `hnsw.js` — busqueda semantica: `VectorStore` (brute-force) y
  `HNSWIndex` (grafo aproximado) son primitivas separadas, no una sola
  abstraccion.
- `mcp.js` / `shell-mcp.js` — dos patrones MCP distintos: uno expone un tool
  por capacidad con JSON schema real (`mcp.js`), el otro expone 2 tools fijos
  (`search`/`describe`) sin importar cuantos comandos haya registrados
  (`shell-mcp.js`).
- `credentials.js` — `CredentialVault`, secretos cifrados (AES-256-GCM via
  `FieldCrypto` de `db.js`), sin RBAC propio: quien decide quien puede leer
  un secreto es quien lo envuelve (ver `examples/vault-access-control`).
- `validate.js` — validacion de schemas standalone (no atada a `cms.js`),
  usada tanto para bodies HTTP como, mas recientemente, para gatear inputs de
  nodos de `workflow.js` (`examples/validated-workflow-nodes`).
- `queue.js`, `cron.js`, `parallel.js`, `plugins.js`, `portable-text.js`,
  `connector.js`, `memory.js`, `net-guard.js` — cola de trabajos en
  background, scheduler cron, combinadores de promesas
  (`parallelRace`/`parallelMerge`), sistema de plugins con capacidades,
  contenido rico portable, cliente HTTP con guardas SSRF, memoria de agente
  (episodica/semantica), y el guard de SSRF que varios de los anteriores
  reusan.

## `createApp()`: el punto de composicion

`index.js`'s `createApp(opts)` es donde los modulos se ensamblan en una
aplicacion real: instancia `CMS`, `WorkflowEngine`, `Shell` (perfil `admin`
por defecto salvo `opts.shellProfile`), monta las rutas HTTP (`routes/`) y
devuelve `{ handle, cms, workflowEngine, shell, router }`. Los ejemplos que
NO llaman `createApp()` (p. ej. `examples/hybrid-catalog-search`,
`examples/trigger-hub`) lo hacen deliberadamente para componer solo los
modulos que necesitan, sin CMS de por medio — "a la carta" es el patron
establecido cuando un ejemplo no necesita todo lo que `createApp()` trae.

## `examples/`: documentacion ejecutable

Cada subdirectorio de `examples/` es un programa real y independiente
(`setup.js` + su propio `README.md` + su propia suite de regresion en
`tests/examples-<nombre>.test.js`), no un snippet. El patron dominante desde
hace varias iteraciones de este proyecto es **combinar 2-3 modulos de
`core/` en un caso de uso que ninguno de los dos resuelve solo** —
`examples/queue-access-control` (RBAC de `shell.js` sobre `queue.js`),
`examples/trigger-driven-a2e` (`triggers.js` disparando `a2e.js` en vez de
`workflow.js`), etc. Varios de estos ejemplos, al construirse honestamente
(verificando en vivo antes de documentar), encontraron y corrigieron bugs
reales en el propio `core/` — la disciplina establecida es: un hallazgo en
`core/` se corrige con aprobacion explicita antes de seguir, nunca se asume.

## Runtime

`server-bun.js`, `server-node.js`, `server-deno.js` — el mismo `createApp()`
montado sobre el runtime nativo de cada uno, sin adaptador intermedio: la
"cero dependencias" incluye no depender de un framework HTTP tampoco.

## Por que esto importa para KDD

Este nodo existe para que un contrato de tarea nuevo pueda enlazar aca en
vez de reexplicar la arquitectura cada vez (regla de no-duplicacion de OKF,
ver [OKF-SPEC.md](../OKF-SPEC.md) §4). No describe el codigo linea por
linea — para eso esta el codigo mismo y los `README.md` de cada ejemplo.
