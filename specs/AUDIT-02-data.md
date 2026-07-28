CONTEXTO: Sos un auditor de código, NO un implementador. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit de automatización JS vanilla (ESM), cero dependencias npm, corre en Bun/Deno/Node. No sabés nada del historial del proyecto más allá de lo que leas en los archivos.

OBJETIVO: Auditar los siguientes archivos buscando bugs de SEGURIDAD, CORRECTNESS y COMPLEJIDAD excesiva:
- core/db.js (document DB tipo Mongo)
- core/vector.js
- core/hnsw.js (índice HNSW para búsqueda vectorial)
- core/memory.js (memoria de agentes)
- core/queue.js

Buscá específicamente (no te limites a esto, es guía):
- Inyección en queries/filtros del doc-DB (operadores tipo `$where`, eval de expresiones de usuario)
- Prototype pollution vía merge/set de documentos con claves de usuario (`__proto__`, `constructor`)
- Corrupción de datos: condiciones de carrera en escrituras concurrentes, pérdida de datos en fallos parciales
- Búsqueda vectorial degradada silenciosamente (p.ej. HNSW que cae a escaneo lineal sin avisar, cálculos de distancia incorrectos)
- Fugas de memoria (listeners/timers no limpiados, colas que crecen sin límite)
- Manejo de errores que oculta fallos reales (catch vacíos, promesas no manejadas)
- Funciones con complejidad ciclomática/nesting excesivo

ARCHIVOS: Leé SOLO los 5 archivos de arriba (podés leer tests/*.test.js correspondientes para contexto, NO los edites). NO edites NADA — sos auditor, no implementador.

DEFINICIÓN DE HECHO: Escribí `specs/AUDIT-02-data-REPORT.md` con esta estructura exacta:

```
# Audit Report 02 — Data layer (db, vector, hnsw, memory, queue)

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

REGLAS: Sos read-only. NO uses Edit/Write sobre ningún archivo salvo `specs/AUDIT-02-data-REPORT.md`. No corras comandos que modifiquen el repo.

ABORTAR SI: no podés leer alguno de los 5 archivos → documentalo como "archivo no accesible" y seguí con los demás.

ENTREGA: `specs/AUDIT-02-data-REPORT.md` completo. Al terminar respondé SOLO: LISTO + 1 línea con el conteo de hallazgos por severidad.
