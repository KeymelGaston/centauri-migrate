import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runExtract } from '../commands/extract.js';

// Reuses the same style of fake as core/extractor/__tests__/fake-firestore.mjs,
// minimal, without depending on that file directly so the tests of both
// modules stay decoupled from each other.
function createFakeDb() {
  return {
    listCollections: async () => [
      {
        id: 'users',
        get: async () => ({
          docs: [
            {
              id: 'u1',
              ref: { path: 'users/u1', listCollections: async () => [] },
              data: () => ({ name: 'Ana' }),
            },
          ],
        }),
      },
    ],
  };
}

async function writeTestConfig(dir: string) {
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      firestoreProjectId: 'demo',
      serviceAccountPath: './sa.json', // unused: `db` is injected, this file is never read
      outputDir: path.join(dir, '.centauri'),
    })
  );
  return configPath;
}

test('runExtract: with an injected db, it never tries to read the real service account', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-extract-'));
  const configPath = await writeTestConfig(dir);

  const result = await runExtract({ configPath, db: createFakeDb() });

  assert.equal(result.total, 1);
  assert.deepEqual(result.counts, { users: 1 });

  const written = await readFile(path.join(result.snapshotDir, 'users.jsonl'), 'utf8');
  const doc = JSON.parse(written.trim());
  assert.equal(doc.id, 'u1');
  assert.equal(doc.fields.name.value, 'Ana');
});

test('runExtract: without a valid config, fails with the same clear message from loadConfig', async () => {
  await assert.rejects(
    () => runExtract({ configPath: '/tmp/does-not-exist-centauri-config.json' }),
    /Run "centauri init" first/
  );
});
