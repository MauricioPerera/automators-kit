CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/queue.js` YA tiene un fix previo (lease de jobs stuck + timeout de handler). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS.

Una auditoría encontró un LOW en `core/queue.js` que te toca a vos:

## Hallazgo: `JobQueue.stop()` no limpia `_flushTimer`
- Líneas ~94-100 (`_markDirty`), ~112-119 (`stop`, revisá el código real para confirmar el rango exacto).
```js
_markDirty() {
  if (this._flushTimer) return;
  this._flushTimer = setTimeout(() => {
    this.db.flush();
    this._flushTimer = null;
  }, 500);
}
```
- Si `stop()` se llama mientras hay un `_flushTimer` pendiente, ese timer sigue vivo y dispara `this.db.flush()` después de que la queue "paró" — puede interactuar mal con recursos ya liberados/cerrados, o simplemente mantener el proceso vivo innecesariamente.
- Fix: en el método `stop()` (revisá su implementación real), agregá `if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }` — considerá si hace falta un flush final síncrono antes de limpiar (para no perder cambios pendientes) o si el `stop()` ya maneja eso de otra forma; documentá la decisión.

ARCHIVOS: Toca SOLO `core/queue.js` y `tests/queue.test.js`. NO toques el fix previo ya existente (lease/timeout).

DEFINICIÓN DE HECHO:
1. Test nuevo: marcar la queue como dirty (disparando `_markDirty` indirectamente vía alguna operación que lo haga) y llamar `stop()` inmediatamente después — confirmá que no queda un timer huérfano corriendo (podés verificar indirectamente, p.ej. esperando más que el delay del flush timer tras `stop()` y confirmando que no hay efectos secundarios inesperados, o inspeccionando `this._flushTimer === null` si es accesible).
2. Confirmá que el fix previo (lease/timeout) sigue funcionando — corré esos tests y no los rompiste.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-37-queue-flush-timer-REPORT.md` (qué cambiaste, decisión sobre flush final, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
