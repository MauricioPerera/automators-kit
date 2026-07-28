CONTEXTO: Sos un auditor de código, NO un implementador. Repo `automators-kit` (D:\Repo\projecto\automators-kit), toolkit de automatización JS vanilla (ESM), cero dependencias npm, corre en Bun/Deno/Node. No sabés nada del historial del proyecto más allá de lo que leas en los archivos.

OBJETIVO: Auditar los siguientes archivos buscando bugs de SEGURIDAD, CORRECTNESS y COMPLEJIDAD excesiva:
- core/credentials.js
- core/http.js
- core/validate.js
- core/mcp.js
- core/shell.js

Buscá específicamente (no te limites a esto, es guía):
- Inyección (SQL/NoSQL/command/path traversal), deserialización insegura
- Uso incorrecto de criptografía (AES-256-GCM, JWT vía Web Crypto): IVs reutilizados, claves hardcodeadas, comparación de secretos no constant-time, algoritmos débiles
- Bypass de autenticación/autorización, escalado de privilegios, RBAC mal aplicado
- ReDoS (regex catastróficas), prototype pollution, validación de entrada insuficiente
- Manejo de errores que filtra información sensible (stack traces, secretos en logs)
- Race conditions, TOCTOU
- Funciones con complejidad ciclomática/nesting excesivo que dificulten auditar el resto

ARCHIVOS: Leé SOLO los 5 archivos de arriba (podés leer tests/*.test.js correspondientes para entender el contrato esperado, pero NO los edites). NO edites NADA — sos auditor, no implementador. No toques ningún archivo del repo.

DEFINICIÓN DE HECHO: Escribí `specs/AUDIT-01-security-REPORT.md` con esta estructura exacta:

```
# Audit Report 01 — Security (credentials, http, validate, mcp, shell)

## Hallazgos

### [SEVERIDAD: CRITICAL|HIGH|MEDIUM|LOW] Título corto
- Archivo: core/X.js
- Línea: N (o rango)
- Evidencia: ```cita literal del código```
- Descripción: qué está mal y por qué importa
- Escenario de explotación/fallo concreto: inputs/pasos que disparan el problema
- Sugerencia de fix (1-2 líneas, NO la implementes)

(repetir por cada hallazgo, ordenados de mayor a menor severidad)

## Resumen
- Archivos revisados: N/5
- Hallazgos: X critical, Y high, Z medium, W low
- Sin hallazgos en: [lista si aplica]
```

Si NO encontrás hallazgos en un archivo, decilo explícito en el resumen ("sin hallazgos en X.js") — no inventes problemas para parecer productivo. Cada hallazgo DEBE tener evidencia literal citada del código real, no paráfrasis.

REGLAS: Sos read-only. NO uses Edit/Write sobre ningún archivo salvo `specs/AUDIT-01-security-REPORT.md`. No corras comandos que modifiquen el repo (git commit, npm install, etc). No loguees secretos reales si encontrás alguno hardcodeado — citá solo el patrón/línea, no el valor completo si parece un secreto real de producción (poco probable en este repo pero por las dudas).

ABORTAR SI: no podés leer alguno de los 5 archivos (no existe, permisos) → documentalo en el reporte como "archivo no accesible" y seguí con los demás. No hay condición de bloqueo total: siempre podés entregar un reporte parcial.

ENTREGA: `specs/AUDIT-01-security-REPORT.md` completo. Al terminar respondé SOLO: LISTO + 1 línea con el conteo de hallazgos por severidad.
