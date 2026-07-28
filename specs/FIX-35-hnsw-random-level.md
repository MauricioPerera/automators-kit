CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline actual: 570 tests, 569 pass, 1 fail conocido y preexistente (`memory.test.js`, timing flaky, no relacionado — no lo toques, no cuenta en tu contra).

IMPORTANTE: `core/hnsw.js` YA tiene un fix previo (`remove()` degradación de grafo + free-list de memoria). NO lo toques ni reviertas — es tuyo agregar 1 fix MÁS.

Una auditoría encontró un LOW en `core/hnsw.js` que te toca a vos:

## Hallazgo: `_randomLevel` puede entrar en loop infinito si `Math.random()` devuelve `0`
- Líneas ~323-325, ~171-173.
```js
_randomLevel() {
  return Math.floor(-Math.log(Math.random()) * this.ml);
}
```
```js
while (this.levels.length <= nodeLevel) {
  this.levels.push(new Map());
}
```
- `Math.random()` puede devolver `0.0` (raro pero posible). `-Math.log(0) === Infinity` → `nodeLevel = Infinity` → el `while` nunca termina, colgando el proceso y agotando memoria.
- Fix: en `_randomLevel`, cláseá `Math.random()` a un mínimo positivo antes del `Math.log` — p.ej. `const r = Math.max(Math.random(), Number.MIN_VALUE);` y usá `r` en vez de `Math.random()` directo. Alternativa/complemento: clampeá `nodeLevel` resultante a un máximo razonable (p.ej. 32) para robustez adicional.

ARCHIVOS: Toca SOLO `core/hnsw.js` y `tests/hnsw.test.js`. NO toques el fix previo ya existente (remove/free-list).

DEFINICIÓN DE HECHO:
1. Test nuevo: mockeando `Math.random` para que devuelva `0` en alguna llamada (podés usar `Math.random = () => 0` temporalmente en el test y restaurarlo después), confirmá que `_randomLevel()` (o el método público que lo invoca, como `add`) NO cuelga y produce un nivel finito y razonable.
2. Confirmá que el fix previo (remove/free-list) sigue funcionando — corré esos tests y no los rompiste.
3. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
4. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados. No reviertas el fix previo. Restaurá `Math.random` global tras el test si lo mockeaste (no dejes el mock global filtrado a otros tests).

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-35-hnsw-random-level-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
