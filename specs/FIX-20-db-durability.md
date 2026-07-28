CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/db.js` YA tiene 2 fixes previos aplicados (prototype pollution en `_setNestedValue`/etc, y ReDoS en `$regex`). NO los toques ni reviertas — es tuyo agregar 5 fixes MÁS al mismo archivo, en zonas distintas. Es una tarea grande, dividida en 5 sub-hallazgos — trabajalos en orden, cada uno con su propio test, y si alguno resulta mucho más complejo de lo esperado, documentalo y priorizá los demás (ver ABORTAR SI parcial más abajo).

Una auditoría encontró 5 hallazgos MEDIUM en `core/db.js` que te tocan a vos:

## Hallazgo 1: Escrituras de archivos no atómicas → corrupción total de colección ante crash
- Líneas ~266-269 (`FileStorageAdapter.writeJson`).
```js
writeJson(filename, data) {
  const file = this.path.join(this.dir, filename);
  this.fs.writeFileSync(file, JSON.stringify(data));
}
```
- Si el proceso muere a mitad del `writeFileSync`, el archivo queda truncado/corrupto y el próximo `readJson` lanza al parsear — toda la colección se vuelve ilegible.
- Fix: escribí a un archivo temporal (`file + '.tmp'`) y luego `fs.renameSync(tmpFile, file)` (rename es atómico en el mismo filesystem). Esto garantiza que el archivo final SIEMPRE es válido (o el viejo, o el nuevo completo, nunca a medio escribir).

## Hallazgo 2: Índices persistentes stale → queries silenciosamente incompletos tras flush parcial
- Líneas ~858-864, ~1146-1151.
- Al cargar, se prefiere importar el estado de índice persistido en vez de reconstruir desde los docs. Si un flush anterior escribió docs pero no índices (crash), el índice queda desincronizado y las queries que usan ese índice dan resultados incorrectos sin error.
- Fix: al cargar el índice persistido, validá (de forma barata, p.ej. comparando el conteo de entradas del índice contra el conteo de docs, o algún checksum/versión simple si ya existe una estructura para eso) que sea consistente con los docs actuales; si no coincide, forzá `rebuild` en vez de usar el estado persistido.

## Hallazgo 3: `EncryptedAdapter.readJson` sincrónico devuelve `null` para datos encriptados no preloaded → datos invisibles
- Líneas ~1757-1768.
```js
readJson(filename) {
  if (this._cache && this._cache.has(filename)) return this._cache.get(filename);
  const encrypted = this.inner.readJson(filename);
  if (!encrypted) return null;
  if (!encrypted.__enc) return encrypted;
  return null;  // No podemos desencriptar sync — retornar null
}
```
- Si una colección encriptada no fue `preload()`-ada, `readJson` retorna `null` silenciosamente. La `Collection` lo interpreta como "vacía" y un insert posterior SOBREESCRIBE datos encriptados existentes al hacer flush.
- Fix: en vez de `return null` en ese caso, lanzá un error explícito (p.ej. `throw new Error('EncryptedAdapter: encrypted data requires preload() before sync access')`) para que el fallo sea visible en vez de silencioso.

## Hallazgo 4: Salt fijo por defecto en derivación PBKDF2
- Líneas ~1658, ~1837.
```js
static async create(inner, password, salt = 'js-doc-store-v1') {
```
```js
static async create(password, salt = 'js-doc-field-v1') {
```
- Salt constante global por defecto — dos instalaciones con la misma password derivan la misma key; vulnerable a rainbow tables precomputadas contra ese salt específico.
- Fix: si no se pasa `salt` explícito, generá uno aleatorio criptográficamente seguro (Web Crypto `crypto.getRandomValues`) por instancia — pero ojo, el salt DEBE persistirse junto a los datos encriptados (si no se persiste, los datos ya encriptados con un salt anterior quedan indescifrables tras un restart). Si persistir el salt requiere cambios más allá de este archivo (p.ej. dónde se guarda), documentá esa limitación en el REPORT y como mínimo lanzá un error si no se provee `salt` explícito en vez de usar el default hardcodeado (opción más simple y seguro, similar al fix de FIX-13 para el JWT secret de cms.js). Elegí la opción que puedas completar dentro de este archivo sin romper tests existentes, y documentá cuál elegiste.

## Hallazgo 5: `catch {}` vacíos ocultan fallos reales en rutas de datos
- Líneas ~1175-1180 (`Collection.import`), ~1485 (`Table.addColumn`), ~1262 (`DocStore._emit` watch), ~1930-1932 (`Auth.init` indexes).
```js
import(docs) {
  let count = 0;
  for (const doc of docs) {
    try { this.insert(doc); count++; } catch { /* Skip duplicates */ }
  }
  return count;
}
```
- El catch de `import` atrapa TODOS los errores (no solo duplicados), ocultando fallos graves (validación, prototype pollution, corrupción). Mismo problema en los otros 3 lugares.
- Fix: en `Collection.import`, filtrá por tipo de error (chequeá `err.message` por algo como "Duplicate"/"Unique constraint" — mirá qué mensaje real usa el código para violaciones de unicidad) y RE-LANZÁ cualquier otro error. En `Table.addColumn` y `Auth.init`, al menos logueá el error con `console.error` en vez de silenciarlo del todo (no hace falta re-lanzar si romper el flujo ahí no es deseable, pero visibilidad es el mínimo). En `_emit`, logueá el error del watcher que falla sin que eso interrumpa la notificación a los demás watchers (mantené el aislamiento entre watchers, pero con visibilidad del fallo).

ARCHIVOS: Toca SOLO `core/db.js` y `tests/db.test.js`. NO toques los 2 fixes previos ya existentes (prototype pollution, ReDoS). NO toques otros archivos core.

DEFINICIÓN DE HECHO (uno por hallazgo, agregá los 5 tests que apliquen):
1. Test que confirma escritura atómica: simulá o verificá que `writeJson` usa tmp+rename (podés inspeccionar llamadas a `fs.renameSync`/`writeFileSync` con un mock/spy si el test setup lo permite, o verificar indirectamente que no queda un archivo corrupto tras una escritura interrumpida simulada).
2. Test que confirma que un índice persistido inconsistente con los docs fuerza rebuild (en vez de devolver resultados incorrectos).
3. Test que confirma que `EncryptedAdapter.readJson` sin preload LANZA en vez de devolver `null` silenciosamente.
4. Test que confirma el nuevo comportamiento del salt PBKDF2 (según la opción que elegiste — aleatorio persistido, o error si no se provee explícito).
5. Test que confirma que `Collection.import` con un doc que falla por una razón NO relacionada a duplicados (p.ej. un error de validación real) SE RE-LANZA (no se traga silenciosamente), mientras que duplicados legítimos sí se siguen saltando.
6. Confirmá que los 2 fixes previos (pollution, ReDoS) siguen funcionando — corré esos tests y no los rompiste.
7. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
8. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los 2 fixes previos.

ABORTAR SI (por hallazgo individual, no para toda la tarea): si UNO de los 5 hallazgos resulta inalcanzable por una razón legítima (p.ej. el fix del salt PBKDF2 requiere persistencia que no es viable sin tocar otros archivos fuera de tu scope) → documentalo con evidencia en el REPORT, completá los OTROS 4 hallazgos igual, y marcá ese uno específico como PARCIAL/BLOQUEADO en el REPORT (no abortes la tarea entera por 1 de 5).

ENTREGA: `specs/FIX-20-db-durability-REPORT.md` (qué cambiaste en cada uno de los 5 hallazgos, decisiones tomadas, tests agregados, salida real de bun test, y cuáles quedaron parciales si aplica). Al terminar respondé SOLO: LISTO + 1 línea con el resumen de los 5.
