CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 490 tests, 489 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/triggers.js` YA tiene 2 fixes previos (SSRF guard + webhook secret/interval clamp). NO los toques ni reviertas — es tuyo agregar 1 fix MÁS, en zona relacionada pero distinta.

Una auditoría encontró un MEDIUM en `core/triggers.js` que te toca a vos:

## Hallazgo: Errores del poller tragados silenciosamente; el intervalo sigue corriendo para siempre
- Líneas ~75-77.
```js
} catch (err) {
  console.error(`[Trigger] Poll error for ${workflowId}:`, err.message);
}
```
- Cualquier fallo del poll (red, JSON inválido, 500) se loguea a stderr y el `setInterval` continúa indefinidamente. No hay circuit-breaker ni contador de fallos consecutivos.
- Fix: llevá un contador de fallos consecutivos por poller (reseteado a 0 en cada poll exitoso). Al superar un umbral configurable (p.ej. `maxConsecutiveFailures`, default razonable como 5), desregistrá el poller (limpiá el `setInterval` con `clearInterval` y quitalo de `this._pollers`) y marcá/reportá el trigger como en estado de error de alguna forma observable — mirá si la clase ya tiene algún mecanismo de callback de error o estado que puedas reusar (p.ej. algo similar a `_onTrigger` pero para errores); si no existe ninguno, agregá un campo de estado simple en el poller registrado (p.ej. `status: 'error'`, `lastError: err.message`) que se pueda consultar externamente.

ARCHIVOS: Toca SOLO `core/triggers.js` y `tests/triggers.test.js`. NO toques los 2 fixes previos ya existentes (SSRF, webhook secret/interval).

DEFINICIÓN DE HECHO:
1. Test nuevo: un poller que falla repetidamente (mockeá `fetch` para que siempre rechace o devuelva error) se desregistra automáticamente tras superar el umbral de fallos consecutivos — confirmá que el `setInterval` ya no está activo (o que el poller ya no aparece en la lista de pollers registrados) después de N fallos.
2. Test nuevo: un poller que falla algunas veces pero luego tiene éxito NO se desregistra (el contador de fallos consecutivos se resetea en éxito).
3. Confirmá que los 2 fixes previos (SSRF, webhook) siguen funcionando — corré esos tests y no los rompiste.
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas los fixes previos.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-25-triggers-poller-errors-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
