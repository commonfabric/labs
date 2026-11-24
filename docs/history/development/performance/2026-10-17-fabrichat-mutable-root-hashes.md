---
status: historical
created: 2026-10-17
archived: 2026-10-17
reason: "A count of the content hashes of mutable values a thirty-message FabriChat room's cold load computes in the worker, October 2026, by calling site and by whether the value's content had been hashed before; the four sites cut to a memo or a walk, and the counts and profile shares before and after."
---

# Which mutable values a FabriChat room's cold load hashes, October 2026

The sibling investigation that made the value hasher keep the encoded bytes
of a deep-frozen sub-container (pull request 9057 of `commonfabric/labs`,
open when this was written, which carries its record as
`2026-10-17-hasher-kept-container-bytes.md` beside this one) counted 107,591 hashes per cold load of the
thirty-message room, 35,254 of a deep-frozen root and 72,337 of a mutable
one, and found that after its change the per-hash cost, not the walks,
was most of the 12 to 13% of busy samples under `hashOfInternal`. It left
"fewer hashes" as the next lever, and named the mutable roots as where they
were. This record counts the mutable-root hashes by the site that asked for
them, says which were repeats, and reports what four cuts did.

## Setup

- The server: the toolshed binary a sibling session built from `main` with
  `EXPERIMENTAL_SERVER_EXECUTION=false` baked in, over a copy of its store,
  which already held the seeded room, on a port no other session held. Every
  change here is worker-side, so the server did not change between arms.
- The room: `packages/patterns/integration/fabrichat-room-seed.ts`, twelve
  members, thirty messages, one thread of five replies, a reaction every
  third message.
- The client: the throwaway harness of the cold-load records, opening a
  headless browser against a dev shell served from a checkout
  (`deno task dev-local` in `packages/shell`), signing in as the room's
  starter, attaching the worker profiler, and waiting for the last message
  and every member's badge. It writes the worker's CPU profile, the load
  summary and the worker's logger counts. Every load below is the room's
  second or later against that store.
- The counter: a temporary logger row in
  `packages/data-model/src/value-hash/impl.ts`, at the one place a hash of
  an object the frozen-object cache did not hold is computed, carrying the
  six innermost frames above the hashing functions, whether the object had
  been hashed before, and whether its hash string had. The SES lockdown's
  `errorTaming: "safe"` blanks stack traces in the worker, so the counting
  loads ran it as `"unsafe"`. The rows crossed the worker boundary as logger
  counts.
- The arms: `main` at `358f96b64b` as before, and the same with the four
  changes below, each served from its own checkout on its own port against
  the one toolshed, loaded in two interleaved pairs (before, after, before,
  after).
- The machine: an M3 Max with sixteen cores, at a one-minute load of 20 to
  400 from other sessions' work throughout. Wall times and profile samples
  are noise at that load; the counts are the evidence.

## The count by site

76,966 hashes of a mutable root per load, 74,528 of a plain object and
2,438 of an array. 59,136 (77%) were of an object never hashed before whose
hash string had been returned already in the load; 2,658 were of an object
hashed before; 15,172 were the first hash of their content.

| Site (innermost frame above the hashing functions)    | Hashes | Content seen before |
| ----------------------------------------------------- | -----: | ------------------: |
| `createRef` (a derived internal cell's id)            | 27,253 |              24,799 |
| `selectorIdentity` (a watch entry's selector)         | 12,218 |              11,693 |
| `watchIdForEntry` (a watch entry's id)                | 12,218 |               6,172 |
| `#collectLinkedCellSyncs` (the walk's memo key)       |  9,239 |               9,239 |
| `valueEqual` (write gates)                            |  3,353 |               2,994 |
| `dataURISyncKey`                                      |  2,338 |                 799 |
| `dedupeByValueEqual` (schema generator)               |  2,207 |               2,011 |
| `generateKey` (the render's child keys)               |  1,922 |                  45 |
| `#mergePrimitiveSchemaIntoAnyOf` (schema generator)   |  1,631 |               1,579 |
| `#viewRefHash`                                        |  1,440 |                 633 |
| an `anyOf` member re-hashed per merge (schema generator) |  1,182 |               1,182 |
| `schedulerActionInstanceKey`                          |    939 |                   0 |
| `#mergeIdenticalSchemas` (schema generator)           |    379 |                 378 |
| `definitionEquivalenceClasses`                        |    246 |                 123 |
| `hashSchema`                                          |    150 |                  26 |
| `computeModuleHashes`                                 |    116 |                  77 |
| a module's pattern factory (`factoryFromPattern`)     |    112 |                  44 |
| the rest                                              |     23 |                   — |

The rows sum to the total. 888 of the `createRef` row are `getMetaCell`
minting a meta cell's id from a fresh `{ type, parent }`, every one a
repeat.

The `createRef` row counts the ids `DerivedInternalCellIds.idFor()` minted.
A second probe in that method sorted its 44,000 calls per load by the
partial cause it was given: 17,760 strings and 3,137 deep-frozen objects,
which it keeps ids for, and 23,956 mutable objects, which it did not:
11,790 of the shape `{ stream: … }`, 7,290 `{ $generated: N }` and 4,860
`{ $generated: N, $kind: "stream" }`, the causes the builder mints when a
pattern module is evaluated. Every action node's instantiation lists its
pattern's derived cells for its scheduler summary, so each of those causes
was hashed once per action node.

A probe in the linked-cell sync walk found that of its 18,174 memo lookups
per load, none hit: 9,239 under a schema that was not deep-frozen, 7,905
under a frozen one, 1,030 under none.

## The four cuts

- **A derived internal cell's id is kept for a mutable JSON cause**
  (`packages/runner/src/derived-internal-cell-ids.ts`). The id is a hash of
  the result cell's entity and the partial cause, and the memo keyed a cause
  by value only for a primitive and by identity only for a deep-frozen
  object. A mutable object or array made of JSON values is now keyed by its
  content, serialized to follow exactly what `createRef()` reads: `-0` and
  `NaN` kept apart from what `JSON.stringify()` makes of them, a hole apart
  from an `undefined`, and an object reached a second time within one cause
  keyed as the `null` it derives as. A cause holding a cell, a reactive, a
  query result, a function, a class instance or a link is hashed on every
  call, as before.
- **A watch id is hashed once per distinct entry**
  (`packages/runner/src/storage/v2-watch.ts`). `watchIdForEntry()` and
  `selectorIdentity()` keep the ids they hashed most recently, keyed by
  `JSON.stringify()` of the strings they hash, which tells two entries apart
  exactly where their hashes would.
- **The linked-cell sync walk interns a schema that is not deep-frozen
  before descending it** (`packages/runner/src/storage/v2.ts`). The walk's
  memo key holds the schema's hash and each child's schema is derived from
  its parent's; a mutable schema missed the derivation cache, so every
  record descended got a fresh schema and hashed it. Interned, the schema
  is hashed once, its derivations come from the derivation cache interned,
  and their hashes are cached by identity.
- **A write's equal-value gate walks the two values in step**
  (`packages/runner/src/storage/v2-transaction.ts`, `runner.ts`,
  `pattern-binding.ts`). The gate that elides a write of a value equal to
  the stored one, the check of whether a pattern's result changed, the match
  of a candidate instance's argument, the match of a manifest entry's link,
  and the check of whether a builtin's output link is already in place
  compared with `valueEqual()`, which hashes each operand whole. They now use `valueEqualByWalk()`, which settles a
  shared subtree by identity and stops at the first difference.

Each cut has a test that counts hashes or mints and fails on the code before
it: `derived-internal-cell-ids.test.ts`, `v2-watch.test.ts`,
`collect-linked-cell-syncs.test.ts`, and the write gate's case in
`v2-transaction.test.ts`, all under `packages/runner/test/`.

## Numbers

Two counting loads, one per arm, each the room's second or later load
against the store. The before load compiled a pattern source on the way
(the schema generator's 5,600 hashes); the after load did not, which is the
compile cache's doing and not these changes', so those rows are left out of
the comparison.

| Site                               | Before | After |
| ---------------------------------- | -----: | ----: |
| `createRef` (derived internal cell ids) | 27,253 | 3,778 |
| `selectorIdentity`                 | 12,218 |   519 |
| `watchIdForEntry`                  | 12,218 | 5,997 |
| `#collectLinkedCellSyncs`          |  9,239 |     0 |
| `valueEqual`                       |  3,353 |   917 |
| `dataURISyncKey`                   |  2,338 | 2,338 |
| `generateKey`                      |  1,922 | 1,922 |
| `#viewRefHash`                     |  1,440 | 1,312 |
| `schedulerActionInstanceKey`       |    939 |   939 |
| `definitionEquivalenceClasses`     |    246 |   246 |
| `hashSchema`                       |    150 |   148 |
| a module's pattern factory         |    112 |   112 |
| `#viewKey`                         |      0 |    72 |
| the rest                           |     23 |    23 |
| every site but the schema generator's | 71,451 | 18,323 |

The schema generator's rows left out are `dedupeByValueEqual`,
`#mergePrimitiveSchemaIntoAnyOf`, the `anyOf` member re-hashed per merge,
`#mergeIdenticalSchemas` and `computeModuleHashes`, 5,515 in the before
load and none in the after load.

Of the 18,323 that remain, 14,446 (79%) are the first hash of their content
in the load; before, 15,172 were. What the cuts removed is the repeats. The
5,997 watch ids are one per distinct entry the load pulls or refreshes;
the 3,778 derived ids are 2,414 first hashes, the 888 meta-cell ids, and
476 repeats of a child result cell's id minted through `getCell`.
The 917 under `valueEqual` are 857 at one site, the match of a stored
manifest entry's link against an expected one under
`#prepareCellsForRunningPattern`, which hashed the expected link once per
entry compared. That site was switched to the walk after the counting load,
so no count after it is recorded here.

Two interleaved profile pairs, at a one-minute load of 440 to 560 from
other sessions' work (other sessions ran their test suites throughout, so
the sample counts below carry that noise; the counts are identical across
the four loads: 1,663 child syncs, 285 cell syncs, 190 native commits, 614
or 615 CFC preparations, 1,156 or 1,157 action runs, no conflicts, reverts
or rejections):

| Samples                       | before-1 | after-1 | before-2 | after-2 |
| ----------------------------- | -------: | ------: | -------: | ------: |
| busy                          |    7,747 |   7,118 |    6,329 |   5,651 |
| `hashOfInternal`              |      971 |     866 |      829 |     631 |
| of busy                       |    12.5% |   12.2% |    13.1% |   11.2% |
| under `hashStringOf`          |      385 |     210 |      303 |     175 |
| under `hashOf` (schema interning) |  574 |     640 |      516 |     444 |

The `hashStringOf` half, where the mutable roots were hashed, fell by
about two fifths in both pairs; the `hashOf` half, which is schema interning
by content, did not move, and is now two thirds to three quarters of the
hashing that remains. The share of busy moved by less than the noise
between the two before loads.

## Not cut, and why

- The schema generator's hashes (`dedupeByValueEqual`,
  `#mergePrimitiveSchemaIntoAnyOf`, `#mergeIdenticalSchemas`, and the
  `anyOf` member re-hashed for every member merged into it, 5,400 per load)
  come from compiling pattern sources in the worker; the merge re-hashes
  every `anyOf` member for each new one, so a union of N members costs N²
  hashes. That the load compiles at all, and the quadratic merge, are each
  a question of their own in `packages/schema-generator`.
- `generateKey` (1,922) and `schedulerActionInstanceKey` (939) hash content
  the load sees for the first time; a memo has nothing to return.
- `dataURISyncKey` (2,338, a third repeats) and `#viewRefHash` (1,440,
  under half repeats) hash small records whose parts include objects; a
  content key for them is the same work as the derived-id one and was left
  for a count that says it pays.
- `getMetaCell` (888) mints a meta cell's id from a fresh
  `{ type, parent }` on every call; a memo by result id and type is a small
  follow-up.

## Addendum: freezing at the source

The review of the pull request carrying this record (an agent working for
its reviewer, on an in-process reproduction of the cold load whose counts
track the record's: 74,242 mutable-root hashes against 76,966) asked
whether deep-freezing the values the count found mutable would serve the
identity caches instead. It found that two of the four sites are mutable
by accident:

- The builder's partial causes are frozen, since a compiled module's
  exports are hardened; what reaches `idFor()` are thawed copies made by
  `withAliasBindings()` in `builder/to-encodable-form.ts`, which rebuilds an
  embedded pattern graph record by record and re-freezes only its two
  schemas. The 24,810 mutable-cause calls per load carry 29 distinct
  objects. Deep-freezing the rebuilt manifest of derived internal cells
  beside the schemas cuts the mints to 2,035, the same as the content key,
  and leaves no mutable cause reaching `idFor()` on that load.
- Every mutable schema the linked-cell sync walk hashed was a fresh `{}`
  from `getSchemaAtPath()` in `cfc.ts`, which made a new one for every
  position a `true` schema admits. Returning one interned instance cuts the
  walk's mutable hashes to zero and spares the 1,182 first hashes the
  walk's interning of those objects cost.

Watch ids and the write gates are not helped by freezing: the watch
functions hash records they build themselves, and a write gate's operands
are close to single-use (4,342 first hashes of frozen operands per load,
none reused). The reproduction's totals, three alternating runs per arm:

| Arm           | Mutable-root hashes | All hashes | Cold load, median of per-run averages |
| ------------- | ------------------: | ---------: | ------------------------------------: |
| base          |              74,242 |     97,571 |                              4,920 ms |
| freeze alone  |              39,901 |     63,218 |                              4,474 ms |
| the four cuts |              14,761 |     35,229 |                              4,390 ms |
| cuts + freeze |              14,761 |     34,047 |                              4,275 ms |

Both freezes landed in the same pull request. The content key and the
walk's interning stay as the fallback for a cause or a schema that arrives
mutable by another route: across the runner, piece and pattern-test suites,
137,434 mutable causes reached `idFor()` before the freeze, every one plain
JSON, and only the reproduction's load was counted with the freeze in
place.

## Rig

The rig, the counter patches and the profiles are in the session's
scratchpad, recorded in the shared notes folder of the session group.
