/**
 * Shared contract between `core/rules` (this module) and `core/inferrer`
 * (the CLI's schema inferrer, from the CLI blueprint).
 *
 * The problem this file solves: `core/rules` needs to know, for every
 * subcollection referenced in a get()/exists() in Firestore Rules, how the
 * schema inferrer resolved it -- did it become its own table? Was it
 * flattened as jsonb inside the parent? Without that information,
 * `core/rules` can only GUESS (see the heuristic fallback in
 * sql-generator.mjs), and that guess can be wrong -- this is exactly the
 * open item that was flagged in the README before this change.
 *
 * This file does NOT implement the schema inferrer. It defines the contract
 * (data shape) both modules must respect, plus a helper to build a
 * SchemaMap by hand (useful for tests, and as a minimal stub while the real
 * inferrer doesn't exist yet).
 *
 * @typedef {'own_table' | 'flattened_jsonb'} FlattenStrategy
 *
 * @typedef {Object} SchemaMapping
 * @property {FlattenStrategy} strategy
 * @property {string} [table] - Postgres table name. Required if
 *   strategy === 'own_table'.
 * @property {string} [primaryKeyColumn] - defaults to 'id' if omitted.
 * @property {string} [parentTable] - only relevant for 'own_table' when the
 *   subcollection has an FK to the parent (e.g. 'org_members.org_id').
 * @property {string} [parentForeignKeyColumn] - the name of that FK column.
 * @property {string} [flattenedIntoTable] - required if strategy ===
 *   'flattened_jsonb': the parent table where the jsonb column lives.
 * @property {string} [flattenedIntoColumn] - required if strategy ===
 *   'flattened_jsonb': the name of the jsonb column (typically an array of
 *   objects, one per document of the original subcollection).
 * @property {string} [elementKeyField] - only for 'flattened_jsonb': the
 *   field inside each element of the jsonb array that identifies the
 *   original document (e.g. 'user_id').
 */

/**
 * Converts a get()/exists() lookup's raw path (already in pairs
 * [{collection, key}], see parseFirestorePath in ast-utils.js) into a
 * stable "shape" to query the SchemaMap with -- the sequence of collection
 * names, ignoring the concrete variables. Two lookups to
 * `/orgs/{x}/members/{y}` for any x, y share the same shape
 * "orgs/members", because the schema inferrer decides how to model that
 * relationship ONCE, not per document.
 *
 * @param {{collection: string, key: any}[]} pairs
 * @returns {string}
 */
export function pathShapeKey(pairs) {
  return pairs.map((p) => p.collection).join('/');
}

/**
 * Builds a SchemaMap from a plain object { 'orgs/members': {...} }. Main
 * use: tests, and as a manual stub while the real inferrer doesn't exist.
 * The real inferrer should expose this same interface (`{
 * resolve(shapeKey) }`) from its own output, likely derived from
 * `schema.proposed.json` (see the CLI blueprint).
 *
 * @param {Record<string, SchemaMapping>} mappingsByShapeKey
 * @returns {{ resolve: (shapeKey: string) => SchemaMapping | null }}
 */
export function createSchemaMap(mappingsByShapeKey) {
  return {
    resolve(shapeKey) {
      return mappingsByShapeKey[shapeKey] ?? null;
    },
  };
}
