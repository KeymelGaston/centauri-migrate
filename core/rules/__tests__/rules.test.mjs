import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { generatePoliciesFromRulesFile } from '../index.mjs';
import { parseLogical } from '../logical-parser.mjs';
import { classifyLeaf } from '../classifier.mjs';
import { createSchemaMap } from '../schema-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixture.rules');

// Generated once and reused across tests (avoids re-parsing 8 times)
const resultsPromise = generatePoliciesFromRulesFile(fixturePath);
async function byPath(p) {
  const results = await resultsPromise;
  const found = results.find((r) => r.path === p);
  assert.ok(found, `no candidate table found for ${p}`);
  return found;
}
function policyFor(table, dialect, index = 0) {
  const matches = table.policies.filter((p) => p.dialect === dialect);
  return matches[index];
}

test('logical-parser: split respects precedence without depending on firetree\'s AST', () => {
  // This is the case that exposed the precedence bug in firetree: if its
  // AST were trusted, "!=" would end up as the root instead of "&&".
  const tree = parseLogical("request.auth != null && request.auth.uid == userId");
  assert.equal(tree.op, 'AND');
  assert.equal(tree.terms.length, 2);
  assert.equal(tree.terms[0].text, 'request.auth != null');
  assert.equal(tree.terms[1].text, 'request.auth.uid == userId');
});

test('logical-parser: top-level OR with AND nested inside explicit parentheses', () => {
  // Before this change, explicit user parentheses would have been treated
  // as an opaque leaf (all of "(b == 2 && c == 3)" as a single unrecognized
  // text -> FALSE). Now it unwraps correctly.
  const tree = parseLogical("a == 1 || (b == 2 && c == 3)");
  assert.equal(tree.op, 'OR');
  assert.equal(tree.terms[0].text, 'a == 1');
  assert.equal(tree.terms[1].op, 'AND');
  assert.equal(tree.terms[1].terms[0].text, 'b == 2');
  assert.equal(tree.terms[1].terms[1].text, 'c == 3');
});

test('logical-parser: does not split inside the parens/brackets of a real call', () => {
  const tree = parseLogical("__doc_lookup_0__.data.role == 'admin' && __doc_lookup_1__");
  assert.equal(tree.op, 'AND');
  assert.equal(tree.terms.length, 2);
});

test('classifier: direct ownership via path variable', () => {
  const leaf = classifyLeaf('request.auth.uid == userId', {});
  assert.equal(leaf.kind, 'owner_pathvar');
  assert.equal(leaf.pathVar, 'userId');
});

test('classifier: ownership via a document field', () => {
  const leaf = classifyLeaf('request.auth.uid == resource.data.authorId', {});
  assert.equal(leaf.kind, 'owner_field');
  assert.equal(leaf.field, 'authorId');
});

test('classifier: REGRESSION -- reversed-comparison lookup is NOT confused with ownership', () => {
  // Real bug found during the spike: "placeholder.data.field == request.auth.uid"
  // was being classified as owner_pathvar instead of lookup_field.
  const lookups = { __doc_lookup_0__: { functionName: 'get', rawPath: '/orgs/$(orgId)' } };
  const leaf = classifyLeaf('__doc_lookup_0__.data.ownerId == request.auth.uid', lookups);
  assert.equal(leaf.kind, 'lookup_field');
  assert.equal(leaf.field, 'ownerId');
  assert.equal(leaf.valueIsIdentity, true);
});

test('users/{userId}: direct ownership, both dialects', async () => {
  const table = await byPath('/users/{userId}');
  const supabase = policyFor(table, 'supabase');
  const generic = policyFor(table, 'generic');
  assert.match(supabase.sql, /id = auth\.uid\(\)/);
  assert.match(generic.sql, /id = current_setting\('app\.user_id'\)::uuid/);
});

test('posts/{postId}: two allows -> "if true" level 0 + ownership by field', async () => {
  const table = await byPath('/posts/{postId}');
  const supabaseSqls = table.policies.filter((p) => p.dialect === 'supabase').map((p) => p.sql);
  assert.ok(supabaseSqls.includes('true'));
  assert.ok(supabaseSqls.some((s) => /author_id = auth\.uid\(\)/.test(s)));
});

test('projects/{projectId}: get() + field -> EXISTS with AND, no auth guard', async () => {
  const table = await byPath('/projects/{projectId}');
  const supabase = policyFor(table, 'supabase');
  assert.match(supabase.sql, /EXISTS \(/);
  assert.match(supabase.sql, /members\.role = 'admin'/);
  // the original's "request.auth != null" must NOT show up as a predicate
  assert.doesNotMatch(supabase.sql, /request\.auth/);
});

test('teams/private: exists() with no further comparison', async () => {
  const table = await byPath('/teams/{teamId}/private/{docId}');
  const supabase = policyFor(table, 'supabase');
  assert.match(supabase.sql, /EXISTS \(\s*SELECT 1 FROM members/);
  assert.ok(table.policies.some((p) => p.notes.some((n) => n.includes('compound path'))));
});

test('schemaMap: with no entry for a given shape, still falls back to the previous heuristic', async () => {
  const schemaMap = createSchemaMap({
    'orgs/members': { strategy: 'own_table', table: 'org_members', primaryKeyColumn: 'user_id', parentForeignKeyColumn: 'org_id' },
  });
  const results = await generatePoliciesFromRulesFile(fixturePath, { schemaMap });
  // teams/members has no entry in this schemaMap -> should still fall back to the heuristic
  const table = results.find((r) => r.path === '/teams/{teamId}/private/{docId}');
  const supabase = policyFor(table, 'supabase');
  assert.ok(supabase.notes.some((n) => n.includes('with no schema map')));
});

test('schemaMap: own_table resolves the real table/column name and correlates with the parent', async () => {
  const schemaMap = createSchemaMap({
    'orgs/members': { strategy: 'own_table', table: 'org_members', primaryKeyColumn: 'user_id', parentForeignKeyColumn: 'org_id' },
  });
  const results = await generatePoliciesFromRulesFile(fixturePath, { schemaMap });
  const table = results.find((r) => r.path === '/orgs/{orgId}/secrets/{secretId}');
  const supabase = policyFor(table, 'supabase');
  // the "admin" half of the OR uses orgs/members -> should resolve to
  // org_members, correlated by org_id, with the real PK user_id (not a
  // guessed generic 'id')
  assert.match(supabase.sql, /org_members\.user_id = auth\.uid\(\)/);
  assert.match(supabase.sql, /org_members\.org_id = <<row>>\.org_id/);
  assert.ok(!supabase.notes.some((n) => n.includes('with no schema map')));
});

test('schemaMap: flattened_jsonb generates a query over the array, not a separate table', async () => {
  const schemaMap = createSchemaMap({
    'orgs/members': {
      strategy: 'flattened_jsonb',
      flattenedIntoTable: 'orgs',
      flattenedIntoColumn: 'members',
      elementKeyField: 'user_id',
    },
  });
  const results = await generatePoliciesFromRulesFile(fixturePath, { schemaMap });
  const table = results.find((r) => r.path === '/orgs/{orgId}/secrets/{secretId}');
  const supabase = policyFor(table, 'supabase');
  assert.match(supabase.sql, /jsonb_array_elements\(orgs\.members\)/);
  assert.match(supabase.sql, /elem->>'user_id' = auth\.uid\(\)::text/);
  assert.match(supabase.sql, /elem->>'role' = 'admin'/);
});

test('admin_panel: custom claim hasAny -> supabase resolves it, generic flags a TODO', async () => {
  const table = await byPath('/admin_panel/{docId}');
  const supabase = policyFor(table, 'supabase');
  const generic = policyFor(table, 'generic');
  assert.match(supabase.sql, /\?\|\s*array\['admin', 'moderator'\]/);
  assert.match(generic.sql, /TODO/);
});

test('orgs/secrets: REGRESSION -- OR of two EXISTS, reversed comparison resolved against the correct table', async () => {
  const table = await byPath('/orgs/{orgId}/secrets/{secretId}');
  const supabase = policyFor(table, 'supabase');
  assert.match(supabase.sql, /^\(\n\s*EXISTS/); // starts with an OR of two EXISTS
  assert.match(supabase.sql, /orgs\.owner_id = auth\.uid\(\)/); // NOT "id = auth.uid()"
  assert.match(supabase.sql, /OR EXISTS/);
  assert.match(supabase.sql, /members\.role = 'admin'/);
});

test('billing: custom claim ==', async () => {
  const table = await byPath('/billing/{docId}');
  const supabase = policyFor(table, 'supabase');
  assert.match(supabase.sql, /app_metadata.*'plan'.*=\s*'pro'/s);
});

test('comments: level 3 -- untranslatable, default FALSE (deny), never invents a permissive policy', async () => {
  const table = await byPath('/comments/{commentId}');
  const supabase = policyFor(table, 'supabase');
  assert.match(supabase.sql, /FALSE/);
  assert.doesNotMatch(supabase.sql, /TRUE/);
});
