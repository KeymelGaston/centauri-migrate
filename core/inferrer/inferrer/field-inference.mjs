/**
 * Infiere el tipo de columna Postgres para un campo, a partir de los
 * CanonicalValue observados en TODOS los documentos de una misma
 * `collectionShape`. Documentos de Firestore son schemaless -- es normal que
 * un campo falte en algunos documentos, o que (por error de la app origen)
 * tenga tipos distintos en documentos distintos. Este modulo nunca decide en
 * silencio ante inconsistencia: la marca con confianza 'baja' y el detalle
 * de que tipos vio, para que `centauri review` se la muestre al usuario.
 */

/** Mapeo de CanonicalType -> tipo Postgres propuesto por default. */
const CANONICAL_TO_PG = {
  string: 'text',
  number: 'numeric', // se refina a 'integer' si TODOS los valores observados son enteros
  boolean: 'boolean',
  timestamp: 'timestamptz',
  geopoint: 'jsonb', // sin soporte de PostGIS en v1; ver nota en el resultado
  reference: 'text', // se sobreescribe si relation-detection.mjs decide 'uuid'/'text' por FK
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
 *   Todos los CanonicalValue vistos para este campo, uno por documento donde
 *   el campo estaba presente (los documentos donde falta NO generan una
 *   entrada aca -- eso se refleja en `presentIn`/`totalDocs` por separado).
 * @param {number} presentIn - en cuantos documentos aparecio el campo
 * @param {number} totalDocs - total de documentos analizados en este shape
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
    // el campo solo aparecio como null, o nunca aparecio con un valor no-null
    return { name: fieldName, pgType: 'text', nullable: true, confidence: 'low', observedTypes: typeCounts, notes: ['nunca se observo un valor no-null; tipo sin evidencia, se propone text por default'] };
  }

  if (distinctTypes.length > 1) {
    // Inconsistencia real de tipos para el mismo campo entre documentos --
    // nunca se decide en silencio. Se propone el tipo mas frecuente, pero
    // marcado con confianza baja y el detalle completo para revision humana.
    const dominant = distinctTypes.reduce((a, b) => (typeCounts[a] >= typeCounts[b] ? a : b));
    notes.push(
      `tipos inconsistentes entre documentos: ${distinctTypes.map((t) => `${t} (${typeCounts[t]}x)`).join(', ')} -- requiere revision manual antes de aplicar`
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
    notes.push("guardado como 'jsonb' ({lat,lng}) -- v1 no soporta tipos PostGIS; revisar si se necesita geometry(Point) mas adelante");
  }

  if (nullable) {
    notes.push(`campo ausente en ${totalDocs - presentIn} de ${totalDocs} documentos`);
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
 * Infiere columnas para TODOS los campos observados en un conjunto de
 * documentos de una misma collectionShape (documentos son schemaless, asi
 * que primero hay que descubrir la union de todos los nombres de campo).
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
