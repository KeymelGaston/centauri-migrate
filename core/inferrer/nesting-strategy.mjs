/**
 * Decides, for a Firestore subcollection (a collectionShape with more than
 * one segment, e.g. "users/orders"), whether the inferrer should propose it
 * as its own table ('own_table') or flattened as jsonb inside the parent
 * ('flattened_jsonb') -- the same decision consumed by `core/rules` via the
 * `schemaMap` contract (see core/rules/schema-contract.mjs).
 *
 * Heuristic (always with explicit confidence, never applied without being
 * flagged as a suggestion):
 *   1. If any document in this subcollection itself has its own
 *      subcollections -> 'own_table' forced, high confidence. jsonb can't
 *      reasonably represent another level of relation.
 *   2. If the "fan-out" (average child documents per parent document) is
 *      high -> 'own_table', medium/high confidence: more relational than
 *      embeddable.
 *   3. If fan-out is low and there are no nested sub-subcollections ->
 *      suggested 'flattened_jsonb', low/medium confidence: a reasonable
 *      candidate, but requires human confirmation (see the product doc:
 *      "clearly relational repeated structure -> table; simple and bounded
 *      -> jsonb").
 */

const HIGH_FANOUT_THRESHOLD = 5;

/** Extracts the PARENT document's path from a subcollection document's
 * sourcePath (e.g. "users/u1/orders/o1" -> "users/u1"). */
function parentDocPath(sourcePath) {
  const parts = sourcePath.split('/');
  return parts.slice(0, -2).join('/');
}

/**
 * @param {string} shape - e.g. "users/orders"
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument[]} docsForShape
 * @param {string[]} allShapesInSnapshot - every collectionShape present in
 *   the full snapshot, used to detect sub-subcollections.
 * @returns {{
 *   strategy: 'own_table'|'flattened_jsonb',
 *   confidence: 'high'|'medium'|'low',
 *   avgChildrenPerParent: number,
 *   hasNestedSubcollections: boolean,
 *   reason: string
 * }}
 */
export function decideNestingStrategy(shape, docsForShape, allShapesInSnapshot) {
  const hasNestedSubcollections = allShapesInSnapshot.some((s) => s !== shape && s.startsWith(shape + '/'));

  const countsByParent = {};
  for (const doc of docsForShape) {
    const parent = parentDocPath(doc.sourcePath);
    countsByParent[parent] = (countsByParent[parent] ?? 0) + 1;
  }
  const parentCount = Object.keys(countsByParent).length;
  const avgChildrenPerParent = parentCount === 0 ? 0 : docsForShape.length / parentCount;

  if (hasNestedSubcollections) {
    return {
      strategy: 'own_table',
      confidence: 'high',
      avgChildrenPerParent,
      hasNestedSubcollections,
      reason: `'${shape}' itself has its own subcollections — jsonb can't represent another level of relation, forcing its own table`,
    };
  }

  if (avgChildrenPerParent > HIGH_FANOUT_THRESHOLD) {
    return {
      strategy: 'own_table',
      confidence: 'medium',
      avgChildrenPerParent,
      hasNestedSubcollections,
      reason: `average of ${avgChildrenPerParent.toFixed(1)} child documents per parent — high fan-out, more relational than embeddable`,
    };
  }

  return {
    strategy: 'flattened_jsonb',
    confidence: 'low',
    avgChildrenPerParent,
    hasNestedSubcollections,
    reason: `average of ${avgChildrenPerParent.toFixed(1)} child documents per parent — low fan-out, a candidate for flattening, but REQUIRES human confirmation before applying (the sample may not be representative)`,
  };
}
