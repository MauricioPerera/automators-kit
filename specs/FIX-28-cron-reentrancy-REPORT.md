# FIX-28 — Cron: guarda anti-reentrada (ejecuciones solapadas)

## Hallazgo (MEDIUM)
`core/cron.js` `_tick()` disparaba `_execute(task)` fire-and-forget (sin `await`) y sin flag de "en ejecución". Si el handler era más lento que el intervalo entre ticks, múltiples ejecuciones del mismo job corrían concurrentemente.

## Qué cambié (solo `core/cron.js`)
1. **`add()`** — agregué dos campos al objeto task:
   - `running: false` — guarda anti-reentrada.
   - `skippedOverlaps: 0` — contador de ejecuciones salteadas por solapamiento (visibilidad).
2. **`list()`** — expongo `running` y `skippedOverlaps` en el status de cada job.
3. **`_execute(task)`** — lógica de guarda:
   ```js
   async _execute(task) {
     if (task.running) { task.skippedOverlaps++; return; }  // salta si ya está corriendo
     task.running = true;
     try {
       await task.handler();
       task.lastRun = Date.now();
       task.runs++;
     } catch (err) {
       task.errors++;
       console.error(`[Cron] Error in '${task.name}':`, err.message);
     } finally {
       task.running = false;   // se limpia siempre, aun si el handler lanza
     }
   }
   ```
   - `task.running = true` se setea sincrónicamente antes del primer `await`, así una invocación concurrente (segundo tick) lo ve y se salta.
   - El `finally` garantiza el release del flag incluso ante excepción del handler.

No toqué el fix previo del parser rango/step (`parseField`, ramas `*/N`, `N-M`, `N/step`).

## Tests agregados (`tests/cron.test.js`)
1. **`does not run overlapping executions of the same job (reentrancy guard)`** — handler lento (promesa no resuelta). Se disparan dos `_execute` concurrentes. La 2da se salta sincrónicamente: `skippedOverlaps === 1`, `running === true`, sin overlap del handler. Tras resolver, `runs === 1`.
2. **`clears running flag after completion and allows a later execution`** — tras la 1ra ejecución el flag queda en `false` y un tick posterior dispara una 2da ejecución normal (`runs === 2`).
3. **`clears running flag even when the handler throws`** — handler que lanza en la 1ra invocación: `errors === 1`, `running === false` tras ella, y una ejecución posterior corre normalmente (`runs === 1`, `calls === 2`). Confirma que el `finally` libera el flag pese a la excepción.

## Verificación del fix previo (parser rango/step)
`bun test tests/cron.test.js` → 25 pass, 0 fail. Incluye intactos:
- `parses explicit range/step, capped at range upper bound` (`5-10/2` → `[5,7,9]`)
- `parses */N (star step) using full field range — unchanged`
- `parses N/step (bare, no explicit range) up to field max — unchanged`

## Salida real de `bun test tests/`
```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom
[Cron] Error in 'j': boom

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.77ms]
[AgentMemory] dedup scan capped: collection has 6 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 7 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 8 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.
[AgentMemory] dedup scan capped: collection has 9 docs (limit 5); scanning only the 5 most recent — full O(n²) scan skipped.

tests\plugins.test.js:
[Hook] Error in err: boom
[Plugins] Failed to load 'evil': Plugin path escapes plugins directory: ../../../../etc/passwd
[Plugins] Loaded: fixture v1.2.3
[Plugins] Failed to load 'evil2': Plugin path escapes plugins directory: C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-outside-sLGQaP\evil.js
[Hook] Error in block: validation-blocked
[Hook] Error in err: boom
[Hook] Error in err: boom
[Plugins] Failed to load 'critical': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-mh5EOD\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-jpjnJ6\does-not-exist\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'
[Plugins] Failed to load 'optional2': Cannot find module 'C:\Users\ADMINI~1\AppData\Local\Temp\akit-plugins-req-zC2jNG\nope\index.js' from 'D:\Repo\projecto\automators-kit\core\plugins.js'

tests\triggers.test.js:
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: boom
[Trigger] Poll error for wf1: transient
[Trigger] Poll error for wf1: transient

 553 pass
 1 fail
 1191 expect() calls
Ran 554 tests across 21 files. [5.55s]
```

**Resultado:** 554 tests, 553 pass, 1 fail. El único fallo es el preexistente y conocido `memory.test.js` (`dream heuristic merges duplicates`, timing flaky, `duration_ms === 0`) — no relacionado con este fix, no se tocó. **0 fallos nuevos respecto al baseline.**