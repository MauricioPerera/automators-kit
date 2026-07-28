# FIX-20 — `core/db.js` durability & security hardening (5 hallazgos MEDIUM)

**Archivos tocados:** `core/db.js`, `tests/db.test.js` (única dupla permitida por la tarea).
**Fixes previos NO tocados:** prototype pollution (`_setNestedValue`/`_getNestedValue`/`_deleteNestedValue` + `DANGEROUS_SEGMENTS`, ~L175-220) y ReDoS (`REGEX_GUARD`/`$regex`, ~L23-56). Verificados vivos al final.

---

## Resumen por hallazgo

| # | Hallazgo | Estado | Tests agregados |
|---|----------|--------|-----------------|
| 1 | Escrituras no atómicas → corrupción de colección | ✅ COMPLETO | 1 |
| 2 | Índices persistentes stale → queries incompletos | ✅ COMPLETO | 2 |
| 3 | `EncryptedAdapter.readJson` devuelve `null` silencioso | ✅ COMPLETO | 2 |
| 4 | Salt fijo por defecto en PBKDF2 | ⚠️ PARCIAL (EncryptedAdapter: completo; FieldCrypto: BLOQUEADO) | 2 |
| 5 | `catch {}` vacíos ocultan fallos | ✅ COMPLETO | 2 |

**Total tests nuevos: 9.** Suite db: 62 → 71 pass, 0 fail.

---

## Hallazgo 1 — Escritura atómica (`FileStorageAdapter.writeJson`)

**Cambio (`core/db.js`, `FileStorageAdapter.writeJson`):** antes `writeFileSync(file, ...)` directo. Ahora escribe a `file + '.tmp'` y luego `fs.renameSync(tmp, file)`. `rename` es atómico en el mismo filesystem (y en Windows reemplaza el destino). Si el proceso muere a mitad del `writeFileSync`, el archivo final nunca queda truncado: queda el viejo válido, o el `rename` instala el nuevo completo.

```js
writeJson(filename, data) {
  const file = this.path.join(this.dir, filename);
  const tmp = file + '.tmp';
  this.fs.writeFileSync(tmp, JSON.stringify(data));
  this.fs.renameSync(tmp, file);
}
```

**Test:** `FIX-20: atomic writes > FileStorageAdapter.writeJson escribe a .tmp y renombra (atomico)`. Usa un `Proxy` sobre `adapter.fs` para espiar `writeFileSync`/`renameSync` sobre un temp dir real (`mkdtempSync`). Verifica: 1) `writeFileSync` escribe a `*.tmp` (nunca al final directo), 2) `renameSync` mueve `*.tmp → final`, 3) el archivo final es parseable y no queda `.tmp` residual.

---

## Hallazgo 2 — Índice persistido stale fuerza rebuild

**Cambio (`core/db.js`, `Collection._createIndexInternal` + nuevo helper `_indexStateIsConsistent`):** al cargar el estado persistido, antes se usaba directamente (`importState`). Ahora se valida consistencia barata: el set de `_id`s referenciados por el índice debe igualar exactamente el set de docs que tienen el campo definido. Si difieren (p.ej. flush parcial: docs escritos, índice no), se cae al branch de `rebuild` desde los docs en vez de usar estado stale.

```js
if (state && !rebuild && this._indexStateIsConsistent(field, type, state)) {
  index.importState(state);
} else if (this._docs && this._docs.size > 0) {
  index.rebuild(Array.from(this._docs.values()));
}
```

`_indexStateIsConsistent` recorre los `_id`s del estado (sorted: `state.entries`; hash: `state.data` valores) y los compara contra `this._docs` (docs con el campo definido). O(docs), una sola pasada.

**Tests:**
- `un indice persistido inconsistente con los docs fuerza rebuild (no resultados incompletos)`: persiste 50 docs + sorted index, corrompe el índice persistido a 1 sola entrada (simula flush parcial), recarga en un `DocStore` nuevo y verifica que `find({value:{$gte:45}})` devuelve los 5 correctos (no 0, que es lo que daría el índice stale).
- `un indice persistido consistente con los docs se reutiliza (round-trip)`: verifica que la optimización de cargar el índice persistido sigue funcionando cuando SÍ es consistente (no regreso a "siempre rebuild").

---

## Hallazgo 3 — `EncryptedAdapter.readJson` fail-loud

**Cambio (`core/db.js`, `EncryptedAdapter.readJson`):** el caso "datos encriptados sin preload" antes devolvía `null` silenciosamente → la `Collection` lo interpretaba como colección vacía → un insert posterior sobreescribía datos encriptados al flush. Ahora lanza:

```js
throw new Error('EncryptedAdapter: encrypted data requires preload() before sync access');
```

**Tests:**
- `lanza si hay datos encriptados sin preload (antes devolvia null silencioso)`.
- `devuelve datos desencriptados tras preload (no rompi el path correcto)` — confirma que el path `preload` + cache sigue funcionando.

---

## Hallazgo 4 — Salt PBKDF2 — ⚠️ PARCIAL

### `EncryptedAdapter.create` — ✅ COMPLETO (opción: salt aleatorio persistido)

**Cambio:** eliminado el default `'js-doc-store-v1'`. Si no se pasa `salt` explícito: lee un salt persistido del adapter interno (`__enc.salt.json`); si no existe, genera uno aleatorio criptográficamente seguro (`crypto.getRandomValues(16 bytes)` → base64) y lo **persiste** en el adapter interno. Salt explícito desactiva la persistencia (lo gestiona el caller).

Esto elimina el salt global constante (no más rainbow table precomputada contra `'js-doc-store-v1'`): cada almacenamiento deriva su propio salt, y como se persiste, los datos siguen siendo descifrables tras restart (mismo inner + password → mismo salt persistido → misma key).

```js
let saltStr = salt;
if (!saltStr) {
  const SALT_FILE = '__enc.salt.json';
  const existing = inner.readJson(SALT_FILE);
  if (existing && typeof existing.salt === 'string') {
    saltStr = existing.salt;
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    saltStr = _uint8ToBase64(bytes);
    inner.writeJson(SALT_FILE, { salt: saltStr });
  }
}
```

**Tests:**
- `sin salt explicito: genera uno aleatorio y lo persiste (sobrevive restart, misma key)`: verifica que `__enc.salt.json` se persiste y que una segunda instancia (mismo inner+password, sin salt) desencripta datos de la primera.
- `salt aleatorio distinto por almacenamiento -> keys distintas (no rainbow global)`: dos `MemoryStorageAdapter` distintos con el mismo password derivan keys distintas (copia el blob encriptado de A a B; B no puede desencriptarlo).

### `FieldCrypto.create` — ❌ BLOQUEADO (documentado, sin fix aplicado)

**Evidencia del bloqueo:** `FieldCrypto.create` tenía el default `'js-doc-field-v1'` (mismo problema). Las dos opciones viables son inalcanzables **sin tocar archivos fuera de scope** (`core/credentials.js`):

1. **Salt aleatorio persistido** — `FieldCrypto` es stateless: solo guarda la `key` derivada, sin acceso a storage. Persistir un salt requeriría que el caller (`CredentialVault` en `core/credentials.js`) lo almacene. `core/credentials.js:31` llama `FieldCrypto.create(this._masterKey)` sin salt y sin pasarle storage. **Fuera de scope** (la tarea prohíbe tocar otros archivos core).

2. **Lanzar si no se provee salt explícito** (opción mínima del enunciado, análoga a FIX-13) — rompería `core/credentials.js` y su suite `tests/credentials.test.js` (`beforeEach` → `vault.init()` → `FieldCrypto.create(masterKey)` sin salt). La tarea exige "sin romper tests existentes". Verificado: `tests/credentials.test.js` usa `vault.init()` en cada test. Hacer el salt obligatorio rompería los 8 tests de credentials.

Una opción intermedia (salt aleatorio **no persistido** por instancia) pasarría los tests de credentials (que usan una sola instancia por test) pero **rompería la decryptión tras restart en producción** — exactamente el escenario que el enunciado prohíbe ("los datos ya encriptados con un salt anterior quedan indescifrables tras un restart"). Descartada por ser peor que el estado actual.

**Decisión:** dejar `FieldCrypto.create` sin cambios en este fix y marcarlo BLOQUEADO, per ABORTAR-SI del enunciado (1 de 5 hallazgos parcial por razón legítima de scope). El fix correcto requiere modificar `core/credentials.js` para persistir/proveer el salt — tarea de un FIX futuro fuera de este scope. **No se agregó test para FieldCrypto** porque no hubo cambio de comportamiento que testear.

> Nota: `EncryptedAdapter` (el otro call site del hallazgo, ~L1658) sí tenía storage vía `inner` y **sí** se completó con la opción primaria del enunciado (salt aleatorio persistido). El hallazgo queda PARCIAL: 1 de 2 call sites arreglado, el otro bloqueado por dependencia fuera de scope.

---

## Hallazgo 5 — `catch {}` vacíos

**4 sitios, cambios puntuales:**

1. **`Collection.import`** (~L1232): el `catch` atrapaba TODO. Ahora filtra por mensaje (`/Duplicate|Unique constraint/i` — los mensajes reales que emite `insert`/`_updateDoc` para violaciones de unicidad) y **re-lanza** cualquier otro error (validación, clone, corrupción). Duplicados legítimos se siguen saltando.

2. **`DocStore._emit`** (~L1318): el `catch {}` silenciaba fallos de watchers. Ahora `console.error(...)` loguea el error del watcher que falló **sin interrumpir** la notificación a los demás (mantiene el aislamiento entre watchers).

3. **`Table.addColumn`** (~L1545): `catch {}` → `console.error` con el nombre de la columna.

4. **`Auth.init`** (~L1990): los 3 `catch {}` de creación de índices → `console.error` cada uno.

**Tests (Hallazgo 5, sobre `Collection.import` — el único con re-throw):**
- `salta duplicados legitimos (Duplicate _id / Unique constraint)`: 2 duplicados saltados, 1 válido insertado, `count === 1`.
- `re-lanza errores NO relacionados a duplicados (no los traga)`: un doc con una función (`structuredClone` lanza "The object can not be cloned." — error no de duplicado) → `import` re-lanza; el doc fallido no se insertó. Verificado el mensaje de `structuredClone` en Bun previo al test.

> `Table.addColumn`, `Auth.init` y `_emit` no recibieron test dedicado: el enunciado pide ahí solo visibilidad (`console.error`), no cambio de control-flow re-lanzable. Verificado que no rompen sus suites existentes (Auth, Table, credentials).

---

## Verificación de fixes previos (DoD #6)

- **Prototype pollution** (`describe('Prototype pollution protection')`, 8 tests): pasan.
- **ReDoS** (`$regex rejects catastrophic (ReDoS) patterns`): pasa.
- Filtro `--test-name-pattern "ReDoS|pollution|__proto__|constructor.prototype|legítimos"` → 9 pass, 0 fail.

No se revirtieron ni tocaron las zonas de esos fixes.

---

## Salida REAL de `bun test tests/` (DoD #7, #8)

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

      at <anonymous> (D:\Repo\projecto\automators-kit\tests\memory.test.js:320:32)
(fail) Dream Cycle > dream heuristic merges duplicates [0.74ms]
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
...
tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-U1sqKT\evil.js

 538 pass
 1 fail
 1144 expect() calls
Ran 539 tests across 21 files [6.24s]
```

**Único fail:** `tests/memory.test.js` → `Dream Cycle > dream heuristic merges duplicates` (`expect(report.duration_ms).toBeGreaterThan(0)`, received `0`). Es el **fail preexistente conocido y flaky de timing** que el enunciado indica no tocar y que no cuenta en contra. Re-corrido `bun test tests/memory.test.js` → 32 pass / 1 fail (mismo test, flaky de `duration_ms`). **0 fallos nuevos respecto al baseline.**

**Suite `tests/db.test.js` aislada:** `71 pass, 0 fail, 158 expect() calls` (62 originales + 9 nuevos FIX-20).