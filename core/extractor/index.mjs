import { extractAll } from './firestore-extractor.mjs';
import { writeSnapshot } from './snapshot-writer.mjs';

/**
 * Extracts the entire Firestore database and dumps it as a local snapshot,
 * in canonical document form (see canonical-document.mjs). This is the
 * equivalent of `centauri extract` from the CLI blueprint.
 *
 * @param {Object} params
 * @param {*} params.db - an Admin SDK Firestore instance (or a fake with
 *   the same minimal interface, see firestore-extractor.mjs)
 * @param {string} params.outputDir - normally `.centauri/snapshot`
 * @returns {Promise<{ counts: Record<string, number>, total: number }>}
 */
export async function extractFirestoreToSnapshot({ db, outputDir }) {
  const counts = await writeSnapshot(outputDir, extractAll(db));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total };
}

export { toCanonicalValue, toCanonicalDocument } from './canonical-document.mjs';
export { walkCollection, extractAll } from './firestore-extractor.mjs';
export { writeSnapshot } from './snapshot-writer.mjs';
