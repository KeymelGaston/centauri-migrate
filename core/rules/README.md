# core/rules — Firestore Security Rules to candidate RLS policies

Status: **spike validated with tests, not yet wired into the CLI.** Meant
to become the `centauri rules` command from the CLI blueprint.

## What it does

Reads a `firestore.rules` file, finds every `match` with a direct `allow`
(a candidate table), and generates a **candidate** RLS policy per
condition, in two dialects: `supabase` (`auth.uid()` / `auth.jwt()`) and
`generic` (`current_setting('app.user_id')`, for self-hosted Postgres).

```js
import { generatePoliciesFromRulesFile } from './index.mjs';

const results = await generatePoliciesFromRulesFile('./firestore.rules');
// [{ path: '/users/{userId}', policies: [{ dialect, sql, notes: [...] }] }]
```

### Coupling with the schema inferrer (`schemaMap`)

When a rule references another collection (`get()`/`exists()`), this module
needs to know how the schema inferrer modeled it: its own table? flattened
as `jsonb` inside the parent? Without that information it can only guess.
The optional second parameter solves this:

```js
import { generatePoliciesFromRulesFile, createSchemaMap } from './index.mjs';

const schemaMap = createSchemaMap({
  'orgs/members': {
    strategy: 'own_table',
    table: 'org_members',
    primaryKeyColumn: 'user_id',
    parentForeignKeyColumn: 'org_id',
  },
});

const results = await generatePoliciesFromRulesFile('./firestore.rules', { schemaMap });
```

The key (`'orgs/members'`) is the path's **shape** (sequence of collection
names, without variables) — see `pathShapeKey()` in `schema-contract.mjs`.
Without a `schemaMap`, or if there's no entry for a given shape, it falls
back to the previous heuristic (own table = last path segment), explicitly
flagged as an assumption in the `notes`. The real schema inferrer
(`core/inferrer`, already exists — see its own README) exposes this exact
same interface `{ resolve(shapeKey) }`, derived from its own
`schema.proposed.json`.

**Never applies anything automatically.** Any unrecognized condition is
translated to `FALSE` (deny) as a safe default — the module never invents a
permissive policy for a pattern it doesn't understand. Every output
requires human review before use (see `centauri review` in the CLI
blueprint).

## Confidence levels it recognizes

| Level | Pattern | Example |
|---|---|---|
| 0 | Trivial | `if true` / `if false` |
| 1 | Direct ownership | `request.auth.uid == userId`, `request.auth.uid == resource.data.authorId` |
| 2 | Reference to another document | `get()`/`exists()`, in either comparison direction |
| 2 | Custom claims | `request.auth.token.X == 'v'`, `.hasAny([...])` |
| 3 | Untranslatable | shape validation (`.keys()`, `.size()`, `.hasOnly()`) → explicit `FALSE` |

## Design decisions worth knowing before touching this code

1. **Don't trust firetree's AST for AND/OR structure — use cel-js's real CST
   instead.** `firetree` builds the wrong tree when a condition mixes
   comparisons (`==`, `!=`) with logical operators (`&&`, `||`) — for
   `request.auth != null && request.auth.uid == userId`, it puts `!=` at the
   root instead of `&&`. Alternatives were investigated (compiling
   `cel-go`/`cel2sql` to WASM, or a per-platform native binary) before
   confirming, with a direct test case, that **`cel-js` already respects
   precedence correctly** — the bug was never there, it was specifically in
   `firetree`. `logical-parser.mjs` walks `cel-js`'s real CST (the
   `conditionalOr > conditionalAnd > relation` hierarchy), including
   explicit unwrapping of user-supplied parentheses
   (`parenthesisExpression`), instead of a hand-rolled text heuristic. Zero
   external binaries, zero WASM — everything within the Node ecosystem.

2. **`firetree`'s `generate()` is only reliable at full-node boundaries** (a
   `match`, an `allow`, a whole `get()/exists()` call). Never regenerate
   `.left`/`.right` of a binary expression separately — it drags along text
   from neighboring nodes. `firetree` is used only for structure (finding
   `match`/`allow`/`get`/`exists`); all boolean logic goes through `cel-js`
   once the condition text has already been reliably extracted.

3. **The order of checks in `classifier.mjs` matters.** Patterns with a
   lookup placeholder (`__doc_lookup_N__.data.X == ...`) are checked
   **before** the generic ownership check, or a reversed comparison like
   `get(orgs).data.ownerId == request.auth.uid` gets confused with an
   ownership check on the current row — a real bug found and fixed during
   the spike (see the `REGRESSION -- reversed-comparison lookup` test).

## Real, unresolved pending items
- **Compound paths without a `schemaMap` entry** still fall back to a
  heuristic (own table = last path segment), explicitly flagged as an
  assumption.
- **`flattened_jsonb` only supports 2-segment paths** (parent + one
  flattened subcollection). Deeper nesting isn't covered — falls back to
  explicit `FALSE`, never a silent guess.
- **Custom claims in the `generic` dialect** (Postgres without Supabase): no
  automatic mechanism — an explicit `TODO` is generated, never invented.
- **`get()`/`exists()` replacement by text, not by position**
  (`ast-utils.js`): correct for the test cases, but fragile if the same call
  appears twice with identical text in the same condition. Should be
  replaced by token position range, not string matching.
- **Only tested against hand-written rules.** Zero validation against real
  `firestore.rules` files from existing projects — cobertura on real-world
  edge cases (nested roles, `in` over lists, multiple chained `get()`s,
  `request.time`) is unverified.

## Files

- `ast-utils.mjs` — everything that touches `firetree`'s AST directly.
- `logical-parser.mjs` — AND/OR tree via `cel-js`'s CST.
- `classifier.mjs` — classifies an already-isolated leaf into a known
  pattern.
- `schema-contract.mjs` — contract shared with the schema inferrer:
  `pathShapeKey()`, `createSchemaMap()`.
- `sql-generator.mjs` — classified pattern → candidate SQL, per dialect,
  using `schemaMap` when available.
- `index.mjs` — orchestrates everything, the module's public API.
- `__tests__/` — 17 tests (`node --test core/rules/__tests__/rules.test.mjs`),
  includes regression tests for real bugs and `schemaMap` cases.
