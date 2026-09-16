/**
 * Infers the Postgres column type for a field, from the CanonicalValues
 * observed across ALL documents of a given `collectionShape`. Firestore
 * documents are schemaless -- it's normal for a field to be missing in some
 * documents, or (due to a bug in the source app) to have different types in
 * different documents. This module never decides silently when facing
 * inconsistency: it flags it with 'low' confidence and the details of what
 * types it saw, so `centauri review` can show it to the user.
 */

/** Mapping of CanonicalType -> default proposed Postgres type. */
const CANONICAL_TO_PG = {
  string: 'text',
  number: 'numeric', // refined to 'integer' if ALL observed values are integers
  boolean: 'boolean',
  timestamp: 'timestamptz',
  geopoint: 'jsonb', // no PostGIS support in v1; see the note in the result
  reference: 'text', // overridden if relation-detection.mjs decides 'uuid'/'text' via FK
  bytes: 'bytea',
  array: 'jsonb',
  map: 'jsonb',
};

function isIntegerNumber(n) {
  return Number.isInteger(n);
}

/**
 * @param {string} fieldName
 * @param {import('../extractor/canonical-document.mjs').CanonicalValue[]} observedValues
 *   Every CanonicalValue seen for this field, one per document where the
 *   field was present (documents where it's missing don't produce an entry
 *   here -- that's reflected separately via `presentIn`/`totalDocs`).
 * @param {number} presentIn - how many documents the field appeared in
 * @param {number} totalDocs - total documents analyzed in this shape
 * @returns {{
 *   name: string,
 *   pgType: string,
 *   nullable: boolean,
 *   confidence: 'high'|'medium'|'low',
 *   observedTypes: Record<string, number>,
 *   notes: string[]
 * }}
 */
export function inferFieldType(fieldName, observedValues, presentIn, totalDocs) {
  const notes = [];
  const nullable = presentIn < totalDocs || observedValues.some((v) => v.type === 'null');

  const nonNull = observedValues.filter((v) => v.type !== 'null');
  /** @type {Record<string, number>} */
  const typeCounts = {};
  for (const v of nonNull) typeCounts[v.type] = (typeCounts[v.type] ?? 0) + 1;

  const distinctTypes = Object.keys(typeCounts);

  if (distinctTypes.length === 0) {
    // the field only ever showed up as null, or no non-null value was ever observed
    return { name: fieldName, pgType: 'text', nullable: true, confidence: 'low', observedTypes: typeCounts, notes: ['no non-null value was ever observed; type has no evidence, defaulting to text'] };
  }

  if (distinctTypes.length > 1) {
    // Real type inconsistency for the same field across documents -- never
    // decided silently. The most frequent type is proposed, but flagged
    // with low confidence and full detail for human review.
    const dominant = distinctTypes.reduce((a, b) => (typeCounts[a] >= typeCounts[b] ? a : b));
    notes.push(
      `inconsistent types across documents: ${distinctTypes.map((t) => `${t} (${typeCounts[t]}x)`).join(', ')} -- requires manual review before applying`
    );
    return { name: fieldName, pgType: CANONICAL_TO_PG[dominant] ?? 'text', nullable: true, confidence: 'low', observedTypes: typeCounts, notes };
  }

  const [onlyType] = distinctTypes;
  let pgType = CANONICAL_TO_PG[onlyType] ?? 'text';

  if (onlyType === 'number') {
    const allIntegers = nonNull.every((v) => isIntegerNumber(v.value));
    pgType = allIntegers ? 'integer' : 'numeric';
  }

  if (onlyType === 'geopoint') {
    notes.push("stored as 'jsonb' ({lat,lng}) -- v1 doesn't support PostGIS types; revisit if geometry(Point) turns out to be needed");
  }

  if (nullable) {
    notes.push(`field missing in ${totalDocs - presentIn} of ${totalDocs} documents`);
  }

  return {
    name: fieldName,
    pgType,
    nullable,
    confidence: nullable ? 'medium' : 'high',
    observedTypes: typeCounts,
    notes,
  };
}

/**
 * Infers columns for ALL fields observed across a set of documents from the
 * same collectionShape (documents are schemaless, so first we need to
 * discover the union of every field name).
 *
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument[]} docs
 * @returns {ReturnType<typeof inferFieldType>[]}
 */
export function inferColumns(docs) {
  /** @type {Record<string, import('../extractor/canonical-document.mjs').CanonicalValue[]>} */
  const valuesByField = {};
  /** @type {Record<string, number>} */
  const presentCountByField = {};

  for (const doc of docs) {
    for (const fieldName of Object.keys(doc.fields)) {
      valuesByField[fieldName] ??= [];
      valuesByField[fieldName].push(doc.fields[fieldName]);
      presentCountByField[fieldName] = (presentCountByField[fieldName] ?? 0) + 1;
    }
  }

  return Object.keys(valuesByField)
    .sort()
    .map((fieldName) => inferFieldType(fieldName, valuesByField[fieldName], presentCountByField[fieldName], docs.length));
}
