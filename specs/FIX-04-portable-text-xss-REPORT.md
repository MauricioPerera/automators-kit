# FIX-04 — XSS almacenado en `renderInlineMarks` (`core/portable-text.js`)

**Fecha:** 2026-07-28
**Archivos tocados:** `core/portable-text.js`, `tests/portable-text.test.js` (únicos permitidos).
**Hallazgos cubiertos:** ambos CRITICAL del mismo archivo (XSS en texto de bloque + XSS en link `[texto](url)`).

---

## Qué cambié

### `renderInlineMarks` (core/portable-text.js)

**Antes:** aplicaba 4 `.replace` markdown (`**bold**`, `*italic*`, `` `code` ``, `[link](url)`) sobre el texto CRUDO sin escapar HTML. El contenido del usuario (`$1`, `$2`) se inyectaba directo en el HTML de salida → XSS almacenado.

**Después:**

```js
function renderInlineMarks(text) {
  if (!text || typeof text !== 'string') return text || '';
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, (m, label, url) => {
      const href = isSafeUrl(url) ? url : '#';
      return `<a href="${href}">${label}</a>`;
    });
}
```

**Approach elegido y documentado:**

1. **Escapar PRIMERO.** Se aplica `escHtml` (la función ya existente en el archivo, reutilizada — no se inventó otra) sobre el texto crudo ANTES de los replaces markdown. Así:
   - El contenido del usuario (`<script>`, `<img onerror=...>`, `"`, `&`, etc.) queda neutralizado como `&lt;script&gt;`, `&quot;`, `&amp;`...
   - Las etiquetas HTML que generamos nosotros (`<strong>`, `<em>`, `<code>`, `<a>`) se insertan como literales en los strings de reemplazo, **no** salen del input del usuario, por lo que NO se auto-escapan. Los delimitadores markdown (`*`, backtick, `[`, `]`, `(`, `)`) no son afectados por `escHtml`, así que el parseo markdown sigue funcionando sobre el texto ya escapado.
   - Para el link, `$1` (texto) y `$2` (url) ya vienen escapados de la pasada de `escHtml`, así que el texto no puede romper la etiqueta `<a>` y la URL no puede romper el atributo `href` con `"` → `&quot;`.

2. **Validación de esquema de URL (`isSafeUrl`, función nueva).** Aún con el escape, `javascript:alert(1)` no contiene chars HTML especiales y llegaría intacto al `href`. Por eso se valida el esquema:
   - **Whitelist:** se permite sólo `http:`, `https:`, `mailto:` y URLs relativas (sin esquema — `/path`, `#anchor`, `page.html`).
   - **Cualquier otro esquema** (`javascript:`, `data:`, `vbscript:`, etc.) → se reemplaza el `href` por `#` (approach "href seguro" del enunciado) y se conserva el texto del link. No se elimina el link: queda `<a href="#">texto</a>`.
   - **Obfuscación `java\tscript:`** — los navegadores strippen ASCII whitespace/tab/newline/control chars de la URL antes de resolver el esquema. `isSafeUrl` replica eso: hace `String(url).replace(/[\s\x00-\x1F]+/g, '')` sobre una copia (sólo para el chequeo, no sobre el href final) y luego testa el esquema. Así `java\tscript:alert(1)` → `javascript:alert(1)` → detectado y bloqueado. El char-class usa `\s` (cubre tab/newline/CR/space) + rango C0 `\x00-\x1F`.

`isSafeUrl` opera sobre la URL ya escapada por `escHtml`; como `escHtml` no toca `:`, letras ni el esquema, el chequeo es válido.

---

## Tests agregados (tests/portable-text.test.js)

Nuevo `describe('toHTML — XSS protection in renderInlineMarks')` con 11 tests:

| # | Test | Cubre |
|---|------|-------|
| 1 | `escapes <script> inside paragraph text` | HECHO 1 — `paragraph` con `<script>alert(1)</script>` → aparece `&lt;script&gt;`, NO `<script>` |
| 2 | `escapes HTML inside heading text` | HECHO 1 — heading con `<img src=x onerror=...>` se escapa |
| 3 | `escapes HTML inside list items and quotes` | HECHO 1 — list items y quote también pasan por `renderInlineMarks` y se escapan |
| 4 | `blocks javascript: link href` | HECHO 2 — `[click](javascript:alert(1))` no produce `href="javascript:..."`, queda `href="#"` |
| 5 | `blocks obfuscated java\tscript: link href` | HECHO 2 — bypass con tab neutralizado |
| 6 | `blocks data: and vbscript: link hrefs` | HECHO 2 — otros esquemas peligrosos |
| 7 | `renders a legitimate https link` | HECHO 3 — `[texto](https://example.com)` → `<a href="https://example.com">texto</a>` |
| 8 | `renders a legitimate relative link` | HECHO 3 — `/path/page` sigue funcionando |
| 9 | `renders a mailto link` | HECHO 3 — `mailto:` whitelisted |
| 10 | `still renders bold/italic/code tags` | HECHO 4 — `<strong>`, `<em>`, `<code>` se generan y NO se auto-escapan |

HECHO 5 y 6: ver salida de suite abajo (0 fallos nuevos vs baseline).

---

## Salida REAL de `bun test tests/`

```
bun test v1.3.14 (0d9b296a)

tests\cron.test.js:
[Cron] Error in 'fail': boom

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
(fail) Dream Cycle > dream heuristic merges duplicates [0.84ms]

tests\plugins.test.js:
[Hook] Error in err: boom

 446 pass
 1 fail
 842 expect() calls
Ran 447 tests across 20 files. [4.08s]
```

**Veredicto suite:**
- `446 pass / 1 fail` total.
- El único fail es `memory.test.js > Dream Cycle > dream heuristic merges duplicates` (`duration_ms` = 0) — el flaky de timing en `dream()` **PREEXISTENTE y documentado en el baseline**, no relacionado con este fix. No se tocó `memory.test.js` ni `core/memory.js`.
- **0 fallos nuevos** respecto al baseline (que era 421 pass / 1 fail; el repo tiene trabajo paralelo en otros módulos que explica el crecimiento de tests, pero ningún fallo nuevo proviene de este fix).
- `bun test tests/portable-text.test.js` aislado: **50 pass / 0 fail** (39 originales + 11 nuevos).

## Archivos no tocados (verificado)

No se modificaron `core/nodes.js`, `core/triggers.js`, `core/a2e.js`, `core/db.js`, `core/plugins.js` ni ningún otro archivo fuera de los dos listados. `git status` del working tree confirma sólo `core/portable-text.js` (mod) y `tests/portable-text.test.js` (mod) de este fix.