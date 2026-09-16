// Seeds test data into the Firestore EMULATOR (never a real project). Run
// with the emulator already up:
//
//   node seed-emulator.mjs
//
// Requires the emulator to be running at 127.0.0.1:8080 (the default port
// suggested by `firebase init emulators`). If you used a different port,
// change the variable below.

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

// IMPORTANT: the env var above must be set BEFORE importing
// 'firebase-admin/app' / 'firebase-admin/firestore' -- if set afterward,
// the SDK will already have tried to resolve real credentials.
const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, Timestamp, GeoPoint } = await import('firebase-admin/firestore');

initializeApp({ projectId: 'demo-centauri' }); // fake projectId, doesn't need to be real
const db = getFirestore();

// In addition to the env var, set the host EXPLICITLY via .settings() --
// more reliable across platforms/versions than relying only on
// FIRESTORE_EMULATOR_HOST. If your emulator runs on a different port
// (check the `firebase emulators:start` log), change it here too.
db.settings({ host: '127.0.0.1:8080', ssl: false });

async function seed() {
  console.log('Seeding test data into the emulator...');

  // users/u1 -- covers string, number, boolean, timestamp, array, nested map, bytes
  const userRef = db.collection('users').doc('u1');
  await userRef.set({
    name: 'Ana',
    age: 29,
    active: true,
    createdAt: Timestamp.fromDate(new Date('2026-01-15T10:00:00Z')),
    tags: ['admin', 'beta'],
    address: { city: 'Santo Domingo', zip: null },
    avatar: Buffer.from('fake-image-bytes'),
  });
  console.log('  users/u1 created');

  // users/u1/orders/o1 -- nested subcollection, to test the recursive traversal
  await userRef.collection('orders').doc('o1').set({
    total: 149.99,
    placedAt: Timestamp.fromDate(new Date('2026-02-01T00:00:00Z')),
    items: [{ sku: 'A1', qty: 2 }],
  });
  console.log('  users/u1/orders/o1 created');

  // A second user, to confirm the extractor walks EVERY document in the
  // collection, not just the first one
  await db.collection('users').doc('u2').set({
    name: 'Luis',
    age: 34,
    active: false,
    createdAt: Timestamp.fromDate(new Date('2026-01-20T08:30:00Z')),
    tags: [],
    address: { city: 'Santiago', zip: '51000' },
    avatar: Buffer.from('another-image'),
  });
  console.log('  users/u2 created (no subcollection, to test the case without orders)');

  // posts/p1 -- covers DocumentReference and GeoPoint
  await db.collection('posts').doc('p1').set({
    title: 'Hello world',
    authorRef: userRef, // real DocumentReference
    location: new GeoPoint(18.4861, -69.9312),
  });
  console.log('  posts/p1 created');

  console.log('\nDone. Expected count when running the extractor:');
  console.log('  users: 2, users/orders: 1, posts: 1 (total: 4)');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error seeding data:', err);
    process.exit(1);
  });
