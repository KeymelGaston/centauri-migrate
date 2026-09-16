import { readSnapshot } from './snapshot-reader.mjs';
import { buildTable } from './table-builder.mjs';
import { toSchemaMapMappings } from './schema-map-adapter.mjs';

/**
 * Infers a proposed relational schema from the local snapshot written by
 * `core/extractor`. Equivalent to `centauri infer` from the CLI blueprint.
 *
 * IMPORTANT (read before applying anything): this proposes a schema, it
 * doesn't apply it. Every column, relation, and flattening decision comes
 * with an explicit confidence level -- `centauri review` (not implemented
 * yet) should show this to the user before touching Postgres.
 *
 * @param {string} snapshotDir - normally `.centauri/snapshot`
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
