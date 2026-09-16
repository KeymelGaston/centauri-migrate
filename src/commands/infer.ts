import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../config/config-loader.js';
import { inferSchema } from '../../core/inferrer/index.mjs';

export interface InferOptions {
  configPath?: string;
}

export interface InferResult {
  schemaPath: string;
  tableCount: number;
  tables: unknown[];
}

/**
 * Real logic behind `centauri infer`: reads the snapshot written by
 * `centauri extract` and proposes a relational schema, saved to
 * `schema.proposed.json` inside the config's output directory. A pure
 * function with respect to `commander` -- see the architecture note in
 * cli.ts.
 */
export async function runInfer(options: InferOptions = {}): Promise<InferResult> {
  const config = await loadConfig(options.configPath);
  const snapshotDir = path.join(config.outputDir, 'snapshot');

  const { tables, schemaMapMappings } = await inferSchema(snapshotDir);

  const schemaPath = path.join(config.outputDir, 'schema.proposed.json');
  await writeFile(schemaPath, JSON.stringify({ tables, schemaMapMappings }, null, 2) + '\n', 'utf8');

  return { schemaPath, tableCount: tables.length, tables };
}
