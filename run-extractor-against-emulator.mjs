// Runs the REAL extractor (core/extractor) against the Firestore emulator
// already seeded with seed-emulator.mjs. Requires the emulator to be running:
//
//   node run-extractor-against-emulator.mjs

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { extractFirestoreToSnapshot } = await import('./core/extractor/index.mjs');

initializeApp({ projectId: 'demo-centauri' });
const db = getFirestore();

// See the note in seed-emulator.mjs: explicit .settings() is more reliable
// than relying only on the env var.
db.settings({ host: '127.0.0.1:8080', ssl: false });

const outputDir = '.centauri/snapshot';

const { counts, total } = await extractFirestoreToSnapshot({ db, outputDir });

console.log('Extraction complete.');
console.log('Document count by collectionShape:', counts);
console.log('Total documents:', total);
console.log(`\nCheck the .jsonl files in ${outputDir}/`);
console.log('In particular, verify:');
console.log('  - users.jsonl: 2 documents, with Timestamp as an ISO string');
console.log('  - users__orders.jsonl: 1 document (u1\'s subcollection)');
console.log('  - posts.jsonl: 1 document, with authorRef.type === "reference" and location.type === "geopoint"');
