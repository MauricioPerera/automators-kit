CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/triggers.js` YA tiene un fix previo aplicado (SSRF guard con `assertPublicUrl` de `core/net-guard.js`, en el método `register()` para triggers tipo POLL). NO toques ni reviertas ese fix — es tuyo el trabajo de agregar 2 fixes MÁS al mismo archivo, sin tocar el guard SSRF existente.

Una auditoría de seguridad encontró 2 hallazgos HIGH en `core/triggers.js` que te tocan a vos:

## Hallazgo 1: Webhook sin autenticación — path adivinable dispara el workflow
- Archivo: core/triggers.js, `register()` (líneas ~52-53) y `fireWebhook` (líneas ~109-114).
- Evidencia:
```js
case TriggerType.WEBHOOK:
  this._webhooks.set(trigger.config.path || workflowId, workflowId);
```
```js
fireWebhook(path, data) {
  const workflowId = this._webhooks.get(path);
  if (!workflowId) return null;
  this._onTrigger(workflowId, { trigger: 'webhook', data });
  return workflowId;
}
```
- Cualquier request HTTP que acierte el `path` (que por defecto ES el `workflowId`, fácil de adivinar/enumerar) dispara la ejecución del workflow con el body entregado. No hay token/secreto/firma que valide que el caller es legítimo.
- Fix: agregá soporte para un secreto opcional por webhook (`trigger.config.secret`). En `fireWebhook`, aceptá un parámetro adicional (p.ej. `providedSecret`) y, si el trigger registrado tiene `config.secret` configurado, rechazá el disparo (retorná `null` o lanzá error controlado, seguí el patrón de retorno que ya usa la función) si `providedSecret` no coincide (comparación exacta, no hace falta constant-time para este fix — documentalo como posible mejora futura si querés). Si el trigger NO tiene `config.secret` configurado, mantené el comportamiento actual (sin romper retrocompatibilidad para webhooks que no configuraron secreto — es decisión del que arma el workflow, no forzada).

## Hallazgo 2: Poll con `interval: 0` → bucle ajustado (DoS local)
- Archivo: core/triggers.js, líneas ~57-58.
- Evidencia:
```js
const interval = trigger.config.interval || 60000;
const timer = setInterval(async () => { ... }, interval);
```
- `interval: 0` (o cualquier valor muy bajo) hace que `setInterval` dispare el callback (que hace `fetch`, async) tan rápido como pueda el event loop, apilando requests sin límite y pudiendo colgar/saturar el runtime.
- Fix: clampeá `interval` a un mínimo razonable, p.ej. `Math.max(trigger.config.interval || 60000, 1000)` — nunca menos de 1000ms entre polls.

ARCHIVOS: Toca SOLO `core/triggers.js` y `tests/triggers.test.js`. NO toques el guard SSRF (`assertPublicUrl`) ya existente en el archivo — solo agregá tus 2 fixes. NO toques `core/nodes.js`, `core/a2e.js`, `core/net-guard.js` — otros devs trabajan ahí en paralelo (o ya terminaron, pero no son tu scope).

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/triggers.test.js: un webhook registrado CON `config.secret` rechaza `fireWebhook(path, data)` si no se pasa el secreto correcto (o se pasa uno incorrecto), y lo acepta con el secreto correcto.
2. Test que confirma que un webhook SIN `config.secret` sigue funcionando exactamente como antes (sin requerir secreto) — no rompiste retrocompatibilidad.
3. Test que confirma que un trigger POLL con `config.interval: 0` (o negativo) termina registrado con un intervalo real clampeado a mínimo 1000ms (podés inspeccionar el timer/interval real registrado, o verificar indirectamente que no se dispara más de 1 vez por segundo en una ventana corta de tiempo).
4. Confirmá que el guard SSRF existente (assertPublicUrl) sigue funcionando — corré los tests relacionados que ya existen y no los rompiste.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix SSRF existente.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-10-webhook-poll-dos-REPORT.md` (qué cambiaste en cada hallazgo, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
