/**
 * Canonical document (see CENTAURI-DEV.md / product doc, "Canonical
 * Document Architecture"): a generic intermediate representation, JSON with
 * type metadata, indifferent to whether the source is Firestore, Mongo, or
 * Dynamo. This file is the ONLY piece of this module that knows about
 * Firestore's native types -- everything else (snapshot-writer, and in the
 * future the schema inferrer) works only with this canonical shape.
 *
 * @typedef {'string'|'number'|'boolean'|'null'|'timestamp'|'geopoint'|
 *   'reference'|'bytes'|'array'|'map'} CanonicalType
 *
 * @typedef {Object} CanonicalValue
 * @property {CanonicalType} type
 * @property {*} value - shape depends on `type`:
 *   string/number/boolean: the value as-is.
 *   null: always `null`.
 *   timestamp: ISO 8601 string.
 *   geopoint: { lat: number, lng: number }.
 *   reference: string -- the full path of the referenced document
 *     (e.g. "orgs/abc/members/xyz"), NEVER the DocumentReference object.
 *   bytes: base64 string.
 *   array: CanonicalValue[].
 *   map: Record<string, CanonicalValue>.
 *
 * @typedef {Object} CanonicalDocument
 * @property {string} id - the document's id in the original source.
 * @property {string} sourcePath - full path in the original source
 *   (e.g. "orgs/abc/members/xyz").
 * @property {string} collectionShape - sequence of collection names without
 *   the concrete ids (e.g. "orgs/members") -- same concept as
 *   `pathShapeKey` in core/rules/schema-contract.mjs, on purpose: the
 *   schema inferrer should be able to correlate both by this exact key,
 *   with no extra transformation.
 * @property {Record<string, CanonicalValue>} fields
 */

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
}

/**
 * Detects the type of a native Firestore value (as returned by
 * `docSnapshot.data()` in the Admin SDK) via duck-typing, not `instanceof`
 * -- more robust across SDK versions and easy to test with fakes that
 * aren't real instances of Firestore's classes.
 *
 * Detection order matters: Timestamp/GeoPoint/DocumentReference are
 * objects, and must be checked BEFORE the generic 'map' case, or they end
 * up misclassified.
 *
 * @param {*} raw
 * @returns {CanonicalValue}
 */
export function toCanonicalValue(raw) {
  if (raw === null || raw === undefined) return { type: 'null', value: null };

  if (typeof raw === 'string') return { type: 'string', value: raw };
  if (typeof raw === 'number') return { type: 'number', value: raw };
  if (typeof raw === 'boolean') return { type: 'boolean', value: raw };

  // Timestamp: admin.firestore.Timestamp exposes toDate() and .seconds/.nanoseconds
  if (typeof raw.toDate === 'function' && typeof raw.seconds === 'number') {
    return { type: 'timestamp', value: raw.toDate().toISOString() };
  }

  // GeoPoint: exposes numeric .latitude/.longitude, nothing else relevant
  if (typeof raw.latitude === 'number' && typeof raw.longitude === 'number') {
    return { type: 'geopoint', value: { lat: raw.latitude, lng: raw.longitude } };
  }

  // DocumentReference: exposes .path (string), .id (string), and a real
  // Firestore get() method -- only the path is stored, never the live object.
  if (typeof raw.path === 'string' && typeof raw.id === 'string' && typeof raw.get === 'function') {
    return { type: 'reference', value: raw.path };
  }

  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return { type: 'bytes', value: Buffer.from(raw).toString('base64') };
  }

  if (Array.isArray(raw)) {
    return { type: 'array', value: raw.map(toCanonicalValue) };
  }

  if (isPlainObject(raw)) {
    /** @type {Record<string, CanonicalValue>} */
    const map = {};
    for (const key of Object.keys(raw)) map[key] = toCanonicalValue(raw[key]);
    return { type: 'map', value: map };
  }

  // Defensive fallback: should never happen with real Firestore data, but
  // better to degrade to a string than to blow up the entire extraction
  // over one unexpected type.
  return { type: 'string', value: String(raw) };
}

/**
 * @param {{ id: string, ref: { path: string }, data: () => Record<string, any> }} docSnapshot
 *   Minimal duck-type of an Admin SDK DocumentSnapshot. NOTE: the path only
 *   lives at `docSnapshot.ref.path`, NOT at `docSnapshot.path` -- the real
 *   DocumentSnapshot doesn't have that direct property (unlike
 *   DocumentReference, which does). Real bug found while validating against
 *   the emulator: the test fake had `.path` set by hand, which papered over
 *   the error -- against the real emulator, `docSnapshot.path` was
 *   `undefined`, and `sourcePath` silently disappeared from the JSON
 *   (JSON.stringify omits `undefined` keys).
 * @param {string} collectionShape
 * @returns {CanonicalDocument}
 */
export function toCanonicalDocument(docSnapshot, collectionShape) {
  const raw = docSnapshot.data();
  /** @type {Record<string, CanonicalValue>} */
  const fields = {};
  for (const key of Object.keys(raw)) fields[key] = toCanonicalValue(raw[key]);
  return {
    id: docSnapshot.id,
    sourcePath: docSnapshot.ref.path,
    collectionShape,
    fields,
  };
}
