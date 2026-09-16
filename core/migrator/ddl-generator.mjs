/**
 * Generates `CREATE TABLE IF NOT EXISTS` statements from the tables
 * proposed by `core/inferrer` (schema.proposed.json). Only 'own_table'
 * entries become real tables -- 'flattened_jsonb' entries instead add an
 * extra jsonb column to whichever table they flatten into.
 *
 * IMPORTANT: this never runs anything with `DROP` or `ALTER ... DROP
 * COLUMN`. If a table already exists, `IF NOT EXISTS` silently no-ops --
 * schema changes to an existing table are out of scope for this v1
 * migrator (see README.md pending items).
 */

function quoteIdent(name) {
  return `"${name}"`;
}

function columnDDL(col) {
  return `${quoteIdent(col.name)} ${col.pgType}${col.nullable ? '' : ' NOT NULL'}`;
}

/**
 * @param {ReturnType<typeof import('../inferrer/table-builder.mjs').buildTable>[]} tables
 * @returns {Array<{ tableName: string, sql: string, jsonbColumns: string[] }>}
 *   `jsonbColumns` lists every column (declared + flattened-in) that needs
 *   an explicit `::jsonb` cast when inserting -- Postgres does not
 *   implicitly cast a text parameter to jsonb.
 */
export function generateCreateTableStatements(tables) {
  const ownTables = tables.filter((t) => t.strategy === 'own_table');
  const flattenedTables = tables.filter((t) => t.strategy === 'flattened_jsonb');

  /** @type {Record<string, string[]>} table name -> extra jsonb column names */
  const extraColumnsByTable = {};
  for (const ft of flattenedTables) {
    extraColumnsByTable[ft.flattenedIntoTable] ??= [];
    extraColumnsByTable[ft.flattenedIntoTable].push(ft.flattenedIntoColumn);
  }

  const tableByShape = Object.fromEntries(tables.map((t) => [t.collectionShape, t]));

  return ownTables.map((table) => {
    const pkType = table.primaryKeyType === 'uuid' ? 'uuid' : 'text';
    const columnDefs = table.columns.map(columnDDL);
    const jsonbColumns = table.columns.filter((c) => c.pgType === 'jsonb').map((c) => c.name);

    const extraCols = extraColumnsByTable[table.tableName] ?? [];
    const extraDefs = extraCols.map((name) => `${quoteIdent(name)} jsonb`);
    jsonbColumns.push(...extraCols);

    /** @type {string[]} */
    const constraints = [];
    let fkColumnDef = [];
    if (table.parentForeignKeyColumn) {
      const parentTable = tableByShape[table.parentCollectionShape];
      // IMPORTANT: the FK column's type must match the PARENT's own primary
      // key type, not this table's -- a child with a plain `text` id can
      // still reference a parent whose id happens to be a real `uuid` (or
      // vice versa). Reusing `pkType` (this table's own PK type) here was a
      // real bug caught by a dedicated test before this got fixed.
      const parentPkType = parentTable ? (parentTable.primaryKeyType === 'uuid' ? 'uuid' : 'text') : pkType;
      fkColumnDef = [`${quoteIdent(table.parentForeignKeyColumn)} ${parentPkType} NOT NULL`];
      if (parentTable) {
        constraints.push(
          `FOREIGN KEY (${quoteIdent(table.parentForeignKeyColumn)}) REFERENCES ${quoteIdent(parentTable.tableName)}(id)`
        );
      }
    }

    const allColumnLines = [`${quoteIdent('id')} ${pkType} PRIMARY KEY`, ...fkColumnDef, ...columnDefs, ...extraDefs, ...constraints];

    const sql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.tableName)} (\n  ${allColumnLines.join(',\n  ')}\n);`;
    return { tableName: table.tableName, sql, jsonbColumns };
  });
}
