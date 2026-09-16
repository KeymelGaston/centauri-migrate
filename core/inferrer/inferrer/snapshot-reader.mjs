import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Lee el snapshot local escrito por `core/extractor` (un `.jsonl` por
 * `collectionShape`, ver snapshot-writer.mjs) y lo agrupa de vuelta por
 * shape para que el inferidor pueda analizar todos los documentos de una
 * misma "colección lógica" juntos.
 *
 * @param {string} snapshotDir - normalmente `.centauri/snapshot`
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
    // el collectionShape real (con '/') viene DENTRO de cada documento, no
    // del nombre de archivo (que reemplaza '/' por '__') -- usamos el del
    // documento para no tener que revertir el reemplazo a mano.
    const shape = docs[0].collectionShape;
    byShape[shape] = docs;
  }
  return byShape;
}
