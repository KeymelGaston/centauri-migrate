import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { loadConfig } from '../config/config-loader.js';

export interface RulesOptions {
  configPath?: string;
}

export interface RulesResult {
  policiesPath: string;
  tableCount: number;
  usedSchemaMap: boolean;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real logic behind `centauri rules`: translates the project's
 * firestore.rules into candidate RLS policies (both Supabase and generic
 * Postgres dialects), saved to `policies.proposed.json`. If
 * `schema.proposed.json` exists (from a previous `centauri infer` run), its
 * `schemaMapMappings` are used to resolve subcollection table/column names
 * for real instead of falling back to core/rules's best-effort heuristic --
 * this is the real coupling point between the two commands, not just a
 * shared type. A pure function with respect to `commander` -- see the
 * architecture note in cli.ts.
 *
 * NOTE: `core/rules` is imported dynamically here (not statically at the
 * top of the file). Statically importing it from a TypeScript file loaded
 * via `tsx` triggers a packaging quirk in one of its transitive
 * dependencies (chevrotain, used by cel-js) where tsx's loader attempts a
 * CommonJS-style resolution of a pure-ESM package and fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. A dynamic `import()` resolves through
 * Node's own ESM loader instead of tsx's static-import transform, which
 * avoids the issue. `core/rules`'s own test suite (plain .mjs, run via
 * `node --test`) is unaffected either way.
 */
export async function runRules(options: RulesOptions = {}): Promise<RulesResult> {
  const { generatePoliciesFromRulesFile, createSchemaMap } = await import('../../core/rules/index.mjs');
  const config = await loadConfig(options.configPath);

  const schemaPath = path.join(config.outputDir, 'schema.proposed.json');
  let schemaMap: ReturnType<typeof createSchemaMap> | null = null;
  const usedSchemaMap = await exists(schemaPath);
  if (usedSchemaMap) {
    const { schemaMapMappings } = JSON.parse(await readFile(schemaPath, 'utf8'));
    schemaMap = createSchemaMap(schemaMapMappings);
  }

  const results = await generatePoliciesFromRulesFile(config.rulesFilePath, { schemaMap: schemaMap ?? undefined });

  const policiesPath = path.join(config.outputDir, 'policies.proposed.json');
  await writeFile(policiesPath, JSON.stringify(results, null, 2) + '\n', 'utf8');

  return { policiesPath, tableCount: results.length, usedSchemaMap };
}
