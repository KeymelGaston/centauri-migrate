import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runRules } from '../commands/rules.js';
import { runInfer } from '../commands/infer.js';

const SIMPLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
`;

async function setupProject(dir: string) {
  const configPath = path.join(dir, 'centauri.config.json');
  const rulesFilePath = path.join(dir, 'firestore.rules');
  await writeFile(rulesFilePath, SIMPLE_RULES);
  await writeFile(
    configPath,
    JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json', outputDir: dir, rulesFilePath })
  );
  return configPath;
}

test('runRules: without a schema.proposed.json, falls back to the heuristic and flags it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-rules-cmd-'));
  const configPath = await setupProject(dir);

  const result = await runRules({ configPath });

  assert.equal(result.usedSchemaMap, false);
  const written = JSON.parse(await readFile(result.policiesPath, 'utf8'));
  const table = written.find((t: { path: string }) => t.path === '/users/{userId}');
  const supabase = table.policies.find((p: { dialect: string }) => p.dialect === 'supabase');
  assert.match(supabase.sql, /id = auth\.uid\(\)/);
});

test('END-TO-END: infer -> rules chained through the command layer uses the real inferred schemaMap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-e2e-'));

  // A rules file that references a subcollection via get(), so the
  // schemaMap coupling actually matters for the generated SQL.
  const rulesFilePath = path.join(dir, 'firestore.rules');
  await writeFile(
    rulesFilePath,
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
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(
    configPath,
    JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json', outputDir: dir, rulesFilePath })
  );

  // Simulate what `centauri extract` would have written: a high fan-out
  // orgs/members subcollection (own_table, not flattened).
  const snapshotDir = path.join(dir, 'snapshot');
  await mkdir(snapshotDir, { recursive: true });
  const orgLine = JSON.stringify({ id: 'org1', sourcePath: 'orgs/org1', collectionShape: 'orgs', fields: {} });
  const memberLines = Array.from({ length: 7 }, (_, i) =>
    JSON.stringify({
      id: `m${i}`,
      sourcePath: `orgs/org1/members/m${i}`,
      collectionShape: 'orgs/members',
      fields: { role: { type: 'string', value: i === 0 ? 'admin' : 'member' } },
    })
  );
  await writeFile(path.join(snapshotDir, 'orgs.jsonl'), orgLine + '\n');
  await writeFile(path.join(snapshotDir, 'orgs__members.jsonl'), memberLines.join('\n') + '\n');

  // Step 1: centauri infer
  const inferResult = await runInfer({ configPath });
  assert.equal(inferResult.tableCount, 2);

  // Step 2: centauri rules -- should pick up schema.proposed.json automatically
  const rulesResult = await runRules({ configPath });
  assert.equal(rulesResult.usedSchemaMap, true);

  const written = JSON.parse(await readFile(rulesResult.policiesPath, 'utf8'));
  const table = written.find((t: { path: string }) => t.path === '/orgs/{orgId}/members/{memberId}');
  const supabase = table.policies.find((p: { dialect: string }) => p.dialect === 'supabase');

  // Must use the REAL table name the inferrer decided ('members'), reached
  // through the full extract -> infer -> rules command chain, not a
  // hand-built mock.
  assert.match(supabase.sql, /FROM members/);
  assert.match(supabase.sql, /members\.org_id/);
  assert.ok(!supabase.notes.some((n: string) => n.includes('with no schema map')));
});
