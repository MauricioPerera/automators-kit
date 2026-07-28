CONTEXTO: Sos un desarrollador, NO auditor. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit JS vanilla (ESM), cero deps npm, corre en Bun. Suite: `bun test tests/`. Baseline conocido: 421 pass / 1 fail (`memory.test.js`, timing flaky en `dream()`, PREEXISTENTE y no relacionado — no lo toques, no cuenta en tu contra).

Una auditoría de seguridad encontró 2 hallazgos CRITICAL (mismo archivo, mismo fix) que te toca arreglar a vos:

## Hallazgo: XSS almacenado en `renderInlineMarks`
- Archivo: core/portable-text.js, función `renderInlineMarks` (líneas ~97-104).
- La función aplica 4 `.replace` con regex markdown-like (`**bold**`, `*italic*`, `` `code` ``, `[link](url)`) sobre el texto CRUDO, sin escapar HTML antes. El texto capturado en cada grupo ($1, y $2 para el link) se inyecta directo en el HTML de salida.
- El archivo YA TIENE una función `escHtml` (usada en otros lugares del mismo archivo para `alt`, `caption`, `language`, `attribution`) — reusala, no inventes otra.
- Problema 1: cualquier texto de bloque (paragraph/heading/list/quote) que contenga HTML/`<script>` se renderiza sin escapar.
- Problema 2 (link): `[texto](url)` → `<a href="url">texto</a>` sin escapar NINGUNO de los dos. La URL permite `javascript:alert(1)` como `href` (XSS al hacer click) y el texto permite breakout de la etiqueta `<a>`.

Fix: en `renderInlineMarks`, escapá el texto con `escHtml` ANTES de aplicar los replaces de markdown (así el HTML que generás vos —`<strong>`, `<em>`, etc.— no se escapa a sí mismo, pero el contenido del usuario sí). Para el link específicamente: además de escapar el texto y la URL, validá que la URL no empiece con `javascript:` (case-insensitive, con posibles espacios/tabs antes como `java\tscript:`) — si el esquema no es http/https/mailto/relative, o reemplazá por un href seguro (p.ej. `#`) o quitá el link y dejá el texto plano. Elegí el approach y documentalo.

ARCHIVOS: Toca SOLO `core/portable-text.js` y `tests/portable-text.test.js`. NO toques `core/nodes.js`, `core/triggers.js`, `core/a2e.js`, `core/db.js`, `core/plugins.js` — otros devs trabajan ahí en paralelo.

DEFINICIÓN DE HECHO:
1. Test nuevo en tests/portable-text.test.js que confirma que un bloque de texto tipo `paragraph` con `<script>alert(1)</script>` en su `text` produce HTML donde el script NO aparece sin escapar (debe aparecer como `&lt;script&gt;` o equivalente, no ejecutable).
2. Test nuevo que confirma que `[click](javascript:alert(1))` NO produce un `href="javascript:alert(1)"` en el HTML final.
3. Test nuevo que confirma que un link legítimo `[texto](https://example.com)` sigue funcionando y generando un `<a href="https://example.com">texto</a>` (o el equivalente escapado) correctamente.
4. Confirmá que el markdown normal (`**bold**`, `*italic*`, código) sigue renderizando las etiquetas HTML correctas (`<strong>`, `<em>`, `<code>`) y no las escapa a sí mismas.
5. `bun test tests/` completo: 0 fallos nuevos respecto al baseline.
6. Pegá la salida REAL de `bun test tests/` en el REPORT.

CCDD GATE: no aplica (MCP vacío, código existente con suite propia — el veredicto es la suite, no un contrato).

REGLAS: no proceses en foreground que no terminen solos. No toques nada fuera de los archivos listados.

ABORTAR SI: el HECHO resulta inalcanzable por una razón legítima → documentalo con evidencia y respondé BLOQUEADO + 1 línea.

ENTREGA: `specs/FIX-04-portable-text-xss-REPORT.md` (qué cambiaste, tests agregados, salida real de bun test). Al terminar respondé SOLO: LISTO + 1 línea.
