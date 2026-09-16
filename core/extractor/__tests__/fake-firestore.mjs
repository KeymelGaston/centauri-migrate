import { Timestamp, GeoPoint } from 'firebase-admin/firestore';

/**
 * Fake Firestore for unit tests -- implements only the minimal interface
 * documented in firestore-extractor.mjs (FirestoreLike / CollectionRefLike
 * / DocSnapshotLike), with no network connection at all.
 *
 * IMPORTANT (honest limitation): this sandbox has no network access to
 * Firestore or its emulator (requires downloading binaries from domains not
 * allowed here). This fake correctly tests the traversal and canonical
 * document conversion LOGIC, but it does NOT replace testing against a real
 * Firestore emulator before trusting this with production data -- explicit
 * pending item, see README.md.
 *
 * Uses the REAL classes from `firebase-admin/firestore` for Timestamp and
 * GeoPoint (they can be built without a live connection), so
 * canonical-document.mjs is tested against the SDK's real types, not a
 * hand-invented shape.
 */

function fakeDocRef(path) {
  const parts = path.split('/');
  return {
    id: parts[parts.length - 1],
    path,
    get: async () => {
      throw new Error('fakeDocRef.get() not implemented -- unused by the current extractor');
    },
  };
}

class FakeDocSnapshot {
  constructor(id, path, rawData, subcollections = {}) {
    this.id = id;
    this._rawData = rawData;
    // IMPORTANT: the path lives ONLY at `.ref.path`, same as the real
    // DocumentSnapshot -- this fake used to have a direct `this.path` that
    // papered over a real bug (see canonical-document.mjs), found only
    // when validating against the real emulator. Don't reintroduce it.
    this.ref = {
      path,
      listCollections: async () =>
        Object.entries(subcollections).map(([name, docs]) => new FakeCollectionRef(name, `${path}/${name}`, docs)),
    };
  }
  data() {
    return this._rawData;
  }
}

class FakeCollectionRef {
  /**
   * @param {string} id
   * @param {string} basePath - full path of this collection (e.g. "orgs/abc/members")
   * @param {Array<{id: string, data: Record<string, any>, subcollections?: Record<string, any>}>} docsSpec
   */
  constructor(id, basePath, docsSpec) {
    this.id = id;
    this._basePath = basePath;
    this._docsSpec = docsSpec;
  }
  async get() {
    const docs = this._docsSpec.map(
      (spec) => new FakeDocSnapshot(spec.id, `${this._basePath}/${spec.id}`, spec.data, spec.subcollections)
    );
    return { docs };
  }
}

/**
 * @param {Record<string, Array<{id: string, data: any, subcollections?: any}>>} rootCollectionsSpec
 * @returns {*} FirestoreLike
 */
export function createFakeFirestore(rootCollectionsSpec) {
  return {
    listCollections: async () =>
      Object.entries(rootCollectionsSpec).map(([id, docs]) => new FakeCollectionRef(id, id, docs)),
  };
}

/** Sample dataset exercising the 8 canonical types + nested subcollections,
 * used by the extractor's own tests. */
export function buildSampleDataset() {
  return {
    users: [
      {
        id: 'u1',
        data: {
          name: 'Ana',
          age: 29,
          active: true,
          createdAt: Timestamp.fromDate(new Date('2026-01-15T10:00:00Z')),
          tags: ['admin', 'beta'],
          address: { city: 'Santo Domingo', zip: null },
          avatar: Buffer.from('fake-image-bytes'),
        },
        subcollections: {
          orders: [
            {
              id: 'o1',
              data: {
                total: 149.99,
                placedAt: Timestamp.fromDate(new Date('2026-02-01T00:00:00Z')),
                items: [{ sku: 'A1', qty: 2 }],
              },
            },
          ],
        },
      },
    ],
    posts: [
      {
        id: 'p1',
        data: {
          title: 'Hello world',
          authorRef: fakeDocRef('users/u1'),
          location: new GeoPoint(18.4861, -69.9312),
        },
      },
    ],
  };
}
