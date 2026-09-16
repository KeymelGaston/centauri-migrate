import { inferColumns } from './field-inference.mjs';
import { detectRelations, snakeCase } from './relation-detection.mjs';
import { decideNestingStrategy } from './nesting-strategy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Firestore's auto-generated ids are 20-character base62 strings, NOT
 * valid uuids -- only propose 'uuid' as the PK type if every observed id
 * really does look like a uuid (ids chosen by hand by the source app, a
 * real case but not Firestore's default). */
function inferPrimaryKeyType(docs) {
  const allLookLikeUuid = docs.length > 0 && docs.every((d) => UUID_RE.test(d.id));
  return allLookLikeUuid ? 'uuid' : 'text';
}

function tableNameFromShape(shape) {
  // last segment of the shape (e.g. "orgs/members" -> "members"); the real
  // name may differ if there's a collision between shapes sharing the same
  // last segment -- see the note in index.mjs about table name collisions.
  return snakeCase(shape.split('/').pop());
}

/** Singularizes a collection name to name an FK column by convention
 * (table 'orgs' -> column 'org_id', not 'orgs_id'). Simple heuristic
 * (strips a trailing 's' except for 'ss' endings), doesn't handle
 * irregular English plurals (e.g. 'children' should give 'child' but this
 * heuristic won't catch it) -- documented as a known limit, not a silent
 * bug: the generated name is always visible for review. */
function singularize(word) {
  if (word.endsWith('ss')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function foreignKeyColumnName(collectionName) {
  return `${singularize(snakeCase(collectionName))}_id`;
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function lowerConfidence(a, b) {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Reconciles inferred columns with detected relations: if a field was
 * detected as a relation (see relation-detection.mjs), the final column
 * must use the proposed FK name (e.g. 'author_id'), not the raw Firestore
 * field name (e.g. 'authorRef') -- otherwise the table ends up with BOTH
 * things unrelated to each other: a column 'authorRef' AND a separate
 * "suggested relation" that nobody applied. Real bug found while reviewing
 * output against real user data.
 *
 * The column's final confidence is the LOWEST between the inferred type's
 * confidence and the confidence that the field is really a relation (an FK
 * detected only by name, with 'high'-confidence type data, is still
 * 'medium' overall -- the uncertainty about whether it's a real relation
 * doesn't go away just because the data type itself is well known).
 */
function reconcileColumnsWithRelations(columns, relations) {
  const relationBySourceField = Object.fromEntries(relations.map((r) => [r.sourceField, r]));

  return columns.map((col) => {
    const relation = relationBySourceField[col.name];
    if (!relation) return col;

    const targetNote = relation.referencedCollectionShape
      ? `foreign key to '${relation.referencedCollectionShape}' (column renamed from '${col.name}' to '${relation.proposedColumn}')`
      : `possible foreign key (unknown target) — ${relation.reason} (column renamed from '${col.name}' to '${relation.proposedColumn}')`;

    return {
      ...col,
      name: relation.proposedColumn,
      sourceField: col.name,
      confidence: lowerConfidence(col.confidence, relation.confidence),
      notes: [...col.notes, targetNote],
    };
  });
}

/**
 * @param {string} shape
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument[]} docs
 * @param {string[]} allShapesInSnapshot
 * @returns {Object} complete proposed table definition for this shape
 */
export function buildTable(shape, docs, allShapesInSnapshot) {
  const isSubcollection = shape.includes('/');
  const rawColumns = inferColumns(docs);
  const relations = detectRelations(docs);
  const columns = reconcileColumnsWithRelations(rawColumns, relations);
  const primaryKeyType = inferPrimaryKeyType(docs);

  const base = {
    collectionShape: shape,
    tableName: tableNameFromShape(shape),
    primaryKeyColumn: 'id',
    primaryKeyType,
    documentCount: docs.length,
    columns,
    relations,
  };

  if (!isSubcollection) {
    return { ...base, strategy: 'own_table', nestingConfidence: 'high', nestingReason: 'root collection, always its own table' };
  }

  const nesting = decideNestingStrategy(shape, docs, allShapesInSnapshot);
  const parentShape = shape.split('/').slice(0, -1).join('/');

  if (nesting.strategy === 'own_table') {
    return {
      ...base,
      strategy: 'own_table',
      nestingConfidence: nesting.confidence,
      nestingReason: nesting.reason,
      avgChildrenPerParent: nesting.avgChildrenPerParent,
      parentCollectionShape: parentShape,
      parentForeignKeyColumn: foreignKeyColumnName(parentShape.split('/').pop()),
    };
  }

  return {
    ...base,
    strategy: 'flattened_jsonb',
    nestingConfidence: nesting.confidence,
    nestingReason: nesting.reason,
    avgChildrenPerParent: nesting.avgChildrenPerParent,
    parentCollectionShape: parentShape,
    flattenedIntoTable: tableNameFromShape(parentShape),
    flattenedIntoColumn: snakeCase(shape.split('/').pop()),
    elementKeyField: 'id',
  };
}
