import { readFile, writeFile } from 'node:fs/promises';

/**
 * Simple step-level checkpoint -- NOT row-level. Each step is either
 * "done" or "not done": creating one table, inserting all of one table's
 * rows, or flattening one subcollection into its parent. If a migration is
 * interrupted mid-table, re-running will re-insert that table's rows from
 * scratch (safe because inserts use `ON CONFLICT (id) DO NOTHING`), not
 * resume from the exact row it stopped at. Documented as a known v1 limit
 * -- true row-level resume would need per-row progress tracking, which
 * isn't implemented here.
 */

/**
 * @param {string} checkpointPath
 * @returns {Promise<{ completedSteps: string[] }>}
 */
export async function loadCheckpoint(checkpointPath) {
  try {
    const raw = await readFile(checkpointPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { completedSteps: [] };
  }
}

/**
 * @param {string} checkpointPath
 * @param {{ completedSteps: string[] }} checkpoint
 */
export async function saveCheckpoint(checkpointPath, checkpoint) {
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
}

export function isStepDone(checkpoint, stepId) {
  return checkpoint.completedSteps.includes(stepId);
}

export function markStepDone(checkpoint, stepId) {
  if (!isStepDone(checkpoint, stepId)) checkpoint.completedSteps.push(stepId);
}
