---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Counts per caller of the schema-reference resolutions a thirty-message FabriChat room's cold load made without consulting the resolver's memo, October 2026, before and after a path narrowing began resolving against one kept document per definition map and a fragment's inherited-definitions view was frozen: 2,944 fell to 684, and the 2,086 under the narrowing were the document minted on the spot for every reference it followed, not the view."
---

# What a narrowing resolved its references against on a FabriChat room's cold load, October 2026

The join-memo record
([`2026-10-16-fabrichat-render-schema-join-memo.md`](2026-10-16-fabrichat-render-schema-join-memo.md))
left 2,086 `resolveCfcSchemaRefs()` calls per cold load of a thirty-message
room that never consulted the resolver's pair memo, all of them under
`schemaAtPath()` narrowing a path through a `$ref`, and read them as
resolutions rooted at the view `cfcSchemaWithInheritedDefs()` mints, which
is memoized per fragment and map but was never frozen. This record is the
count that settles what the root was, and the count after both the view and
the narrowing's root were made cacheable.

## Setup

The join-memo record's rig, unchanged: the same toolshed binary over a copy
of the same seeded store, the same thirty-message, twelve-member room, a dev
shell served from this tree, and the same throwaway harness opening a
headless browser, signing in as the room's starter, and waiting for the last
message and every member's badge. The counter was a temporary one in
`resolveCfcSchemaRefs()` recording, for every call, whether the pair memo
was consulted, hit or missed, and when it was not consulted, which of the
two arguments was not deep-frozen and the four innermost frames above the
resolver. The worker's SES lockdown blanks `Error.stack`, so the counting
loads ran with its error taming relaxed. The counts are exact and the same
between loads of one arm; the machine ran at a one-minute load of 170 to
320 from other sessions' work, so nothing here is timed.

## What the root was

`#schemaAtPathInternal()` followed every `$ref` it reached by resolving the
cursor against a document it minted on the spot, `{ $defs: defs }`. The
resolver's memo is keyed on the root it is given, and a fresh object is
never a key, so every narrowing through a reference resolved it again:
2,086 times per load, 1,168 of them from `schemaAtPath()` directly and 918
from `#narrowUnion()` narrowing a union's arms, with the cursor itself
deep-frozen in every one. The inherited-definitions view was not that root.
It was the schema side of a smaller set: 171 resolutions under
`resolveSchema()` whose schema was the unfrozen view of a union branch
(`narrowUnionByValueType`, `asCellCompoundCandidates`, `readsAsHandle`),
and 3 under `asCellFollowScopeCap()` whose root was one.

| caller of the uncacheable resolution | before | after |
| --- | ---: | ---: |
| `#schemaAtPathInternal`, cursor deep-frozen, root minted | 2,086 | 0 |
| `#schemaAtPathInternal`, cursor an unfrozen type-list arm | 129 | 129 |
| `resolveRootRefForScope` under `getSchemaScopeCap`, schema mutable | 247 | 247 |
| `resolveRootRefForScope` under `asCellFollowScopeCap`, schema mutable | 300 | 300 |
| `resolveRootRefForScope` under `declaredSchemaScope`, schema mutable | 8 | 8 |
| `resolveSchema` under `narrowUnionByValueType`, schema an unfrozen view | 159 | 0 |
| `resolveSchema` under `asCellCompoundCandidates`, schema an unfrozen view | 9 | 0 |
| `resolveRootRefForStructure` under `readsAsHandle`, schema an unfrozen view | 3 | 0 |
| `resolveRootRefForScope` under `asCellFollowScopeCap`, root an unfrozen view | 3 | 0 |
| total | 2,944 | 684 |

| per load | before | after |
| --- | ---: | ---: |
| pair memo consulted | 121,467 | 123,726 |
| of which hit | 115,607 | 117,564 |
| of which missed | 5,860 | 6,162 |
| pair memo not consulted | 2,944 | 684 |

The 2,259 resolutions the change moved into the memo are 1,957 hits and
302 misses, 296 of the misses the first resolution of each reference a
narrowing follows against its map; the after load made one resolution
fewer in all, 124,410 against 124,411. Two of the three after loads agree on
every figure. The first consulted the memo 155,914 times with the same 684
not consulted, and took 70 s rather than 40 s to render; a sibling
investigation's loads of the same room ran against this rig's shell and
store during those minutes, so that load is not one of this record's
figures. What a concurrent load changes is how many times the render asks,
not what the resolver can keep.

## What changed

- `cfcSchemaDocumentOf()` in `packages/runner/src/cfc/schema-refs.ts`
  returns the document whose `$defs` is a given map: one deep-frozen
  document kept per deep-frozen map, one shared empty document for no map,
  and a fresh one for a map that is not deep-frozen, which is never a memo
  key. `#schemaAtPathInternal()` resolves the references it follows against
  it.
- `cfcSchemaWithInheritedDefs()` deep-freezes the view it memoizes when the
  map is deep-frozen as well as the fragment. The view's parts are then all
  frozen, so freezing costs the root object alone.

`packages/runner/test/cfc/schema-refs.test.ts` pins both: the view of a
deep-frozen fragment and map is deep-frozen and the same instance each
time, and a reference resolved against it resolves to the same instance
twice; the document of a deep-frozen map is deep-frozen and kept, the
document of no map is shared, a reference resolved against it resolves to
the same instance twice, and a narrowing through a `$ref` reads its
definition through that document.

## What is left

- 129 resolutions per load under `#schemaAtPathInternal()` whose cursor is
  an arm `#narrowUnion()` mints for a type list, `{ ...cursor, type }`, and
  so is not frozen. Interning the arm would cost a content hash per
  narrowing; keeping the arms per frozen union would not.
- 555 under `resolveRootRefForScope()` whose schema is mutable: the scope
  readers are asked of positions whose schema arrives unfrozen, which is a
  question about the callers, not the resolver.
