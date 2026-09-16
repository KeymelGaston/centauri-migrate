import { toColumnValue, toPlainJson } from './canonical-to-sql.mjs';

/**
 * Extracts the parent document's id from a subcollection document's
 * sourcePath (e.g. "orgs/org1/members/m0" -> "org1").
 * @param {string} sourcePath
 * @returns {string}
 */
export function parentIdFromChildSourcePath(sourcePath) {
  const parts = sourcePath.split('/');
  return parts[parts.length - 3];
}

/**
 * Converts one canonical document into a row object ready to bind as
 * parameterized `INSERT` values for an `own_table` table.
 *
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument} doc
 * @param {ReturnType<typeof import('../inferrer/table-builder.mjs').buildTable>} table
 * @returns {Record<string, *>}
 */
export function mapDocumentToRow(doc, table) {
  const row = { id: doc.id };
  for (const col of table.columns) {
    // A column whose relation was reconciled (see core/inferrer's
    // table-builder.mjs) carries `sourceField`, pointing back at the raw
    // Firestore field name -- the column itself may have been renamed
    // (e.g. 'authorRef' -> 'author_id').
    const sourceField = col.sourceField ?? col.name;
    const cv = doc.fields[sourceField];
    row[col.name] = toColumnValue(cv, col.pgType, { isForeignKey: !!col.sourceField });
  }
  if (table.parentForeignKeyColumn) {
    row[table.parentForeignKeyColumn] = parentIdFromChildSourcePath(doc.sourcePath);
  }
  return row;
}

/**
 * Converts one canonical document into a plain JSON element for a
 * `flattened_jsonb` array column -- keeps every field's full plain value
 * (including a reference's full path, unlike an FK column, since this
 * embeds inside a document, not a relational column).
 *
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument} doc
 * @param {string} elementKeyField
 * @returns {Record<string, *>}
 */
export function mapDocumentToFlattenedElement(doc, elementKeyField = 'id') {
  const element = { [elementKeyField]: doc.id };
  for (const fieldName of Object.keys(doc.fields)) {
    element[fieldName] = toPlainJson(doc.fields[fieldName]);
  }
  return element;
}
