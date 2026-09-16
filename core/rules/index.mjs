import { loadRules, findLeafMatches, extractDocumentLookups } from './ast-utils.mjs';
import { parseLogical, attachLookups } from './logical-parser.mjs';
import { composeSql } from './sql-generator.mjs';

/**
 * Public entry point of the `core/rules` module: reads a firestore.rules
 * file and returns, for every candidate table (leaf match), the candidate
 * RLS policies for both dialects (supabase, generic) along with the
 * warnings that require human review.
 *
 * IMPORTANT (read before using in production): this is a BEST-EFFORT
 * translator, not a security guarantee. Any unrecognized condition is
 * translated to FALSE (deny) as a safe default -- it never invents a
 * permissive policy for a pattern it doesn't understand. Every policy
 * generated here must go through human review before being applied; see
 * known limitations in README.md.
 *
 * @param {string} rulesFilePath - path to a firestore.rules file
 * @param {Object} [options]
 * @param {{ resolve: (shapeKey: string) => import('./schema-contract.mjs').SchemaMapping | null }} [options.schemaMap]
 *   Contract shared with the schema inferrer (see schema-contract.mjs). If
 *   omitted, subcollections referenced by get()/exists() are resolved with
 *   a best-effort heuristic (explicitly flagged as an assumption in each
 *   policy's notes).
 * @returns {Promise<Array<{
 *   path: string,
 *   policies: Array<{
 *     dialect: 'supabase' | 'generic',
 *     sql: string,
 *     notes: string[]
 *   }>
 * }>>}
 */
export async function generatePoliciesFromRulesFile(rulesFilePath, { schemaMap = null } = {}) {
  const { context, ast } = await loadRules(rulesFilePath);
  const leafMatches = await findLeafMatches(context, ast);

  const results = [];
  for (const { path, allows } of leafMatches) {
    const policies = [];
    for (const allowNode of allows) {
      const testNode = allowNode.condition?.test ?? allowNode.condition;
      if (!testNode) continue;

      const { cleanedExpr, lookupsByPlaceholder } = await extractDocumentLookups(context, testNode);
      const tree = attachLookups(parseLogical(cleanedExpr), lookupsByPlaceholder);

      for (const dialect of ['supabase', 'generic']) {
        const notes = [];
        const sql = composeSql(tree, dialect, notes, schemaMap);
        policies.push({ dialect, sql: sql ?? 'true', notes: [...new Set(notes)] });
      }
    }
    results.push({ path, policies });
  }
  return results;
}

export { parseLogical, attachLookups } from './logical-parser.mjs';
export { classifyLeaf } from './classifier.mjs';
export { leafToSql, composeSql, IDENTITY, snakeCase } from './sql-generator.mjs';
export { extractDocumentLookups, parseFirestorePath, findLeafMatches } from './ast-utils.mjs';
export { pathShapeKey, createSchemaMap } from './schema-contract.mjs';
