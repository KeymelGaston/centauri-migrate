/**
 * Centralized, pretty terminal output for the Centauri CLI.
 * Pure functions with zero dependency on `commander` -- consistent with the
 * thin-wrapper pattern used across `src/commands/*.ts` (this file only
 * formats/prints; the command functions stay side-effect-free and testable).
 *
 * Static imports of chalk/ora/boxen/cli-table3 were verified against this
 * repo's actual `tsx` + tsconfig ("module": "NodeNext", no "type": "module"
 * in package.json) -- unlike `core/rules` (chevrotain via cel-js, see
 * commands/rules.ts's comment), these four packages resolve fine here, so
 * no dynamic import() workaround is needed for them.
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import boxen from 'boxen';
import Table from 'cli-table3';

// ---------------------------------------------------------------------------
// Basic message levels
// ---------------------------------------------------------------------------

export function success(message: string): void {
  console.log(`${chalk.green('✔')} ${message}`);
}

export function error(message: string): void {
  console.error(`${chalk.red('✖')} ${chalk.red(message)}`);
}

export function warn(message: string): void {
  console.warn(`${chalk.yellow('⚠')} ${chalk.yellow(message)}`);
}

export function info(message: string): void {
  console.log(`${chalk.blue('ℹ')} ${message}`);
}

/** A sub-step or secondary line under a main message (dimmed). */
export function step(message: string): void {
  console.log(`  ${chalk.dim(message)}`);
}

/** Section header printed at the top of each command's output. */
export function header(title: string): void {
  console.log('\n' + chalk.bold.cyan(`centauri ${title}`));
  console.log(chalk.cyan('─'.repeat(title.length + 9)));
}

// ---------------------------------------------------------------------------
// Confidence badges -- shared vocabulary across core/rules, core/inferrer,
// and `centauri review` ('high' | 'medium' | 'low')
// ---------------------------------------------------------------------------

export type ConfidenceLevel = 'high' | 'medium' | 'low';

const CONFIDENCE_STYLE: Record<ConfidenceLevel, (s: string) => string> = {
  high: chalk.green,
  medium: chalk.yellow,
  low: chalk.red,
};

/** e.g. confidenceBadge('low') -> colored "[LOW]" */
export function confidenceBadge(level: ConfidenceLevel): string {
  return CONFIDENCE_STYLE[level](`[${level.toUpperCase()}]`);
}

// ---------------------------------------------------------------------------
// Spinners for async steps (extract, migrate --apply)
// ---------------------------------------------------------------------------

/**
 * Runs an async task with a spinner, auto succeed/fail based on outcome.
 * The wrapped command function itself stays untouched -- only cli.ts (the
 * wiring layer) calls this, so runExtract/runMigrate/etc. remain pure and
 * testable exactly as before.
 */
export async function withSpinner<T>(
  text: string,
  task: () => Promise<T>,
  options?: { successText?: string; failText?: string }
): Promise<T> {
  const spinner: Ora = ora(text).start();
  try {
    const result = await task();
    spinner.succeed(options?.successText ?? text);
    return result;
  } catch (err) {
    spinner.fail(options?.failText ?? text);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Prints a table sized to fit the actual terminal width, wrapping long cell
 * content (e.g. RLS policy notes, DDL) across multiple lines instead of
 * letting a single wide column stretch the whole table past what any
 * terminal can show on one line (real bug found in `centauri review`
 * output: long `description` values pushed the table far past 200+
 * columns wide with no wrapping at all).
 */
export function printTable(headers: string[], rows: string[][]): void {
  const numCols = headers.length;
  const terminalWidth = process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 100;
  // cli-table3's `colWidths` is the FULL rendered width of each column
  // (content + its own 1-char padding on each side) -- only the vertical
  // border characters between/around columns are extra. Real bug found
  // here: an earlier version treated colWidths as content-only width and
  // added padding on top when computing `available`, which silently ate
  // into the space cli-table3 actually gives the content, truncating even
  // short values (e.g. "rls-policy" -> "rls-pol…") that should have fit.
  //
  // SAFETY_MARGIN: keep the rendered table strictly narrower than the
  // reported terminal width, never exactly equal to it. Legacy Windows
  // consoles (conhost, used by classic PowerShell -- not Windows Terminal)
  // can fail to record a real line break when a line fills the buffer
  // width exactly, which merges rows together on copy/paste even though
  // the live on-screen render and the underlying output stream are both
  // correct. Costs nothing to avoid.
  const SAFETY_MARGIN = 2;
  const overhead = numCols + 1 + SAFETY_MARGIN;
  const available = Math.max(terminalWidth - overhead, numCols * 10);

  const PADDING = 2; // 1 char each side, included inside colWidths
  const natural = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)) + PADDING);

  // Only shrink whichever column is currently the widest, down to MIN_COL_WIDTH,
  // one step at a time -- keeps short columns (e.g. "Confidence", "[MEDIUM]")
  // at their natural width instead of truncating them along with everything
  // else. Real bug found in `centauri review` output: proportional shrinking
  // truncated "Category"/"Confidence" headers themselves even though they
  // were never the reason the table didn't fit -- the long `description`
  // column was.
  const MIN_COL_WIDTH = 12; // 10 chars of content + 2 padding
  const colWidths = [...natural];
  let total = colWidths.reduce((a, b) => a + b, 0);
  while (total > available) {
    let widestIdx = -1;
    let widestVal = MIN_COL_WIDTH;
    colWidths.forEach((w, i) => {
      if (w > widestVal) {
        widestVal = w;
        widestIdx = i;
      }
    });
    if (widestIdx === -1) break; // every column already at the minimum
    const shrinkBy = Math.min(total - available, widestVal - MIN_COL_WIDTH);
    colWidths[widestIdx] -= shrinkBy;
    total -= shrinkBy;
  }

  const table = new Table({
    head: headers.map((h) => chalk.bold.white(h)),
    style: { head: [], border: ['grey'] },
    colWidths,
    wordWrap: true,
  });
  rows.forEach((row) => table.push(row));
  console.log(table.toString());
}

// ---------------------------------------------------------------------------
// Boxes -- for summaries the user should notice (dry-run result, final report)
// ---------------------------------------------------------------------------

export function printSummaryBox(
  title: string,
  lines: string[],
  variant: 'info' | 'success' | 'warn' = 'info'
): void {
  const borderColor = variant === 'success' ? 'green' : variant === 'warn' ? 'yellow' : 'cyan';
  const content = [chalk.bold(title), '', ...lines].join('\n');
  console.log(
    boxen(content, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderColor,
      borderStyle: 'round',
    })
  );
}
