import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config/config-loader.js';
import { extractFirestoreToSnapshot } from '../../core/extractor/index.mjs';

export interface ExtractOptions {
  configPath?: string;
  /** Injected for tests; built from the config's service account in real use. */
  db?: unknown;
}

export interface ExtractResult {
  snapshotDir: string;
  counts: Record<string, number>;
  total: number;
}

/**
 * Real logic behind `centauri extract`: loads the config, connects to
 * Firestore (or uses the `db` injected in tests) and dumps everything to a
 * local snapshot via `core/extractor`. A pure function with respect to
 * `commander` -- see the architecture note in cli.ts.
 */
export async function runExtract(options: ExtractOptions = {}): Promise<ExtractResult> {
  const config = await loadConfig(options.configPath);

  let firestoreDb = options.db;
  if (!firestoreDb) {
    // Dynamic import: firebase-admin shouldn't load at all in tests that
    // inject their own fake `db` (avoids requiring real credentials just to
    // run the suite).
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const serviceAccountRaw = await readFile(path.resolve(config.serviceAccountPath), 'utf8');
    const serviceAccount = JSON.parse(serviceAccountRaw);
    const app = initializeApp({ credential: cert(serviceAccount), projectId: config.firestoreProjectId });
    firestoreDb = getFirestore(app);
  }

  const snapshotDir = path.join(config.outputDir, 'snapshot');
  const { counts, total } = await extractFirestoreToSnapshot({ db: firestoreDb as never, outputDir: snapshotDir });

  return { snapshotDir, counts, total };
}
