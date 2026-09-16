import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/config-loader.js';

test('loadConfig: missing file -> clear message, not a raw ENOENT', async () => {
  await assert.rejects(() => loadConfig('/tmp/does-not-really-exist.json'), /Run "centauri init" first/);
});

test('loadConfig: invalid JSON -> clear message', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-config-'));
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(configPath, '{ this is not valid json');
  await assert.rejects(() => loadConfig(configPath), /is not valid JSON/);
});

test('loadConfig: missing required fields -> message says which ones', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-config-'));
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(configPath, JSON.stringify({ firestoreProjectId: 'demo' }));
  await assert.rejects(() => loadConfig(configPath), /serviceAccountPath/);
});

test('loadConfig: valid config -> applies defaults for optional fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-config-'));
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(configPath, JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json' }));
  const config = await loadConfig(configPath);
  assert.equal(config.outputDir, '.centauri');
  assert.equal(config.rulesFilePath, 'firestore.rules');
  assert.equal(config.rlsDialect, 'supabase');
});

test('loadConfig: respects explicit values over the defaults', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-config-'));
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      firestoreProjectId: 'demo',
      serviceAccountPath: './sa.json',
      outputDir: 'output',
      rulesFilePath: 'rules.rules',
      rlsDialect: 'generic',
    })
  );
  const config = await loadConfig(configPath);
  assert.equal(config.outputDir, 'output');
  assert.equal(config.rulesFilePath, 'rules.rules');
  assert.equal(config.rlsDialect, 'generic');
});
