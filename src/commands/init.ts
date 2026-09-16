import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG_TEMPLATE } from '../config/config-loader.js';

export interface InitOptions {
  /** Directory to initialize in (default: process cwd). */
  cwd?: string;
  /** Overwrite centauri.config.json even if it already exists. */
  force?: boolean;
}

export interface InitResult {
  configPath: string;
  stateDir: string;
  /** false if a config already existed and `force` wasn't passed -- nothing was touched. */
  created: boolean;
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
 * Real logic behind `centauri init`: creates `centauri.config.json` (with
 * placeholders, never real credentials) and the `.centauri/` state
 * directory. A pure function -- it doesn't depend on `commander` and never
 * prints anything; `cli.ts` decides how to display the result. Uses the
 * same config shape (`DEFAULT_CONFIG_TEMPLATE`) as `config-loader.ts`, so
 * whatever `init` writes is always something `extract` (and every other
 * command) can read without any transformation.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.join(cwd, 'centauri.config.json');
  const stateDir = path.join(cwd, DEFAULT_CONFIG_TEMPLATE.outputDir);

  await mkdir(stateDir, { recursive: true });

  const configExists = await exists(configPath);
  if (configExists && !options.force) {
    return { configPath, stateDir, created: false };
  }

  await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2) + '\n', 'utf8');
  return { configPath, stateDir, created: true };
}
