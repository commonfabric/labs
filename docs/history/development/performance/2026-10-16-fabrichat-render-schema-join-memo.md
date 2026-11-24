---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Counts per caller of schema-intern cache misses on a thirty-message FabriChat room's cold load, October 2026, settling whether the render's schema joins missed by identity because schemas arrived unfrozen or copied across the worker boundary: they did not, the join had no memo at all and resolved its references against fresh roots; and the counts and profile shares after the join was kept per schema."
---

# What the render's schema joins hashed on a FabriChat room's cold load, October 2026

The cold-load record
([`2026-10-16-fabrichat-room-cold-load-phases.md`](2026-10-16-fabrichat-room-cold-load-phases.md))
left the render phase as the largest remaining share of a thirty-message
room's load: 4.5 s in the sinks under `renderRoot` → `#reconcileIntoWrapper`
→ `#bindCellProps` → `#sinkCell`, about 25 bound props per row, and 1.8 s of
`internSchema` inside them, most of it resolving `$ref`s under `joinSchema`.
The reading to test was that a join of the same two schemas ought to be
memoized by identity, and that it was not pointed at an upstream defect: a
schema arriving unfrozen, or as a fresh copy, from the round trip through the
main thread (`cell:subscribe`, `cell:resolveAsCell` and `vdom:mount` hand
links with schemas across the worker boundary). This record is the count
that settles it.

## Setup

- The server: the toolshed binary a sibling investigation had built from
  `main` at `e9d06a608b` with `EXPERIMENTAL_SERVER_EXECUTION=false` baked in,
  over a store directory of its own, on a port no other session held. Every
  change here is worker-side, so the server did not change between arms.
- The room: `packages/patterns/integration/fabrichat-room-seed.ts`, twelve
  members, thirty messages, one thread of five replies, a reaction every
  third message.
- The client: the throwaway harness of the cold-load record, opening a
  headless browser against a dev shell served from this tree
  (`SHELL_PORT=5311 TOOLSHED_PORT=8511 deno task dev-local` in
  `packages/shell`), signing in as the room's starter, attaching the worker
  profiler, and waiting for the last message and every member's badge. It
  writes the worker's CPU profile, the load summary and the worker's logger
  counts. Every load below is the room's second or later; the first load
  builds and commits the rows.
- The counter: a temporary counter in `internSchemaReturningSchemaAndHash()`
  (`packages/data-model-schema/src/schema-intern.ts`) recorded, for every
  call given an object, whether it hit the identity `WeakMap`; on a miss, the
  caller as the four innermost frames above the interning functions, whether
  the object arrived deep-frozen, was frozen in place, or was cloned, whether
  its content was already interned, the length of its JSON as the measure of
  what the miss hashed, and the distinct contents per caller. Two more
  counted each top-level `joinSchema()` entry by whether its schema was
  already interned, and each `resolveCfcSchemaRefs()` call by whether its
  pair memo was consulted, hit or missed, and when not consulted, which of
  its two arguments was not deep-frozen. The counts crossed the worker
  boundary as logger counts (`rt.getLoggerCounts()`). The worker's SES
  lockdown blanks `Error.stack`, so the counting loads ran with its error
  taming relaxed. The counts are exact and identical between two loads of
  one arm; the counting itself made those loads slow, so nothing timed was
  taken from them.
- The machine: an M3 Max with sixteen cores, at a one-minute load of 20 to
  100 from other sessions' work throughout.

## What a load interned, and what missed

The load made 1,425,301 `internSchema()` calls with an object. 1,394,076 hit
the identity cache. 31,225 missed, and hashed 42.1 million characters of
schema JSON between them; 22,412 of the misses were of content already
interned. The misses came from 237 callers. The table holds the thirteen
that matter to the question, 13,562 misses and 28.5 million characters; the
other 224 callers are 17,663 misses and 13.6 million characters between
them, none above 0.8 million, the largest of them by count the 2,297
`{ $ref }` forms `externalizeSchema` minted per alias binding (0.14 million
characters) and the 1,217 documents `externalizeSyncSelector` interned.

| caller | misses | deep-frozen on arrival | distinct contents | JSON characters hashed |
| --- | ---: | ---: | ---: | ---: |
| `resolveCfcSchemaRefs` under `resolveSchemaRefsOrThrow`, from `joinSchema` | 1,596 | 138 | 672 | 8.69 M |
| `resolveCfcSchemaRefs` under `collectCfcSchemaEntries` | 375 | 10 | 232 | 4.25 M |
| `decomposeSchema` in `externalizeSchema`, under `resolveCellAlias` | 2,297 | 0 | 295 | 3.70 M |
| `resolveCfcSchemaRefs` under `_schemaHasIfcUncached` | 742 | 0 | 455 | 3.40 M |
| `resolveCfcSchemaRefs` under `resolve3` | 225 | 0 | 184 | 1.92 M |
| `resolveCfcSchemaRefs` under `extractDefaultValues` | 163 | 8 | 135 | 1.80 M |
| `selectReferencedCfcSchemaDefs` under `schemaAtPath` | 511 | 0 | 185 | 1.28 M |
| `addDocument` in `decomposeSchema`, under `externalizeSchema` | 1,930 | 463 | 627 | 0.97 M |
| `joinSchema` under `traverseValue`, in the builder | 659 | 1 | 233 | 0.91 M |
| `verifySchemaDocument`, on a session sync frame | 1,075 | 1,075 | 482 | 0.86 M |
| `joinSchema` on each subschema, under `forEachSubschema` | 3,444 | 3,444 | 556 | 0.32 M |
| `internCellLinkSchema` in `getCellFromLink`, under `getDerivedInternalCell` | 194 | 150 | 88 | 0.30 M |
| `internCellLinkSchema` in `getCellFromLink`, under `getCell` (the worker boundary) | 351 | 351 | — | 0.10 M |

The worker boundary is the last row. A `CellRef` decoded from a request
carries its schema as a fresh object, deep-frozen, whose content the worker
has interned already: 351 such objects per load, hashed once each and then
cached for that object, a tenth of a million characters out of 42 million.
That is not where the time went.

The join is. `joinSchema()` was entered at the top level 10,901 times per
load, and 10,036 of those entries were given a schema that was already the
interned instance: the identity cache was not what missed. What missed was
below it. The join had no memo of its own, so every entry walked the whole
schema again, interning every subschema it reached (3,444 misses of frozen
sub-objects on their first sight, cheap, and 220,896 pair-memo hits in
`resolveCfcSchemaRefs()` after that) and resolving every `$ref` it reached.
Of those resolutions, 6,337 missed the pair memo and 2,944 never consulted
it, because one of the two objects the memo keys on was not deep-frozen. The
view a `$ref` resolves to is `{ ...body, $defs }`, built fresh, cached per
document and reference by `resolveCfcSchemaRef()`, and never frozen, so a
resolution rooted at such a view was uncacheable, resolved again on every
walk, and interned its result again, a result that carries the document's
whole definition map and hashes all of it. The distinct contents of a load's
top-level joins numbered 376.

The third row is the pattern builder, not the render. `resolveCellAlias()`
sanitized a binding's schema into a mutable strip per call and externalized
that strip, so a cell bound at many positions decomposed a fresh copy of the
same content each time: 2,297 decompositions of 295 contents.

## What changed

- `ContextualFlowControl.joinSchema()` keeps the atoms a join of a schema as
  its own document collects, per canonical instance, in a `WeakMap` swapped
  on the registry clear as every memo of resolution successes is. A walk
  during which an external document was missing is not kept. The walk
  itself moves to `#joinSchemaWalk()`.
- `resolveCfcSchemaRef()` deep-freezes the view it caches for a deep-frozen
  document. The view's parts are the document's, so freezing costs the root
  object and nothing below, and the memos keyed on a resolution's root then
  hold for it.
- The builder's alias resolver sanitizes a deep-frozen binding schema into
  its canonical strip when the schema is externalized, so decomposition,
  which memoizes by identity, runs once per content; 2,349 of a load's 2,575
  alias schemas arrive deep-frozen, and a mutable one is stripped as before
  rather than frozen in place. An inline schema stays a strip of its own per
  position, since `createRef()` hashes an object it reaches twice in one
  cause as `null`.

`packages/runner/test/cfc-join-schema-memo.test.ts` pins the first: a
second join of a schema, or of a structurally equal one, resolves no
reference, a schema not yet joined does, and a join that lacked a document
is joined again once the document has arrived.
`packages/runner/test/cfc/schema-refs.test.ts` pins the second: the view of
a deep-frozen document is deep-frozen and carries the document's own map, a
reference within it resolves to the same instance twice, and the view of a
mutable document is left unfrozen.

## After

The same load, the same counter:

| per load | before | after |
| --- | ---: | ---: |
| `internSchema()` identity hits | 1,394,076 | 497,409 |
| `internSchema()` identity misses | 31,225 | 26,123 |
| JSON characters hashed by misses | 42.1 M | 37.1 M |
| top-level `joinSchema()` entries | 10,901 | 10,901 |
| of which walked | 10,901 | 376 |
| `resolveCfcSchemaRefs()` pair-memo hits | 220,896 | 115,547 |
| `resolveCfcSchemaRefs()` pair-memo misses | 6,337 | 5,861 |
| decompositions under `resolveCellAlias` | 2,297 | 0 |

The 376 walks that remain are one per distinct schema, and what they hash is
the first resolution of each `$ref` they reach: 1,146 misses of 672 contents,
6.6 million characters, each a definition view carrying its document's map.
The 2,086 resolutions that still never consult the pair memo are not under
the join at all: they are `schemaAtPath()` narrowing into a union arm whose
root is an inherited-definitions view (`cfcSchemaWithInheritedDefs`), which
is memoized per map but minted unfrozen. That is the next thing to freeze,
and it is outside what this change touched.

## The profiles

Three pairs of loads, each arm's worker bundle built from this tree with the
three changed files at their before or after state, the arms alternating
after, before, after, before, after, before as the one-minute load rose from
51 to 75. Each cell is the function's inclusive sample count and its share of
the profile's samples outside `(idle)`. `sink` is the render's subscription
read, the frame the cold-load record's 4.5 s sat under; `joinSchema` is the
join, whatever called it; `internSchema` is every interning, under the join
or not.

| pair | arm | busy samples | `sink` | `joinSchema` | `internSchema` | `handleMessage` | sign-in to last message |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | after | 9,518 | 2,385 (25.1%) | 186 (2.0%) | 768 (8.1%) | 974 (10.2%) | 33.0 s |
| 1 | before | 10,871 | 3,253 (29.9%) | 616 (5.7%) | 877 (8.1%) | 1,461 (13.4%) | 28.6 s |
| 2 | after | 8,240 | 2,160 (26.2%) | 176 (2.1%) | 684 (8.3%) | 912 (11.1%) | 28.0 s |
| 2 | before | 9,070 | 2,731 (30.1%) | 477 (5.3%) | 738 (8.1%) | 1,147 (12.6%) | 28.8 s |
| 3 | after | 8,367 | 1,909 (22.8%) | 158 (1.9%) | 705 (8.4%) | 803 (9.6%) | 24.8 s |
| 3 | before | 10,262 | 2,881 (28.1%) | 453 (4.4%) | 784 (7.6%) | 1,110 (10.8%) | 25.1 s |

The join's share falls from 4.4–5.7% to 1.9–2.1% in every pair, and the
sinks' from 28–30% to 23–26%: what the memo removes is the walk itself, the
1.4 million identity-cache probes and 220,000 pair-memo probes a load made
over schemas it had joined before, more than the hashing under it. The
interning's own share is unchanged at about 8%, since what it hashed under
the join moved to the first walk of each schema and the rest of it never was
under the join: the samples that left `resolveCfcSchemaRefs` under
`joinSchema` (153 to 89 in the first pair) and `decomposeSchema` under
`resolveCellAlias` (67 to 0) are the size of the change, and the callers
that remain are the ones the counts above name. The wall times say nothing:
the load moved within each pair by more than the arms differ, and the
sampled interval was about 2 ms, so a sample is a coarse unit of time.

## What is left

- `resolveCfcSchemaRefs()` interns each resolved definition view, and a view
  carries the document's whole `$defs`, so hashing a view hashes the map
  again: 672 distinct views cost 6.6 million characters per load under the
  join alone, and the hasher consults its identity cache for the root object
  only, never for a frozen sub-object it reaches. A view hashed as its body
  plus the map's known hash would cost its body.
- `cfcSchemaWithInheritedDefs` mints its memoized view unfrozen, so every
  resolution rooted at one (2,086 per load, under `schemaAtPath`) bypasses
  the pair memo and resolves again.
- `verifySchemaDocument` hashes 1,075 arriving documents per load, 757 of
  them content the worker already holds; verification is what the hash is
  for, so that cost is by design unless the frame carried the hash it was
  verified against.
- The worker boundary: 351 decoded schemas hashed once each per load. A
  request could carry the schema's tagged hash beside the schema, so a worker
  that already holds the content could find it without hashing; at a tenth
  of a million characters per load it is not worth a protocol change.
