# core/inferrer — documento canónico → esquema relacional propuesto

Estado: **construido y testeado, incluyendo integración real con
`core/rules`** (no solo unitarios). Pensado para volverse `centauri infer`.

## Qué hace

Lee el snapshot que escribió `core/extractor`, y por cada `collectionShape`
propone: columnas (con tipo Postgre y nivel de confianza), relaciones
(foreign keys candidatas), y — para subcolecciones — si conviene tabla
propia o aplanar a `jsonb`. **Nunca decide en silencio**: cualquier
inconsistencia (tipos de campo distintos entre documentos, fan-out
ambiguo) queda marcada con confianza baja/media y su razón, para que
`centauri review` (no implementado aún) se la muestre al usuario.

```js
import { inferSchema } from './index.mjs';

const { tables, schemaMapMappings } = await inferSchema('.centauri/snapshot');
```

`schemaMapMappings` es, literalmente, el objeto que espera
`createSchemaMap()` de `core/rules/schema-contract.mjs` — **no una forma
parecida, la forma exacta**. Esto está probado con tests de integración
reales (no solo unitarios de cada módulo por separado): se genera un
snapshot, se infiere el esquema, y el resultado se pasa de verdad a
`generatePoliciesFromRulesFile()` de `core/rules`, confirmando que el SQL
generado usa los nombres de tabla/columna que el inferidor decidió — no un
mock hecho a mano.

## Decisiones y sus niveles de confianza

| Decisión | Alta confianza | Media | Baja |
|---|---|---|---|
| Tipo de columna | un solo tipo observado en todos los docs | campo ausente en algunos docs (nullable) | tipos inconsistentes entre docs |
| Relación (FK) | `DocumentReference` real | nombre de campo sugiere relación (`authorId`) pero es un valor plano | — |
| Tabla propia vs `jsonb` | tiene sub-subcolecciones (forzado) | fan-out alto (>5 docs/padre) | fan-out bajo (candidato a aplanar, requiere confirmación) |

## Heurísticas con límites conocidos, documentados a propósito

- **Tipo de PK**: `text` por default (los ids autogenerados de Firestore son
  strings base62, no UUIDs); se propone `uuid` solo si TODOS los ids
  observados tienen forma de UUID real.
- **Singularización de nombres de FK** (`orgs` → `org_id`, no `orgs_id`):
  heurística simple (quita `s` final salvo `ss`), **no maneja plurales
  irregulares en inglés** (`children` no da `child`). El nombre generado
  siempre es visible para revisión — no es una decisión invisible.
- **Fan-out para decidir aplanado**: umbral fijo (>5 docs/padre en promedio).
  Con una muestra chica (como cualquier snapshot de prueba), el promedio
  puede no ser representativo del dato real de producción — por eso el caso
  de fan-out bajo siempre queda en confianza `low`, nunca más alta.
- **`geopoint` siempre se propone como `jsonb`** — v1 no evalúa tipos
  PostGIS (`geometry(Point)`), aunque sería la opción más idiomática en
  Postgres para datos geoespaciales reales.

## Bug real encontrado y corregido (revisión contra datos reales del usuario)

Corriendo `infer-schema.mjs` contra un snapshot real, la tabla `posts` mostró
la columna `authorRef: text` **y por separado** una relación sugerida hacia
`author_id` — ninguna de las dos reconciliada con la otra. La tabla final
habría quedado con el nombre crudo del campo de Firestore en vez del nombre
de columna FK real. Corregido en `table-builder.mjs`
(`reconcileColumnsWithRelations`): cuando un campo tiene una relación
detectada, la columna final usa el nombre de FK propuesto, con
`sourceField` guardado para trazabilidad, y la confianza final es la **más
baja** entre la confianza del tipo y la confianza de que sea de verdad una
relación (una FK detectada solo por heurística de nombre, aunque el tipo de
dato se conozca con certeza, sigue siendo `medium` en conjunto).

## Pendientes reales, no resueltos

- **Colisión de nombres de tabla**: `tableNameFromShape()` usa solo el
  último segmento del path (`orgs/members` → `members`). Si dos
  subcolecciones distintas terminan en el mismo nombre (ej.
  `orgs/members` y `teams/members`), ambas proponen la tabla `members` —
  no hay detección de colisión todavía.
- **Arrays de referencias**: un campo `array` cuyo contenido son
  `DocumentReference` (ej. `collaboratorRefs: [ref1, ref2]`) no se detecta
  como relación many-to-many — se trata como `jsonb` genérico. El diseño de
  `relation-detection.mjs` solo mira el tipo del campo completo, no el
  contenido de arrays.
- **Sin propuesta de índices** — el bosquejo del CLI menciona un modo
  `AnalyzeQuery`-like para sugerir índices (visto en `cel2sql` durante la
  investigación de RLS), no implementado aquí.
- **No se corrió contra un snapshot real completo de un proyecto grande** —
  los tests de integración usan datasets pequeños construidos a mano
  (7-8 documentos). El comportamiento del umbral de fan-out con datos
  reales (miles de documentos, distribución desigual entre padres) no está
  validado.

## Archivos

- `snapshot-reader.mjs` — lee los `.jsonl` de `core/extractor` de vuelta,
  agrupados por `collectionShape`.
- `field-inference.mjs` — tipo de columna por campo, con confianza.
- `relation-detection.mjs` — relaciones por `DocumentReference` real o
  heurística de nombre.
- `nesting-strategy.mjs` — `own_table` vs `flattened_jsonb` por subcolección.
- `table-builder.mjs` — combina todo lo anterior en una definición de tabla.
- `schema-map-adapter.mjs` — el punto de acoplamiento real con `core/rules`:
  convierte las tablas inferidas al formato exacto de `createSchemaMap()`.
- `index.mjs` — orquesta todo, API pública (`inferSchema`).
- `__tests__/` — 14 tests, incluye 2 de integración real cruzando a
  `core/rules` (no mocks) y 1 regression test (singularización de FK).
