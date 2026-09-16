import { generateCreateTableStatements } from './ddl-generator.mjs';
import { mapDocumentToRow, mapDocumentToFlattenedElement, parentIdFromChildSourcePath } from './row-mapper.mjs';
import { loadCheckpoint, saveCheckpoint, isStepDone, markStepDone } from './checkpoint-store.mjs';
import { readSnapshot } from '../inferrer/snapshot-reader.mjs';

/**
 * Runs the actual migration: creates every proposed table, inserts every
 * document's data, and updates flattened `jsonb` columns on their parent
 * rows. This is the ONLY module in the whole project that writes to a real
 * database -- everything upstream (`core/rules`, `core/extractor`,
 * `core/inferrer`) only ever produces proposals.
 *
 * @param {Object} params
 * @param {ReturnType<typeof import('../inferrer/table-builder.mjs').buildTable>[]} params.tables
 * @param {string} params.snapshotDir
 * @param {boolean} [params.dryRun] - if true (default), never touches
 *   Postgres at all -- not even a connection is required.
 * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} [params.pgClient]
 *   required when `dryRun` is false. Any object exposing an async `query()`
 *   with this shape works -- a real `pg.Client`/`pg.Pool`, or a fake for tests.
 * @param {string} [params.checkpointPath] - required when `dryRun` is false.
 * @param {boolean} [params.force] - ignore the existing checkpoint and start over.
 * @returns {Promise<Object>} a dry-run preview, or a real-run summary
 */
export async function runMigration({ tables, snapshotDir, dryRun = true, pgClient, checkpointPath, force = false }) {
  const ddlStatements = generateCreateTableStatements(tables);
  const ownTables = tables.filter((t) => t.strategy === 'own_table');
  const flattenedTables = tables.filter((t) => t.strategy === 'flattened_jsonb');

  if (dryRun) {
    let byShape = {};
    try {
      byShape = await readSnapshot(snapshotDir);
    } catch {
      // no snapshot yet -- still show the DDL preview, just with zero row counts
    }
    const rowCounts = {};
    for (const table of ownTables) rowCounts[table.tableName] = (byShape[table.collectionShape] ?? []).length;
    return {
      dryRun: true,
      ddlStatements,
      rowCounts,
      flattenTargets: flattenedTables.map((t) => `${t.flattenedIntoTable}.${t.flattenedIntoColumn}`),
    };
  }

  if (!pgClient) throw new Error('runMigration requires a pgClient when dryRun is false');
  if (!checkpointPath) throw new Error('runMigration requires a checkpointPath when dryRun is false');

  const checkpoint = force ? { completedSteps: [] } : await loadCheckpoint(checkpointPath);
  const summary = { tablesCreated: [], rowsInserted: {}, flattenedUpdated: {} };

  // 1. DDL, in dependency order (see ddl-generator.mjs).
  for (const stmt of ddlStatements) {
    const stepId = `ddl:${stmt.tableName}:${stmt.sql}`;
    if (isStepDone(checkpoint, stepId)) continue;
    await pgClient.query(stmt.sql);
    markStepDone(checkpoint, stepId);
    await saveCheckpoint(checkpointPath, checkpoint);
    summary.tablesCreated.push(stmt.tableName);
  }

  const byShape = await readSnapshot(snapshotDir);

  // 2. Insert every own_table's rows. Idempotent via ON CONFLICT DO NOTHING,
  // so re-running after an interruption never duplicates rows -- but see
  // checkpoint-store.mjs for the honest limit on resume granularity.
  for (const table of ownTables) {
    const stepId = `data:${table.collectionShape}`;
    if (isStepDone(checkpoint, stepId)) {
      summary.rowsInserted[table.tableName] = 'skipped (already done per checkpoint)';
      continue;
    }
    const docs = byShape[table.collectionShape] ?? [];
    let count = 0;
    for (const doc of docs) {
      const row = mapDocumentToRow(doc, table);
      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const sql = `INSERT INTO "${table.tableName}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (id) DO NOTHING`;
      await pgClient.query(sql, columns.map((c) => row[c]));
      count++;
    }
    summary.rowsInserted[table.tableName] = count;
    markStepDone(checkpoint, stepId);
    await saveCheckpoint(checkpointPath, checkpoint);
  }

  // 3. Flatten each flattened_jsonb subcollection into its parent's jsonb column.
  for (const table of flattenedTables) {
    const stepId = `flatten:${table.collectionShape}`;
    if (isStepDone(checkpoint, stepId)) {
      summary.flattenedUpdated[`${table.flattenedIntoTable}.${table.flattenedIntoColumn}`] = 'skipped (already done per checkpoint)';
      continue;
    }
    const docs = byShape[table.collectionShape] ?? [];
    /** @type {Record<string, any[]>} */
    const elementsByParentId = {};
    for (const doc of docs) {
      const parentId = parentIdFromChildSourcePath(doc.sourcePath);
      elementsByParentId[parentId] ??= [];
      elementsByParentId[parentId].push(mapDocumentToFlattenedElement(doc, table.elementKeyField));
    }
    let updated = 0;
    for (const [parentId, elements] of Object.entries(elementsByParentId)) {
      const sql = `UPDATE "${table.flattenedIntoTable}" SET "${table.flattenedIntoColumn}" = $1::jsonb WHERE id = $2`;
      await pgClient.query(sql, [JSON.stringify(elements), parentId]);
      updated++;
    }
    summary.flattenedUpdated[`${table.flattenedIntoTable}.${table.flattenedIntoColumn}`] = updated;
    markStepDone(checkpoint, stepId);
    await saveCheckpoint(checkpointPath, checkpoint);
  }

  return { dryRun: false, summary };
}

export { generateCreateTableStatements } from './ddl-generator.mjs';
export { mapDocumentToRow, mapDocumentToFlattenedElement, parentIdFromChildSourcePath } from './row-mapper.mjs';
export { toColumnValue, toPlainJson, referenceIdFromPath } from './canonical-to-sql.mjs';
export { loadCheckpoint, saveCheckpoint } from './checkpoint-store.mjs';
