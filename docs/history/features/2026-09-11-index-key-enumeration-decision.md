---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Accepted Q7 API decision; records context, consequences, and alternatives before implementation."
---

# Mixed index key enumeration decision

Mike approved explicit tagged enumeration on September 11, 2026, resolving Q7
of the [computation-cost implementation plan](../plans/pattern-computation-cost-implementation.md).
This records an accepted design decision, not completed implementation or test
acceptance. The [archived contract](../plans/collection-index-contract.md) tracks
implementation requirements.

## Context

Collection indexes accept primitive values and Cell identities as keys. The
string `"glaze"`, a Cell containing `"glaze"`, and a different Cell containing
the same string identify three different buckets. Membership and lookup in the
producer implementation preserve these distinctions.

Mixed `keys(): K[]` enumeration exposed a schema boundary: when a result schema
admits a primitive and a Cell alternative, runtime materialization can wrap a
primitive as a Cell. A correctly stored key therefore does not establish that
an authored consumer receives the promised key kind. The pending producer work
is [PR #7323](https://github.com/commontoolsinc/labs/pull/7323), within
[design #7155](https://github.com/commontoolsinc/labs/pull/7155).

## Decision

Provide an explicit tagged enumeration API for mixed primitive/Cell indexes.
A primitive entry has shape `{ kind: "value", value: "glaze" }`; a Cell entry
has shape `{ kind: "cell", cell: glazeCell }`. Preserve simple homogeneous
`keys()` usage. General runtime union materialization changes are separate work.
The method name and concrete type wiring remain implementation details subject
to the ordinary review gates.

## Consequences

- Callers of mixed enumeration inspect `kind` and pass `value` or `cell` to
  lookup. A Cell entry carries the original identity, including cross-space
  identity; its stored value does not replace that identity.
- The explicit object shape adds caller code and a public type contract, but
  makes the distinction visible to both the schema and the author.
- Tags do not change equality, occupied-key ordering, grouping, unique-key
  selection, or lookup isolation. Both representations must retain demand-only
  enumeration and removal/reinsertion behavior.
- Acceptance must exercise compiled authored consumers, not just raw helper
  output. It must distinguish equal primitive/Cell contents, distinct Cells,
  lookup round trips, cross-space references, and durable resume.
- Approval removes the product decision blocker. Implementation, validation,
  antagonistic review, and clean Cubic review still precede merge. It grants
  no permission to update the live poll without coordination.

## Alternatives considered

1. **Keep mixed `keys(): K[]` and repair general runtime unions.** This keeps
   the shortest caller API, but requires a broader decision about overlapping
   primitive/Cell alternatives and compatibility testing beyond indexes.
   It was not selected for this implementation scope.
2. **Defer mixed enumeration.** Grouping, lookup, and homogeneous enumeration
   could ship with an explicit limitation. This offers a smaller immediate
   change but leaves the mixed-key capability incomplete. It was not selected.
3. **Explicit tagged enumeration (selected).** This confines the representation
   decision to enumeration and exposes value versus identity directly. Its
   cost is additional API surface and a tag that consumers inspect.
