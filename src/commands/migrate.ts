import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config/config-loader.js';

export interface MigrateOptions {
  configPath?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Injected for tests; built from CENTAURI_POSTGRES_URL in real use. */
  pgClient?: { query: (sql: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };
}

export interface MigrateResult {
  dryRun: boolean;
  [key: string]: unknown;
}

/**
 * Real logic behind `centauri migrate`: the ONLY command that writes to a
 * real database. Reads `schema.proposed.json` (from `centauri infer`) and
 * the snapshot (from `centauri extract`), then either previews the DDL and
 * row counts (`dryRun`, the default) or actually creates tables and inserts
 * data via `core/migrator`.
 *
 * SECURITY: the Postgres connection string is NEVER read from
 * `centauri.config.json` -- only from the `CENTAURI_POSTGRES_URL`
 * environment variable. This is deliberate (see CENTAURI-DEV.md, section 7
 * -- Docker distribution): `centauri.config.json` is a file a user might
 * commit to git or copy into a Docker build context; an env var set at
 * container runtime never ends up baked into an image or a repo.
 *
 * A pure function with respect to `commander` -- see the architecture note
 * in cli.ts. `core/migrator` is imported dynamically for the same reason
 * `commands/rules.ts` does (see its own comment): avoids a `tsx` +
 * `chevrotain` loader quirk when this file is loaded from other commands
 * that transitively pull in `core/rules`.
 */
export async function runMigrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const dryRun = options.dryRun ?? true;
  const config = await loadConfig(options.configPath);

  const schemaPath = path.join(config.outputDir, 'schema.proposed.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any[];
  try {
    ({ tables } = JSON.parse(await readFile(schemaPath, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Could not find ${schemaPath}. Run "centauri infer" first.`);
    }
    throw err;
  }

  const snapshotDir = path.join(config.outputDir, 'snapshot');
  const { runMigration } = await import('../../core/migrator/index.mjs');

  if (dryRun) {
    return (await runMigration({ tables, snapshotDir, dryRun: true })) as unknown as MigrateResult;
  }

  let pgClient = options.pgClient;
  let ownsClient = false;
  if (!pgClient) {
    const connectionString = process.env.CENTAURI_POSTGRES_URL;
    if (!connectionString) {
      throw new Error(
        'CENTAURI_POSTGRES_URL is not set. The Postgres connection string is never read from centauri.config.json -- ' +
          'set it as an environment variable before running a real (non-dry-run) migration.'
      );
    }
    const { Client } = await import('pg');
    const client = new Client({ connectionString });
    await client.connect();
    pgClient = client;
    ownsClient = true;
  }

  const checkpointPath = path.join(config.outputDir, 'migration.checkpoint.json');
  try {
    return (await runMigration({ tables, snapshotDir, dryRun: false, pgClient, checkpointPath, force: options.force })) as unknown as MigrateResult;
  } finally {
    if (ownsClient && pgClient.end) await pgClient.end();
  }
}
