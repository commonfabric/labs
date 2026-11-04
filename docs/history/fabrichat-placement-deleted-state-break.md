---
status: historical
created: 2026-11-03
archived: 2026-11-03
reason: "Record of the deliberate contract break taken when a FabriChat placement's state gained the value deleted, which the pattern-update gate refuses as a published enum an older reader never admitted."
---

# FabriChat: a placement's `state` gains `"deleted"`, which the update gate cannot prove

`fabrichat/placement.tsx` publishes, for a room placed in a space, whether the
viewer can read it: `"member"`, `"not-member"` or `"unavailable"`. The
space-deletion specification adds `"deleted"`
([`FabriChatPlacement.md`](../specs/fabrichat/FabriChatPlacement.md)): a room
whose space is deleted can be read by no one, whatever the viewer's level, and
a client shows such a room as deleted, with no controls
([`clients.md`](../specs/fabrichat/clients.md#showing-a-room)). The placement
reads `spaceDeleted(room)` before the access level and publishes `"deleted"`
when it is `true`.

Against every recorded baseline of `fabrichat/placement.tsx` that carries
the state's enum, the pattern-update proof reports `result.$VIEWS.chat.state:
enum/const no longer accepts every previous value`, and against those of
`fabrichat/adapter.tsx`, which re-exports the placement's data face, the same
at `result.$VIEWS.chat.state` and `result.placement.$VIEWS.chat.state`. A published value is proved
against what a reader of the recorded contract admits, and a reader built
against the old enum admits no `"deleted"`, so a grown result enum is a break
by the proof's rule whatever the value means.

## Why this could not be done compatibly

The new value is the change. Publishing the deletion through a separate
boolean beside the state, leaving the enum as it was, was rejected on its
merits: a reader would then have to combine two fields to learn one fact, and
the specification names the state's value, which every FabriChat client reads
as one word. The value is what the readers are being updated to show.

## What the break costs

No deployed reader refuses the value. The placement's readers are FabriChat's
clients, the shell's adapter and the native ones, which read the state as a
string and show the rooms whose state they do not know as unreadable until
they are updated to show a deleted room as deleted; the specification asks
that of them in the same change. A placement on the old source publishes no
`"deleted"`, and reads a deleted room as `"unavailable"`, until it is updated.

The entries in `tasks/pattern-compat-accepted-breaks.ts` forgive exactly the
`(fabrichat/placement.tsx, baseline)` and `(fabrichat/adapter.tsx, baseline)`
pairs the proof blames, on the paths it names: each pattern's newest baseline
in an entry of its own, and the earlier ones within the entries that already
name them for their activity log and their per-session `canSend`. The
contracts recorded once this ships are new baselines no entry names, so the
next change to either is gated again against the shape the break left behind.
