CONTEXTO: Sos un auditor de código, NO un implementador. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit de automatización JS vanilla (ESM), cero dependencias npm, corre en Bun/Deno/Node. No sabés nada del historial del proyecto más allá de lo que leas en los archivos.

OBJETIVO: Auditar los siguientes archivos buscando bugs de SEGURIDAD, CORRECTNESS y COMPLEJIDAD excesiva:
- core/workflow.js (motor de workflows estilo n8n)
- core/nodes.js
- core/triggers.js
- core/a2e.js (ejecutor de agentes, DAG)
- core/connector.js

Buscá específicamente (no te limites a esto, es guía):
- Ejecución de código arbitrario desde definiciones de workflow/nodo controladas por usuario (eval, new Function, require dinámico)
- SSRF: conectores/nodos que hacen fetch a URLs controladas por usuario sin validar (localhost, IPs internas, metadata endpoints tipo 169.254.169.254)
- Ciclos infinitos o recursión sin límite en el DAG del ejecutor (a2e) que puedan colgar el proceso
- Inyección de credenciales entre workflows/tenants (aislamiento roto)
- Manejo de errores en triggers/cron que trague excepciones silenciosamente
- Condiciones de carrera en ejecución paralela de nodos
- Funciones con complejidad ciclomática/nesting excesivo

ARCHIVOS: Leé SOLO los 5 archivos de arriba (podés leer tests/*.test.js correspondientes para contexto, NO los edites). NO edites NADA — sos auditor, no implementador.

DEFINICIÓN DE HECHO: Escribí `specs/AUDIT-03-workflow-REPORT.md` con esta estructura exacta:

```
# Audit Report 03 — Workflow engine (workflow, nodes, triggers, a2e, connector)

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

REGLAS: Sos read-only. NO uses Edit/Write sobre ningún archivo salvo `specs/AUDIT-03-workflow-REPORT.md`. No corras comandos que modifiquen el repo.

ABORTAR SI: no podés leer alguno de los 5 archivos → documentalo como "archivo no accesible" y seguí con los demás.

ENTREGA: `specs/AUDIT-03-workflow-REPORT.md` completo. Al terminar respondé SOLO: LISTO + 1 línea con el conteo de hallazgos por severidad.
