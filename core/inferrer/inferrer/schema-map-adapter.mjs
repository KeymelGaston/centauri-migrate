/**
 * Convierte las tablas propuestas por el inferidor al formato EXACTO que
 * espera `createSchemaMap()` en `core/rules/schema-contract.mjs`. Este
 * archivo es, literalmente, el punto de acoplamiento entre los dos modulos
 * -- si el contrato de core/rules cambia alguna vez, este es el unico lugar
 * que deberia necesitar actualizarse.
 *
 * @param {ReturnType<typeof import('./table-builder.mjs').buildTable>[]} tables
 * @returns {Record<string, import('../rules/schema-contract.mjs').SchemaMapping>}
 */
export function toSchemaMapMappings(tables) {
  /** @type {Record<string, any>} */
  const mappings = {};

  for (const table of tables) {
    if (!table.collectionShape.includes('/')) continue; // solo subcolecciones necesitan entrada aca

    if (table.strategy === 'own_table') {
      mappings[table.collectionShape] = {
        strategy: 'own_table',
        table: table.tableName,
        primaryKeyColumn: table.primaryKeyColumn,
        parentForeignKeyColumn: table.parentForeignKeyColumn,
      };
    } else {
      mappings[table.collectionShape] = {
        strategy: 'flattened_jsonb',
        flattenedIntoTable: table.flattenedIntoTable,
        flattenedIntoColumn: table.flattenedIntoColumn,
        elementKeyField: table.elementKeyField,
      };
    }
  }

  return mappings;
}
