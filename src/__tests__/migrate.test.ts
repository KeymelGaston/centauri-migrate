import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runMigrate } from '../commands/migrate.js';

async function setupProject(dir: string) {
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(
    configPath,
    JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json', outputDir: dir })
  );
  await mkdir(path.join(dir, 'snapshot'), { recursive: true });
  await writeFile(
    path.join(dir, 'snapshot', 'users.jsonl'),
    JSON.stringify({ id: 'u1', sourcePath: 'users/u1', collectionShape: 'users', fields: { name: { type: 'string', value: 'Ana' } } }) + '\n'
  );
  await writeFile(
    path.join(dir, 'schema.proposed.json'),
    JSON.stringify({
      tables: [
        {
          collectionShape: 'users',
          tableName: 'users',
          primaryKeyColumn: 'id',
          primaryKeyType: 'text',
          strategy: 'own_table',
          columns: [{ name: 'name', pgType: 'text', nullable: false }],
        },
      ],
    })
  );
  return configPath;
}

test('runMigrate: without schema.proposed.json, fails with a clear message', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-cmd-'));
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(configPath, JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json', outputDir: dir }));
  await assert.rejects(() => runMigrate({ configPath }), /Run "centauri infer" first/);
});

test('runMigrate: dry-run never requires CENTAURI_POSTGRES_URL or a pgClient', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-cmd-'));
  const configPath = await setupProject(dir);
  const previous = process.env.CENTAURI_POSTGRES_URL;
  delete process.env.CENTAURI_POSTGRES_URL;
  try {
    const result = await runMigrate({ configPath, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal((result as unknown as { rowCounts: Record<string, number> }).rowCounts.users, 1);
  } finally {
    if (previous !== undefined) process.env.CENTAURI_POSTGRES_URL = previous;
  }
});

test('runMigrate: REGRESSION -- a real (non-dry-run) migration without CENTAURI_POSTGRES_URL fails clearly, never falls back to config.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-cmd-'));
  const configPath = await setupProject(dir);
  const previous = process.env.CENTAURI_POSTGRES_URL;
  delete process.env.CENTAURI_POSTGRES_URL;
  try {
    await assert.rejects(() => runMigrate({ configPath, dryRun: false }), /CENTAURI_POSTGRES_URL is not set/);
  } finally {
    if (previous !== undefined) process.env.CENTAURI_POSTGRES_URL = previous;
  }
});

test('runMigrate: real run with an injected pgClient creates the table and inserts the row', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-migrate-cmd-'));
  const configPath = await setupProject(dir);

  const calls: { sql: string; params?: unknown[] }[] = [];
  const pgClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  const result = await runMigrate({ configPath, dryRun: false, pgClient });
  assert.equal(result.dryRun, false);
  const summary = (result as unknown as { summary: { tablesCreated: string[]; rowsInserted: Record<string, number> } }).summary;
  assert.deepEqual(summary.tablesCreated, ['users']);
  assert.equal(summary.rowsInserted.users, 1);
  assert.ok(calls.some((c) => c.sql.startsWith('CREATE TABLE')));
  assert.ok(calls.some((c) => c.sql.startsWith('INSERT')));
});
