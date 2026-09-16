import { classifyLeaf } from './classifier.mjs';
import { parseFirestorePath } from './ast-utils.mjs';
import { pathShapeKey } from './schema-contract.mjs';

export function snakeCase(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export const IDENTITY = {
  supabase: {
    uid: () => `auth.uid()`,
    customClaim: (p) => `(auth.jwt() -> 'app_metadata' -> '${p}')`,
  },
  generic: {
    uid: () => `current_setting('app.user_id')::uuid`,
    customClaim: (p) => `NULL /* TODO: define how '${p}' reaches the session in generic Postgres */`,
  },
};

function resolveKeyExpr(key, dialect) {
  const inner = key.replace(/^\$\(|\)$/g, '');
  if (inner === 'request.auth.uid') return { sql: IDENTITY[dialect].uid(), caveat: null };
  return {
    sql: `<<row>>.${snakeCase(inner)}`,
    caveat: `assumes the current row's column '${snakeCase(inner)}' corresponds to the path variable {${inner}} — verify against the inferred schema`,
  };
}

/** Translates an ALREADY CLASSIFIED leaf to a SQL fragment for the given dialect.
 * @param {*} leaf
 * @param {'supabase'|'generic'} dialect
 * @param {{ resolve: (shapeKey: string) => import('./schema-contract.mjs').SchemaMapping | null } | null} [schemaMap]
 *   If provided, it's used to resolve the real table/column names for any
 *   subcollection referenced by get()/exists() -- instead of guessing by
 *   convention (see schema-contract.mjs). If omitted, or if
 *   `schemaMap.resolve()` returns null for a given path, it falls back to
 *   the previous heuristic (same behavior as before this change).
 * @returns {{sql: string|null, note?: string, drop?: boolean}}
 */
export function leafToSql(leaf, dialect, schemaMap = null) {
  switch (leaf.kind) {
    case 'auth_guard':
      // Contributes no predicate of its own: it's implemented by scoping the
      // policy to the authenticated role (Supabase: `TO authenticated`) or
      // by requiring the session to have app.user_id set (generic).
      return { sql: null, drop: true };
    case 'trivial':
      return { sql: leaf.value, note: `check whether "${leaf.value}" reflects the real intent` };
    case 'owner_pathvar':
      return { sql: `id = ${IDENTITY[dialect].uid()}`, note: `assumes PK 'id' corresponds to {${leaf.pathVar}}` };
    case 'owner_field':
      return { sql: `${snakeCase(leaf.field)} = ${IDENTITY[dialect].uid()}` };
    case 'lookup_field':
    case 'lookup_exists': {
      const pairs = parseFirestorePath(leaf.lookup.rawPath);
      const mapping = schemaMap?.resolve(pathShapeKey(pairs)) ?? null;
      return lookupToSql(leaf, pairs, dialect, mapping);
    }
    case 'custom_claim_eq':
      return { sql: `${IDENTITY[dialect].customClaim(leaf.claim)} = '${leaf.value}'`, note: `confirm where the claim '${leaf.claim}' actually lives` };
    case 'custom_claim_hasAny': {
      const claim = IDENTITY[dialect].customClaim(leaf.claim);
      const sql = dialect === 'supabase' ? `${claim}::jsonb ?| array[${leaf.values.map((v) => `'${v}'`).join(', ')}]` : claim;
      return { sql, note: `confirm where the claim '${leaf.claim}' actually lives` };
    }
    default:
      return { sql: 'FALSE', note: `unrecognized condition ("${leaf.text}") — requires manual review; FALSE (deny) is used as the safe default` };
  }
}

/** Generates the EXISTS(...) fragment for a get()/exists() lookup, using the
 * schema inferrer's real decision when available (`mapping`), or the
 * previous heuristic when not. */
function lookupToSql(leaf, pairs, dialect, mapping) {
  const target = pairs[pairs.length - 1];
  const notes = [];

  if (!mapping) {
    // No info from the schema inferrer: same heuristic as before this
    // change -- assumes its own table named after the collection.
    const key = resolveKeyExpr(target.key, dialect);
    let sql = `EXISTS (\n      SELECT 1 FROM ${target.collection}\n      WHERE ${target.collection}.id = ${key.sql}`;
    if (leaf.kind === 'lookup_field') sql += `\n        AND ${target.collection}.${snakeCase(leaf.field)} = ${valueSql(leaf, dialect)}`;
    sql += `\n    )`;
    if (key.caveat) notes.push(key.caveat);
    if (pairs.length > 1) {
      notes.push(
        `compound path (${pairs.map((p) => p.collection).join(' > ')}) with no schema map — table name '${target.collection}' is an assumption, not a confirmed decision; connect this to the schema inferrer to resolve it for real`
      );
    }
    return { sql, note: notes.join(' | ') || null };
  }

  if (mapping.strategy === 'own_table') {
    const table = mapping.table;
    const pk = mapping.primaryKeyColumn ?? 'id';
    const key = resolveKeyExpr(target.key, dialect);
    let sql = `EXISTS (\n      SELECT 1 FROM ${table}\n      WHERE ${table}.${pk} = ${key.sql}`;
    if (key.caveat) notes.push(key.caveat);

    // If there's a parent in the path (e.g. orgs/{orgId}/members/{uid}) and
    // the mapping declares its FK, also correlate against the parent -- if
    // this isn't done, a `id`/pk that happens to match under a DIFFERENT
    // parent would still pass the check, which would be over-permissive.
    if (pairs.length > 1 && mapping.parentForeignKeyColumn) {
      const parentPair = pairs[pairs.length - 2];
      const parentKey = resolveKeyExpr(parentPair.key, dialect);
      sql += `\n        AND ${table}.${mapping.parentForeignKeyColumn} = ${parentKey.sql}`;
      if (parentKey.caveat) notes.push(parentKey.caveat);
    } else if (pairs.length > 1 && !mapping.parentForeignKeyColumn) {
      notes.push(
        `the mapping for '${pathShapeKey(pairs)}' doesn't declare parentForeignKeyColumn — the policy is NOT correlating against the path's parent (${pairs[pairs.length - 2].collection}); if '${table}' can have rows with the same ${pk} under different parents, this is more permissive than it should be`
      );
    }

    if (leaf.kind === 'lookup_field') sql += `\n        AND ${table}.${snakeCase(leaf.field)} = ${valueSql(leaf, dialect)}`;
    sql += `\n    )`;
    return { sql, note: notes.join(' | ') || null };
  }

  if (mapping.strategy === 'flattened_jsonb') {
    // The subcollection isn't its own table: it lives as a jsonb array in a
    // column of another table (mapping.flattenedIntoTable / ...Column).
    // Only the 2-segment case (parent collection -> flattened subcollection)
    // is supported for now.
    if (pairs.length !== 2) {
      notes.push(
        `mapping 'flattened_jsonb' for '${pathShapeKey(pairs)}' with ${pairs.length} segments isn't supported (only the 2-segment case is handled: parent + flattened subcollection) — requires manual review`
      );
      return { sql: 'FALSE', note: notes.join(' | ') };
    }
    const parentPair = pairs[0];
    const parentKey = resolveKeyExpr(parentPair.key, dialect);
    const innerKey = resolveKeyExpr(target.key, dialect);
    const elementField = mapping.elementKeyField ?? 'id';
    const parentPk = mapping.flattenedIntoTablePrimaryKeyColumn ?? 'id';

    let sql =
      `EXISTS (\n      SELECT 1 FROM ${mapping.flattenedIntoTable}\n` +
      `      CROSS JOIN LATERAL jsonb_array_elements(${mapping.flattenedIntoTable}.${mapping.flattenedIntoColumn}) AS elem\n` +
      `      WHERE ${mapping.flattenedIntoTable}.${parentPk} = ${parentKey.sql}\n` +
      `        AND elem->>'${elementField}' = ${innerKey.sql}::text`;
    if (leaf.kind === 'lookup_field') {
      sql += `\n        AND elem->>'${snakeCase(leaf.field)}' = ${valueSql(leaf, dialect)}`;
    }
    sql += `\n    )`;
    if (parentKey.caveat) notes.push(parentKey.caveat);
    notes.push(
      `policy over a flattened jsonb array: verify that the field name inside each element ('${elementField}'${leaf.kind === 'lookup_field' ? `, '${snakeCase(leaf.field)}'` : ''}) exactly matches what the schema inferrer produced`
    );
    return { sql, note: notes.join(' | ') || null };
  }

  return { sql: 'FALSE', note: `unrecognized schema map strategy: '${mapping.strategy}'` };
}

function valueSql(leaf, dialect) {
  return leaf.valueIsIdentity ? IDENTITY[dialect].uid() : `'${leaf.value}'`;
}

/** Recursively composes the AND/OR tree into a single SQL string, dropping
 * "drop" leaves (e.g. the request.auth != null guard). */
export function composeSql(tree, dialect, notes, schemaMap = null) {
  if (tree.op === 'LEAF') {
    const leaf = classifyLeaf(tree.text, tree.lookupsByPlaceholder);
    const { sql, note, drop } = leafToSql(leaf, dialect, schemaMap);
    if (note) notes.push(note);
    return drop ? null : sql;
  }
  const parts = tree.terms.map((t) => composeSql(t, dialect, notes, schemaMap)).filter((p) => p !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const joiner = tree.op === 'AND' ? '\n  AND ' : '\n  OR ';
  return '(\n  ' + parts.join(joiner) + '\n)';
}
