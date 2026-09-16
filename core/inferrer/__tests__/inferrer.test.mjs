import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inferFieldType, inferColumns } from '../field-inference.mjs';
import { detectRelation } from '../relation-detection.mjs';
import { decideNestingStrategy } from '../nesting-strategy.mjs';
import { buildTable } from '../table-builder.mjs';
import { toSchemaMapMappings } from '../schema-map-adapter.mjs';
import { inferSchema } from '../index.mjs';
import { writeSnapshot } from '../../extractor/snapshot-writer.mjs';
import { createSchemaMap, generatePoliciesFromRulesFile } from '../../rules/index.mjs';

function cv(type, value) {
  return { type, value };
}

// ---------------------------------------------------------------------------
// field-inference.mjs
// ---------------------------------------------------------------------------

test('inferFieldType: consistent type -> high confidence', () => {
  const result = inferFieldType('name', [cv('string', 'Ana'), cv('string', 'Luis')], 2, 2);
  assert.equal(result.pgType, 'text');
  assert.equal(result.confidence, 'high');
  assert.equal(result.nullable, false);
});

test('inferFieldType: integers -> integer; with decimals -> numeric', () => {
  const ints = inferFieldType('age', [cv('number', 29), cv('number', 34)], 2, 2);
  assert.equal(ints.pgType, 'integer');

  const decimals = inferFieldType('total', [cv('number', 149.99), cv('number', 10)], 2, 2);
  assert.equal(decimals.pgType, 'numeric');
});

test('inferFieldType: REGRESSION -- inconsistent types are never decided silently', () => {
  const result = inferFieldType('value', [cv('string', 'ten'), cv('number', 10)], 2, 2);
  assert.equal(result.confidence, 'low');
  assert.ok(result.notes.some((n) => n.includes('inconsistent')));
  assert.deepEqual(result.observedTypes, { string: 1, number: 1 });
});

test('inferFieldType: field missing in some documents -> nullable, medium confidence', () => {
  const result = inferFieldType('nickname', [cv('string', 'Ana')], 1, 3);
  assert.equal(result.nullable, true);
  assert.equal(result.confidence, 'medium');
});

test('inferColumns: discovers the union of fields across documents with different shapes (schemaless)', () => {
  const docs = [
    { fields: { name: cv('string', 'Ana'), age: cv('number', 29) } },
    { fields: { name: cv('string', 'Luis') } }, // no 'age'
  ];
  const columns = inferColumns(docs);
  const age = columns.find((c) => c.name === 'age');
  assert.equal(age.nullable, true);
  assert.equal(age.confidence, 'medium');
});

// ---------------------------------------------------------------------------
// relation-detection.mjs
// ---------------------------------------------------------------------------

test('detectRelation: real DocumentReference -> high confidence, known target collection', () => {
  const result = detectRelation('authorRef', [cv('reference', 'users/u1')]);
  assert.equal(result.confidence, 'high');
  assert.equal(result.referencedCollectionShape, 'users');
  assert.equal(result.proposedColumn, 'author_id');
});

test('detectRelation: name heuristic with no DocumentReference -> medium confidence, unknown target', () => {
  const result = detectRelation('authorId', [cv('string', 'u1')]);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.referencedCollectionShape, null);
});

test('detectRelation: field with no relation pattern -> null (nothing suggested)', () => {
  const result = detectRelation('description', [cv('string', 'hello')]);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// nesting-strategy.mjs
// ---------------------------------------------------------------------------

function makeChildDocs(shape, parentIds, docsPerParent) {
  const docs = [];
  for (const parentId of parentIds) {
    for (let i = 0; i < docsPerParent; i++) {
      docs.push({ sourcePath: `orgs/${parentId}/members/m${i}`, collectionShape: shape, fields: {} });
    }
  }
  return docs;
}

test('decideNestingStrategy: low fan-out -> suggested flattened_jsonb, low confidence', () => {
  const docs = makeChildDocs('orgs/members', ['org1', 'org2'], 1);
  const result = decideNestingStrategy('orgs/members', docs, ['orgs', 'orgs/members']);
  assert.equal(result.strategy, 'flattened_jsonb');
  assert.equal(result.confidence, 'low');
});

test('decideNestingStrategy: high fan-out -> own_table', () => {
  const docs = makeChildDocs('orgs/members', ['org1', 'org2'], 8);
  const result = decideNestingStrategy('orgs/members', docs, ['orgs', 'orgs/members']);
  assert.equal(result.strategy, 'own_table');
});

test('decideNestingStrategy: sub-subcollections force own_table regardless of fan-out', () => {
  const docs = makeChildDocs('orgs/members', ['org1'], 1);
  const result = decideNestingStrategy('orgs/members', docs, ['orgs', 'orgs/members', 'orgs/members/permissions']);
  assert.equal(result.strategy, 'own_table');
  assert.equal(result.confidence, 'high');
});

test('buildTable: REGRESSION -- FK to the parent gets singularized ("orgs" -> "org_id", not "orgs_id")', () => {
  const docs = makeChildDocs('orgs/members', ['org1', 'org2'], 8); // high fan-out -> own_table
  const table = buildTable('orgs/members', docs, ['orgs', 'orgs/members']);
  assert.equal(table.strategy, 'own_table');
  assert.equal(table.parentForeignKeyColumn, 'org_id');
});

test('buildTable: REGRESSION -- a column with a detected relation uses the proposed FK name, not the raw field', () => {
  // Real case found while reviewing output against the user's own data:
  // before this fix, the column stayed as 'authorRef' AND a separate
  // "suggested relation" toward 'author_id' showed up, with neither one applied.
  const docs = [
    { id: 'p1', sourcePath: 'posts/p1', fields: { authorRef: cv('reference', 'users/u1'), title: cv('string', 'Hello') } },
  ];
  const table = buildTable('posts', docs, ['posts', 'users']);
  const columnNames = table.columns.map((c) => c.name);

  assert.ok(!columnNames.includes('authorRef'), 'the raw field name must not remain');
  assert.ok(columnNames.includes('author_id'), 'the proposed FK name must be used');

  const fkColumn = table.columns.find((c) => c.name === 'author_id');
  assert.equal(fkColumn.sourceField, 'authorRef');
  assert.equal(fkColumn.confidence, 'high'); // high-confidence type + high-confidence relation -> high
  assert.ok(fkColumn.notes.some((n) => n.includes("foreign key to 'users'")));
});

test('buildTable: REGRESSION -- a name-heuristic relation (medium confidence) lowers the column\'s final confidence', () => {
  const docs = [{ id: 'p1', sourcePath: 'posts/p1', fields: { authorId: cv('string', 'u1') } }];
  const table = buildTable('posts', docs, ['posts']);
  const fkColumn = table.columns.find((c) => c.name === 'author_id');
  // the data type is 'high' (a single consistent string), but the relation
  // is only 'medium' (name heuristic, no real DocumentReference) -> the
  // column's final confidence must reflect the lower of the two.
  assert.equal(fkColumn.confidence, 'medium');
});

// ---------------------------------------------------------------------------
// Real integration: snapshot -> inferSchema -> schemaMap -> core/rules
// ---------------------------------------------------------------------------

test('INTEGRATION: the real inferred schemaMap produces correct SQL in core/rules (high fan-out -> own_table)', async () => {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'centauri-infer-'));

  async function* fakeDocs() {
    yield { id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: { name: cv('string', 'Acme') } };
    for (let i = 0; i < 7; i++) {
      yield {
        id: `m${i}`,
        sourcePath: `orgs/org1/members/m${i}`,
        collectionShape: 'orgs/members',
        fields: { role: cv('string', i === 0 ? 'admin' : 'member') },
      };
    }
  }
  await writeSnapshot(snapshotDir, fakeDocs());

  const { schemaMapMappings, tables } = await inferSchema(snapshotDir);

  const membersTable = tables.find((t) => t.collectionShape === 'orgs/members');
  assert.equal(membersTable.strategy, 'own_table'); // 7 members for 1 org -> high fan-out
  assert.equal(schemaMapMappings['orgs/members'].table, 'members');
  assert.equal(schemaMapMappings['orgs/members'].parentForeignKeyColumn, 'org_id');

  // Now we hand it for real to core/rules, without mocking anything by hand.
  const rulesFile = path.join(snapshotDir, 'test.rules');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    rulesFile,
    `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{memberId} {
      allow read: if get(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'admin';
    }
  }
}
`
  );

  const schemaMap = createSchemaMap(schemaMapMappings);
  const results = await generatePoliciesFromRulesFile(rulesFile, { schemaMap });
  const table = results.find((r) => r.path === '/orgs/{orgId}/members/{memberId}');
  const supabasePolicy = table.policies.find((p) => p.dialect === 'supabase');

  // Must use the REAL inferred table name ('members'), not a hand-built mock
  assert.match(supabasePolicy.sql, /FROM members/);
  assert.match(supabasePolicy.sql, /members\.role = 'admin'/);
  assert.ok(!supabasePolicy.notes.some((n) => n.includes('with no schema map')));
});

test('INTEGRATION: low fan-out -> flattened_jsonb, core/rules generates a jsonb_array_elements query', async () => {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'centauri-infer-'));

  async function* fakeDocs() {
    yield { id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: { name: cv('string', 'Acme') } };
    yield {
      id: 'm0',
      sourcePath: 'orgs/org1/members/m0',
      collectionShape: 'orgs/members',
      fields: { role: cv('string', 'admin') },
    };
  }
  await writeSnapshot(snapshotDir, fakeDocs());

  const { schemaMapMappings, tables } = await inferSchema(snapshotDir);
  const membersTable = tables.find((t) => t.collectionShape === 'orgs/members');
  assert.equal(membersTable.strategy, 'flattened_jsonb'); // 1 member for 1 org -> low fan-out

  const rulesFile = path.join(snapshotDir, 'test.rules');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    rulesFile,
    `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{memberId} {
      allow read: if get(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'admin';
    }
  }
}
`
  );

  const schemaMap = createSchemaMap(schemaMapMappings);
  const results = await generatePoliciesFromRulesFile(rulesFile, { schemaMap });
  const table = results.find((r) => r.path === '/orgs/{orgId}/members/{memberId}');
  const supabasePolicy = table.policies.find((p) => p.dialect === 'supabase');

  assert.match(supabasePolicy.sql, /jsonb_array_elements\(orgs\.members\)/);
});
