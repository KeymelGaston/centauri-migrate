/**
 * Converts CanonicalValue (see core/extractor/canonical-document.mjs) into
 * values ready for a parameterized Postgres query, according to the pgType
 * decided by core/inferrer.
 */

/** Recursively strips the {type, value} wrapper, producing plain JSON
 * suitable for a jsonb column or an embedded flattened-array element. */
export function toPlainJson(cv) {
  if (cv === null || cv === undefined) return null;
  switch (cv.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return cv.value;
    case 'timestamp':
      return cv.value; // already an ISO string
    case 'geopoint':
      return cv.value; // { lat, lng }
    case 'reference':
      return cv.value; // full path string
    case 'bytes':
      return cv.value; // base64 string
    case 'array':
      return cv.value.map(toPlainJson);
    case 'map': {
      const out = {};
      for (const key of Object.keys(cv.value)) out[key] = toPlainJson(cv.value[key]);
      return out;
    }
    default:
      return null;
  }
}

/** A Firestore reference's canonical value holds the full path
 * ("orgs/abc/members/xyz"); a resolved FK column should hold just the
 * referenced document's id ("xyz"), never the path. */
export function referenceIdFromPath(path) {
  return path.split('/').pop();
}

/**
 * @param {import('../extractor/canonical-document.mjs').CanonicalValue | undefined} cv
 * @param {string} pgType
 * @param {{ isForeignKey?: boolean }} [opts]
 * @returns {*} a value safe to pass as a `pg` query parameter
 */
export function toColumnValue(cv, pgType, { isForeignKey = false } = {}) {
  if (!cv || cv.type === 'null') return null;
  if (isForeignKey && cv.type === 'reference') return referenceIdFromPath(cv.value);
  if (pgType === 'jsonb') return JSON.stringify(toPlainJson(cv));
  if (pgType === 'bytea') return Buffer.from(cv.value, 'base64');
  return cv.value;
}
