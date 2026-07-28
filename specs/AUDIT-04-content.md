CONTEXTO: Sos un auditor de código, NO un implementador. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit de automatización JS vanilla (ESM), cero dependencias npm, corre en Bun/Deno/Node. No sabés nada del historial del proyecto más allá de lo que leas en los archivos.

OBJETIVO: Auditar los siguientes archivos buscando bugs de SEGURIDAD, CORRECTNESS y COMPLEJIDAD excesiva:
- core/cms.js
- core/portable-text.js
- core/plugins.js
- core/cron.js
- core/parallel.js

Buscá específicamente (no te limites a esto, es guía):
- XSS almacenado si portable-text/cms renderiza HTML de usuario sin sanitizar
- Path traversal en operaciones de archivos del CMS
- Plugins de terceros con acceso sin sandboxear a APIs sensibles (filesystem, red, proceso)
- Expresiones cron mal parseadas que puedan causar DoS (loop tight) o ejecuciones no deseadas
- Condiciones de carrera en ejecución paralela (core/parallel.js): resultados mezclados entre tareas, errores de una tarea que corrompen el estado de otra
- Manejo de errores que trague excepciones silenciosamente
- Funciones con complejidad ciclomática/nesting excesivo

ARCHIVOS: Leé SOLO los 5 archivos de arriba (podés leer tests/*.test.js correspondientes para contexto, NO los edites). NO edites NADA — sos auditor, no implementador.

DEFINICIÓN DE HECHO: Escribí `specs/AUDIT-04-content-REPORT.md` con esta estructura exacta:

```
# Audit Report 04 — Content & misc (cms, portable-text, plugins, cron, parallel)

## Hallazgos

### [SEVERIDAD: CRITICAL|HIGH|MEDIUM|LOW] Título corto
- Archivo: core/X.js
- Línea: N (o rango)
- Evidencia: ```cita literal del código```
- Descripción: qué está mal y por qué importa
- Escenario de explotación/fallo concreto
- Sugerencia de fix (1-2 líneas, NO la implementes)

## Resumen
- Archivos revisados: N/5
- Hallazgos: X critical, Y high, Z medium, W low
- Sin hallazgos en: [lista si aplica]
```

Si NO encontrás hallazgos en un archivo, decilo explícito. Cada hallazgo DEBE tener evidencia literal citada, no paráfrasis.

REGLAS: Sos read-only. NO uses Edit/Write sobre ningún archivo salvo `specs/AUDIT-04-content-REPORT.md`. No corras comandos que modifiquen el repo.

ABORTAR SI: no podés leer alguno de los 5 archivos → documentalo como "archivo no accesible" y seguí con los demás.

ENTREGA: `specs/AUDIT-04-content-REPORT.md` completo. Al terminar respondé SOLO: LISTO + 1 línea con el conteo de hallazgos por severidad.
