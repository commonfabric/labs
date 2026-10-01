---
status: historical
created: 2026-10-01
archived: 2026-10-01
reason: "Record of the deliberate contract break taken when home's default profile moved from a link stored at the root of its own cell to a link under `profile` in a fresh slot cell, so that the picker can re-point it, including why existing homes start with no default and the ruling under which the required home pattern takes the break."
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
  constraint that is not stable under default insertion", against the one home
  baseline recorded after the schema generator began carrying the slot's labels
  ([`home-default-profile-labels-break.md`](home-default-profile-labels-break.md)).
  The other 23 home baselines report the same path and are already forgiven by
  that entry and the profile inbox entry
  ([`profile-inbox-piece-break.md`](profile-inbox-piece-break.md)).
- `system/profile-picker.tsx`, `argument.defaultProfile`: the same finding,
  against the six picker baselines no entry named. The picker's other four
  baselines report the same path and are forgiven by the two profile inbox
  entries.

No other pattern reports a finding.

## What existing homes see

The slot is a fresh cell, so every existing home starts with no default. Its
previous `defaultProfile` cell keeps its link, and nothing reads it. Until the
user picks a default again, `#profile` orders its candidates by most recent use,
then by list order, which is how it orders a home that never set one. A runtime
reading a home that has not yet followed the new source reaches the profile
itself through `defaultProfile`, and a profile has no `profile` field, so it
too reads no default.

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

## What was validated

- `system/profile-create.default-profile.test.tsx` sets a default, moves it to a
  second profile and back, and checks that each profile keeps its own name. All
  six assertions pass; with the link written at the slot's root instead, three
  fail.
- The `home-profile` browser integration test moves the default from one
  profile to another and waits for the picker's marker to follow. It passes
  with this change, and fails without it on the cross-space write refusal.
- A home created under the previous source, with two profiles and its first
  profile set as the default, was reopened under this one. Home followed the
  new source, showed both profiles and no default, set a default, moved it to
  the second profile, and kept it there while a third profile was created.

## Why the required home pattern takes the break

Home is a required pattern: it updates every space's root, and
`pattern-break-registry-guards.ts` refuses a break naming one unless the entry
carries a ruling. Three ways were weighed: reset the defaults, as above; keep
the same slot and add a repair that rewrites each existing home's stored link,
which preserves current defaults at the cost of an operational step; or change
the runtime so that a handler can re-point a link stored at a cell's root,
which changes core cell semantics. Gideon chose "Reset defaults", 2026-10-01:
keep the default in a fresh cell, so existing homes start with no default and
users re-pick it once, with `#profile` ordering by most recent use until then.
