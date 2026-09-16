# core/inferrer — canonical document → proposed relational schema

Status: **built and tested, including real integration with `core/rules`**
(not just unit tests). Meant to become `centauri infer`.

## What it does

Reads the snapshot written by `core/extractor`, and for every
`collectionShape` proposes: columns (with Postgres type and confidence
level), relations (candidate foreign keys), and — for subcollections —
whether it's better as its own table or flattened to `jsonb`. **It never
decides silently**: any inconsistency (field types differing between
documents, ambiguous fan-out) gets flagged with low/medium confidence and
its reason, so `centauri review` (not implemented yet) can show it to the
user.

```js
import { inferSchema } from './index.mjs';

const { tables, schemaMapMappings } = await inferSchema('.centauri/snapshot');
```

`schemaMapMappings` is, literally, the object expected by
`createSchemaMap()` from `core/rules/schema-contract.mjs` — **not a similar
shape, the exact shape**. This is proven with real integration tests (not
just unit tests of each module in isolation): a snapshot gets generated,
the schema gets inferred, and the result is handed for real to
`generatePoliciesFromRulesFile()` from `core/rules`, confirming that the
generated SQL uses the table/column names the inferrer decided on — not a
hand-built mock.

## Decisions and their confidence levels

| Decision | High confidence | Medium | Low |
|---|---|---|---|
| Column type | a single type observed across all docs | field missing in some docs (nullable) | inconsistent types across docs |
| Relation (FK) | real `DocumentReference` | field name suggests a relation (`authorId`) but it's a plain value | — |
| Own table vs `jsonb` | has sub-subcollections (forced) | high fan-out (>5 docs/parent) | low fan-out (candidate to flatten, requires confirmation) |

## Heuristics with known limits, documented on purpose

- **PK type**: `text` by default (Firestore's auto-generated ids are base62
  strings, not UUIDs); `uuid` is only proposed if EVERY observed id has the
  shape of a real UUID.
- **FK name singularization** (`orgs` → `org_id`, not `orgs_id`): a simple
  heuristic (strips a trailing `s` except for `ss`), **doesn't handle
  irregular English plurals** (`children` doesn't give `child`). The
  generated name is always visible for review — it's never a silent
  decision.
- **Fan-out threshold for the flattening decision**: a fixed threshold (>5
  docs/parent on average). With a small sample (like any test snapshot),
  the average may not be representative of real production data — that's
  why the low-fan-out case always stays at `low` confidence, never higher.
- **`geopoint` is always proposed as `jsonb`** — v1 doesn't evaluate
  PostGIS types (`geometry(Point)`), even though that would be the more
  idiomatic Postgres option for real geospatial data.

## Real bug found and fixed (reviewed against real user data)

Running `infer-schema.mjs` against a real snapshot, the `posts` table
showed the column `authorRef: text` **and separately** a suggested relation
toward `author_id` — neither reconciled with the other. The final table
would have kept the raw Firestore field name instead of the real FK column
name. Fixed in `table-builder.mjs` (`reconcileColumnsWithRelations`): when
a field has a detected relation, the final column uses the proposed FK
name, with `sourceField` kept for traceability, and the final confidence is
the **lowest** between the type's confidence and the confidence that it's
really a relation (an FK detected only by name heuristic, even with a
well-known data type, is still `medium` overall).

## Real, unresolved pending items

- **Table name collisions**: `tableNameFromShape()` only uses the last
  segment of the path (`orgs/members` → `members`). If two different
  subcollections end in the same name (e.g. `orgs/members` and
  `teams/members`), both propose the `members` table — there's no collision
  detection yet.
- **Arrays of references**: an `array` field whose contents are
  `DocumentReference`s (e.g. `collaboratorRefs: [ref1, ref2]`) isn't
  detected as a many-to-many relation — it's treated as generic `jsonb`.
  `relation-detection.mjs` only looks at the field's overall type, not the
  contents of arrays.
- **No index proposals** — the CLI blueprint mentions an `AnalyzeQuery`-like
  mode to suggest indexes (seen in `cel2sql` during the RLS research), not
  implemented here.
- **Not run against a real, large project snapshot** — the integration
  tests use small hand-built datasets (7-8 documents). Fan-out threshold
  behavior against real data (thousands of documents, uneven distribution
  across parents) is unvalidated.

## Files

- `snapshot-reader.mjs` — reads `core/extractor`'s `.jsonl` files back,
  grouped by `collectionShape`.
- `field-inference.mjs` — column type per field, with confidence.
- `relation-detection.mjs` — relations via a real `DocumentReference` or
  name heuristic.
- `nesting-strategy.mjs` — `own_table` vs `flattened_jsonb` per subcollection.
- `table-builder.mjs` — combines everything above into a table definition.
- `schema-map-adapter.mjs` — the real coupling point with `core/rules`:
  converts the inferred tables into the exact shape `createSchemaMap()` expects.
- `index.mjs` — orchestrates everything, public API (`inferSchema`).
- `__tests__/` — 16 tests, includes 2 real integration tests crossing into
  `core/rules` (no mocks) and 1 regression test (FK singularization).
