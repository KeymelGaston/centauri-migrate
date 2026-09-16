import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runInit } from '../commands/init.js';

test('runInit: creates centauri.config.json and .centauri/ in an empty directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-init-'));
  const result = await runInit({ cwd: dir });

  assert.equal(result.created, true);
  const config = JSON.parse(await readFile(result.configPath, 'utf8'));
  assert.equal(config.firestoreProjectId, 'your-firebase-project-id');
  assert.equal(config.rlsDialect, 'supabase');
});

test('runInit: does NOT overwrite an existing config without --force', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-init-'));
  await runInit({ cwd: dir });

  // the user already edited their config with real data
  const configPath = path.join(dir, 'centauri.config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, JSON.stringify({ firestore: { projectId: 'my-real-project' } }));

  const second = await runInit({ cwd: dir });
  assert.equal(second.created, false);

  // confirm the user's real file is still intact
  const stillThere = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(stillThere.firestore.projectId, 'my-real-project');
});

test('runInit: REGRESSION -- with --force it DOES overwrite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-init-'));
  await runInit({ cwd: dir });
  const configPath = path.join(dir, 'centauri.config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, JSON.stringify({ custom: true }));

  const result = await runInit({ cwd: dir, force: true });
  assert.equal(result.created, true);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.custom, undefined); // back to the default, overwritten
});
