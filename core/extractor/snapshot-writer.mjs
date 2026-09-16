import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes a stream of canonical documents to disk, one `.jsonl` file per
 * `collectionShape` (one line = one document, JSON Lines format so it can
 * be written/read without loading the whole collection into memory).
 *
 * The file name replaces '/' with '__' (e.g. "orgs/members" ->
 * "orgs__members.jsonl") because '/' isn't valid in a file name on most
 * systems.
 *
 * @param {string} outputDir - normally `.centauri/snapshot`
 * @param {AsyncIterable<import('./canonical-document.mjs').CanonicalDocument>} documents
 * @returns {Promise<Record<string, number>>} document count written per shape
 */
export async function writeSnapshot(outputDir, documents) {
  await mkdir(outputDir, { recursive: true });

  /** @type {Record<string, import('node:fs/promises').FileHandle>} */
  const openFiles = {};
  /** @type {Record<string, number>} */
  const counts = {};

  try {
    for await (const doc of documents) {
      const fileName = doc.collectionShape.replaceAll('/', '__') + '.jsonl';
      const filePath = path.join(outputDir, fileName);

      if (!openFiles[doc.collectionShape]) {
        openFiles[doc.collectionShape] = await open(filePath, 'w');
        counts[doc.collectionShape] = 0;
      }

      await openFiles[doc.collectionShape].appendFile(JSON.stringify(doc) + '\n');
      counts[doc.collectionShape] += 1;
    }
  } finally {
    await Promise.all(Object.values(openFiles).map((fh) => fh.close()));
  }

  return counts;
}
