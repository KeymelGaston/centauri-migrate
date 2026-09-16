import { toCanonicalDocument } from './canonical-document.mjs';

/**
 * Minimal (duck-typed) interface this file needs from the Firestore Admin
 * SDK -- documented explicitly here so it can be tested with a lightweight
 * fake without depending on a real connection (see
 * __tests__/fake-firestore.mjs).
 *
 * FirestoreLike:
 *   listCollections(): Promise<CollectionRefLike[]>
 *
 * CollectionRefLike:
 *   id: string
 *   get(): Promise<{ docs: DocSnapshotLike[] }>
 *
 * DocSnapshotLike:
 *   id: string
 *   data(): Record<string, any>
 *   ref: { path: string, listCollections(): Promise<CollectionRefLike[]> }
 *   (the real DocumentSnapshot does NOT have its own `.path` -- only lives at `.ref.path`)
 */

/**
 * Recursively walks a collection and all its subcollections, generating a
 * CanonicalDocument for every document found.
 *
 * SCALE NOTE (pending, unresolved): uses `collectionRef.get()`, which pulls
 * the whole collection in a single QuerySnapshot. For very large
 * collections (millions of documents, the Traba case from the product doc)
 * this doesn't scale -- it would need to paginate with `.stream()` or
 * `startAfter()` cursors. Acceptable for v1's small-team customer segment
 * (see product doc, section 2), documented as a known limit.
 *
 * @param {*} collectionRef - CollectionRefLike
 * @param {string} shapePath - accumulated shape so far (e.g. "orgs/members")
 * @returns {AsyncGenerator<import('./canonical-document.mjs').CanonicalDocument>}
 */
export async function* walkCollection(collectionRef, shapePath) {
  const snapshot = await collectionRef.get();
  for (const doc of snapshot.docs) {
    yield toCanonicalDocument(doc, shapePath);

    const subcollections = await doc.ref.listCollections();
    for (const subcollectionRef of subcollections) {
      const childShapePath = `${shapePath}/${subcollectionRef.id}`;
      yield* walkCollection(subcollectionRef, childShapePath);
    }
  }
}

/**
 * Entry point: extracts the ENTIRE database (every root collection and its
 * subcollections, recursively), generating canonical documents.
 *
 * @param {*} db - FirestoreLike
 * @returns {AsyncGenerator<import('./canonical-document.mjs').CanonicalDocument>}
 */
export async function* extractAll(db) {
  const rootCollections = await db.listCollections();
  for (const collectionRef of rootCollections) {
    yield* walkCollection(collectionRef, collectionRef.id);
  }
}
