---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Counts per caller and profile shares of schema interning on a fabrichat room's reload before and after six derivations began keeping the schema they derive per schema they derive it from, October 2026."
---

# What interning a schema hashes on a fabrichat room's reload, October 2026

`internSchema()` returns the canonical instance of a schema's content. For an
object it has been given before, that is one `WeakMap` read. For any other
object it deep-freezes the schema and hashes all of it, whether or not the
content is already interned. This records how many of the calls a room's
reload makes were of an object it had not been given before, which callers
made them and what the objects were, and what changed when six derivations
stopped building a schema per call.

## Setup

- The server: a local toolshed at a port offset, `serverExecution` off, its
  store holding a room of thirty messages and twelve members.
- The client: a Deno `cf piece render` of the room through
  `skills/perf-investigation/scripts/profile-cf.ts`.
- The code: for the base arm, `main` at `676e4cae1b` with the change that
  made a pattern hold its schemas deep-frozen merged in
  ([`2026-10-13-pattern-schema-narrowing.md`](2026-10-13-pattern-schema-narrowing.md));
  for the new arm, that with this change.
- The machine ran at a one-minute load of 200 to 355 throughout, from other
  sessions. A profiled render took between two and a half and twelve
  minutes, and a counting render up to an hour. So nothing here is a wall
  time. The counts are exact. The shares are of the samples a V8 profile
  took outside `(idle)`, compared between two renders started together, one
  per arm, with the arm that started first alternating.

The calls were counted with a temporary counter in
`internSchemaReturningSchemaAndHash()`, for every call given an object. It
recorded the caller, as the four innermost frames above the interning
functions; whether the object was in the identity cache; on a miss, whether
the object arrived deep-frozen, was frozen in place, or was cloned, and
whether its content was already interned; the distinct objects and the
distinct contents each caller passed; and the length of the missed schema's
JSON, as the measure of what the miss hashed. The lockdown blanks
`Error.stack`, so the counting renders ran with its error taming relaxed. A
second temporary counter in `Runner.#cellsNodePlanReads` recorded the state
of each plan's module schema.

Every render of either arm, counting or profiled, wrote the same 232,190
bytes of HTML.

## What the base reload interned

A reload called `internSchema()` with an object 1,253,168 times. 86,407 of
those calls missed the identity cache, and hashed 150.3 million characters of
schema JSON between them. 83,445 of the misses were of content already
interned: the object was new and what it held was not. A second base render
missed 86,268 times.

Of the misses, 67,159 were of an object that was not deep-frozen, which is
what a schema just built is; 18,819 were of an object that was deep-frozen
already, which is what a schema read out of a document is; and 429 cloned
their input.

| caller | calls | misses | deep-frozen on arrival | distinct contents | JSON characters hashed |
| --- | ---: | ---: | ---: | ---: | ---: |
| `internCellLinkSchema` in `asSchema`, under `#cellsNodePlanReads` | 2,770 | 2,770 | 38 | 66 | 40.1 M |
| `internPathSelector` under `normalizeSyncSelector`, from `#syncLinkTarget` | 18,599 | 18,319 | 0 | 142 | 38.1 M |
| `internSchemaPairAsKey` in `combineSchemaForLink`, under `#collectLinkedCellSyncs` | 14,278 | 7,139 | 7,139 | 42 | 23.1 M |
| `resolveCfcSchemaRefs` under `_schemaHasIfcUncached` | 3,133 | 2,807 | 859 | | 9.4 M |
| `resolveCfcSchemaRefs` and `joinSchema`, under `joinSchema` | 20,433 | 2,186 | 1,256 | | 5.1 M |
| `resolveCfcSchemaRefs` under `collectCfcSchemaEntries` | 398 | 358 | 14 | 238 | 4.3 M |
| `internSchemaPairAsKey` in `mergeSchemaFlags`, under `combineSchemaForLink` | 8,302 | 3,585 | 1,899 | 10 | 4.2 M |
| `pruneCfcSchemaDefinitions` under `normalizeSyncSelector` | 1,124 | 1,124 | 0 | | 3.2 M |
| `foldDeclaredScopeIntoLinkSchema` | 420 | 420 | 0 | 1 | 1.8 M |
| `internPathSelector` under `externalizeSyncSelector` | 22,886 | 22,853 | 0 | | 1.5 M |
| `externalizeSchema` under `externalizeLinkSchema` | 15,610 | 5,847 | 105 | | 1.4 M |
| the link-resolution exit in `resolveLinkTracingDereferences` | 82,153 | 3,393 | 3,391 | | 0.4 M |
| `schemaAtPath` under `resolveLinkTracingDereferences` | 426 | 426 | 0 | 8 | 0.06 M |

A distinct-contents cell is empty where the row adds up several callers.
The first four rows and the tenth are 53,888 of the misses and 112 million
of the characters.

## What each caller was handing over

- **`asSchema` under `#cellsNodePlanReads`.** A handler node's inputs are
  synced under its argument schema with the `$event` slot declared a stream,
  and `schemaWithEventSlotAsStream()` built that schema anew on each call. Of
  5,615 plan reads of a JavaScript module, 2,690 were of a handler and got a
  new object; the other 2,925 passed the module's own schema object, which
  is interned from its first read on. The handler schemas average 14.5
  thousand characters.
- **`internPathSelector` under `normalizeSyncSelector`.** Syncing a link's
  target asks for it under the reader's schema without its outermost handle
  boundary, and `selectorSchemaForLink()` returned a new object on each
  call, whether or not it removed a boundary. The definitions pass over a
  root that is not deep-frozen is not kept either, which is the eighth row.
- **`internSchemaPairAsKey` in `combineSchemaForLink`.** The call is made
  with the reader's schema and the link's. The 7,139 hits are the reader's
  half. The 7,139 misses are the link's: a plan's inputs document is a
  `data:` URI, each decoding of one holds the schemas of its links as objects
  of its own, and all 7,139 crossings took the arm where a reader with a
  shape of its own crosses a link whose schema declares a `default`. That arm
  uses the link schema for its `default` and nothing else.
- **`resolveCfcSchemaRefs` under `_schemaHasIfcUncached`.** Link resolution
  asks `schemaHasIfc()` about the stored schema of each hop it crosses. The
  verdict is kept by the schema's identity, so each document's copy of a
  link schema was judged afresh, and judging one resolves the references it
  holds, each resolution building a schema that is then interned.
- **`internPathSelector` under `externalizeSyncSelector`.** A selector whose
  closure the space persists goes out as `{ "$ref": … }`, built per call.
  The misses are small, 64 characters each on average, and there are more of
  them than of any other row: 14,877 from `syncCell`, for 58 references, and
  7,976 from `#syncLinkTarget`, for 38.
- **`foldDeclaredScopeIntoLinkSchema`.** One schema, with one scope folded
  into it, cloned and hashed 420 times.
- **`internSchemaPairAsKey` under `mergeSchemaFlags`.** A reader with no
  shape of its own takes the link's schema, so the canonical instance of
  the link's schema is the result. 1,899 misses are link schemas out of
  decoded documents; 1,686 are an empty reader schema built per call, two
  characters each.

## Whether module schemas are copies per node

They are not. The 5,615 plan reads of a JavaScript module reached 133 module
objects, each holding an argument schema object of its own, so the rows of a
room share their modules. 80 of the 133 schema objects were not deep-frozen
when a plan first read them, and 53 were deep-frozen and not interned.

The 80 are the handler schemas, and on the base arm they stayed that way
through the pre-sync: 2,702 plan reads found the module's schema not
deep-frozen. Interning the schema built for the `$event` slot froze the
members it shares with the module's schema and left the module's root as it
was.

## What changed

Six derivations keep what they derive.

- `schemaWithEventSlotAsStream()` keeps its result per handler schema, which
  it interns as a cell would, freezing it in place.
- `selectorSchemaForLink()` keeps its result per deep-frozen reader schema.
- `externalizeSyncSelector()` keeps the reference and the inline form of a
  selector per decomposition.
- `foldDeclaredScopeIntoLinkSchema()` keeps the folded schema per emitted
  schema and scope.
- `combineSchemaForLink()` keys the schema a shaped reader inherits a
  default into by the reader's schema and the default.
- `schemaHasIfc()` judges a deep-frozen schema as the interned instance of
  its content.

None of them puts one schema object at two positions of a pattern graph. The
twenty-three ids the earlier record derived from ten built patterns are the
same on both arms.

A reload on the new arm made 1,285,536 calls, of which 35,101 missed and
hashed 45.1 million characters.

| caller | base: misses | base: characters | new: misses | new: characters |
| --- | ---: | ---: | ---: | ---: |
| `asSchema` and `schemaWithEventSlotAsStream`, under `#cellsNodePlanReads` | 2,770 | 40.1 M | 186 | 1.7 M |
| `internPathSelector` under `normalizeSyncSelector`, from `#syncLinkTarget` | 18,319 | 38.1 M | 0 | 0 |
| `selectorSchemaForLink`, interning the reader schema it is given | | | 1,331 | 2.7 M |
| `pruneCfcSchemaDefinitions` under `normalizeSyncSelector` | 1,124 | 3.2 M | 361 | 1.1 M |
| `combineSchemaForLink` under `#collectLinkedCellSyncs` | 7,139 | 23.1 M | 0 | 0 |
| `internPathSelector` under `externalizeSyncSelector` | 22,853 | 1.5 M | 0 | 0 |
| `foldDeclaredScopeIntoLinkSchema` | 420 | 1.8 M | 1 | 4,353 |
| `resolveCfcSchemaRefs` under `_schemaHasIfcUncached` | 2,807 | 9.4 M | 391 | 1.8 M |
| `schemaHasIfc`, interning the schema it is given | | | 4,580 | 5.2 M |
| the link-resolution exit in `resolveLinkTracingDereferences` | 3,393 | 0.4 M | 851 | 0.1 M |
| `internSchemaPairAsKey` in `mergeSchemaFlags`, under `combineSchemaForLink` | 3,585 | 4.2 M | 3,372 | 4.2 M |

The 2,690 handler plan reads were given twelve read schema objects between
them.

The change to `schemaHasIfc()` moves a hash more than it removes one. It
interns each link schema it is given, 4,580 of which nothing had interned,
where the base arm interned what each of them resolved to. 2,542 of those
4,580 the link-resolution exit would have interned next. Counted together,
the resolutions, the schemas `schemaHasIfc()` interns, that exit and
`mergeSchemaFlags` miss 591 times fewer and hash 2.7 million characters
fewer than on the base arm.

## The profiles

Four pairs of renders, each pair started together. Each cell is the
inclusive time of the function over the profile's samples outside `(idle)`,
as a share of those samples.

| pair | arm | samples outside `(idle)`, s | `internSchema` | `internPathSelector` | `#cellsNodePlanReads` | `internSchemaPairAsKey` | `schemaHasIfc` | `resolveCfcSchemaRefs` | `hashOf` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | base | 132.9 | 9.11% | 3.11% | 2.10% | 2.27% | 0.80% | 0.98% | 10.51% |
| 1 | new | 125.8 | 2.88% | 0.38% | 0.49% | 0.42% | 0.65% | 0.60% | 5.03% |
| 2 | base | 305.3 | 8.73% | 2.58% | 2.73% | 1.59% | 0.99% | 1.35% | 9.83% |
| 2 | new | 277.3 | 3.73% | 0.26% | 0.73% | 0.43% | 0.75% | 0.82% | 5.99% |
| 3 | base | 655.3 | 7.65% | 2.75% | 2.13% | 1.24% | 0.88% | 1.25% | 9.18% |
| 3 | new | 589.5 | 4.77% | 0.30% | 0.71% | 0.27% | 0.89% | 0.74% | 5.67% |
| 4 | base | 279.6 | 5.66% | 1.71% | 1.64% | 0.97% | 0.83% | 1.16% | 8.06% |
| 4 | new | 263.9 | 2.78% | 0.21% | 0.44% | 0.09% | 0.70% | 0.58% | 4.74% |

The third pair ran at a load of 355. Its new arm puts 9.8 seconds of
interning under two callers, `extractDefaultValuesInternal` and
`#resolveCellPropsBindingTarget`, which carry at most half a second between
them in each of the other seven profiles, and which miss 1,597 and 235
times on either arm, hashing 246 thousand characters in all. That is a stall
landing on whatever frame was running. Without those samples the arm's share
is 3.1%.

The samples outside `(idle)` are wall seconds of a process sharing its
cores, and are given for the direction they agree on.

## What the reload still interns

35,101 misses and 45.1 million characters.

- 13,749 of the misses are of a deep-frozen object, and most of those are a
  link schema read out of a document: 4,580 at `schemaHasIfc`, 1,686 under
  `mergeSchemaFlags`, 1,227 at `selectorSchemaForLink`. A plan's inputs
  document is a `data:` URI, decoded apart from the value it was minted
  from, once for its sync (`valueFromDataUri` under `#syncDataURICell`) and
  again for its reads, so each decoding holds new objects. That decoding is
  4.1 to 7.5% of the samples in the eight profiles above, and minting the
  documents (`dataUriFromValue`) 5.8 to 7.6%.
- 5,839 are link serialization (`externalizeSchema` under
  `externalizeLinkSchema`), which interns the stripped schema it builds and
  then a `{ "$ref": … }` it builds per call: 1.3 million characters.
- 2,186 are under `joinSchema`, at 5.1 million characters, and 358 under
  `collectCfcSchemaEntries`, at 4.3 million. Both are a first sight of the
  object passed: each has as many distinct objects as misses.
- `schemaAtPath` under `resolveLinkTracingDereferences` narrows each stored
  link schema as its own object, 426 times for eight contents, and hashes
  64 thousand characters in all.
