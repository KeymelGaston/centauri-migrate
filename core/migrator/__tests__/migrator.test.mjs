import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateCreateTableStatements } from '../ddl-generator.mjs';
import { mapDocumentToRow, mapDocumentToFlattenedElement, parentIdFromChildSourcePath } from '../row-mapper.mjs';
import { toColumnValue, toPlainJson, referenceIdFromPath } from '../canonical-to-sql.mjs';
import { loadCheckpoint, saveCheckpoint, isStepDone, markStepDone } from '../checkpoint-store.mjs';
import { runMigration } from '../index.mjs';
import { writeSnapshot } from '../../extractor/snapshot-writer.mjs';

function cv(type, value) {
  return { type, value };
}

// ---------------------------------------------------------------------------
// canonical-to-sql.mjs
// ---------------------------------------------------------------------------

test('toColumnValue: jsonb column gets JSON-stringified plain data', () => {
  const value = toColumnValue(cv('array', [cv('string', 'a')]), 'jsonb');
  assert.equal(value, JSON.stringify(['a']));
});

test('toColumnValue: bytea column gets a real Buffer', () => {
  const b64 = Buffer.from('hi').toString('base64');
  const value = toColumnValue(cv('bytes', b64), 'bytea');
  assert.ok(Buffer.isBuffer(value));
  assert.equal(value.toString(), 'hi');
});

test('toColumnValue: a reference used as a foreign key resolves to just the id, never the full path', () => {
  const value = toColumnValue(cv('reference', 'users/u1'), 'text', { isForeignKey: true });
  assert.equal(value, 'u1');
});

test('toColumnValue: a reference NOT used as a foreign key keeps its full path (e.g. embedded in jsonb)', () => {
  const value = toColumnValue(cv('reference', 'users/u1'), 'jsonb', { isForeignKey: false });
  assert.equal(value, JSON.stringify('users/u1'));
});

test('toPlainJson: recursively strips the canonical wrapper', () => {
  const result = toPlainJson(cv('map', { city: cv('string', 'Santo Domingo') }));
  assert.deepEqual(result, { city: 'Santo Domingo' });
});

test('referenceIdFromPath: last segment only', () => {
  assert.equal(referenceIdFromPath('orgs/abc/members/xyz'), 'xyz');
});

// ---------------------------------------------------------------------------
// ddl-generator.mjs
// ---------------------------------------------------------------------------

const SAMPLE_TABLES = [
  {
    collectionShape: 'orgs',
    tableName: 'orgs',
    primaryKeyColumn: 'id',
    primaryKeyType: 'text',
    strategy: 'own_table',
    columns: [{ name: 'name', pgType: 'text', nullable: false }],
  },
  {
    collectionShape: 'orgs/members',
    tableName: 'members',
    primaryKeyColumn: 'id',
    primaryKeyType: 'text',
    strategy: 'own_table',
    parentCollectionShape: 'orgs',
    parentForeignKeyColumn: 'org_id',
    columns: [{ name: 'role', pgType: 'text', nullable: false }],
  },
  {
    collectionShape: 'orgs/members/permissions',
    strategy: 'flattened_jsonb',
    flattenedIntoTable: 'members',
    flattenedIntoColumn: 'permissions',
    elementKeyField: 'id',
  },
];

test('generateCreateTableStatements: only own_table entries become real tables', () => {
  const statements = generateCreateTableStatements(SAMPLE_TABLES);
  assert.equal(statements.length, 2); // orgs, members -- NOT permissions
  assert.deepEqual(statements.map((s) => s.tableName).sort(), ['members', 'orgs']);
});

test('generateCreateTableStatements: flattened subcollection adds a jsonb column to its parent, not a new table', () => {
  const statements = generateCreateTableStatements(SAMPLE_TABLES);
  const membersStmt = statements.find((s) => s.tableName === 'members');
  assert.match(membersStmt.sql, /"permissions" jsonb/);
  assert.ok(membersStmt.jsonbColumns.includes('permissions'));
});

test('generateCreateTableStatements: FK column references the parent table by name', () => {
  const statements = generateCreateTableStatements(SAMPLE_TABLES);
  const membersStmt = statements.find((s) => s.tableName === 'members');
  assert.match(membersStmt.sql, /FOREIGN KEY \("org_id"\) REFERENCES "orgs"\(id\)/);
});

test('generateCreateTableStatements: REGRESSION -- FK column type matches the PARENT\'s PK type, not the child\'s own', () => {
  const tablesWithMismatchedPkTypes = [
    { collectionShape: 'orgs', tableName: 'orgs', primaryKeyColumn: 'id', primaryKeyType: 'uuid', strategy: 'own_table', columns: [] },
    {
      collectionShape: 'orgs/members',
      tableName: 'members',
      primaryKeyColumn: 'id',
      primaryKeyType: 'text', // child's OWN id type is text, unrelated to the parent's
      strategy: 'own_table',
      parentCollectionShape: 'orgs',
      parentForeignKeyColumn: 'org_id',
      columns: [],
    },
  ];
  const statements = generateCreateTableStatements(tablesWithMismatchedPkTypes);
  const membersStmt = statements.find((s) => s.tableName === 'members');
  // the FK column must be 'uuid' (the PARENT's type), not 'text' (blindly
  // copying the child's own PK type) -- real bug caught before it shipped.
  assert.match(membersStmt.sql, /"org_id" uuid NOT NULL/);
  assert.doesNotMatch(membersStmt.sql, /"org_id" text/);
});

// ---------------------------------------------------------------------------
// row-mapper.mjs
// ---------------------------------------------------------------------------

test('parentIdFromChildSourcePath: extracts the parent id from a subcollection path', () => {
  assert.equal(parentIdFromChildSourcePath('orgs/org1/members/m0'), 'org1');
});

test('mapDocumentToRow: plain columns + a renamed FK column resolved to just the referenced id', () => {
  const table = {
    columns: [
      { name: 'title', pgType: 'text' },
      { name: 'author_id', pgType: 'text', sourceField: 'authorRef' },
    ],
  };
  const doc = {
    id: 'p1',
    sourcePath: 'posts/p1',
    fields: { title: cv('string', 'Hello'), authorRef: cv('reference', 'users/u1') },
  };
  const row = mapDocumentToRow(doc, table);
  assert.deepEqual(row, { id: 'p1', title: 'Hello', author_id: 'u1' });
});

test('mapDocumentToRow: adds the parent FK column derived from sourcePath', () => {
  const table = { columns: [{ name: 'role', pgType: 'text' }], parentForeignKeyColumn: 'org_id' };
  const doc = { id: 'm0', sourcePath: 'orgs/org1/members/m0', fields: { role: cv('string', 'admin') } };
  const row = mapDocumentToRow(doc, table);
  assert.equal(row.org_id, 'org1');
});

test('mapDocumentToFlattenedElement: keeps a reference\'s full path (not resolved to just an id)', () => {
  const doc = { id: 'o1', sourcePath: 'users/u1/orders/o1', fields: { placedBy: cv('reference', 'users/u1') } };
  const element = mapDocumentToFlattenedElement(doc);
  assert.equal(element.id, 'o1');
  assert.equal(element.placedBy, 'users/u1'); // full path preserved, unlike an FK column
});

// ---------------------------------------------------------------------------
// checkpoint-store.mjs
// ---------------------------------------------------------------------------

test('checkpoint: loadCheckpoint on a missing file returns an empty checkpoint, not an error', async () => {
  const checkpoint = await loadCheckpoint('/tmp/does-not-exist-checkpoint.json');
  assert.deepEqual(checkpoint, { completedSteps: [] });
});

test('checkpoint: mark/isStepDone round-trip through save/load', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-checkpoint-'));
  const checkpointPath = path.join(dir, 'checkpoint.json');
  let checkpoint = await loadCheckpoint(checkpointPath);
  markStepDone(checkpoint, 'ddl:users');
  await saveCheckpoint(checkpointPath, checkpoint);

  checkpoint = await loadCheckpoint(checkpointPath);
  assert.equal(isStepDone(checkpoint, 'ddl:users'), true);
  assert.equal(isStepDone(checkpoint, 'ddl:posts'), false);
});

// ---------------------------------------------------------------------------
// index.mjs -- full orchestration, dry-run and against a FAKE pg client
// ---------------------------------------------------------------------------

function createFakePgClient() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

test('runMigration: dry-run never requires a pgClient and touches nothing', async () => {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-'));
  await writeSnapshot(snapshotDir, (async function* () {
    yield { id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: { name: cv('string', 'Acme') } };
  })());

  const result = await runMigration({ tables: SAMPLE_TABLES, snapshotDir, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.rowCounts.orgs, 1);
  assert.ok(result.ddlStatements.length > 0);
});

test('runMigration: real run creates tables, inserts rows, and flattens the child subcollection', async () => {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-'));
  await writeSnapshot(snapshotDir, (async function* () {
    yield { id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: { name: cv('string', 'Acme') } };
    yield { id: 'm0', sourcePath: 'orgs/org1/members/m0', collectionShape: 'orgs/members', fields: { role: cv('string', 'admin') } };
    yield {
      id: 'p1',
      sourcePath: 'orgs/org1/members/m0/permissions/p1',
      collectionShape: 'orgs/members/permissions',
      fields: { scope: cv('string', 'billing') },
    };
  })());

  const pgClient = createFakePgClient();
  const checkpointPath = path.join(snapshotDir, 'migration.checkpoint.json');

  const result = await runMigration({ tables: SAMPLE_TABLES, snapshotDir, dryRun: false, pgClient, checkpointPath });

  assert.deepEqual(result.summary.tablesCreated.sort(), ['members', 'orgs']);
  assert.equal(result.summary.rowsInserted.orgs, 1);
  assert.equal(result.summary.rowsInserted.members, 1);
  assert.equal(result.summary.flattenedUpdated['members.permissions'], 1);

  const insertCalls = pgClient.calls.filter((c) => c.sql.startsWith('INSERT'));
  assert.equal(insertCalls.length, 2);
  const updateCall = pgClient.calls.find((c) => c.sql.startsWith('UPDATE'));
  assert.equal(updateCall.params[1], 'm0'); // parent id for the flattened permissions array
});

test('runMigration: REGRESSION -- re-running with the same checkpoint skips already-completed steps', async () => {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-'));
  await writeSnapshot(snapshotDir, (async function* () {
    yield { id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: { name: cv('string', 'Acme') } };
  })());

  const singleTable = [SAMPLE_TABLES[0]];
  const checkpointPath = path.join(snapshotDir, 'migration.checkpoint.json');

  const firstClient = createFakePgClient();
  await runMigration({ tables: singleTable, snapshotDir, dryRun: false, pgClient: firstClient, checkpointPath });
  assert.equal(firstClient.calls.length, 2); // 1 CREATE TABLE + 1 INSERT

  const secondClient = createFakePgClient();
  const secondResult = await runMigration({ tables: singleTable, snapshotDir, dryRun: false, pgClient: secondClient, checkpointPath });
  assert.equal(secondClient.calls.length, 0); // everything already checkpointed -- nothing re-run
  assert.match(secondResult.summary.rowsInserted.orgs, /skipped/);
});

test('runMigration: --force ignores the existing checkpoint and starts over', async () => {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-'));
  await writeSnapshot(snapshotDir, (async function* () {
    yield { id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: { name: cv('string', 'Acme') } };
  })());

  const singleTable = [SAMPLE_TABLES[0]];
  const checkpointPath = path.join(snapshotDir, 'migration.checkpoint.json');

  await runMigration({ tables: singleTable, snapshotDir, dryRun: false, pgClient: createFakePgClient(), checkpointPath });

  const forcedClient = createFakePgClient();
  await runMigration({ tables: singleTable, snapshotDir, dryRun: false, pgClient: forcedClient, checkpointPath, force: true });
  assert.equal(forcedClient.calls.length, 2); // re-ran despite the existing checkpoint
});
