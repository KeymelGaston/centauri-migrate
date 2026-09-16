import { readSnapshot } from './snapshot-reader.mjs';
import { buildTable } from './table-builder.mjs';
import { toSchemaMapMappings } from './schema-map-adapter.mjs';

/**
 * Infiere un esquema relacional propuesto a partir del snapshot local
 * escrito por `core/extractor`. Equivalente a `centauri infer` del bosquejo
 * del CLI.
 *
 * IMPORTANTE (leer antes de aplicar nada): esto propone un esquema, no lo
 * aplica. Cada columna, relacion, y decision de aplanado viene con un nivel
 * de confianza explicito -- `centauri review` (no implementado aun) deberia
 * mostrarle esto al usuario antes de tocar Postgres.
 *
 * @param {string} snapshotDir - normalmente `.centauri/snapshot`
 * @returns {Promise<{
 *   tables: ReturnType<typeof buildTable>[],
 *   schemaMapMappings: ReturnType<typeof toSchemaMapMappings>,
 * }>}
 */
export async function inferSchema(snapshotDir) {
  const byShape = await readSnapshot(snapshotDir);
  const allShapes = Object.keys(byShape);

  const tables = allShapes.map((shape) => buildTable(shape, byShape[shape], allShapes));
  const schemaMapMappings = toSchemaMapMappings(tables);

  return { tables, schemaMapMappings };
}

export { readSnapshot } from './snapshot-reader.mjs';
export { inferFieldType, inferColumns } from './field-inference.mjs';
export { detectRelation, detectRelations } from './relation-detection.mjs';
export { decideNestingStrategy } from './nesting-strategy.mjs';
export { buildTable } from './table-builder.mjs';
export { toSchemaMapMappings } from './schema-map-adapter.mjs';
