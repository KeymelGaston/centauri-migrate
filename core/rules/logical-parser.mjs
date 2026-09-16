import { parse as parseCel } from 'cel-js';

/**
 * Breaks down a boolean condition into an AND/OR tree using the real CST
 * from `cel-js`, instead of a hand-rolled paren-depth split.
 *
 * Why: the first version avoided trusting `firetree`'s AST (which builds
 * the wrong tree when a condition mixes comparisons with logical operators
 * -- see ast-utils.js) by implementing a manual paren-depth split. It
 * worked, but it was our own heuristic. It was verified with concrete cases
 * that `cel-js` DOES respect operator precedence correctly (the real
 * conditionalOr > conditionalAnd > relation hierarchy of the CEL grammar)
 * -- the bug was never in cel-js, it was specifically in firetree's AST.
 * Using the CST of a real parser is more robust than our heuristic for
 * nested cases we didn't hand-cover (explicit user parentheses grouping a
 * sub-expression, for example).
 *
 * Input requirement: `expr` must be valid CEL -- i.e. it must have already
 * gone through `extractDocumentLookups()` (ast-utils.js), which replaces
 * each Firestore get()/exists() (not valid CEL, due to its path literal)
 * with a simple placeholder.
 */

function countChildren(node) {
  if (!node.children) return 0;
  return Object.values(node.children).reduce((n, arr) => n + arr.length, 0);
}

/** If `node` is, with no real operator applied along the way, a simple
 * wrapper around an expression in explicit user parentheses (e.g. the whole
 * condition is literally `(b == 2 && c == 3)`), returns the inner `expr`
 * node so it can be recursed into as a new top level. If a real operator is
 * applied along the way (a comparison, an addition, etc.) or a plain token
 * is reached, returns null -- `node` should be treated as a genuine leaf. */
function tryUnwrapParens(node) {
  let cur = node;
  while (true) {
    if (cur.name === 'parenthesisExpression') return cur.children.expr[0];
    if (countChildren(cur) !== 1) return null;
    const onlyKey = Object.keys(cur.children)[0];
    const next = cur.children[onlyKey][0];
    if (next.image !== undefined && !next.children) return null; // terminal token
    cur = next;
  }
}

function collectTokens(node, out) {
  if (node === null || typeof node !== 'object') return;
  if (node.image !== undefined && node.startOffset !== undefined) {
    out.push(node);
    return;
  }
  if (node.children) {
    for (const key of Object.keys(node.children)) node.children[key].forEach((c) => collectTokens(c, out));
  }
}

/** Exact text of a sub-node, reconstructed from its tokens' position range
 * (not from grammar regeneration) -- reliable because cel-js DOES preserve
 * correct offsets per token. */
function textOf(node, src) {
  const toks = [];
  collectTokens(node, toks);
  if (toks.length === 0) return '';
  const start = Math.min(...toks.map((t) => t.startOffset));
  const end = Math.max(...toks.map((t) => t.endOffset));
  return src.slice(start, end + 1).trim();
}

/** Flattens chains of the same operator so we don't over-nest
 * (a && b && c -> {op:AND, terms:[a,b,c]} instead of AND(AND(a,b),c)). */
function flatten(op, left, right) {
  const terms = [];
  for (const side of [left, right]) {
    if (side.op === op) terms.push(...side.terms);
    else terms.push(side);
  }
  return { op, terms };
}

/** node: a 'conditionalOr' or 'conditionalAnd' node from the cel-js CST, or
 * any lower-level node that ended up as a base case. */
function buildFromLogicalNode(node, src) {
  if (node.name === 'conditionalOr' && node.children.rhs) {
    return flatten('OR', buildFromLogicalNode(node.children.lhs[0], src), buildFromLogicalNode(node.children.rhs[0], src));
  }
  if (node.name === 'conditionalOr') {
    return buildFromLogicalNode(node.children.lhs[0], src);
  }
  if (node.name === 'conditionalAnd' && node.children.rhs) {
    return flatten('AND', buildFromLogicalNode(node.children.lhs[0], src), buildFromLogicalNode(node.children.rhs[0], src));
  }
  if (node.name === 'conditionalAnd') {
    return buildFromLogicalNode(node.children.lhs[0], src);
  }

  // Base case: we reached something that isn't conditionalOr/conditionalAnd
  // (typically a 'relation'). Before accepting it as a leaf, check whether
  // it's a simple wrapper around explicit user parentheses -- if it is,
  // recurse inside it as a new top level of logic.
  const unwrapped = tryUnwrapParens(node);
  if (unwrapped) {
    return buildFromLogicalNode(unwrapped.children.conditionalOr[0], src);
  }

  return { op: 'LEAF', text: textOf(node, src) };
}

/**
 * @param {string} expr - condition already cleaned of get()/exists() (see
 *   extractDocumentLookups in ast-utils.js), must be valid CEL.
 * @returns {{op:'AND'|'OR', terms: any[]} | {op:'LEAF', text: string}}
 */
export function parseLogical(expr) {
  const trimmed = expr.trim();
  const result = parseCel(trimmed);
  if (!result.isSuccess) {
    // Shouldn't happen if extractDocumentLookups() already cleaned the
    // condition correctly -- but if it does, better to degrade to an
    // "unrecognized" leaf (the classifier sends it to FALSE) than to blow
    // up the whole pipeline.
    return { op: 'LEAF', text: trimmed };
  }
  const topConditionalOr = result.cst.children.conditionalOr[0];
  return buildFromLogicalNode(topConditionalOr, trimmed);
}

/** Attaches the lookups map to every leaf of the tree, so the classifier
 * can resolve __doc_lookup_N__ placeholders without threading it through
 * every recursive call. */
export function attachLookups(tree, lookupsByPlaceholder) {
  if (tree.op === 'LEAF') tree.lookupsByPlaceholder = lookupsByPlaceholder;
  else tree.terms.forEach((t) => attachLookups(t, lookupsByPlaceholder));
  return tree;
}
