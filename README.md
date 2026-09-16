# Centauri Migrate

A CLI that migrates Firestore to Postgres with assisted schema inference and Firestore Security Rules → Row Level Security translation.

> **Status: early, working end-to-end, not yet battle-tested.** Every command runs and is covered by tests (84 passing at the time of writing), including real integration tests and validation against the Firestore emulator — but this hasn't been run against a large, real-world production dataset yet. See [Known limitations](#known-limitations) before trusting it with anything you can't afford to lose.

## Why

Moving off Firestore into Postgres means solving two problems most tools ignore:

1. **Schema inference** — Firestore is schemaless; Postgres isn't. Someone has to decide what tables, columns, and relationships your documents actually represent.
2. **Security rules** — your Firestore Security Rules encode real access-control logic. If you migrate the data but not the rules, you can go from "properly locked down" to "wide open" without anyone noticing until it's too late.

Centauri Migrate handles both, and is explicit about what it's confident in and what it isn't.

## Core principle

**Nothing is ever applied silently.** Every inferred column, relation, table-flattening decision, and RLS policy carries a confidence level (`high` / `medium` / `low`). Anything below `high` is surfaced by `centauri review` before you'd ever run a real migration. Anything Centauri can't confidently translate becomes an explicit `FALSE` (deny) in generated RLS policies — never a guessed permissive rule.

## Install

```bash
git clone https://github.com/KeymelGaston/centauri-migrate.git
cd centauri-migrate
npm install
```

Requires Node 20+. Uses [`tsx`](https://github.com/privatenumber/tsx) to run the TypeScript CLI directly — no build step needed for local use.

## Quick start

```bash
npx tsx src/cli.ts init
```

Creates `centauri.config.json` (with placeholders, never real credentials) and a `.centauri/` state directory. Fill in:
- `firestoreProjectId` — your Firebase project ID
- `serviceAccountPath` — path to a downloaded service account key ([Firebase Console → Project settings → Service accounts](https://console.firebase.google.com/))

```bash
npx tsx src/cli.ts extract
```

Walks your entire Firestore database (collections + subcollections, recursively) and writes a local snapshot to `.centauri/snapshot/`.

```bash
npx tsx src/cli.ts infer
```

Proposes a relational schema from that snapshot — tables, columns, types, and relationships — written to `.centauri/schema.proposed.json`.

```bash
npx tsx src/cli.ts rules
```

Translates your `firestore.rules` into candidate RLS policies (both Supabase and generic-Postgres dialects), written to `.centauri/policies.proposed.json`. Automatically uses the real schema from the previous step to resolve subcollection table/column names correctly.

```bash
npx tsx src/cli.ts review
```

Aggregates everything from the two steps above that isn't `high` confidence into a single report — `.centauri/review.report.json` — so you know exactly what to check before touching a real database.

```bash
npx tsx src/cli.ts migrate
```

Dry-run by default: previews the exact `CREATE TABLE` statements and row counts, touches nothing. When you're ready:

```bash
export CENTAURI_POSTGRES_URL="postgres://user:pass@host:5432/db"
npx tsx src/cli.ts migrate --apply
```

**The Postgres connection string is only ever read from this environment variable — never from a config file.** This is deliberate: if Centauri Migrate is ever run inside a Docker container (see [`CENTAURI-DEV.md`](./CENTAURI-DEV.md)), a value in a config file can end up baked into an image; an environment variable set at container runtime never does.

## What it looks like

```
CREATE TABLE IF NOT EXISTS "orgs" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "members" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "role" text NOT NULL,
  FOREIGN KEY ("org_id") REFERENCES "orgs"(id)
);
```

...generated automatically from Firestore documents like `orgs/{orgId}/members/{memberId}`, with the decision to keep it as its own table (rather than flatten it into a `jsonb` column) based on real fan-out measured in your data — not a guess.

## Architecture

```
core/
├── rules/       Firestore Security Rules → candidate RLS policies
├── extractor/   Firestore → canonical documents (source-independent format)
├── inferrer/    canonical documents → proposed relational schema
└── migrator/    proposed schema + snapshot → real Postgres tables and data
src/
├── cli.ts               commander wiring only — no business logic
├── commands/*.ts        one pure, independently-testable function per command
└── config/config-loader.ts
```

Each `core/*` module has its own README with implementation details, confidence-level rules, and documented limitations. For the full engineering history — bugs found, alternatives investigated and rejected, and why things are built the way they are — see [`CENTAURI-DEV.md`](./CENTAURI-DEV.md).

## Known limitations

- **Not validated against a real, large Firestore project** — tested against the Firestore emulator and hand-built datasets, not a production-scale database.
- **`centauri rules` has zero validation against real-world `firestore.rules` files** — only against rules written to cover known patterns.
- **Migration checkpoint/resume is table-level, not row-level** — if interrupted mid-table, that table's rows are re-inserted from scratch (safe, via `ON CONFLICT DO NOTHING`, but not efficient for very large tables).
- **No pagination for very large Firestore collections** yet.
- **No index proposals, no cutover/dual-write support** — this covers initial extraction, inference, and import only, not a live production cutover.

See each `core/*/README.md` for the full, per-module list.

## License

MIT — see [`LICENSE`](./LICENSE).

## Contributing

Not yet open for external contributions while the core flow is still stabilizing — issues and discussion are welcome.
