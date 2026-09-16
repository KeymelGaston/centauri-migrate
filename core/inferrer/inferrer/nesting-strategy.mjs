/**
 * Decide, para una subcoleccion de Firestore (collectionShape con mas de un
 * segmento, ej. "users/orders"), si el inferidor deberia proponerla como
 * tabla propia ('own_table') o aplanada como jsonb dentro del padre
 * ('flattened_jsonb') -- la misma decision que consume `core/rules` via el
 * contrato `schemaMap` (ver core/rules/schema-contract.mjs).
 *
 * Heuristica (siempre con confianza explicita, nunca aplicada sin marcar
 * como sugerencia):
 *   1. Si algun documento de esta subcoleccion tiene, a su vez, sus propias
 *      subcolecciones -> 'own_table' forzado, alta confianza. jsonb no puede
 *      representar otro nivel de relacion de forma razonable.
 *   2. Si el "fan-out" (documentos hijos promedio por documento padre) es
 *      alto -> 'own_table', confianza media/alta: mas relacional que
 *      embebible.
 *   3. Si el fan-out es bajo y no hay sub-subcolecciones -> 'flattened_jsonb'
 *      sugerido, confianza baja/media: candidato razonable, pero requiere
 *      confirmacion humana (ver product doc: "estructura repetida
 *      claramente relacional -> tabla; simple y acotado -> jsonb").
 */

const HIGH_FANOUT_THRESHOLD = 5;

/** Extrae el path del documento PADRE a partir del sourcePath de un
 * documento de subcoleccion (ej. "users/u1/orders/o1" -> "users/u1"). */
function parentDocPath(sourcePath) {
  const parts = sourcePath.split('/');
  return parts.slice(0, -2).join('/');
}

/**
 * @param {string} shape - ej. "users/orders"
 * @param {import('../extractor/canonical-document.mjs').CanonicalDocument[]} docsForShape
 * @param {string[]} allShapesInSnapshot - todos los collectionShape presentes
 *   en el snapshot completo, para detectar sub-subcolecciones.
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
      reason: `'${shape}' tiene a su vez sus propias subcolecciones — jsonb no puede representar otro nivel de relacion, se fuerza tabla propia`,
    };
  }

  if (avgChildrenPerParent > HIGH_FANOUT_THRESHOLD) {
    return {
      strategy: 'own_table',
      confidence: 'medium',
      avgChildrenPerParent,
      hasNestedSubcollections,
      reason: `promedio de ${avgChildrenPerParent.toFixed(1)} documentos hijos por padre — fan-out alto, mas relacional que embebible`,
    };
  }

  return {
    strategy: 'flattened_jsonb',
    confidence: 'low',
    avgChildrenPerParent,
    hasNestedSubcollections,
    reason: `promedio de ${avgChildrenPerParent.toFixed(1)} documentos hijos por padre — fan-out bajo, candidato a aplanar, pero REQUIERE confirmacion humana antes de aplicarse (muestra puede no ser representativa)`,
  };
}
