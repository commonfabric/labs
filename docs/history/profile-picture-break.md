---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Record of the contract breaks taken when profiles gained a picture stored as bytes, which the pattern-update gate reports wherever the new optional field lands on an object inside a union."
---

# Profile pictures: a new optional field inside a union fails the update gate

Profiles gained `picture`, the bytes of a raster image, beside the `avatar`
text they already had. `avatar` held a URL, a `data:` URL, or a glyph, which
every reader rendered or copied as a string. A picture stored as a `data:`
URL is a third larger than its bytes and is decoded again by every reader, so
the picture became a field of its own, typed `FabricBytes`:

- `system/profile-home.tsx` gained the owner-protected `picture?:
  FabricBytes` and its writer `setPicture`, and its edit form sets the
  picture from an image picked with `<cf-avatar-input>`, which crops it to a
  square and scales it to 128 pixels on each side.
- A `#profilePicture` wish target reads it, beside `#profileAvatar`.
- `<cf-avatar>` gained a `bytes` property, and `<cf-profile-badge>` shows the
  picture, falling back to the `avatar` text when there is none.
- Patterns that snapshot a participant's avatar into shared state snapshot
  the picture into a new `picture` field, and the avatar text only for a
  profile that has no picture.

## Why a new field rather than a new type for `avatar`

Changing the type of `avatar` was measured first and abandoned:

- **Stored state.** Snapshot records already hold `avatar: ""` inline (every
  roster, player and user entry written by a join). At update time the runner
  validates a piece's stored argument against the new schema and refuses a
  readable wrong-typed value, so every such piece would refuse the update.
- **Deployed readers.** Pieces running older pattern code read `avatar` as a
  string. The Topics board declares it required in its `#profile` wish, so a
  profile holding bytes there, or holding none, fails that whole read and the
  board loses the author's name.
- **The update gate.** The change produced findings on more than twenty
  patterns, one for each place a string `avatar` was declared.

A new optional field changes none of what is stored or read today: `avatar`
keeps its type, a stored value of any vintage still validates, and an older
reader never sees the new field. No form writes the profile's `avatar` any
more.

Every place that draws a profile draws its picture, or else its avatar text,
or else initials. A snapshot copies the picture when the profile has one and
the avatar text when it does not, so a person whose profile still holds a
`data:` URL is drawn with it in a roster, game or comment they join, until
they set a picture. Topics copies the picture or avatar text only into a
comment's author, the one attribution it displays, so that a board's index
rows carry no image.

## What the gate still reports, and why it is accepted

The proof lets an open argument object gain an optional named field, as the
piece-evolution policy. It does not apply that policy inside a union: it
compares a union's alternatives as two-part conjunctions (the union node's
own keywords beside the branch), and it withholds the evolution policy from
any conjunction of more than one part. The same `picture?: FabricBytes`
added to an object that sits directly at a property passes; added to an
object that is one branch of an `anyOf` it is refused. A probe of
`assertPatternSchemasBackwardCompatible` with `{ name }` gaining `picture`
shows exactly that, with and without a `default` beside the `anyOf`.

Four places put the new field inside a union:

- `battleship/multiplayer/lobby.tsx` and `battleship/multiplayer/room.tsx`,
  `argument.player1`: `PlayerData | null`.
- `system/profile-picker.tsx`, `argument.legacyDefaultProfile`:
  `BackwardsCompatibleProfile | undefined`. Here the new property also
  carries the owner-protection label, which the proof compares for exact
  equality before it considers that the property is new and optional, as it
  did for the profile's share inbox pointer
  ([profile-inbox-pointer-break.md](profile-inbox-pointer-break.md)).
- `topics/main.tsx`, `argument.topics[].createdBy`: `TopicAuthor` beside a
  `Default<>`.

None of these is a break a deployed piece can observe. A stored value
without `picture` validates against the candidate, because the property is
optional, and a stored value cannot hold a `picture` the old pattern never
wrote. The entries in `tasks/pattern-compat-accepted-breaks.ts` forgive only
the named `(pattern, baseline)` pairs on the one path the proof names, and the
contracts recorded once this ships are new baselines no entry names. A proof
that applied the evolution policy to a union branch whose companion fragment
constrains nothing would accept all four, and these entries would then
forgive nothing and be removed.
