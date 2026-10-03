---
status: historical
created: 2026-10-01
archived: 2026-10-01
reason: "Record of the deliberate contract break taken when home's default profile moved from a link stored at the root of its own cell to a link under `profile` in a fresh slot cell, so that the picker can re-point it, including how existing homes keep the default they chose, what a home that has not yet run with the slot offers, why the picker's rows are named so an upgraded home's rows are documents of their own, and the rulings under which the required home pattern takes the break."
---

# Home: the default profile's link moves under `profile`

Moving home's default profile to a second profile failed (Topics board: "Moving
home's default profile to another profile fails: the picker's write is refused
as a cross-space write"). Home kept the default in
`new Writable<BackwardsCompatibleProfile | undefined>(undefined).for(
"defaultProfile")`, and `setDefaultProfile` wrote the chosen profile's link to
that cell's root. A handle to a cell whose root holds a link denotes the cell
the link names: the traversal rule for a cell boundary resolves write redirects
and then follows one more link
(`docs/specs/space-model/8-traversal.md`, "Pointer and Redirect Details"). So
once a default was set, the handler's handle was the default profile itself, and
the next "Set default" wrote a link to the new profile into the old one. In one
space that overwrote the old profile without an error; across spaces, where
every profile lives, the handler's receipt in home's space made it a second
writer in the transaction, and the write was refused as a cross-space write.

The link now sits under a key, as the profile's share inbox pointer does
(`docs/specs/shared-profile-space.md`). `DefaultProfileSlot`
(`system/profile-create.tsx`) is `{ profile?: BackwardsCompatibleProfile }`;
home holds it in `new Writable<TrustedDefaultProfile>({}).for(
"defaultProfileSlot")`; `setDefaultProfile` writes `defaultProfile.key(
"profile")`; the picker reads the default from the same key; and the `#profile`
wish reads `defaultProfile.profile`.

## What the proof reports

- `system/home.tsx`, `result.defaultProfile`: "defaults changed below a
  constraint that is not stable under default insertion", against the five
  home baselines no entry named: the one recorded when the schema generator
  began carrying the slot's labels
  ([`home-default-profile-labels-break.md`](home-default-profile-labels-break.md))
  and four recorded beside it by other changes to home. The other 23 home
  baselines report the same path and are already forgiven by that entry and the
  profile inbox entry
  ([`profile-inbox-piece-break.md`](profile-inbox-piece-break.md)).
- `system/profile-picker.tsx`, `argument.defaultProfile`: the same finding,
  against the seven picker baselines no entry named. The picker's other four
  baselines report the same path and are forgiven by the two profile inbox
  entries.

No other pattern reports a finding.

## How existing homes keep their default

Home still creates the cell it kept the default in, under the same cause, so it
names the same document, and exposes it as `legacyDefaultProfile`. Nothing
writes it: a write through it would land in the profile its root links to. It
is the default while the slot holds none:

- `#profile` orders by the slot's `profile`, or, while the slot holds none, by
  the link at the root of that cell.
- The picker lights the row of whichever of the two is the default, and "Set
  default" writes the slot, which from then on is the default.

A home keeps the default it chose under the previous source with no migration
step, and the first "Set default" moves it.

A home that has not yet run with the slot keeps its default as a link at the
root of the cell its `defaultProfile` names, since `PiecesController` follows a
root's source only when the user opens it. `wish.ts` tells the two apart by what
that cell holds at its root, an object for a slot and a link or nothing
otherwise. For a home without the slot, `#profile` reads the default from
`defaultProfile` itself, and the picker it shows is handed no slot and
`offersSetDefault: false`, so it offers no "Set default" until Home is opened
and runs with the slot. Without that, the picker would write through
`defaultProfile` into the default profile, which is the failure review found
(Sol, on labs#8373).

## What the slot's labels now protect

The slot's cell carries `TrustedDefaultProfile`, so `setDefaultProfile`'s write
is checked against the writer that type declares. Measured against a local
stack enforcing CFC strictly: with `TrustedDefaultProfile`'s declared writer
swapped to `setMruProfile`, both browser tests that set a default are refused by
the write policy gate, and with it restored both pass. This makes the declared
writer reach the written cell for `defaultProfile` (Topics board: "Home's
declared writers for `defaultProfile` and `profiles` sit on its result slots, so
writes to the cells those slots name never consult them"); `profiles` and `mru`
are still held in cells that carry no trusted type.

## Why the picker's rows are named

Under `enforce-strict`, a document the previous source persisted keeps the
schema it was written with: CFC's schema merge refuses a write whose schema
gives one of its values another `type` set. The picker's rows are such
documents, keyed by the rows' map and the element each row shows, and the
picker's new inputs change what a row captures. The schema generator then
emits the captured `homeSpace`, an optional `string | undefined`, as
`["string", "undefined"]` where the previous rows hold `"string"`: whether it
drops the `undefined` an optional property adds depends on the property's
siblings. On a home upgraded with the rows unnamed, the start commit was
refused for every row, so the slot was never written, and "Set default" was
refused by the write policy gate.

The rows' map is now named (`profileRows`), so its container, and every row
under it, is keyed by that name rather than by the map's position. The rows of
an upgraded home are documents of their own, and the previous rows are left
unread.

## What was validated

- `system/profile-create.default-profile.test.tsx` sets a default, moves it to a
  second profile and back, and checks that each profile keeps its own name. All
  six assertions pass; with the link written at the slot's root instead, three
  fail.
- The `home-profile` browser integration test moves the default from one
  profile to another and waits for the picker's marker to follow. It passes
  with this change, and fails without it on the cross-space write refusal.
- `wish.test.ts` resolves headless `#profile` to a legacy default while the slot
  holds none, to the slot's default over a legacy one, and to the default of a
  home without the slot. `profile-picker-default-badge.test.ts` lights the
  legacy default's row while the slot holds none, the slot's over the legacy
  one, and offers no "Set default" with no slot bound.
- A home created under the previous source, with two profiles and its first
  profile set as the default, was reopened under this one with the worker's
  console captured. Home followed the new source and still showed the first
  profile as the default; the default then moved to the second profile and
  back, and stayed while a third profile was created. No start commit was
  refused. With the rows unnamed, the same run refused the start commit as
  described above.

## Why the required home pattern takes the break

Home is a required pattern: it updates every space's root, and
`pattern-break-registry-guards.ts` refuses a break naming one unless the entry
carries a ruling.

Three ways were weighed at first:
- reset the defaults, with the slot in a fresh cell and the previous one left
  unread;
- keep the same cell and add a repair that rewrites each existing home's
  stored link;
- change the runtime so that a handler can re-point a link stored at a cell's
  root, which changes core cell semantics.

Gideon chose "Reset defaults", 2026-10-01. Review then found the picker failing
for a home not yet run with the slot. The fixes on offer either hid "Set
default" until Home was opened, upgraded Home on demand, or cleared the old
default early, and all of them lost or froze the default.

Gideon ruled, 2026-10-01: "i feel like we need to somehow preserve the default
profile across this migration", and approved the design above: "that sounds
good to me. let's proceed as you suggest for 8373".
