# core/extractor — Firestore → canonical document

Status: **built and tested against a fake, and validated against a real
Firestore emulator.** Meant to become `centauri extract`.

## What it does

Recursively walks the entire Firestore database (root collections +
subcollections, no depth limit) and converts every document into a
**canonical document** — JSON with type metadata, independent of the
source (see the product doc, "Canonical Document Architecture"). The
result is written as a local snapshot in `.jsonl`, one file per
"collection shape".

```js
import { extractFirestoreToSnapshot } from './index.mjs';

const { counts, total } = await extractFirestoreToSnapshot({
  db,               // Admin SDK Firestore instance
  outputDir: '.centauri/snapshot',
});
// counts: { users: 120, 'users/orders': 843, posts: 56 }
```

## The canonical document

```js
{
  id: 'u1',
  sourcePath: 'users/u1',
  collectionShape: 'users',           // or 'orgs/members' for subcollections
  fields: {
    name: { type: 'string', value: 'Ana' },
    createdAt: { type: 'timestamp', value: '2026-01-15T10:00:00.000Z' },
    authorRef: { type: 'reference', value: 'users/u1' },  // only the path, never the live object
    location: { type: 'geopoint', value: { lat: 18.48, lng: -69.93 } },
    tags: { type: 'array', value: [{ type: 'string', value: 'admin' }] },
  },
}
```

`collectionShape` uses the **same concept** as `pathShapeKey()` in
`core/rules/schema-contract.mjs` — on purpose: it's the key the schema
inferrer should use to correlate "what the extractor found here" with
"what `core/rules` assumed about this subcollection", with no intermediate
transformation.

## Supported types

`string`, `number`, `boolean`, `null`, `timestamp`, `geopoint`, `reference`
(path only), `bytes` (base64), `array` (recursive), `map` (recursive).
Covers the SDK's 8 real field types — detection is duck-typed
(`toDate()`+`.seconds` for Timestamp, `.latitude`/`.longitude` for
GeoPoint, `.path`+`.id`+`.get()` for DocumentReference), not `instanceof`,
so it doesn't couple to a specific SDK version.

## Validated against a real emulator — a real bug was found and fixed

Running `run-extractor-against-emulator.mjs` against a real Firestore
emulator (not just the fake) immediately surfaced a real bug:
`toCanonicalDocument()` was reading `docSnapshot.path`. The real Admin SDK
`DocumentSnapshot` **doesn't have `.path` as its own property** — the path
only lives at `docSnapshot.ref.path`. The test fake had `.path` set by hand
(a "convenient" shape that didn't match the real SDK), which papered over
the bug across all 9 automated tests. Against the real emulator,
`docSnapshot.path` was `undefined`, and `JSON.stringify()` omits
`undefined` keys — so `sourcePath` **silently disappeared** from the final
snapshot, with no visible error. Fixed to read `docSnapshot.ref.path`; the
fake was fixed to stop having that property and reflect the real shape; an
explicit regression test was added with a snapshot that has no top-level
`.path`.

## Real, unresolved pending items

- **Doesn't paginate large collections.** Uses `collectionRef.get()` (pulls
  the whole `QuerySnapshot` at once). For collections with millions of
  documents (the Traba case from the product doc) this doesn't scale — it
  would need `.stream()` or `startAfter()` cursors. Acceptable for v1's
  small customer segment, documented as a known limit, not resolved.
- **No retries or checkpointing yet.** The product doc flags this as a
  cross-cutting MVP requirement ("resilience against partial failures") —
  this module doesn't implement it yet. If `extractAll` gets interrupted
  midway, there's no way to resume from where it left off.
- **No handling of Firestore API rate limits.** A large database can hit
  read quotas; there's no backoff or throttling.
- **`fakeDocRef.get()` isn't implemented** in the test fake (it throws if
  called) because the current extractor doesn't need it — if future logic
  ever calls `.get()` on a reference, the fake needs that method for real.

## Files

- `canonical-document.mjs` — converts native Firestore values to canonical
  document form. The only piece that knows Firestore-specific types.
- `firestore-extractor.mjs` — recursive traversal (`walkCollection`,
  `extractAll`), documents the minimal interface it needs from the Admin SDK.
- `snapshot-writer.mjs` — writes to disk, one `.jsonl` per `collectionShape`.
- `index.mjs` — orchestrates everything, public API (`extractFirestoreToSnapshot`).
- `__tests__/` — 10 tests, includes `fake-firestore.mjs` (the test fake,
  documented with its own limitation above).
