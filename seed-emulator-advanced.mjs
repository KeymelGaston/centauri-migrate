// Seeds a more varied dataset into the Firestore EMULATOR, deliberately
// covering edge cases the full CLI pipeline (extract -> infer -> rules ->
// review) hasn't been run against yet:
//
//   - a field with INCONSISTENT types across documents (users.age: number
//     in most docs, string in one) -> should surface as a low-confidence
//     schema-column finding in `centauri review`.
//   - a subcollection with MIXED fan-out (org1 has 8 members, org2 has 1)
//     under the SAME collectionShape -> tests how the averaging heuristic
//     in nesting-strategy.mjs behaves on non-uniform real-world data,
//     which no existing test covers.
//   - a subcollection with its OWN nested subcollection (forces own_table
//     regardless of fan-out) run through the real CLI end-to-end, not just
//     the unit test.
//   - an array of DocumentReferences (collaboratorRefs) -- a KNOWN,
//     documented limitation (not detected as a many-to-many relation).
//     Seeding it here lets us confirm the limitation manifests exactly as
//     documented, not silently differently.
//
//   node seed-emulator-advanced.mjs

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');

initializeApp({ projectId: 'demo-centauri' });
const db = getFirestore();
db.settings({ host: '127.0.0.1:8080', ssl: false });

async function seed() {
  console.log('Seeding an advanced, deliberately messier dataset...');

  // --- users: mostly consistent, one inconsistent field ---
  await db.collection('users').doc('u1').set({ name: 'Ana', age: 29, active: true });
  await db.collection('users').doc('u2').set({ name: 'Luis', age: 34, active: true });
  await db.collection('users').doc('u3').set({ name: 'Marta', age: 'twenty-eight', active: false }); // age as string on purpose
  console.log('  users: 3 docs (u3.age is a string on purpose -- inconsistent type)');

  // --- orgs with mixed fan-out members subcollections ---
  await db.collection('orgs').doc('org1').set({ name: 'Acme' });
  for (let i = 0; i < 8; i++) {
    await db.collection('orgs').doc('org1').collection('members').doc(`m${i}`).set({
      role: i === 0 ? 'admin' : 'member',
    });
  }
  await db.collection('orgs').doc('org2').set({ name: 'Small Co' });
  await db.collection('orgs').doc('org2').collection('members').doc('m0').set({ role: 'admin' });
  console.log('  orgs: 2 orgs, org1 has 8 members (high fan-out), org2 has 1 (low fan-out) -- same collectionShape');

  // --- a subcollection with its own nested subcollection ---
  await db
    .collection('orgs')
    .doc('org1')
    .collection('members')
    .doc('m0')
    .collection('permissions')
    .doc('p1')
    .set({ scope: 'billing' });
  console.log('  orgs/org1/members/m0/permissions/p1: forces own_table on "orgs/members" regardless of fan-out');

  // --- posts with a real DocumentReference AND an array of references ---
  const userRef = db.collection('users').doc('u1');
  const collaboratorRef = db.collection('users').doc('u2');
  await db.collection('posts').doc('p1').set({
    title: 'Launch day',
    authorRef: userRef,
    collaboratorRefs: [collaboratorRef], // known limitation: not detected as many-to-many
    publishedAt: Timestamp.fromDate(new Date('2026-03-01T00:00:00Z')),
  });
  console.log('  posts/p1: has both authorRef (single reference) and collaboratorRefs (array of references)');

  console.log('\nDone seeding. Now run: node run-full-pipeline.mjs');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error seeding data:', err);
    process.exit(1);
  });
