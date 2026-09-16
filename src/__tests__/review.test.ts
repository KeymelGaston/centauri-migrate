import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runReview } from '../commands/review.js';

async function writeConfig(dir: string) {
  const configPath = path.join(dir, 'centauri.config.json');
  await writeFile(
    configPath,
    JSON.stringify({ firestoreProjectId: 'demo', serviceAccountPath: './sa.json', outputDir: dir })
  );
  return configPath;
}

test('runReview: with neither schema nor policies present, fails with a clear message', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-review-'));
  const configPath = await writeConfig(dir);
  await assert.rejects(() => runReview({ configPath }), /Run "centauri infer" and\/or "centauri rules" first/);
});

test('runReview: schema only -- surfaces low/medium-confidence columns, relations, and nesting decisions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-review-'));
  const configPath = await writeConfig(dir);
  await writeFile(
    path.join(dir, 'schema.proposed.json'),
    JSON.stringify({
      tables: [
        {
          collectionShape: 'users',
          tableName: 'users',
          strategy: 'own_table',
          nestingConfidence: 'high',
          nestingReason: 'root collection, always its own table',
          columns: [
            { name: 'name', confidence: 'high', notes: [] },
            { name: 'nickname', confidence: 'medium', notes: ['field missing in 2 of 5 documents'] },
          ],
          relations: [
            { sourceField: 'authorId', proposedColumn: 'author_id', confidence: 'medium', reason: 'name heuristic, unknown target' },
          ],
        },
        {
          collectionShape: 'users/orders',
          tableName: 'orders',
          strategy: 'flattened_jsonb',
          nestingConfidence: 'low',
          nestingReason: 'average of 1.0 child documents per parent — low fan-out',
          columns: [],
          relations: [],
        },
      ],
    })
  );

  const result = await runReview({ configPath });

  assert.equal(result.ranAgainstSchema, true);
  assert.equal(result.ranAgainstPolicies, false);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.byCategory['schema-column'], 1);
  assert.equal(result.summary.byCategory['schema-relation'], 1);
  assert.equal(result.summary.byCategory['schema-nesting'], 1);

  const nestingFinding = result.findings.find((f) => f.category === 'schema-nesting');
  assert.equal(nestingFinding?.location, 'users/orders');
});

test('runReview: policies only -- surfaces every policy with notes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-review-'));
  const configPath = await writeConfig(dir);
  await writeFile(
    path.join(dir, 'policies.proposed.json'),
    JSON.stringify([
      {
        path: '/orgs/{orgId}/members/{memberId}',
        policies: [
          { dialect: 'supabase', sql: 'id = auth.uid()', notes: [] },
          { dialect: 'generic', sql: 'FALSE', notes: ["unrecognized condition — requires manual review; FALSE (deny) is used as the safe default"] },
        ],
      },
    ])
  );

  const result = await runReview({ configPath });

  assert.equal(result.ranAgainstPolicies, true);
  assert.equal(result.summary.total, 1);
  assert.equal(result.findings[0].confidence, 'low'); // FALSE -> low confidence
});

test('runReview: schema + policies together -- writes a single combined report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'centauri-review-'));
  const configPath = await writeConfig(dir);
  await writeFile(
    path.join(dir, 'schema.proposed.json'),
    JSON.stringify({ tables: [{ collectionShape: 'users', tableName: 'users', strategy: 'own_table', nestingConfidence: 'high', nestingReason: '', columns: [{ name: 'a', confidence: 'low', notes: ['inconsistent types'] }], relations: [] }] })
  );
  await writeFile(
    path.join(dir, 'policies.proposed.json'),
    JSON.stringify([{ path: '/users/{userId}', policies: [{ dialect: 'supabase', sql: 'id = auth.uid()', notes: ['some caveat'] }] }])
  );

  const result = await runReview({ configPath });

  assert.equal(result.ranAgainstSchema, true);
  assert.equal(result.ranAgainstPolicies, true);
  assert.equal(result.summary.total, 2);

  const written = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(written.summary.total, 2);
});
