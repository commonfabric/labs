---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Record of the deliberate contract break taken when the profile gained its owner-protected share inbox pointer, which the pattern-update gate reads as a changed label under profile-picker's defaultProfile argument."
---

# Profile: the share inbox pointer is a labelled property the update gate cannot prove

`system/profile-home.tsx` gained `inbox?: OwnerProtectedProfileWrite<{ space,
host }, typeof setInbox>` and the `setInbox` stream: where the owner's share
inbox is — the dedicated space their loom daemon minted, into which other
people's daemons push offers of looms (loom's multi-user sharing design D8,
the profile-handler share flow; commontoolsinc/loom#5988). A sender resolves
a person to their profile and reads the pointer there; the pointer holds no
secret, the inbox space's ACL is the gate.

`system/profile-picker.tsx` takes a stored profile as `defaultProfile:
BackwardsCompatibleProfile`. Against both of its recorded baselines the
pattern-update proof reports `argument.defaultProfile: a schema alternative
accepted previously is not accepted by the candidate`, and the inner reason,
read off the property proof, is `profile.inbox: ifc changed`: the baseline
holds no `inbox` property, the candidate's carries the owner-protection label
(`writeAuthorizedBy`, `ownerPrincipal`, `addIntegrity`), and the proof
compares a semantic extension for exact equality before it considers that the
property is new and optional.

## Why this could not be done compatibly

Three shapes were measured against the gate and rejected:

- **`Default<…, { space: ""; host: "" }>`, the `bio` idiom.** An object
  default beneath a `$ref` constraint: "defaults changed below a constraint
  that is not stable under default insertion".
- **The field optional in `BackwardsCompatibleProfile` as well as its
  stream.** The proof's `required` lists already agree; the label is what
  differs, and optionality does not remove it.
- **The field optional and undefaulted (`inbox?:`), the shape that shipped.**
  Still `ifc changed`, for the reason above.

The alternative that passes the gate is an UNLABELLED pointer, and it was
rejected on its merits: a profile field anyone can write is a field a stranger
can redirect to their own inbox space, and every offer meant for the owner
then lands with the stranger. Owner protection is the property that makes the
pointer safe to publish. A pointer published anywhere but the profile was
rejected too: the profile is what a sender already holds for a person they
have met (the lobby roster, a share's member rows), and a sibling pattern
would need its own discovery.

## What the break costs

Nothing deployed holds state under the old shape that the new one refuses: a
stored profile without `inbox` validates against the candidate (the property
is optional), and a picker reading such a profile sees `inbox` as absent. The
break is a statement about the proof, not about a deployed piece. The entry
in `tasks/pattern-compat-accepted-breaks.ts` forgives exactly the two
`(system/profile-picker.tsx, baseline)` pairs on the one path the proof
names, and the contract recorded once this ships is a new baseline no entry
names, so the next change to the picker is gated again against the shape the
break left behind.

Whether the proof should read a new, optional, labelled property as
compatible is a question for the gate's owner; this record does not decide
it.
