/**
 * Converts the tables proposed by the inferrer into the EXACT format that
 * `createSchemaMap()` expects in `core/rules/schema-contract.mjs`. This
 * file is, literally, the coupling point between the two modules -- if
 * core/rules's contract ever changes, this should be the only place that
 * needs updating.
 *
 * @param {ReturnType<typeof import('./table-builder.mjs').buildTable>[]} tables
 * @returns {Record<string, import('../rules/schema-contract.mjs').SchemaMapping>}
 */
export function toSchemaMapMappings(tables) {
  /** @type {Record<string, any>} */
  const mappings = {};

  for (const table of tables) {
    if (!table.collectionShape.includes('/')) continue; // only subcollections need an entry here

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
