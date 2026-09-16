#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runExtract } from './commands/extract.js';
import { runInfer } from './commands/infer.js';
import { runRules } from './commands/rules.js';
import { runReview } from './commands/review.js';
import { runMigrate } from './commands/migrate.js';

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
    const result = await runInit({ force: opts.force });
    if (!result.created) {
      console.log(`${result.configPath} already exists -- left untouched (use --force to overwrite).`);
      return;
    }
    console.log(`Created ${result.configPath}`);
    console.log(`State directory ready at ${result.stateDir}`);
    console.log('\nBefore running "centauri extract":');
    console.log('  1. Replace "firestoreProjectId" with your real Firebase project ID.');
    console.log('  2. Download a service account key (Firebase Console -> Project settings -> Service accounts -> Generate new private key) and point "serviceAccountPath" to that file.');
    console.log('  3. Never commit that credentials file to git -- add it to .gitignore.');
  });

program
  .command('extract')
  .description('Extract the entire Firestore database to a local snapshot (.centauri/snapshot)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    const result = await runExtract({ configPath: opts.config });
    console.log(`Snapshot written to ${result.snapshotDir}`);
    console.log('Document count by collectionShape:', result.counts);
    console.log(`Total: ${result.total} documents`);
  });

program
  .command('infer')
  .description('Propose a relational schema from the extracted snapshot (schema.proposed.json)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    const result = await runInfer({ configPath: opts.config });
    console.log(`Proposed schema written to ${result.schemaPath}`);
    console.log(`${result.tableCount} candidate tables. Every column/relation/nesting decision carries a confidence level -- review before applying anything.`);
  });

program
  .command('rules')
  .description('Translate firestore.rules into candidate RLS policies (policies.proposed.json)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    const result = await runRules({ configPath: opts.config });
    console.log(`Candidate policies written to ${result.policiesPath}`);
    console.log(`${result.tableCount} candidate tables.`);
    if (!result.usedSchemaMap) {
      console.log('\nNo schema.proposed.json found -- subcollection table/column names were guessed with a best-effort heuristic (flagged in each policy\'s notes). Run "centauri infer" first for more accurate results.');
    }
    console.log('\nNever apply these policies without reviewing every note first.');
  });

program
  .command('review')
  .description('Aggregate every low/medium-confidence decision from schema.proposed.json and policies.proposed.json into one report')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .action(async (opts: { config: string }) => {
    const result = await runReview({ configPath: opts.config });
    console.log(`Review report written to ${result.reportPath}`);
    console.log(`${result.summary.total} item(s) need a human look:`, result.summary.byCategory);
    if (!result.ranAgainstSchema) console.log('(no schema.proposed.json found -- run "centauri infer" to include schema findings)');
    if (!result.ranAgainstPolicies) console.log('(no policies.proposed.json found -- run "centauri rules" to include RLS findings)');
  });

program
  .command('migrate')
  .description('Create tables and migrate data into Postgres (writes real data unless --dry-run)')
  .option('-c, --config <path>', 'path to centauri.config.json', 'centauri.config.json')
  .option('--apply', 'actually run the migration against Postgres (requires CENTAURI_POSTGRES_URL); default is a dry-run preview', false)
  .option('-f, --force', 'ignore the existing checkpoint and start the migration over', false)
  .action(async (opts: { config: string; apply: boolean; force: boolean }) => {
    const dryRun = !opts.apply;
    if (dryRun) {
      const result = await runMigrate({ configPath: opts.config, dryRun: true });
      const preview = result as unknown as { ddlStatements: { tableName: string; sql: string }[]; rowCounts: Record<string, number>; flattenTargets: string[] };
      console.log('DRY RUN -- nothing was written to Postgres.\n');
      for (const stmt of preview.ddlStatements) {
        console.log(stmt.sql);
        console.log(`  -> ${preview.rowCounts[stmt.tableName] ?? 0} row(s) would be inserted\n`);
      }
      if (preview.flattenTargets.length > 0) {
        console.log('Flattened columns that would be populated:', preview.flattenTargets.join(', '));
      }
      console.log('\nRun with --apply to execute this for real (requires CENTAURI_POSTGRES_URL to be set).');
      return;
    }

    console.log('Applying migration to Postgres...');
    const result = await runMigrate({ configPath: opts.config, dryRun: false, force: opts.force });
    console.log('Done.', (result as unknown as { summary: unknown }).summary);
  });

program.parseAsync(process.argv);

