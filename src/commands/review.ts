import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { loadConfig } from '../config/config-loader.js';

export interface ReviewOptions {
  configPath?: string;
}

export interface ReviewFinding {
  category: 'schema-column' | 'schema-relation' | 'schema-nesting' | 'rls-policy';
  confidence: 'low' | 'medium';
  location: string;
  description: string;
}

export interface ReviewResult {
  reportPath: string;
  findings: ReviewFinding[];
  summary: { total: number; byCategory: Record<string, number> };
  ranAgainstSchema: boolean;
  ranAgainstPolicies: boolean;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface SchemaColumn {
  name: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}
interface SchemaRelation {
  sourceField: string;
  proposedColumn: string;
  confidence: 'high' | 'medium';
  reason: string;
}
interface SchemaTable {
  collectionShape: string;
  tableName: string;
  strategy: 'own_table' | 'flattened_jsonb';
  nestingConfidence: 'high' | 'medium' | 'low';
  nestingReason: string;
  columns: SchemaColumn[];
  relations: SchemaRelation[];
}
interface PolicyEntry {
  dialect: string;
  sql: string;
  notes: string[];
}
interface PolicyTable {
  path: string;
  policies: PolicyEntry[];
}

function findingsFromSchema(tables: SchemaTable[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const table of tables) {
    for (const col of table.columns) {
      if (col.confidence !== 'high') {
        findings.push({
          category: 'schema-column',
          confidence: col.confidence,
          location: `${table.tableName}.${col.name}`,
          description: col.notes.join(' | ') || `column confidence is '${col.confidence}'`,
        });
      }
    }
    for (const rel of table.relations) {
      if (rel.confidence !== 'high') {
        findings.push({
          category: 'schema-relation',
          confidence: rel.confidence,
          location: `${table.tableName}.${rel.proposedColumn}`,
          description: rel.reason,
        });
      }
    }
    // Root collections are always 'own_table' at 'high' confidence by
    // construction (see table-builder.mjs) -- only subcollections carry a
    // real nesting decision worth surfacing here.
    if (table.collectionShape.includes('/') && table.nestingConfidence !== 'high') {
      findings.push({
        category: 'schema-nesting',
        confidence: table.nestingConfidence,
        location: table.collectionShape,
        description: `${table.strategy}: ${table.nestingReason}`,
      });
    }
  }
  return findings;
}

function findingsFromPolicies(tables: PolicyTable[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const table of tables) {
    for (const policy of table.policies) {
      if (policy.notes.length > 0) {
        findings.push({
          category: 'rls-policy',
          confidence: policy.sql.includes('FALSE') ? 'low' : 'medium',
          location: `${table.path} (${policy.dialect})`,
          description: policy.notes.join(' | '),
        });
      }
    }
  }
  return findings;
}

/**
 * Real logic behind `centauri review`: reads `schema.proposed.json` and/or
 * `policies.proposed.json` and pulls together every decision that carries
 * anything less than 'high' confidence into a single report -- the whole
 * point of every confidence level threaded through `core/inferrer` and
 * `core/rules` is to surface exactly this list before anyone applies
 * anything to a real database. This command doesn't let you edit the
 * proposal yet (no apply step exists to feed); it's a read + aggregate
 * step. A pure function with respect to `commander` -- see the
 * architecture note in cli.ts.
 */
export async function runReview(options: ReviewOptions = {}): Promise<ReviewResult> {
  const config = await loadConfig(options.configPath);

  const schemaPath = path.join(config.outputDir, 'schema.proposed.json');
  const policiesPath = path.join(config.outputDir, 'policies.proposed.json');

  const ranAgainstSchema = await exists(schemaPath);
  const ranAgainstPolicies = await exists(policiesPath);

  if (!ranAgainstSchema && !ranAgainstPolicies) {
    throw new Error(
      `Neither ${schemaPath} nor ${policiesPath} exist. Run "centauri infer" and/or "centauri rules" first.`
    );
  }

  let findings: ReviewFinding[] = [];
  if (ranAgainstSchema) {
    const { tables } = JSON.parse(await readFile(schemaPath, 'utf8'));
    findings = findings.concat(findingsFromSchema(tables));
  }
  if (ranAgainstPolicies) {
    const policyTables = JSON.parse(await readFile(policiesPath, 'utf8'));
    findings = findings.concat(findingsFromPolicies(policyTables));
  }

  const byCategory: Record<string, number> = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

  const reportPath = path.join(config.outputDir, 'review.report.json');
  await writeFile(reportPath, JSON.stringify({ findings, summary: { total: findings.length, byCategory } }, null, 2) + '\n', 'utf8');

  return { reportPath, findings, summary: { total: findings.length, byCategory }, ranAgainstSchema, ranAgainstPolicies };
}
