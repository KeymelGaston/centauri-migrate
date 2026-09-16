import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runInfer } from '../commands/infer.js';

async function writeSnapshotFile(snapshotDir: string, fileName: string, docs: unknown[]) {
  await mkdir(snapshotDir, { recursive: true });
  const content = docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
  await writeFile(path.join(snapshotDir, fileName), content);
}

test('runInfer: reads the snapshot written by extract and proposes a schema', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-infer-cmd-'));
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(
    configPath,
    JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json', outputDir: dir })
  );

  await writeSnapshotFile(path.join(dir, 'snapshot'), 'users.jsonl', [
    { id: 'u1', sourcePath: 'users/u1', collectionShape: 'users', fields: { name: { type: 'string', value: 'Ana' } } },
  ]);

  const result = await runInfer({ configPath });

  assert.equal(result.tableCount, 1);
  const written = JSON.parse(await readFile(result.schemaPath, 'utf8'));
  assert.equal(written.tables[0].tableName, 'users');
  assert.equal(written.tables[0].columns[0].name, 'name');
});
