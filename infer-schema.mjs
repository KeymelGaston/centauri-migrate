// Runs the schema inferrer against the snapshot you already generated with
// run-extractor-against-emulator.mjs. Doesn't need the emulator running --
// it only reads the .jsonl files from disk.
//
//   node infer-schema.mjs

import { writeFile } from 'node:fs/promises';
import { inferSchema } from './core/inferrer/index.mjs';

const snapshotDir = '.centauri/snapshot';

const { tables, schemaMapMappings } = await inferSchema(snapshotDir);

console.log(`\nSchema proposed from ${snapshotDir} (${tables.length} candidate tables)\n`);
console.log('='.repeat(70));

for (const table of tables) {
  console.log(`\nCandidate table: ${table.tableName}  (from "${table.collectionShape}", ${table.documentCount} documents)`);
  console.log(`  Strategy: ${table.strategy}  [confidence: ${table.nestingConfidence}]`);
  console.log(`  Reason: ${table.nestingReason}`);
  if (table.strategy === 'own_table' && table.parentForeignKeyColumn) {
    console.log(`  FK to parent: ${table.parentForeignKeyColumn} -> ${table.parentCollectionShape}`);
  }
  if (table.strategy === 'flattened_jsonb') {
    console.log(`  Flattened into: ${table.flattenedIntoTable}.${table.flattenedIntoColumn}`);
  }
  console.log(`  PK: ${table.primaryKeyColumn} (${table.primaryKeyType})`);

  console.log('  Columns:');
  for (const col of table.columns) {
    const nullMark = col.nullable ? '?' : '';
    console.log(`    - ${col.name}${nullMark}: ${col.pgType}  [confidence: ${col.confidence}]`);
    for (const note of col.notes) console.log(`        ! ${note}`);
  }

  if (table.relations.length > 0) {
    console.log('  Suggested relations:');
    for (const rel of table.relations) {
      const target = rel.referencedCollectionShape ?? '(unknown, requires confirmation)';
      console.log(`    - ${rel.sourceField} -> ${rel.proposedColumn}  toward "${target}"  [confidence: ${rel.confidence}]`);
      console.log(`        ${rel.reason}`);
    }
  }
}

console.log('\n' + '='.repeat(70));
console.log('\nschemaMap ready to use with core/rules:');
console.log(JSON.stringify(schemaMapMappings, null, 2));

await writeFile('.centauri/schema.proposed.json', JSON.stringify({ tables, schemaMapMappings }, null, 2));
console.log('\nSaved to .centauri/schema.proposed.json');
