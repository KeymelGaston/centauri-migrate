import { readFile } from 'node:fs/promises';

export interface CentauriConfig {
  firestoreProjectId: string;
  serviceAccountPath: string;
  outputDir: string;
  rulesFilePath: string;
  rlsDialect: 'supabase' | 'generic' | 'both';
}

const REQUIRED_FIELDS = ['firestoreProjectId', 'serviceAccountPath'] as const;

export const DEFAULT_CONFIG_TEMPLATE: CentauriConfig = {
  firestoreProjectId: 'your-firebase-project-id',
  serviceAccountPath: './service-account.json',
  outputDir: '.centauri',
  rulesFilePath: 'firestore.rules',
  rlsDialect: 'supabase',
};

/**
 * Loads and validates `centauri.config.json`. Never returns a half-validated
 * config -- if something required is missing, it fails with a message that
 * says exactly what's missing, not a "cannot read property of undefined"
 * stack trace three steps later inside `extract`.
 */
export async function loadConfig(configPath = 'centauri.config.json'): Promise<CentauriConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Could not find ${configPath}. Run "centauri init" first.`);
    }
    throw err;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const missing = REQUIRED_FIELDS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`${configPath} is missing required fields: ${missing.join(', ')}`);
  }

  return {
    firestoreProjectId: config.firestoreProjectId as string,
    serviceAccountPath: config.serviceAccountPath as string,
    outputDir: (config.outputDir as string) ?? DEFAULT_CONFIG_TEMPLATE.outputDir,
    rulesFilePath: (config.rulesFilePath as string) ?? DEFAULT_CONFIG_TEMPLATE.rulesFilePath,
    rlsDialect: (config.rlsDialect as CentauriConfig['rlsDialect']) ?? DEFAULT_CONFIG_TEMPLATE.rlsDialect,
  };
}
