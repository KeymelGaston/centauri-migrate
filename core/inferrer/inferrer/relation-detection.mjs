/**
 * Detecta relaciones (foreign keys candidatas) en un campo, con el mismo
 * espiritu de niveles de confianza que `core/rules`: una relacion explicita
 * (un DocumentReference real de Firestore) es alta confianza; un nombre de
 * campo que "parece" una relacion (`authorId`, `orgRef`) sin serlo de verdad
 * es media confianza y SIEMPRE se marca como sugerida, nunca aplicada.
 */

function snakeCase(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const NAME_HEURISTIC_RE = /(?:_id|Id|_ref|Ref)$/;

/** A partir de un path de Firestore ("orgs/abc/members/xyz"), la forma de
 * coleccion referenciada ("orgs/members") -- mismo concepto que
 * `pathShapeKey` en core/rules/schema-contract.mjs. */
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
    // Alta confianza: es literalmente un DocumentReference de Firestore.
    const shapes = new Set(referenceValues.map((v) => shapeFromReferencePath(v.value)));
    if (shapes.size > 1) {
      // el mismo campo referencia a colecciones distintas segun el documento
      // (poco comun, pero posible en Firestore) -- bajar confianza y avisar.
      return {
        sourceField: fieldName,
        proposedColumn: proposedColumnName(fieldName),
        confidence: 'medium',
        referencedCollectionShape: null,
        reason: `DocumentReference real, pero apunta a distintas colecciones segun el documento (${[...shapes].join(', ')}) — requiere una FK polimorfica o revision manual, no una FK simple`,
      };
    }
    return {
      sourceField: fieldName,
      proposedColumn: proposedColumnName(fieldName),
      confidence: 'high',
      referencedCollectionShape: [...shapes][0],
      reason: 'DocumentReference real de Firestore',
    };
  }

  // Sin dato de tipo 'reference' -- heuristica de nombre, siempre confianza
  // media, nunca alta: no hay forma de saber a que coleccion apunta.
  const nonNullValues = observedValues.filter((v) => v.type !== 'null');
  const looksLikeId = nonNullValues.every((v) => v.type === 'string' || v.type === 'number');
  if (NAME_HEURISTIC_RE.test(fieldName) && looksLikeId && nonNullValues.length > 0) {
    return {
      sourceField: fieldName,
      proposedColumn: proposedColumnName(fieldName),
      confidence: 'medium',
      referencedCollectionShape: null,
      reason: `nombre de campo sugiere una relacion ('${fieldName}'), pero es un ${nonNullValues[0].type} plano, no un DocumentReference — coleccion destino desconocida, requiere confirmacion humana`,
    };
  }

  return null;
}

/**
 * Corre `detectRelation` sobre todos los campos observados en un conjunto de
 * documentos.
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
