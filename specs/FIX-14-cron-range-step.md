CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un HIGH que te toca arreglar a vos:

## Hallazgo: Parser cron — `rango/step` ignora el límite superior del rango → ejecuciones no deseadas
- Archivo: core/cron.js, líneas ~43-47.
- Evidencia:
```js
} else if (part.includes('/')) {
  const [range, step] = part.split('/');
  const stepN = parseInt(step);
  if (isNaN(stepN) || stepN <= 0) throw new Error(`Invalid cron step: ${step}`);
  const start = range === '*' ? min : parseInt(range);
  for (let i = start; i <= max; i += stepN) values.add(i);
```
- Para un campo tipo `5-10/2`, `range = '5-10'`. `parseInt('5-10')` da `5` (parseInt se detiene en el primer carácter no-dígito, el `-`). El límite superior `10` se DESCARTA silenciosamente, y el bucle avanza desde `5` hasta `max` (p.ej. 59 para minutos) en vez de detenerse en `10`.
- Escenario de fallo real: `cron.add('report', '5-10/2 * * * *', fn)` — la intención es que dispare en los minutos 5, 7, 9 (dentro del rango 5-10, cada 2). En cambio dispara en 5, 7, 9, 11, 13, ..., 59 — 28 veces por hora en vez de 3. Si el job tiene efectos externos (envío de reportes, llamadas a APIs, cobros), esto causa ejecuciones no deseadas repetidas.
- Fix: cuando `range` contiene un `-` (es un rango explícito tipo `lo-hi`, no `*`), parseá `lo` y `hi` por separado (`range.split('-')`) y usá `hi` como cota superior del bucle en vez de `max` (el máximo del campo completo). Si `range === '*'`, el comportamiento actual (usar `min`/`max` del campo) sigue siendo correcto — no lo cambies. Asegurate de manejar bien el caso `range` sin `-` (un solo número, tipo `5/2` que significa "desde 5 hasta el máximo del campo, cada 2" — ESE caso SÍ debe seguir usando `max` como cota, es el comportamiento actual y correcto para un rango no explícito).

ARCHIVOS: Toca SOLO `core/cron.js` y `tests/cron.test.js`. NO toques otros archivos core.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/cron.test.js que confirma que la expresión cron `5-10/2 * * * *` (o el formato de campo equivalente que uses para testear el parser directamente) produce exactamente los valores `[5, 7, 9]` para el campo de minutos, NO incluye 11, 13, ..., 59.
2. Test que confirma que el caso `range === '*'` (p.ej. `*/15`) sigue funcionando igual que antes (usa min/max del campo completo).
3. Test que confirma que el caso `N/step` sin rango explícito (p.ej. `5/2`, sin guión) sigue funcionando igual que antes (desde `5` hasta el máximo del campo).
4. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
5. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-14-cron-range-step-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
