CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/cron.js` YA tiene un fix previo (parser de rango/step). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS, en zona distinta.

Una auditoría encontró un MEDIUM en `core/cron.js` que te toca a vos:

## Hallazgo: Ejecuciones solapadas del mismo job (sin guarda anti-reentrada)
- Líneas ~163-188.
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
- `_execute` no se awaitea desde `_tick` (fire-and-forget) ni hay flag de "en ejecución". Si el handler es más lento que el intervalo entre ticks, múltiples ejecuciones del mismo job corren concurrentemente.
- Fix: agregá un flag `task.running` (booleano). Al entrar a `_execute`, si `task.running === true`, saltá esa ejecución (no la dispares de nuevo) — opcionalmente incrementá un contador `task.skippedOverlaps` para visibilidad. Seteá `task.running = true` al empezar y `task.running = false` en un `finally` (para que se limpie incluso si el handler lanza).

ARCHIVOS: Toca SOLO `core/cron.js` y `tests/cron.test.js`. NO toques el fix previo ya existente (parser rango/step).

DEFINICIÓN DE HECHO:
1. Test nuevo: un job con handler LENTO (usá una promesa que tarda más que el intervalo de tick del test, o simulá 2 ticks mientras el handler sigue corriendo) NO se ejecuta 2 veces en simultáneo — confirmá que la segunda invocación se salta mientras la primera sigue corriendo.
2. Test nuevo: tras terminar la primera ejecución, un tick posterior SÍ dispara una nueva ejecución normal (el flag se limpia correctamente, incluso si el handler anterior lanzó una excepción).
3. Confirmá que el fix previo (parser rango/step) sigue funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-28-cron-reentrancy-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
