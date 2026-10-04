---
status: historical
created: 2026-10-01
archived: 2026-10-01
reason: "Record of the deliberate contract break taken when the schema generator stopped dropping the CFC labels of a labeled cell beside undefined or null, which gave home's result slot defaultProfile the labels its type declares, including what those labels do not protect and the ruling under which the required home pattern takes the break."
---

# Home: `defaultProfile` carries the labels its type declares

The schema generator dropped the CFC labels of a labeled cell that sat beside
nothing but `undefined` or `null`, as `Confidential<Cell<T>, …> | undefined`
does (Topics board: "A nullable `Confidential<Cell<T>, …>` field loses its
label from the pattern's argument schema, so the stored input carries no
declared label"). `CommonFabricFormatter.#isWrapperUnion` took such a union for
a union of plain cells, and `#formatWrapperUnion` formatted the cell from its
type reference, reading past the CFC metadata. It now treats a cell under CFC
labels as a labeled value, which `UnionFormatter` reads through its CFC alias.

Across the pattern tree that changes one emitted schema. Home's result declares
`defaultProfile?: TrustedDefaultProfile`, and `TrustedDefaultProfile`
(`system/profile-create.tsx`) is a profile link under `writeAuthorizedBy:
setDefaultProfile`, `addIntegrity: ["profile-link"]`, and a `uiContract`
requiring the picker's `SetDefaultProfile` action from `ProfilePickerSurface`,
beside `undefined`. Every home contract recorded before this change shows that
slot with none of those labels; it now carries all three.

## What the proof reports

`system/home.tsx`, `result.defaultProfile`: "a schema alternative accepted
previously is not accepted by the candidate", against 18 of home's 23
baselines. The compatibility proof compares `uiContract` as declared store
policy and `writeAuthorizedBy` as the write authorization, so a slot gaining
both is a changed contract. The other five baselines report the same path and
are already forgiven by the profile inbox entry
([`profile-inbox-piece-break.md`](profile-inbox-piece-break.md)); the new entry
names the 18, keeping the pairs disjoint. No other pattern's contract changes.

## What the labels do not protect

The labels sit on home's result slot, which links to the cell the picker
writes: `new Writable<BackwardsCompatibleProfile | undefined>(…).for(
"defaultProfile")` in `home.tsx`, whose own type carries none of them.
`setDefaultProfile` writes that cell, so the declared writer is not consulted on
the write. Measured against a local stack enforcing CFC strictly: with this
change and `TrustedDefaultProfile`'s declared writer swapped to `setMruProfile`,
the picker's "Set default" still lands, though the runtime compares a writer's
module identity and binding path and would refuse it if consulted. The same
holds on home's `profiles`, whose declared writer the schema already carried:
swapped to `setMruProfile`, profile creation still appends (creation is gated
by its trusted UI event). Making the declared writers protect the cells they
describe is follow-up work, filed on the Topics board.

## What was validated

- The `home-profile` browser integration test now asserts that "Set default"
  lands, by the picker's default marker appearing, and passes with this change
  on fresh homes.
- A home created under the previous compiler and reopened under this one lists
  its profiles, sets its first default, creates a third profile, and keeps the
  default. Its stored result-schema reference does not change, because a
  piece's pattern identity is content-addressed over its source, which this
  change leaves alone; a home created under this change stores a new one.
- Moving an existing default to another profile fails on homes under the
  previous compiler too, in a single session, with a cross-space write
  isolation error from the picker. It is not caused by this change, and is
  filed on the Topics board.

## Why the required home pattern takes the break

Home is a required pattern: it updates every space's root, and
`pattern-break-registry-guards.ts` refuses a break naming one unless the entry
carries a ruling. Gideon ruled it in, 2026-10-01, after the measurements above:
"yeah i think we should do 1 now and follow up with 2. please proceed as you
suggest, including with the one upgrade test" — option 1 being to land the
generator fix with this accepted break, and 2 to make the declared writers
reach the written cells.
