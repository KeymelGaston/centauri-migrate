import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads the local snapshot written by `core/extractor` (one `.jsonl` per
 * `collectionShape`, see snapshot-writer.mjs) and groups it back by shape
 * so the inferrer can analyze every document of the same "logical
 * collection" together.
 *
 * @param {string} snapshotDir - normally `.centauri/snapshot`
 * @returns {Promise<Record<string, import('../extractor/canonical-document.mjs').CanonicalDocument[]>>}
 */
export async function readSnapshot(snapshotDir) {
  const files = await readdir(snapshotDir);
  /** @type {Record<string, import('../extractor/canonical-document.mjs').CanonicalDocument[]>} */
  const byShape = {};

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const content = await readFile(path.join(snapshotDir, file), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const docs = lines.map((line) => JSON.parse(line));
    if (docs.length === 0) continue;
    // the real collectionShape (with '/') lives INSIDE each document, not
    // in the file name (which replaces '/' with '__') -- we use the one
    // from the document so we don't have to reverse that replacement by hand.
    const shape = docs[0].collectionShape;
    byShape[shape] = docs;
  }
  return byShape;
}
