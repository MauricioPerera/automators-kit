CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 452 tests, 451 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró un HIGH que te toca arreglar a vos:

## Hallazgo: Secreto JWT por defecto predecible si no se configura `opts.secret`
- Archivo: core/cms.js, línea ~152.
- Evidencia:
```js
this.auth = new Auth(this.db, {
  secret: opts.secret || 'akit-dev-secret',
  tokenExpiry: opts.tokenExpiry || 7 * 24 * 60 * 60,
});
```
- Si una instancia de `CMS` se construye sin `opts.secret`, TODOS los JWT se firman con el secreto hardcodeado `'akit-dev-secret'`, público en el código fuente del repo. Un atacante puede forjar `{ role: 'admin' }` firmado con ese secreto conocido y obtener acceso administrador total.
- Fix: en producción esto debe fallar fuerte, no caer a un default inseguro. Pero hay que preservar la experiencia de desarrollo/testing (el repo tiene una suite de tests que probablemente instancia `CMS` sin secret en varios lugares — mirá `tests/cms.test.js` e `integration.test.js` antes de decidir el approach exacto). Opciones válidas (elegí la que rompa menos tests, documentá cuál elegiste):
  (a) Si no hay `opts.secret`, generar un secreto aleatorio criptográficamente seguro por instancia (con Web Crypto API, `crypto.getRandomValues`, coherente con cómo el repo ya maneja crypto en otros módulos como `credentials.js` si existe ese patrón) en vez de un string hardcodeado. Esto mantiene los tests funcionando (cada instancia sigue teniendo UN secreto, aunque distinto) pero elimina el secreto PREDECIBLE/público — ya no es forjable sin conocer el secreto generado. Documentá que esto significa que los tokens no sobreviven un restart del proceso si no se configuró un secreto persistente explícito (trade-off aceptable para dev; en producción real se recomienda `opts.secret` explícito de todos modos).
  (b) Alternativa más estricta: lanzar error si `opts.secret` no está definido o tiene longitud insuficiente (p.ej. < 16 caracteres), rompiendo instancias que no configuren secret explícito. Solo elegí esta si (a) resulta inviable por algún motivo real que encuentres en el código.
  NO dejes el string hardcodeado como fallback bajo ninguna circunstancia.

ARCHIVOS: Toca SOLO `core/cms.js` y `tests/cms.test.js`. Si tests en OTROS archivos (p.ej. `tests/integration.test.js`) instancian `CMS` sin `opts.secret` y tu fix (opción b) los rompe, NO los edites vos — documentá cuáles se rompen en el REPORT y preferí la opción (a) para no requerir tocar archivos de otros devs. Si estás seguro de que necesitás la opción (b) y eso implica editar `tests/integration.test.js`, hacelo pero DECLARALO explícito en el REPORT (excepción justificada al alcance de archivos).

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/cms.test.js que confirma que dos instancias de `CMS` sin `opts.secret` NO comparten el mismo secreto/no generan tokens forjables con el string `'akit-dev-secret'` (p.ej.: crear un token con una instancia, confirmar que NO es válido si se intenta verificar manualmente con el secreto hardcodeado viejo).
2. Test que confirma que `opts.secret` explícito sigue funcionando igual que antes (comportamiento no roto para el caso configurado).
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline (si elegiste la opción (b) y algo se rompe fuera de tu scope, documentalo en vez de forzar).
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados salvo la excepción documentada arriba.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-13-cms-jwt-secret-REPORT.md` (qué opción elegiste y por qué, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
