# Audit Report 02 — Data layer (db, vector, hnsw, memory, queue)

## Hallazgos

### [SEVERIDAD: CRITICAL] Prototype pollution vía operadores de update con claves `__proto__`/`constructor`
- Archivo: core/db.js
- Línea: 139-148 (usado por 173, 183, 191, 209)
- Evidencia:
```js
function _setNestedValue(obj, path, value) {
  if (!path.includes('.')) { obj[path] = value; return; }
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
```
- Descripción: `_setNestedValue` camina el path con `current = current[parts[i]]` sin filtrar `__proto__`/`constructor`/`prototype`. Para un path `__proto__.polluted`, `current['__proto__']` es `Object.prototype` (no es `null`, así que no se crea key propia) y luego `current['polluted'] = value` escribe directamente sobre `Object.prototype`. Lo mismo con `constructor.prototype.x`. Afecta `$set`, `$inc`, `$push` y `$rename` (líneas 173/183/191/209). Como el filtro/usuario controla las claves del update, cualquier caller que acepte filtros/updates de usuario expone todo el proceso.
- Escenario de explotación: `db.users.update({}, { $set: { "__proto__.isAdmin": true } })` contamina `Object.prototype.isAdmin = true` para TODOS los objetos del proceso (no solo la colección); luego `({}).isAdmin === true`, bypassing de checks `if (obj.role)` en Auth/colecciones, persistencia de la contaminación a disco vía `JSON.stringify` en colecciones que incluyan el proto en alguna serialización, etc.
- Sugerencia de fix: bloquear claves `__proto__`, `constructor`, `prototype` en `_setNestedValue`/`_getNestedValue`/`_deleteNestedValue`, o recorrer con `Object.create(null)` y `Object.defineProperty` own properties.

### [SEVERIDAD: HIGH] Búsqueda vectorial IVF degradada silenciosamente — `sampleDims` nunca se usa para clustering
- Archivo: core/vector.js
- Línea: 1560-1566, 1599, 1631
- Evidencia:
```js
build(col, sampleDims = 128) {
  ...
  const dim = this.store.dim;
  ...
  const { centroids, assignments } = this._kmeans(flat, n, dim, this.numClusters);
  const index = { centroids, assignments, sampleDims };
```
```js
_getCandidates(col, query) {
  const idx  = this._loadIndex(col);
  ...
  const dims = idx.sampleDims ?? query.length;
  const centDists = centroids.map((c, i) => ({ i, d: euclideanDist(query, c, dims) }));
```
- Descripción: `build` acepta `sampleDims` pero construye los centroides con `this.store.dim` (dimensión completa), guardando `sampleDims` solo como metadata. En `_getCandidates`/`search` se comparan los primeros `sampleDims` componentes del query contra centroides que se clusterizaron sobre la dimensión completa. La proyección Matryoshka (truncar el query a N dims) no se refleja en los centroides, así que la asignación de cluster/probe es incorrecta cuando `query.length < dim`. El recall cae sin ningún aviso ni fallback a scan.
- Escenario de fallo: embeddings Matryoshka (ej. query de 128 dims contra store de 768); IVF elige clusters comparando 128 componentes del query contra centroides calculados sobre 768 → clusters equivocados → resultados irrelevantes o vacíos sin error.
- Sugerencia de fix: clusterizar k-means sobre los primeros `sampleDims` componentes (`_kmeans(flat, n, sampleDims, k)`), o ignorar `sampleDims` en search y exigir `query.length === dim`.

### [SEVERIDAD: HIGH] HNSW: `remove` degrada el grafo silenciosamente y filtra memoria por holes
- Archivo: core/hnsw.js
- Línea: 233-268 (remove), 161-164 (add)
- Evidencia:
```js
this.idToIdx.delete(id);
this.vectors[idx] = null;
this.nodeLevels.delete(idx);
this.count--;
if (this.entryPoint === idx) {
  this.entryPoint = -1;
  for (const [nIdx] of this.nodeLevels) {
    if (this.vectors[nIdx]) {
      this.entryPoint = nIdx;
      this.maxLevel = this.nodeLevels.get(nIdx) || 0;
      break;
    }
  }
}
```
- Descripción: Al removerse el entry point se elige el primer nodo restante y se setea `maxLevel` al nivel de ese nodo, pero pueden existir otros nodos en niveles superiores que quedan huérfanos (inalcanzables desde el nuevo entry point). Las capas superiores se "cortan" del grafo y esos nodos nunca más se visitan en búsqueda → degradación permanente del recall sin error ni log. Además `vectors[idx] = null` y `idxToId` no se compactan (add usa `this.idxToId.length` que nunca decrece): bajo churn continuo el array `vectors` crece monótonamente con holes `null` → fuga de memoria no acotada.
- Escenario de fallo: indexar y remover repetidamente (caso típico de memoria/queue con expiración); tras remover el nodo entry-point superior, el recall cae y el consumo de memoria sube indefinidamente.
- Sugerencia de fix: al reasignar entry point, recorrer `nodeLevels` y tomar el de mayor nivel (no el primero); compactar `vectors`/`idxToId` o reusar holes con un free-list.

### [SEVERIDAD: HIGH] `$regex` con patrón arbitrario de usuario → ReDoS
- Archivo: core/db.js (línea 69-73) y core/vector.js (línea 233-237)
- Evidencia (db.js):
```js
case '$regex': {
  const re = typeof target === 'string' ? new RegExp(target) : target;
  if (!re.test(String(val ?? ''))) return false;
  break;
}
```
- Descripción: el operador `$regex` construye `new RegExp(target)` con el patrón crudo que llega en el filtro. Si el filtro proviene de input de usuario (API REST, query de cliente), un patrón catastrófico (ej. `(a+)+$`) bloquea el event loop en `re.test`. Sin límite de tamaño ni timeout. Lo mismo aplica a `core/vector.js` `matchFilter` `$regex` y a los `cond instanceof RegExp` de db.js línea 52.
- Escenario de explotación: request con `{ name: { $regex: "(a+)+$" } }` y un campo `name` con valor `aaaaaaaaaaaaaaaaaaaaaaaa!` → bloqueo de CPU por minutos.
- Sugerencia de fix: validar/sanitizar el patrón (longitud máx, whitelist de anchors, o `timeoutRegex` no existe en JS → limitar a literales conocidos o ejecutar en worker con timeout).

### [SEVERIDAD: MEDIUM] Jobs en estado `processing` se pierden para siempre ante un crash
- Archivo: core/queue.js
- Línea: 166-179 (poll), 181-219 (process)
- Evidencia:
```js
const available = this._jobs.find({
  status: 'pending',
  runAt: { $lte: now },
}).sort({ priority: -1, createdAt: 1 }).limit(this.concurrency - this._running).toArray();
```
```js
this._jobs.update({ _id: job._id }, { $set: { status: 'processing', updatedAt: Date.now() } });
```
- Descripción: `_poll` solo selecciona `status: 'pending'`. Al marcar un job `processing` y caer el proceso (crash/OOM/restart) antes del `finally`, el job queda `processing` en disco y nunca más es seleccionado ni reintegrado a dead-letter. No hay lease, no hay recuperación de jobs stuck. `stats()` los cuenta como `processing` eternamente y el trabajo se pierde silenciosamente.
- Escenario de fallo: worker muere matando un `send-email` en `processing` → ese mail nunca se envía ni reintenta, sin alarma.
- Sugerencia de fix: agregar `runAt`/`expiresAt` a jobs `processing` y reclamar los vencidos en `_poll` (`status: 'processing', updatedAt: { $lt: now - leaseMs } }`).

### [SEVERIDAD: MEDIUM] Opción `timeout` de handler registrada pero nunca aplicada
- Archivo: core/queue.js
- Línea: 51-54, 181-219
- Evidencia:
```js
register(type, handler, opts = {}) {
  this._handlers.set(type, { handler, ...opts });
  return this;
}
```
```js
async _process(job) {
  const handlerDef = this._handlers.get(job.type);
  ...
  const result = await handlerDef.handler(job.data, job);
```
- Descripción: `register(type, handler, { timeout })` guarda `timeout` en `handlerDef`, pero `_process` jamás lo referencia — el handler se awaita sin límite. Un handler que cuelgue (loop infinito, await de red sin timeout) bloquea uno de los slots de concurrencia para siempre. Feature anunciada silenciosamente rota.
- Escenario de fallo: handler de fetch sin timeout propio → job `processing` por siempre, slot de concurrencia consumido.
- Sugerencia de fix: envolver el handler en `Promise.race([handlerDef.handler(...), timeoutPromise(handlerDef.timeout)])` y tratar timeout como error reintentable.

### [SEVERIDAD: MEDIUM] Escrituras de archivos no atómicas → corrupción total de colección ante crash
- Archivo: core/db.js
- Línea: 266-269 (FileStorageAdapter.writeJson), 1135-1155 (flush)
- Evidencia:
```js
writeJson(filename, data) {
  const file = this.path.join(this.dir, filename);
  this.fs.writeFileSync(file, JSON.stringify(data));
}
```
- Descripción: `writeJson` escribe directo al archivo final sin `tmp + rename`. Si el proceso muere a mitad del `writeFileSync`, el archivo queda truncado/corrupto y el próximo `readJson` lanza al hacer `JSON.parse` (toda la colección se vuelve ilegible, no solo un doc). Además `flush` escribe `docs`, `meta` e `indexes` en archivos separados sin orden de durabilidad: un crash entre la escritura de docs y la de índices deja índices persistentes desactualizados respecto a los docs.
- Escenario de fallo: power-loss o SIGKILL durante un flush grande → `users.docs.json` truncado → `Collection._ensureLoaded` recibe array inválido y la colección entera se pierde.
- Sugerencia de fix: escribir a `file.tmp` y `fs.renameSync(file.tmp, file)` (atómico en mismo FS); además reconstruir índices desde docs al cargar si hay mismatch de versión/conteo.

### [SEVERIDAD: MEDIUM] Índices persistentes stale → queries silenciosamente incompletos tras flush parcial
- Archivo: core/db.js
- Línea: 858-864, 1146-1151
- Evidencia:
```js
const state = this._adapter.readJson(this._indexFile(field, type));
if (state && !rebuild) {
  index.importState(state);
} else if (this._docs && this._docs.size > 0) {
  index.rebuild(Array.from(this._docs.values()));
}
```
```js
if (this._dirtyIds.size > 0) {
  for (const [field, index] of this._indexes) {
    ...
    this._adapter.writeJson(this._indexFile(field, type), index.exportState());
  }
}
```
- Descripción: al cargar, `_createIndexInternal` prefiere importar el estado de índice persistido (`!rebuild`) en vez de reconstruir desde los docs. Si un flush anterior escribió los docs pero no los índices (crash, o path donde `_dirtyIds` quedó vacío pero docs sí cambiaron — ej. tras `clear()` que hace `_dirtyIds.clear()` pero setea `_dirty=true`), el índice en disco queda desincronizado: faltan/ sobran ids vs los docs reales. `_tryIndexLookup` entonces devuelve ids inexistentes o omite docs existentes para queries que usan índice (igualdad/rango sobre campo indexado), dando resultados incorrectos sin error.
- Escenario de fallo: colección con índice único en `email`; tras un flush interrumpido, `findOne({ email: 'x' })` (usa índice) no encuentra un doc que SÍ está en `users.docs.json` → registro "fantasma" ausente.
- Sugerencia de fix: al cargar, validar que `exportState` del índice coincida con los `_ids` de docs; si no, forzar `rebuild`.

### [SEVERIDAD: MEDIUM] `EncryptedAdapter.readJson` sincrónico devuelve `null` para datos encriptados no preloaded → datos invisibles
- Archivo: core/db.js
- Línea: 1757-1768
- Evidencia:
```js
readJson(filename) {
  if (this._cache && this._cache.has(filename)) {
    return this._cache.get(filename);
  }
  const encrypted = this.inner.readJson(filename);
  if (!encrypted) return null;
  if (!encrypted.__enc) return encrypted;
  return null;  // No podemos desencriptar sync — retornar null
}
```
- Descripción: si una colección no fue `preload()`-ada antes de un acceso sync (ej. `DocStore` que carga perezosamente en el primer `insert`/`find`), `readJson` ve `{__enc: ...}` y, como no puede desencriptar sincrónicamente, retorna `null`. La `Collection` lo interpreta como "colección nueva/vacía" y opera sobre un estado limpio: un `insert` posterior sobreescribe datos encriptados existentes al hacer flush, o un `find` retorna vacío. Pérdida/datos-invisibles silenciosa, sin throw.
- Escenario de fallo: reinicio del proceso sin llamar `await adapter.preload([...])` → `db.users.find()` devuelve `[]` aunque haya miles de docs encriptados; cualquier write ahora pisará el archivo.
- Sugerencia de fix: lanzar un error explícito ("encrypted data requires preload()") en vez de devolver `null`, o exigir `preload` obligatorio en el constructor.

### [SEVERIDAD: MEDIUM] Salt fijo por defecto en derivación PBKDF2 (EncryptedAdapter / FieldCrypto)
- Archivo: core/db.js
- Línea: 1658, 1837
- Evidencia:
```js
static async create(inner, password, salt = 'js-doc-store-v1') {
```
```js
static async create(password, salt = 'js-doc-field-v1') {
```
- Descripción: el salt de PBKDF2 por defecto es una constante global, idéntica para todos los usuarios/instalaciones que no pasen `salt`. Dos passwords iguales en dos instancias derivan la misma key; un atacante con una rainbow table precomputada contra ese salt específico rompe todos los usuarios que usaron el default. No hay warning ni obligación de pasar salt.
- Escenario de explotación: dump de la DB robado; atacante precomputa PBKDF2(password, 'js-doc-store-v1', 100000) para diccionarios comunes una sola vez y descifra todos los campos/DBs de quienes usaron el default.
- Sugerencia de fix: generar salt aleatorio por-instalación y persistirlo junto a los datos, o exigir `salt` obligatorio (throw si es el default).

### [SEVERIDAD: MEDIUM] `Reranker.crossModelSearch` indexa respuesta de API externa sin bounds check
- Archivo: core/vector.js
- Línea: 2242-2257
- Evidencia:
```js
const ranked = await this.rank(queryText, documents);
const results = [];
for (const r of ranked) {
  if (results.length >= limit) break;
  const candidate = allCandidates[r.index];
  results.push({
    id:         candidate.id,
    ...
  });
}
```
- Descripción: `r.index` proviene de la respuesta JSON del API de reranking (externo/no confiable). Si `r.index` es `undefined` o está fuera de rango, `allCandidates[r.index]` es `undefined` y `candidate.id` lanza `TypeError`, abortando toda la búsqueda. No hay validación de `0 <= r.index < allCandidates.length`. Un provider que reordene IDs de forma inesperada rompe el flujo.
- Escenario de fallo: API retorna `{response:[{id:0},{id:1}]}` pero el store mandó 0 documentos útiles y `allCandidates` quedó corto, o retorna indices como strings → crash.
- Sugerencia de fix: validar `Number.isInteger(r.index) && r.index >= 0 && r.index < allCandidates.length` antes de acceder; skipiar inválidos.

### [SEVERIDAD: MEDIUM] `catch {}` vacíos ocultan fallos reales en rutas de datos
- Archivo: core/db.js
- Línea: 1175-1180 (Collection.import), 1485 (Table.addColumn), 1262 (DocStore._emit watch), 1930-1932 (Auth.init indexes)
- Evidencia:
```js
import(docs) {
  let count = 0;
  for (const doc of docs) {
    try {
      this.insert(doc);
      count++;
    } catch {
      // Skip duplicates
    }
  }
  return count;
}
```
```js
try { this._col.createIndex(colDef.name, { unique: true }); } catch {}
```
- Descripción: el catch de `import` atrapa TODOS los errores (no solo duplicados): validación de `Table`, prototype pollution, errores de disco, corruption. El comentario miente ("Skip duplicates") y el caller recibe un `count` feliz sin saber que se descartaron docs por motivos graves. Igual en `Table.addColumn` (silencia índice roto por datos preexistentes), `_emit` (un watcher que tira oculta el evento a los demás) y `Auth.init` (silencia fallo de creación de índices únicos → login/verificación de sesión luego hace full-scan o rompe unicidad).
- Escenario de fallo: importar un dump donde algunos docs violan un schema → se descartan silenciosamente, el `count` reporta "import exitoso" y faltan registros.
- Sugerencia de fix: filtrar por tipo de error (`err.message.includes('Duplicate')`/`Unique constraint`) y re-lanzar el resto; loguear en `_emit`.

### [SEVERIDAD: MEDIUM] `dream`/`saveOrUpdate`/`_findDuplicateClusters` son O(n²) sobre toda la memoria
- Archivo: core/memory.js
- Línea: 521-574 (saveOrUpdate), 653-691 (_findDuplicateClusters), 587-647 (dream)
- Evidencia:
```js
const existing = col.find({}).toArray();
for (const doc of existing) {
  let score;
  if (this._similarityFn) { ... } else { ... }
  if (score > bestScore) { bestScore = score; bestMatch = doc; }
}
```
- Descripción: cada `saveOrUpdate` trae TODOS los docs y los compara contra el nuevo; `dream`→`_findDuplicateClusters` hace un doble bucle O(n²) con cálculo de similaridad por par (y `_extractSearchable` + split por término en cada comparación). No hay batching ni index. Con memorias de miles de entries, un `dream()` puede tardar minutos y bloquear; con decenas de miles es inmanejable. Complejidad ciclomática/nesting alta en `_llmConsolidate` (4 niveles, switch con try/catch anidado).
- Escenario de fallo: agente con 20k memorias → `dream()` nocturno cuelga el proceso / OOM.
- Sugerencia de fix: pre-tokenizar y construir un índice invertido de términos→docIds (o usar el `vector.js` que ya existe) para dedup, y paginar clusters.

### [SEVERIDAD: LOW] `_randomLevel` puede entrar en loop infinito si `Math.random()` devuelve `0`
- Archivo: core/hnsw.js
- Línea: 323-325, 171-173
- Evidencia:
```js
_randomLevel() {
  return Math.floor(-Math.log(Math.random()) * this.ml);
}
```
```js
while (this.levels.length <= nodeLevel) {
  this.levels.push(new Map());
}
```
- Descripción: `Math.random()` puede devolver `0.0` (raro pero posible, y Bun/engines con PRNG de baja entropía más aún). `-Math.log(0) === Infinity` → `nodeLevel = Infinity` → el `while (this.levels.length <= Infinity)` nunca termina → hang + OOM asignando Maps. Sin clamp.
- Escenario de fallo: insert masivo que tarde o temprano toca `random()===0` → proceso colgado.
- Sugerencia de fix: `const r = Math.max(Math.random(), Number.MIN_VALUE)` antes del log, o clamp `nodeLevel` a un máximo.

### [SEVERIDAD: LOW] `PolarQuantizedStore` reporta scores de "coseno" fuera de escala correcta
- Archivo: core/vector.js
- Línea: 1274-1288, 1419-1427
- Evidencia:
```js
_cosinePolar(query, packed, offset) {
  ...
  let dot = 0, nq = 0;
  for (let p = 0; p < this._pairs; p++) {
    ...
    dot += qa * this._cosTable[indices[p]] + qb * this._sinTable[indices[p]];
    nq += qa * qa + qb * qb;
  }
  const denomQ = Math.sqrt(nq);
  return denomQ === 0 ? 0 : dot / denomQ;
}
```
- Descripción: el vector reconstruido tiene norma `sqrt(pairs)` (cada par `(cos,sin)` aporta 1), no 1. El score retornado es `dot(query,stored)/|query|`, que escala con `|stored|=sqrt(pairs)` y puede exceder 1. El ranking se preserva pero el "cosine" no está en [-1,1], lo que rompe normalizaciones que asumen ese rango (ej. `HybridSearch` weighted, `searchAcross` min-max) y devuelve scores engañosos al consumidor.
- Sugerencia de fix: dividir por `Math.sqrt(nq) * Math.sqrt(this._pairs)` (norma del stored) para devolver un coseno real en [-1,1].

### [SEVERIDAD: LOW] `TopKHeap` con `k=0` lanza al acceder `this.data[0]`
- Archivo: core/vector.js
- Línea: 25-33 (y consumidor search col, line 531)
- Evidencia:
```js
push(item) {
  if (this.data.length < this.k) {
    ...
  } else if (item.score > this.data[0].score) {
```
- Descripción: `search(col, query, limit=5,...)` permite `limit=0` vía callers (ej. `matryoshkaSearch` con `limit=0`, o `searchAcross` con `limit=0`). Con `k=0`, `this.data[0]` es `undefined` → `item.score > undefined.score` → `TypeError`. No hay guard.
- Sugerencia de fix: `if (this.k <= 0) return;` al inicio de `push`.

### [SEVERIDAD: LOW] `JobQueue.stop()` no limpia `_flushTimer`
- Archivo: core/queue.js
- Línea: 94-100, 112-119
- Evidencia:
```js
_markDirty() {
  if (this._flushTimer) return;
  this._flushTimer = setTimeout(() => {
    this.db.flush();
    this._flushTimer = null;
  }, 500);
}
```
```js
stop() {
  this._started = false;
  if (this._timer) {
    clearInterval(this._timer);
    this._timer = null;
  }
  return this;
}
```
- Descripción: `stop()` limpia el `_timer` de polling pero no el `_flushTimer`. Un flush pendiente puede dispararse después del `stop()` (sobre una DB que el caller ya podría haber cerrado), y no hay `destroy()` para liberar el timer. Fuga de handle menor.
- Sugerencia de fix: `if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }` en `stop()`.

## Resumen
- Archivos revisados: 5/5
- Hallazgos: 1 critical, 3 high, 9 medium, 4 low (17 hallazgos)
- Sin hallazgos en: ninguno — todos los archivos presentaron al menos un hallazgo.
- Notas: core/db.js concentra el riesgo crítico (prototype pollution) y la mayoría de los medium (crypto, atomicidad, catch vacíos). core/hnsw.js no tiene persistencia pero su `remove` compromete calidad de búsqueda. core/memory.js es correcto en seguridad pero O(n²) en mantenimiento. core/queue.js pierde jobs ante crashes y anuncia un `timeout` que no aplica.