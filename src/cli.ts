#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runExtract } from './commands/extract.js';
import { runInfer } from './commands/infer.js';
import { runRules } from './commands/rules.js';
import { runReview } from './commands/review.js';
import { runMigrate } from './commands/migrate.js';
import {
  header,
  success,
  error,
  step,
  info,
  warn,
  withSpinner,
  printTable,
  printSummaryBox,
  confidenceBadge,
  type ConfidenceLevel,
} from './utils/cli-output.js';

// ARCHITECTURE NOTE: this file should stay as wiring ONLY (parse flags ->
// call the real command function). Each command's logic lives in
// src/commands/*.ts as pure functions with zero dependency on `commander`
// -- if the command-parsing library ever changes (oclif, yargs), only this
// file needs to be rewritten.

const program = new Command();

program.name('centauri').description('Migrate Firestore to Postgres with assisted schema inference').version('0.1.0');

program
  .command('init')
  .description('Create centauri.config.json and the .centauri/ state directory')
  .option('-f, --force', 'overwrite centauri.config.json if it already exists', false)
  .action(async (opts: { force: boolean }) => {
    header('init');
    const result = await runInit({ force: opts.force });
    if (!result.created) {
      warn(`${result.configPath} already exists -- left untouched (use --force to overwrite).`);
      return;
    }
    success(`Created ${result.configPath}`);
    success(`State directory ready at ${result.stateDir}`);
    printSummaryBox('Before running "centauri extract"', [
      '1. Replace "firestoreProjectId" with your real Firebase project ID.',
      '2. Download a service account key (Firebase Console -> Project settings -> Service accounts -> Generate new private key) and point "serviceAccountPath" to that file.',
      '3. Never commit that credentials file to git -- add it to .gitignore.',
    ]);
  });

program
  .command('extract')
  .description('Extract the entire Firestore database to a local snapshot (.centauri/snapshot)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    header('extract');
    const result = await withSpinner('Extracting Firestore documents...', () =>
      runExtract({ configPath: opts.config })
    );
    success(`Snapshot written to ${result.snapshotDir}`);
    printTable(
      ['Collection shape', 'Documents'],
      Object.entries(result.counts).map(([shape, count]) => [shape, String(count)])
    );
    info(`Total: ${result.total} document(s)`);
  });

program
  .command('infer')
  .description('Propose a relational schema from the extracted snapshot (schema.proposed.json)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    header('infer');
    const result = await withSpinner('Inferring relational schema from snapshot...', () =>
      runInfer({ configPath: opts.config })
    );
    success(`Proposed schema written to ${result.schemaPath}`);
    info(`${result.tableCount} candidate table(s).`);
    step('Every column/relation/nesting decision carries a confidence level -- run "centauri review" before applying anything.');
  });

program
  .command('rules')
  .description('Translate firestore.rules into candidate RLS policies (policies.proposed.json)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    header('rules');
    const result = await withSpinner('Translating Security Rules into candidate RLS...', () =>
      runRules({ configPath: opts.config })
    );
    success(`Candidate policies written to ${result.policiesPath}`);
    info(`${result.tableCount} candidate table(s).`);
    if (!result.usedSchemaMap) {
      warn(
        'No schema.proposed.json found -- subcollection table/column names were guessed with a ' +
          'best-effort heuristic (flagged in each policy\'s notes). Run "centauri infer" first for more accurate results.'
      );
    }
    warn('Never apply these policies without reviewing every note first.');
  });

program
  .command('review')
  .description('Aggregate every low/medium-confidence decision from schema.proposed.json and policies.proposed.json into one report')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    header('review');
    const result = await withSpinner('Aggregating findings...', () => runReview({ configPath: opts.config }));
    success(`Review report written to ${result.reportPath}`);

    if (result.findings.length > 0) {
      printTable(
        ['Category', 'Confidence', 'Location', 'Description'],
        result.findings.map((f) => [
          f.category,
          confidenceBadge(f.confidence as ConfidenceLevel),
          f.location,
          f.description,
        ])
      );
    }

    const summaryLines = Object.entries(result.summary.byCategory).map(([cat, n]) => `${cat}: ${n}`);
    printSummaryBox(`${result.summary.total} item(s) need a human look`, summaryLines, result.summary.total > 0 ? 'warn' : 'success');

    if (!result.ranAgainstSchema) info('No schema.proposed.json found -- run "centauri infer" to include schema findings.');
    if (!result.ranAgainstPolicies) info('No policies.proposed.json found -- run "centauri rules" to include RLS findings.');
  });

program
  .command('migrate')
  .description('Create tables and migrate data into Postgres (writes real data unless --dry-run)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .option('--apply', 'actually run the migration against Postgres (requires CENTAURI_POSTGRES_URL); default is a dry-run preview', false)
  .option('-f, --force', 'ignore the existing checkpoint and start the migration over', false)
  .action(async (opts: { config: string; apply: boolean; force: boolean }) => {
    header('migrate');
    const dryRun = !opts.apply;
    if (dryRun) {
      const result = await withSpinner('Building dry-run preview...', () =>
        runMigrate({ configPath: opts.config, dryRun: true })
      );
      const preview = result as unknown as {
        ddlStatements: { tableName: string; sql: string }[];
        rowCounts: Record<string, number>;
        flattenTargets: string[];
      };
      warn('DRY RUN -- nothing was written to Postgres.');

      printTable(
        ['Table', 'Rows to insert', 'DDL'],
        preview.ddlStatements.map((stmt) => [stmt.tableName, String(preview.rowCounts[stmt.tableName] ?? 0), stmt.sql])
      );

      const summaryLines = [
        `Tables to create: ${preview.ddlStatements.length}`,
        `Total rows to insert: ${Object.values(preview.rowCounts).reduce((a, b) => a + b, 0)}`,
      ];
      if (preview.flattenTargets.length > 0) {
        summaryLines.push(`Flattened columns to populate: ${preview.flattenTargets.join(', ')}`);
      }
      printSummaryBox('Dry-run summary', summaryLines, 'info');
      info('Run with --apply to execute this for real (requires CENTAURI_POSTGRES_URL to be set).');
      return;
    }

    const result = await withSpinner(
      'Applying migration to Postgres...',
      () => runMigrate({ configPath: opts.config, dryRun: false, force: opts.force }),
      { successText: 'Migration applied.' }
    );
    printSummaryBox(
      'Migration complete',
      [JSON.stringify((result as unknown as { summary: unknown }).summary, null, 2)],
      'success'
    );
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Without this, a thrown Error inside any command's action bubbles up as
    // an unhandled rejection -- Node dumps a raw stack trace and the exit
    // code is non-deterministic. Every command already throws plain `Error`s
    // with an intentionally clear `.message` (see e.g. migrate.ts's
    // CENTAURI_POSTGRES_URL check) -- print exactly that, in the same style
    // as everything else, and fail the process deliberately.
    error(err instanceof Error ? err.message : String(err));
    if (process.env.CENTAURI_DEBUG) {
      console.error(err);
    } else {
      step('Run with CENTAURI_DEBUG=1 for the full stack trace.');
    }
    process.exitCode = 1;
  }
}

main();
