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

test('inferFieldType: tipo consistente -> alta confianza', () => {
  const result = inferFieldType('name', [cv('string', 'Ana'), cv('string', 'Luis')], 2, 2);
  assert.equal(result.pgType, 'text');
  assert.equal(result.confidence, 'high');
  assert.equal(result.nullable, false);
});

test('inferFieldType: numeros enteros -> integer; con decimales -> numeric', () => {
  const ints = inferFieldType('age', [cv('number', 29), cv('number', 34)], 2, 2);
  assert.equal(ints.pgType, 'integer');

  const decimals = inferFieldType('total', [cv('number', 149.99), cv('number', 10)], 2, 2);
  assert.equal(decimals.pgType, 'numeric');
});

test('inferFieldType: REGRESSION -- tipos inconsistentes nunca se deciden en silencio', () => {
  const result = inferFieldType('value', [cv('string', 'diez'), cv('number', 10)], 2, 2);
  assert.equal(result.confidence, 'low');
  assert.ok(result.notes.some((n) => n.includes('inconsistentes')));
  assert.deepEqual(result.observedTypes, { string: 1, number: 1 });
});

test('inferFieldType: campo ausente en algunos documentos -> nullable, confianza media', () => {
  const result = inferFieldType('nickname', [cv('string', 'Ana')], 1, 3);
  assert.equal(result.nullable, true);
  assert.equal(result.confidence, 'medium');
});

test('inferColumns: descubre la union de campos entre documentos con forma distinta (schemaless)', () => {
  const docs = [
    { fields: { name: cv('string', 'Ana'), age: cv('number', 29) } },
    { fields: { name: cv('string', 'Luis') } }, // sin 'age'
  ];
  const columns = inferColumns(docs);
  const age = columns.find((c) => c.name === 'age');
  assert.equal(age.nullable, true);
  assert.equal(age.confidence, 'medium');
});

// ---------------------------------------------------------------------------
// relation-detection.mjs
// ---------------------------------------------------------------------------

test('detectRelation: DocumentReference real -> alta confianza, coleccion destino conocida', () => {
  const result = detectRelation('authorRef', [cv('reference', 'users/u1')]);
  assert.equal(result.confidence, 'high');
  assert.equal(result.referencedCollectionShape, 'users');
  assert.equal(result.proposedColumn, 'author_id');
});

test('detectRelation: heuristica de nombre sin DocumentReference -> confianza media, destino desconocido', () => {
  const result = detectRelation('authorId', [cv('string', 'u1')]);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.referencedCollectionShape, null);
});

test('detectRelation: campo sin patron de relacion -> null (no se sugiere nada)', () => {
  const result = detectRelation('description', [cv('string', 'hola')]);
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

test('decideNestingStrategy: fan-out bajo -> flattened_jsonb sugerido, confianza baja', () => {
  const docs = makeChildDocs('orgs/members', ['org1', 'org2'], 1);
  const result = decideNestingStrategy('orgs/members', docs, ['orgs', 'orgs/members']);
  assert.equal(result.strategy, 'flattened_jsonb');
  assert.equal(result.confidence, 'low');
});

test('decideNestingStrategy: fan-out alto -> own_table', () => {
  const docs = makeChildDocs('orgs/members', ['org1', 'org2'], 8);
  const result = decideNestingStrategy('orgs/members', docs, ['orgs', 'orgs/members']);
  assert.equal(result.strategy, 'own_table');
});

test('decideNestingStrategy: sub-subcolecciones fuerzan own_table sin importar el fan-out', () => {
  const docs = makeChildDocs('orgs/members', ['org1'], 1);
  const result = decideNestingStrategy('orgs/members', docs, ['orgs', 'orgs/members', 'orgs/members/permissions']);
  assert.equal(result.strategy, 'own_table');
  assert.equal(result.confidence, 'high');
});

test('buildTable: REGRESSION -- FK al padre se singulariza ("orgs" -> "org_id", no "orgs_id")', () => {
  const docs = makeChildDocs('orgs/members', ['org1', 'org2'], 8); // fan-out alto -> own_table
  const table = buildTable('orgs/members', docs, ['orgs', 'orgs/members']);
  assert.equal(table.strategy, 'own_table');
  assert.equal(table.parentForeignKeyColumn, 'org_id');
});

test('buildTable: REGRESSION -- columna con relacion detectada usa el nombre de FK propuesto, no el campo crudo', () => {
  // Caso real encontrado revisando output contra datos del usuario: antes de
  // este fix, la columna quedaba como 'authorRef' Y por separado aparecia
  // una "relacion sugerida" hacia 'author_id' sin que ninguna se aplicara.
  const docs = [
    { id: 'p1', sourcePath: 'posts/p1', fields: { authorRef: cv('reference', 'users/u1'), title: cv('string', 'Hola') } },
  ];
  const table = buildTable('posts', docs, ['posts', 'users']);
  const columnNames = table.columns.map((c) => c.name);

  assert.ok(!columnNames.includes('authorRef'), 'no debe quedar el nombre crudo del campo');
  assert.ok(columnNames.includes('author_id'), 'debe quedar el nombre de FK propuesto');

  const fkColumn = table.columns.find((c) => c.name === 'author_id');
  assert.equal(fkColumn.sourceField, 'authorRef');
  assert.equal(fkColumn.confidence, 'high'); // tipo alta confianza + relacion alta confianza -> high
  assert.ok(fkColumn.notes.some((n) => n.includes("foreign key hacia 'users'")));
});

test('buildTable: REGRESSION -- relacion por heuristica de nombre (confianza media) baja la confianza final de la columna', () => {
  const docs = [{ id: 'p1', sourcePath: 'posts/p1', fields: { authorId: cv('string', 'u1') } }];
  const table = buildTable('posts', docs, ['posts']);
  const fkColumn = table.columns.find((c) => c.name === 'author_id');
  // tipo de dato es 'high' (un solo string consistente), pero la relacion es
  // solo 'medium' (heuristica de nombre, sin DocumentReference real) -> la
  // confianza final de la columna debe reflejar la mas baja de las dos.
  assert.equal(fkColumn.confidence, 'medium');
});

// ---------------------------------------------------------------------------
// Integracion real: snapshot -> inferSchema -> schemaMap -> core/rules
// ---------------------------------------------------------------------------

test('INTEGRACION: el schemaMap inferido de verdad produce SQL correcto en core/rules (fan-out alto -> own_table)', async () => {
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
  assert.equal(membersTable.strategy, 'own_table'); // 7 miembros para 1 org -> fan-out alto
  assert.equal(schemaMapMappings['orgs/members'].table, 'members');
  assert.equal(schemaMapMappings['orgs/members'].parentForeignKeyColumn, 'org_id');

  // Ahora se lo pasamos de verdad a core/rules, sin mockear nada a mano.
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

  // Debe usar el nombre de tabla REAL inferido ('members'), no un mock a mano
  assert.match(supabasePolicy.sql, /FROM members/);
  assert.match(supabasePolicy.sql, /members\.role = 'admin'/);
  assert.ok(!supabasePolicy.notes.some((n) => n.includes('sin schema map')));
});

test('INTEGRACION: fan-out bajo -> flattened_jsonb, core/rules genera query sobre jsonb_array_elements', async () => {
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
  assert.equal(membersTable.strategy, 'flattened_jsonb'); // 1 miembro para 1 org -> fan-out bajo

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
