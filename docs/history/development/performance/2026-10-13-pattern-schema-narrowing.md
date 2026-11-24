---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Counts and profile shares from a fabrichat room's reload before and after a pattern began holding its argument and result schemas deep-frozen from the time the builder makes it, with the entity ids that interning those schemas would have changed, October 2026."
---

# Narrowing a pattern's argument schema on a fabrichat room's reload, October 2026

Binding a pattern's nodes narrows the pattern's argument schema for every
argument alias it binds, through `ContextualFlowControl.schemaAtPath`, and
that function keeps a narrowing only for a deep-frozen schema. This records
how many of those narrowings a room's reload made of a schema that was not
deep-frozen, by which route each such schema reached the binding, what the
narrowings cost, and what changed when the builder began handing out
deep-frozen schemas. It also records why those schemas stayed separate
objects and were not interned.

## Setup

- The server: a local toolshed at a port offset, `serverExecution` off, its
  store holding a room of thirty messages and twelve members seeded the day
  before and opened many times since.
- The client: a Deno `cf piece render` of the room through
  `skills/perf-investigation/scripts/profile-cf.ts`.
- The code: main at `83c5203f2e` for the base arm, and that commit with the
  change for the new arm.
- The machine ran at a one-minute load of 250 to 390 throughout, from other
  sessions. A render took five to ten minutes. So nothing here is a wall
  time. The counts are exact. The shares are of the samples a V8 profile
  took outside `(idle)`, compared between two renders started together, one
  per arm, with the arm that started first alternating.

The narrowings were counted with a temporary counter in
`unwrapOneLevelAndBindToDoc()`. For each argument alias bound it counted the
narrowings the alias's path makes of the pattern's own argument schema: one
per path segment, and one more for the whole path where the caller passes
the schema as `sourceSchemas.argument`. It did not count the narrowings of
the argument link's schema, which is interned. Each count was keyed by
whether the schema was deep-frozen and by how the pattern holding it came to
be, which `resolveOriginal()` reports: a pattern the builder returned, or a
copy of one.

## Which schemas were narrowed

A reload bound 62,250 aliases in every render of either arm. Of those,
62,136 were argument aliases bound under a pattern's argument schema, and
they narrowed it 75,317 times. The other 114 bound with no such schema to
narrow.

| pattern holding the schema | schema when narrowed | base: aliases | base: narrowings | new: aliases | new: narrowings |
| --- | --- | ---: | ---: | ---: | ---: |
| a copy of a pattern the builder returned | not deep-frozen | 38,168 | 38,448 | 0 | 0 |
| a copy of a pattern the builder returned | deep-frozen | 17,800 | 18,035 | 55,968 | 56,483 |
| a pattern the builder returned | not deep-frozen | 4,128 | 12,621 | 0 | 0 |
| a pattern the builder returned | deep-frozen | 2,040 | 6,213 | 6,168 | 18,834 |

On the base arm 51,069 of the 75,317 narrowings were of a schema that was
not deep-frozen. A second base render gave the same counts.

On the base arm six schema objects were narrowed while not deep-frozen:
three held by patterns the builder returned, of four such patterns, and
three held by copies, of six. Each of the six was narrowed deep-frozen later
in the same reload.

Two routes brought a schema to the binding, and no third. No pattern in the
reload was a plain object that was not a copy of a builder pattern, so none
came from a stored graph.

- **A pattern the builder returned.** `factoryFromPattern` handed out the
  result of `sanitizeSchemaForLinks()`. For three of the four patterns that
  was a mutable tree throughout: the schema the pattern was given was not
  deep-frozen when the sanitizer ran, so the sanitizer's memo did not apply
  and its result shared nothing frozen.
- **A copy of one.** The builder's binding walk (`withAliasBindings()`)
  rebuilds a nested pattern's graph into the node that instantiates it,
  record by record, and that rebuilt the nested pattern's schemas as mutable
  copies. A child pattern runs from that copy. This route carried three
  quarters of the narrowings of a schema that was not deep-frozen.

What froze those six schemas partway through the base reload is the first
run of the pattern holding each. `Cell.asSchema()` interns the schema it is
given, which freezes a mutable one in place, and setup calls it with the
pattern's argument schema. The resume pre-sync binds a pattern's nodes
before the pattern has run, so its narrowings came before that.

`frozenSchemaStandIn()` in `pattern-binding.ts`, which substituted a
deep-frozen clone for a schema that was a mutable root over deep-frozen
members, applied to none of the aliases on the base arm. No schema reached
the binding in that shape.

## What the narrowings cost

Three pairs of renders, each pair started together. Each cell is the
inclusive time of the function over the profile's samples outside `(idle)`,
as a share of those samples.

| pair | arm | `selectReferencedCfcSchemaDefs` | `schemaAtPath` | `unwrapOneLevelAndBindToDoc` | `sanitizeSchemaForLinksInternal` | `factoryFromPattern` | `withAliasBindings` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | base | 4.88% | 5.59% | 12.77% | 2.04% | 1.51% | 1.20% |
| 1 | new | 0.66% | 0.92% | 5.26% | 0.67% | 1.70% | 1.39% |
| 2 | base | 4.43% | 5.18% | 12.36% | 2.68% | 0.78% | 0.65% |
| 2 | new | 0.70% | 1.91% | 5.66% | 0.54% | 0.99% | 0.80% |
| 3 | base | 4.26% | 4.78% | 10.36% | 1.63% | 1.00% | 0.79% |
| 3 | new | 0.56% | 0.73% | 4.90% | 0.40% | 1.15% | 0.93% |

The binding walk's share fell by more than the narrowing's. The walk also
sanitizes and interns the argument link's schema on every call
(`canonicalSchemaLink()`), and that is a memo hit for a deep-frozen schema
and a strip, a clone and a hash for a mutable one.

The builder's own share rose by 0.15 to 0.2 of a percentage point in each
pair, for the freezing it now does.

The samples outside `(idle)` came to 415, 299 and 298 seconds on the base
arm and 381, 267 and 249 on the new, each against the render it was paired
with. Those are wall seconds of a process sharing its cores, and are given
for the direction they agree on.

All six renders, and the renders that carried the counter, wrote the same
232,190 bytes of HTML.

## What interning costs in the same reload

`internSchema()` was 9.6%, 11.5% and 9.3% of the base arm's samples and
8.9%, 10.3% and 8.2% of the new arm's. The change did not aim at it. In the
new arm's three profiles its inclusive time divides by caller as follows.

| caller | pair 1 | pair 2 | pair 3 |
| --- | ---: | ---: | ---: |
| `internPathSelector`, under a sync's `normalizeSyncSelector` and `externalizeSyncSelector` | 27.2% | 26.1% | 27.2% |
| `internCellLinkSchema` in `asSchema`, under `#cellsNodePlanReads` | 20.9% | 18.7% | 17.4% |
| `internSchemaPairAsKey`, under `combineSchemaForLink` and `mergeSchemaFlags` | 17.9% | 18.1% | 21.0% |

## Why the schemas were not interned

The first version of the change had the builder return the interned instance
of each schema, and had the builder's binding walk return a deep-frozen
record it left unchanged as the same object, so that a pattern and every
copy of its graph shared one schema object. It removed the same narrowings.
It was withdrawn because it changed derived entity ids.

`createRef()` guards against cycles by hashing an object it reaches a second
time in one cause as `null`. So the id it derives depends on which objects a
cause shares, and not only on what the cause holds. A node's cause holds its
bound inputs and outputs, a handler's holds its bound inputs, and either can
hold a pattern's graph with its schemas.

Twenty-three ids were derived with `createRef()` from ten built patterns:
one from each pattern's schemas, result and nodes, and one from each node's
inputs and outputs. The patterns were built from mutable and from deep-frozen
schemas, from one object given as both schemas, from equal schemas, with a
pattern nested once, twice and at three levels, and with patterns and a
shared deep-frozen constant passed as a node's input values.

- With the interning version, nine of the twenty-three differed from main's:
  the three patterns given one object or equal objects as both schemas,
  every pattern nesting another, and the pattern holding patterns as input
  values together with the id of its node.
- With the version that landed, none differed. It freezes the objects main
  already made and shares none that main kept apart.
