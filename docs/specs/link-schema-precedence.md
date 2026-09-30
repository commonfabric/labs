# Link-Schema Precedence

What decides the schema a read continues with when it crosses a link. A
stored link may carry a schema describing its target, and that description
routinely covers more than the reader asked for — the classic case is a
reader selecting `{ name }` from a Contact whose link schema names and
requires both `name` and `phoneNumber`. The reader's schema takes
precedence: nothing the link declares can widen what the read loads,
demand more than the reader requires, or reshape what the reader declared.

## Status

Shipped, on by default behind the `readerSchemaPrecedence` experimental
flag; the
[flag registry](../development/EXPERIMENTAL_OPTIONS.md#readerschemaprecedence)
carries the rollback, authority, and lifecycle detail.

## The rule

`combineSchemaForLink(parentSchema, linkSchema)` in
[`packages/runner/src/traverse.ts`](../../packages/runner/src/traverse.ts)
resolves every crossing. It is precedence, not intersection:

- A `false` reader schema stays `false`: the reader selected nothing, and
  the link cannot widen that.
- A true or empty reader schema (`true`, `{}`, or a flag-only wrapper such
  as `{ "asCell": ["cell"] }`) adopts the link schema under the reader's
  own `asCell` wrapper. This is what types a schemaless or handle-only
  read by the link it crossed — a piece typed by its own registration —
  and what lets a link's `false` schema attenuate an open read to nothing.
- Any other reader schema is used as it stands and the link schema is
  ignored — including a `false` link schema, which blocks only readers
  that brought no shape of their own.

`{ "type": "unknown" }` is a shaped reader, not an empty one: it is the
deliberate request for reference semantics, so at a hop it wins the
crossing and stays opaque through every deeper hop. At the read's entry
it adopts the stored schema instead; see "The read entry" below.

For the Contact example, a reader of

```json
{
  "type": "object",
  "properties": { "name": { "type": "string" } },
  "required": ["name"]
}
```

crossing a link that names and requires both `name` and `phoneNumber`
continues with exactly the reader's schema: `phoneNumber` is neither
loaded, tracked, nor required, and a target that satisfies the reader
reads successfully whatever else the link demands.

Chains compose hop by hop: `combine(combine(reader, link1), link2)`. Once
a shaped schema is traveling — the reader's own, or a link schema an
agnostic reader adopted — later links no longer reshape it.

### The read entry

A read addressed at a slot that holds a link — a keyed cell's `get()`, a
handle minted by `resolveAsCell()` — crosses that link before its
traversal starts, and that crossing follows link resolution's rule rather
than the combine above: a stored schema that constrains replaces the
schema the reader carried in, one that constrains nothing (`true`, `{}`,
or a `cid:` reference resolving to either) leaves the reader's traveling,
and a stored `false` selects nothing. The traversal then starts at the
target with whichever schema won. A reader wrapped in `asCell` is not
addressed at the slot this way: its handle is minted at the traversal
boundary, where the crossing is a hop and combines, so the handle keeps
the reader's own schema (the asCell handle arm in
`stored-link-schema-precedence.test.ts`).

So the two ways of reaching one element answer differently when its link
carries a constraining schema: read by its own path, the element projects
by the stored schema; read within its array, the array's traversal crosses
the same link under the reader's item schema and the element projects by
the reader's. `{ "type": "unknown" }` follows the same split in both
directions — a reader typed `unknown` adopts the stored schema at the
entry, and a stored `unknown` keeps a shaped reader's read by path a
reference while the same reader reads through it within the array (no
`set()` mints such a link: a cell written into a slot carries its own
schema, never the slot's). A lazy view's re-entry at a link slot is a
hop, not an entry, and combines. One policy for the entry and the hops is
not stated here yet; the pins in `stored-link-schema-precedence.test.ts`
record both answers as they stand.

A link into another space carries its stored schema across the boundary
recomposed into a self-contained form, its `cid:` closure loaded from the
space that holds the link
([`content-addressed-schemas.md`](content-addressed-schemas.md), "Space
boundaries"), and the entry projects by it the same way.

The strict pseudo-intersection (`combineSchema`) remains in use for one
job: merging a compound schema's base keywords with its own
`anyOf`/`oneOf` branches, where both parts were authored as one
constraint. [`json_schema.md`](json_schema.md#combining-schemas) states
both operations' keyword-level behavior.

## Defaults inherit from the last declaration

`default` is the one keyword that crosses the precedence line: a value's
default is inherited from the last crossed schema that declares one. Each
hop's stored schema describes that hop's target, so the nearest
declaration is the aptest — a link's top-level `default` overrides earlier
links' and the reader's own, and where no link declares one the reader's
stands (a default-only reader's included, though `{ "default": … }` is
otherwise a true schema). A default-only STORED schema contributes the
same way: trivially true for shape, its default is still the nearest
declaration, and the resolution carry inherits it onto the traveling
schema rather than discarding it with the shape it does not have. Path
narrowing surfaces a link's nested property defaults as top-level at the
positions where deeper reads combine, so the rule composes per position
across a chain.

The rule changes what the combined schema carries; where defaults are
*applied* is unchanged (the cell read path applies them, the raw query
traverser applies them only in its existing spots).

## Flow control does not combine

A discarded link schema's `ifc` never rides onto the combined schema.
Write policy consumes declared schemas verbatim
(`recordSchemaWritePolicyInput`), so a flow-control clause transplanted
onto a reader's schema — an `ownerPrincipal` grafted where nobody authored
it — reads as a different declaration and corrupts identity-sensitive
machinery such as verified-binding correspondence. Enforcement reads
stored cfc metadata and label views rather than combined schemas.

What replaces combination is the **crossing seam**
(`markIfcBearingLinkCrossing` in
[`packages/runner/src/schema-ifc.ts`](../../packages/runner/src/schema-ifc.ts)):
a transaction is marked cfc-relevant at every actual link crossing whose
stored schema carries `ifc` anywhere (`schemaHasIfc`), independently of
which side won the combination.

### Where crossings mark

- The read entry point (`validateAndTransform`) gates off the
  write-redirect resolution's schema and the full value resolution's.
- Link resolution records every hop's schema **as stored** — an ancestor
  hop's narrowing can reduce the traveling schema to nothing while the
  declaration stands — keyed by the hop's **source space**, where the
  stored link and its schema's closure documents live. The memoized
  resolution record replays the marking per call, and evaluation happens
  at mark time, so no stale verdict is baked into the record.
- The traversal marks each pointer it follows (`followPointer`, after
  external schema-document registration) and the extra handle hop of an
  `asCell` crossing — `getNextCellLink`, its schema.ts twin at the root
  `asCell` mint in `validateAndTransform`, and the array walk's own
  element hop, each of which dereferences a link without going through
  `followPointer`.
- Content-reading resolvers opt in (`markIfcCrossings`): the entry
  resolutions, schema-less query-result proxy accesses,
  `getRaw`/`getRawUntyped` (which resolve links on the way to the
  target), `resolveAsCell`, the read halves of the mergeable-op mutators,
  and the candidate comparisons of `addUnique`/`removeByValue`.
- `set()`'s pre-write resolution opts in too: the stream check reads the
  resolved terminal value, which makes that resolution a content read
  like any other. A transaction the crossing marks relevant is prepared
  before it commits, by `commit()` itself where nothing prepared it
  earlier (see [CFC commit preparation](cfc-commit-preparation.md)), so a
  hand-rolled `edit()`/`commit()` that sets through an ifc-bearing
  crossing is judged the same way a runtime-owned commit path is.
  Relevance for the write itself still belongs to the write-policy gate
  (`recordRelevantSchemaWritePolicyInput`).

### Closure loading at the seam

A stored schema's external `cid:` refs are resolvable before anything
walks them: `ensureExternalSchemaClosure` loads and registers the closure
transaction-level. The schema-document registry is realm-global and
content-addressed — a hash registered from any space serves every space's
check without a read, soundly, since equal hashes name equal bytes. Only a
document the registry does not hold is read, in the referrer space, where
it lives: closure documents travel WITH the documents that refer to them,
so a well-formed declaration always resolves from the local store, and the
loading is registry warming, never a wait for delivery.

A ref the closure cannot resolve therefore names a corrupt runtime or a
deliberately malformed written schema. Such a declaration is logged and
SELECTS NOTHING — it never shapes a read and never throws out of one:
the traversal narrows a broken declaration to `false`, which a reader
with a shape of its own ignores under precedence while an agnostic
reader adopts it and reads nothing through the crossing; link resolution
skips narrowing it rather than throwing on the dangling ref; and the
seams still mark whatever the schema legibly declares (`schemaHasIfc`
walks what resolves).

Link resolution narrows a stored schema across an ancestor hop (a read
that descends past the link's position), and that walk resolves `$ref`s
too — it runs the same registry warming first, from the hop's source
space.

## The flag

`readerSchemaPrecedence` is server-authoritative: the server's traversal
decides what a subscription loads, tracks, and ships, so every realm must
resolve hops under one combine rule. A server publishes its resolved
posture at `/api/meta` and deployed CLIs adopt it, with an explicit
`EXPERIMENTAL_READER_SCHEMA_PRECEDENCE` as the per-process override; the
browser shell bakes the flag at build time, so a browser rollback ships
with a redeploy. A fetched posture that declares nothing for the flag
predates it and adopts as the legacy strict `false`; an explicit
`experimental: null` (no Runtime yet) and an unreachable server adopt
nothing. The rollback is plain ambient last-construction-wins state:
each Runtime construction sets it, and dispose deliberately does not
reset it — serving runtimes are per-space and idle-disposed, so a
teardown reset would lift a rollback out from under the survivors.
Successive runtimes in one test process still get differing flag states,
because every construction sets. The
[registry section](../development/EXPERIMENTAL_OPTIONS.md#readerschemaprecedence)
is the authority on the lifecycle and the removal path.

## Test anchors

`packages/runner/test/combine-schema.test.ts` pins each precedence arm,
the strict-union contrast, the default-inheritance arms, and the rollback
arm. `packages/runner/test/link-ifc-read-relevance.test.ts` pins the
crossing seam: entry, nested, resolution-chain, handle-hop, cold-closure,
cold-closure narrowing, narrowed-away-ancestor, proxy, raw-read,
`set()`-resolution, array-element, and root-asCell-mint marking, plus the
broken-declaration rule (an unresolvable stored schema selects nothing —
a shaped reader reads on, and what it legibly declares still marks).
`packages/runner/test/schema-ifc.test.ts` pins the closure loader's
broken-declaration arms.
`packages/runner/test/stored-link-schema-precedence.test.ts` pins the
cell-level reads — the entry rule (by path against within the array, a
stored `false`, both `unknown` directions, a link into another space), the
asCell handle regression, and the inherited default.
`packages/runner/test/cross-space-cid-schema.test.ts` pins the crossing's
recomposition route by route, and
`packages/patterns/collection-naming/board.test.tsx` pins a lift's view
holding a `Record<string, unknown>` map's members as references.
`packages/runner/test/reader-schema-precedence-config.test.ts`
and the ambient-flag family in
`packages/runner/test/experimental-options.test.ts` pin the
construction-set ambient lifecycle (no teardown reset);
`packages/runner/test/runtime-presets.test.ts` pins adoption and the
legacy-absent rule. The traverse-replay goldens carry the
serving-behavior consequences.

## Related documents

- [Schema Narrowing, Memory v2 queries](memory-v2/05-queries.md#534-schema-narrowing)
  — the combination and relevance rules in the query pipeline's context.
- [JSON Schema](json_schema.md#combining-schemas) — keyword-level behavior
  of both combine operations.
- [Traversal](space-model/8-traversal.md) — where composition sits among
  the traversal's other divergences from strict JSON Schema.
- [Content-addressed schemas](content-addressed-schemas.md) — the schema
  documents the seam's closure loading resolves.
- [Experimental flag registry](../development/EXPERIMENTAL_OPTIONS.md#readerschemaprecedence)
  — rollback, authority, adoption, and lifecycle.
