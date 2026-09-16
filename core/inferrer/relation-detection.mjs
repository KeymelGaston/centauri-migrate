/**
 * Detects relations (candidate foreign keys) in a field, with the same
 * spirit of confidence levels as `core/rules`: an explicit relation (a real
 * Firestore DocumentReference) is high confidence; a field name that
 * "looks like" a relation (`authorId`, `orgRef`) without actually being one
 * is medium confidence and is ALWAYS flagged as suggested, never applied.
 */

function snakeCase(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const NAME_HEURISTIC_RE = /(?:_id|Id|_ref|Ref)$/;

/** From a Firestore path ("orgs/abc/members/xyz"), the referenced
 * collection shape ("orgs/members") -- same concept as `pathShapeKey` in
 * core/rules/schema-contract.mjs. */
function shapeFromReferencePath(refPath) {
  const parts = refPath.split('/').filter(Boolean);
  const collections = [];
  for (let i = 0; i < parts.length; i += 2) collections.push(parts[i]);
  return collections.join('/');
}

function proposedColumnName(fieldName) {
  const snake = snakeCase(fieldName);
  if (/_id$/.test(snake)) return snake;
  if (/_ref$/.test(snake)) return snake.replace(/_ref$/, '_id');
  return `${snake}_id`;
}

/**
 * @param {string} fieldName
 * @param {import('../extractor/canonical-document.mjs').CanonicalValue[]} observedValues
 * @returns {null | {
 *   sourceField: string,
 *   proposedColumn: string,
 *   confidence: 'high'|'medium',
 *   referencedCollectionShape: string|null,
 *   reason: string
 * }}
 */
export function detectRelation(fieldName, observedValues) {
  const referenceValues = observedValues.filter((v) => v.type === 'reference');

  if (referenceValues.length > 0) {
    // High confidence: it's literally a Firestore DocumentReference.
    const shapes = new Set(referenceValues.map((v) => shapeFromReferencePath(v.value)));
    if (shapes.size > 1) {
      // the same field references different collections depending on the
      // document (uncommon, but possible in Firestore) -- lower confidence
      // and flag it.
      return {
        sourceField: fieldName,
        proposedColumn: proposedColumnName(fieldName),
        confidence: 'medium',
        referencedCollectionShape: null,
        reason: `real DocumentReference, but points to different collections depending on the document (${[...shapes].join(', ')}) — needs a polymorphic FK or manual review, not a simple FK`,
      };
    }
    return {
      sourceField: fieldName,
      proposedColumn: proposedColumnName(fieldName),
      confidence: 'high',
      referencedCollectionShape: [...shapes][0],
      reason: 'real Firestore DocumentReference',
    };
  }

  // No 'reference' type data -- name heuristic, always medium confidence,
  // never high: there's no way to know which collection it points to.
  const nonNullValues = observedValues.filter((v) => v.type !== 'null');
  const looksLikeId = nonNullValues.every((v) => v.type === 'string' || v.type === 'number');
  if (NAME_HEURISTIC_RE.test(fieldName) && looksLikeId && nonNullValues.length > 0) {
    return {
      sourceField: fieldName,
      proposedColumn: proposedColumnName(fieldName),
      confidence: 'medium',
      referencedCollectionShape: null,
      reason: `field name suggests a relation ('${fieldName}'), but it's a plain ${nonNullValues[0].type}, not a DocumentReference — target collection unknown, requires human confirmation`,
    };
  }

  return null;
}

/**
 * Runs `detectRelation` over every field observed in a set of documents.
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument[]} docs
 * @returns {ReturnType<typeof detectRelation>[]}
 */
export function detectRelations(docs) {
  /** @type {Record<string, import('../extractor/canonical-document.mjs').CanonicalValue[]>} */
  const valuesByField = {};
  for (const doc of docs) {
    for (const fieldName of Object.keys(doc.fields)) {
      valuesByField[fieldName] ??= [];
      valuesByField[fieldName].push(doc.fields[fieldName]);
    }
  }
  return Object.keys(valuesByField)
    .sort()
    .map((fieldName) => detectRelation(fieldName, valuesByField[fieldName]))
    .filter((r) => r !== null);
}

export { snakeCase };
