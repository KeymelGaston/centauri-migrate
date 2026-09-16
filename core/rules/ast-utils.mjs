import { parse, generate, setupContext } from 'firetree';

/**
 * IMPORTANT NOTE about firetree:
 * `generate()` is reliable for regenerating the text of a COMPLETE node
 * (a match, an allow, a whole get()/exists() call). It is NOT reliable for
 * regenerating hand-reconstructed halves of a binary expression (it drags
 * along text from neighboring nodes) -- that's why everything below
 * operates on complete nodes and never tries to generate() an isolated
 * `.left`/`.right`.
 */

export async function loadRules(filePath) {
  const context = setupContext();
  const ast = await parse(context, { filePath });
  return { context, ast };
}

/** Walks the full AST deduping by `id` (firetree's AST shares nodes -- it's
 * a DAG, not a pure tree -- and without dedup any recursive walk explodes
 * exponentially). */
export function walkDeduped(root, visit) {
  const visited = new Set();
  function walk(node) {
    if (node === null || typeof node !== 'object') return;
    if (node.id) {
      if (visited.has(node.id)) return;
      visited.add(node.id);
    }
    visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'tokenList') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(root);
}

export function extractPathVars(pathSrc) {
  const vars = new Set();
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(pathSrc))) vars.add(m[1]);
  return vars;
}

/** AllowStatement nodes that are direct children of this match (without
 * descending into nested matches, to avoid mixing rules from another
 * "table"). */
export function getDirectAllows(matchNode) {
  const localVisited = new Set();
  const allows = [];
  function walk(n, isRoot) {
    if (n === null || typeof n !== 'object') return;
    if (n.id) {
      if (localVisited.has(n.id)) return;
      localVisited.add(n.id);
    }
    if (n.type === 'AllowStatement') {
      allows.push(n);
      return;
    }
    if (n.type === 'MatchStatement' && !isRoot) return;
    for (const key of Object.keys(n)) {
      if (key === 'parent' || key === 'tokenList') continue;
      const value = n[key];
      if (Array.isArray(value)) value.forEach((v) => walk(v, false));
      else if (value && typeof value === 'object') walk(value, false);
    }
  }
  walk(matchNode, true);
  return allows;
}

/** Finds every "leaf" match (with a direct allow) in the file, already
 * deduped -- firetree duplicates whole subtrees with different ids. */
export async function findLeafMatches(context, ast) {
  const matchStatements = [];
  walkDeduped(ast, (n) => {
    if (n.type === 'MatchStatement') matchStatements.push(n);
  });

  const leafMatches = [];
  const seenSignatures = new Set();
  for (const m of matchStatements) {
    const src = (await generate(context, { ast: m })).replace(/\s+/g, ' ').trim();
    const pathMatch = src.match(/^match (\/\S+)/);
    if (!pathMatch) continue;
    const path = pathMatch[1];
    const allows = getDirectAllows(m);
    if (allows.length === 0) continue;
    const allowSources = await Promise.all(allows.map((a) => generate(context, { ast: a })));
    const signature = path + '|' + allowSources.join('|');
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    leafMatches.push({ path, pathVars: extractPathVars(path), allows });
  }
  return leafMatches;
}

/**
 * Extracts get()/exists() calls from a condition and returns the condition
 * text with each call replaced by a simple placeholder, parseable by
 * parseLogical (see logical-parser.js). Firestore extends CEL with a "path
 * literal" as the argument to get()/exists() that isn't valid CEL for a
 * generic parser -- hence the need for the placeholder.
 */
export async function extractDocumentLookups(context, conditionNode) {
  const originalSource = (await generate(context, { ast: conditionNode })).trim();
  const lookupCalls = [];
  walkDeduped(conditionNode, (node) => {
    const isDocLookup =
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      (node.callee.name === 'get' || node.callee.name === 'exists');
    if (isDocLookup) lookupCalls.push(node);
  });

  const lookupsByPlaceholder = {};
  let cleanedExpr = originalSource;
  for (const [index, callNode] of lookupCalls.entries()) {
    const callSource = (await generate(context, { ast: callNode })).trim();
    const pathArg = callNode.args?.[0];
    const rawPath = pathArg ? (await generate(context, { ast: pathArg })).trim() : null;
    const placeholder = `__doc_lookup_${index}__`;
    lookupsByPlaceholder[placeholder] = { functionName: callNode.callee.name, rawPath, placeholder };
    // Text-level replacement: correct for the test cases, but fragile if
    // the same call appears twice with identical text in the same
    // condition. Pending: replace by token position range, not string match.
    cleanedExpr = cleanedExpr.split(callSource).join(placeholder);
  }
  return { cleanedExpr, lookupsByPlaceholder };
}

/** Converts a raw Firestore path (e.g.
 * "/databases/$(database)/documents/members/$(request.auth.uid)") into
 * pairs [{collection, key}], stripping Firestore's fixed prefix. */
export function parseFirestorePath(rawPath) {
  const cleaned = rawPath.replace(/^\/databases\/\$\(database\)\/documents/, '');
  const parts = cleaned.split('/').filter(Boolean);
  const pairs = [];
  for (let i = 0; i < parts.length; i += 2) pairs.push({ collection: parts[i], key: parts[i + 1] });
  return pairs;
}
