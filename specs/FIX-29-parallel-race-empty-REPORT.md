# FIX-29 — `parallelRace([])` con arreglo vacío cuelga indefinidamente

## Hallazgo
`core/parallel.js`, `parallelRace` (~líneas 175-214): con `tasks = []`, el `forEach` nunca invoca su callback, por lo que `resolve` nunca se llama y la `Promise` queda pending para siempre. `parallelMerge` ya manejaba el caso vacío (vía `Promise.all` sobre arreglo vacío, que resuelve enseguida); `parallelRace` no.

## Cambio aplicado
**Archivo:** `core/parallel.js`

Guard al inicio de `parallelRace`, antes de crear la `Promise`:

```js
// Empty task list: no winner possible. Resolve immediately instead of
// hanging forever (forEach never calls its callback, so the Promise would
// otherwise stay pending). Mirrors the all-failed shape: null resolved,
// winnerId -1, zero duration.
if (!tasks || tasks.length === 0) {
  return { resolved: null, winnerId: -1, duration: 0 };
}
```

Forma del resultado coherente con el caso "todas fallan" de la propia función (`{ resolved: null, winnerId: -1, duration }`), con `duration: 0` porque no hubo trabajo. También cubre `tasks` nulo/undefined por robustez.

No se tocaron otros archivos core.

## Tests agregados
**Archivo:** `tests/parallel.test.js` (dentro de `describe('parallelRace')`)

1. **`empty task list resolves instead of hanging`** — `await parallelRace([])` envuelto en `Promise.race` contra un reject a los 2000ms. Si el fix regresa, el test falla rápido por timeout en vez de colgar la suite. Verifica `resolved === null`, `winnerId === -1`, `duration === 0`.
2. **`non-empty race still works as before`** — 3 tasks con delays 50/10/30ms; confirma que gana el más rápido (`'b'`, `winnerId === 1`) y `duration >= 0`. Comportamiento normal inalterado.

## Verificación: `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom
[Cron] Error in 'j': boom

tests\memory.test.js:
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 7 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 8 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 9 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-YO8gJ5\evil.js
[Hook] Error in block: validation-blocked
[Hook] Error in err: boom
[Hook] Error in err: boom
[Plugins] Failed to load 'critical': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-U4baYp\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-qqI8fo\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional2': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-n2gsBD\nope\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'

tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 556 pass
 0 fail
 1201 expect() calls
Ran 556 tests across 21 files. [5.62s]
```

**Resultado:** 556 pass, 0 fail. 0 fallos nuevos respecto al baseline. (El flaky preexistente de `memory.test.js` no se manifestó en esta corrida; no fue tocado.)