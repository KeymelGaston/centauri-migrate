// Runs the FULL pipeline (extract -> infer -> rules -> review) through the
// real command layer (src/commands/*.ts), the same code `centauri` runs
// from the terminal -- not core/* called directly. Requires the emulator
// running and seeded with seed-emulator-advanced.mjs.
//
//   node run-full-pipeline.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const outputDir = '.centauri-e2e'; // separate dir, doesn't clash with earlier manual runs
const rulesFilePath = path.resolve('firestore-advanced.rules');
const configPath = path.resolve('centauri.e2e.config.json');

await mkdir(outputDir, { recursive: true });
await writeFile(
  configPath,
  JSON.stringify({
    firestoreProjectId: 'demo-centauri',
    serviceAccountPath: './unused.json', // unused: a real emulator-backed db is injected below
    outputDir,
    rulesFilePath,
  })
);

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { runExtract } = await import('./src/commands/extract.js');
const { runInfer } = await import('./src/commands/infer.js');
const { runRules } = await import('./src/commands/rules.js');
const { runReview } = await import('./src/commands/review.js');

initializeApp({ projectId: 'demo-centauri' });
const db = getFirestore();
db.settings({ host: '127.0.0.1:8080', ssl: false });

console.log('=== Step 1/4: centauri extract (against the real emulator) ===');
const extractResult = await runExtract({ configPath, db });
console.log('Document count by collectionShape:', extractResult.counts);

console.log('\n=== Step 2/4: centauri infer ===');
const inferResult = await runInfer({ configPath });
console.log(`${inferResult.tableCount} candidate tables -> ${inferResult.schemaPath}`);
for (const table of inferResult.tables) {
  console.log(`  - ${table.tableName} (${table.collectionShape}): ${table.strategy} [${table.nestingConfidence}]`);
}

console.log('\n=== Step 3/4: centauri rules ===');
const rulesResult = await runRules({ configPath });
console.log(`usedSchemaMap: ${rulesResult.usedSchemaMap} -> ${rulesResult.policiesPath}`);

console.log('\n=== Step 4/4: centauri review ===');
const reviewResult = await runReview({ configPath });
console.log(`${reviewResult.summary.total} finding(s):`, reviewResult.summary.byCategory);
console.log(`Full report: ${reviewResult.reportPath}`);

console.log('\n=== Things worth checking by hand in the output above / report files ===');
console.log('1. users.age inconsistency -> should show up as a schema-column finding (low confidence)');
console.log('2. orgs/members -> should be own_table (forced by the nested permissions subcollection),');
console.log('   NOT a fan-out-based decision -- confirm nestingReason mentions sub-subcollections, not fan-out');
console.log('3. orgs/members/permissions -> its own table too (root of its own decision)');
console.log('4. posts.collaboratorRefs -> should be plain jsonb, NOT detected as a relation (known limitation)');
console.log('5. posts.authorRef -> SHOULD be detected as a relation -> author_id, high confidence');
console.log('6. the two get()/exists() rules under orgs/members* -> should resolve via the REAL inferred');
console.log('   schemaMap (table name from step 2), not the heuristic fallback -- check for the absence of');
console.log('   "with no schema map" in policies.proposed.json notes for those two entries');
