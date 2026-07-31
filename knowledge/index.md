# Knowledge Bundle (OKF) — automators-kit

Base de conocimiento del proyecto, siguiendo Knowledge-Driven Development
(KDD). El formato de los nodos esta especificado en [OKF-SPEC](./OKF-SPEC.md).

Instanciado sobre un proyecto JS/Bun ya existente y activo (no un proyecto
nuevo desde la plantilla) — ver la nota al pie de [validacion.md](./validacion.md)
y `.agents/AGENTS.md` para las adaptaciones (runner `bun test`, sin retrofit
de contratos sobre codigo legacy).

## Referencia (metodologia, vendorizada desde la plantilla KDD)
- [Especificación OKF](./OKF-SPEC.md) — spec normativa de nodos OKF.
- [Validación de contratos](./validacion.md) — niveles 1 y 2, gate multi-lenguaje, export, precedencia del budget, ciclo de vida.
- [Metodología de ejecución por contratos](./metodologia-ejecucion.md) — proceso de nivel proyecto (specs/, docs/reports/, delegación y verificación).
- [Rule contract](./rule-contract-spec.md) — reglas de negocio como datos declarativos (Capa 3, opcional, sin contenido todavia en este repo).

## Arquitectura
- [Arquitectura general](./architecture/)

## Contratos de tarea
- [Contratos de Desarrollo](./contracts/)
