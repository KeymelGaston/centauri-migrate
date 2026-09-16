import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { toCanonicalValue, toCanonicalDocument } from '../canonical-document.mjs';
import { extractAll } from '../firestore-extractor.mjs';
import { extractFirestoreToSnapshot } from '../index.mjs';
import { createFakeFirestore, buildSampleDataset } from './fake-firestore.mjs';
import { Timestamp, GeoPoint } from 'firebase-admin/firestore';

test('canonical-document: primitives', () => {
  assert.deepEqual(toCanonicalValue('hello'), { type: 'string', value: 'hello' });
  assert.deepEqual(toCanonicalValue(42), { type: 'number', value: 42 });
  assert.deepEqual(toCanonicalValue(true), { type: 'boolean', value: true });
  assert.deepEqual(toCanonicalValue(null), { type: 'null', value: null });
});

test('canonical-document: real SDK Timestamp -> ISO string', () => {
  const ts = Timestamp.fromDate(new Date('2026-03-01T12:00:00.000Z'));
  const result = toCanonicalValue(ts);
  assert.equal(result.type, 'timestamp');
  assert.equal(result.value, '2026-03-01T12:00:00.000Z');
});

test('canonical-document: real SDK GeoPoint -> {lat,lng}', () => {
  const gp = new GeoPoint(18.4861, -69.9312);
  assert.deepEqual(toCanonicalValue(gp), { type: 'geopoint', value: { lat: 18.4861, lng: -69.9312 } });
});

test('canonical-document: DocumentReference (duck-typed) -> path as a string, never the live object', () => {
  const fakeRef = { id: 'u1', path: 'users/u1', get: async () => {} };
  assert.deepEqual(toCanonicalValue(fakeRef), { type: 'reference', value: 'users/u1' });
});

test('canonical-document: REGRESSION -- sourcePath comes from docSnapshot.ref.path, NEVER docSnapshot.path', () => {
  // Real bug found while validating against the Firestore emulator: the
  // real DocumentSnapshot has no `.path` of its own, only `.ref.path`. A
  // fake with `.path` set by hand papered over this -- JSON.stringify omits
  // undefined keys, so `sourcePath` silently vanished from the final
  // snapshot, with no visible error.
  const snapshotWithNoOwnPath = {
    id: 'u1',
    // on purpose: NO `.path` at the top level, same as the real SDK
    ref: { path: 'users/u1' },
    data: () => ({ name: 'Ana' }),
  };
  const doc = toCanonicalDocument(snapshotWithNoOwnPath, 'users');
  assert.equal(doc.sourcePath, 'users/u1');
});

test('canonical-document: bytes -> base64', () => {
  const buf = Buffer.from('hello');
  const result = toCanonicalValue(buf);
  assert.equal(result.type, 'bytes');
  assert.equal(Buffer.from(result.value, 'base64').toString(), 'hello');
});

test('canonical-document: recursive array', () => {
  const result = toCanonicalValue(['a', 1, true]);
  assert.equal(result.type, 'array');
  assert.deepEqual(result.value, [
    { type: 'string', value: 'a' },
    { type: 'number', value: 1 },
    { type: 'boolean', value: true },
  ]);
});

test('canonical-document: recursive nested map, including null', () => {
  const result = toCanonicalValue({ city: 'Santo Domingo', zip: null });
  assert.equal(result.type, 'map');
  assert.deepEqual(result.value.city, { type: 'string', value: 'Santo Domingo' });
  assert.deepEqual(result.value.zip, { type: 'null', value: null });
});

test('extractAll: walks root collections and nested subcollections', async () => {
  const db = createFakeFirestore(buildSampleDataset());
  const docs = [];
  for await (const doc of extractAll(db)) docs.push(doc);

  // 1 user + 1 order (that user's subcollection) + 1 post = 3 documents
  assert.equal(docs.length, 3);

  const user = docs.find((d) => d.collectionShape === 'users');
  assert.equal(user.id, 'u1');
  assert.equal(user.sourcePath, 'users/u1');
  assert.equal(user.fields.name.value, 'Ana');
  assert.equal(user.fields.createdAt.type, 'timestamp');
  assert.deepEqual(user.fields.tags.value.map((v) => v.value), ['admin', 'beta']);

  const order = docs.find((d) => d.collectionShape === 'users/orders');
  assert.equal(order.sourcePath, 'users/u1/orders/o1');
  assert.equal(order.fields.total.value, 149.99);

  const post = docs.find((d) => d.collectionShape === 'posts');
  assert.equal(post.fields.authorRef.type, 'reference');
  assert.equal(post.fields.authorRef.value, 'users/u1');
  assert.equal(post.fields.location.type, 'geopoint');
});

test('extractFirestoreToSnapshot: writes one .jsonl per collectionShape with valid file names', async () => {
  const db = createFakeFirestore(buildSampleDataset());
  const outputDir = await mkdtemp(path.join(tmpdir(), 'centauri-snapshot-'));

  const { counts, total } = await extractFirestoreToSnapshot({ db, outputDir });

  assert.equal(total, 3);
  assert.deepEqual(counts, { users: 1, 'users/orders': 1, posts: 1 });

  // "users/orders" (with '/') must be written as "users__orders.jsonl"
  const ordersFile = await readFile(path.join(outputDir, 'users__orders.jsonl'), 'utf8');
  const orderLine = JSON.parse(ordersFile.trim());
  assert.equal(orderLine.collectionShape, 'users/orders');
  assert.equal(orderLine.fields.total.value, 149.99);

  const usersFile = await readFile(path.join(outputDir, 'users.jsonl'), 'utf8');
  const userLine = JSON.parse(usersFile.trim());
  assert.equal(userLine.id, 'u1');
});
