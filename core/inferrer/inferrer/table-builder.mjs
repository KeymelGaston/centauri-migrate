import { inferColumns } from './field-inference.mjs';
import { detectRelations, snakeCase } from './relation-detection.mjs';
import { decideNestingStrategy } from './nesting-strategy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Los ids autogenerados de Firestore son strings base62 de 20 caracteres,
 * NO uuids validos -- proponer 'uuid' como tipo de PK solo si de verdad
 * todos los ids observados tienen forma de uuid (ids elegidos a mano por la
 * app origen, caso real pero no el default de Firestore). */
function inferPrimaryKeyType(docs) {
  const allLookLikeUuid = docs.length > 0 && docs.every((d) => UUID_RE.test(d.id));
  return allLookLikeUuid ? 'uuid' : 'text';
}

function tableNameFromShape(shape) {
  // ultimo segmento de la forma (ej. "orgs/members" -> "members"); el nombre
  // real puede diferir si hay colision entre shapes con el mismo ultimo
  // segmento -- ver nota en index.mjs sobre colisiones de nombre de tabla.
  return snakeCase(shape.split('/').pop());
}

/** Singulariza un nombre de coleccion para nombrar una columna FK por
 * convencion (tabla 'orgs' -> columna 'org_id', no 'orgs_id'). Heuristica
 * simple (quita 's' final salvo terminaciones en 'ss'), no maneja plurales
 * irregulares en ingles (ej. 'children' -> deberia dar 'child' pero esta
 * heuristica no lo detecta) -- documentado como limite conocido, no un
 * bug silencioso: el nombre generado siempre queda visible para revision. */
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
 * Reconcilia columnas inferidas con relaciones detectadas: si un campo fue
 * detectado como relacion (ver relation-detection.mjs), la columna final
 * debe usar el nombre propuesto de FK (ej. 'author_id'), no el nombre crudo
 * del campo de Firestore (ej. 'authorRef') -- de lo contrario la tabla queda
 * con AMBAS cosas sin relacionarse entre si: una columna 'authorRef' Y una
 * "relacion sugerida" separada que nadie aplico. Bug real encontrado
 * revisando el output contra datos reales del usuario.
 *
 * La confianza final de la columna es la MAS BAJA entre la confianza del
 * tipo inferido y la confianza de que el campo sea de verdad una relacion
 * (una FK detectada solo por nombre, con dato de tipo 'high', sigue siendo
 * 'medium' en conjunto -- la incertidumbre sobre si es una relacion de
 * verdad no desaparece solo porque el tipo de dato si se conoce bien).
 */
function reconcileColumnsWithRelations(columns, relations) {
  const relationBySourceField = Object.fromEntries(relations.map((r) => [r.sourceField, r]));

  return columns.map((col) => {
    const relation = relationBySourceField[col.name];
    if (!relation) return col;

    const targetNote = relation.referencedCollectionShape
      ? `foreign key hacia '${relation.referencedCollectionShape}' (columna renombrada de '${col.name}' a '${relation.proposedColumn}')`
      : `posible foreign key (destino desconocido) — ${relation.reason} (columna renombrada de '${col.name}' a '${relation.proposedColumn}')`;

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
 * @returns {Object} definicion completa de tabla propuesta para este shape
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
    return { ...base, strategy: 'own_table', nestingConfidence: 'high', nestingReason: 'coleccion raiz, siempre tabla propia' };
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
