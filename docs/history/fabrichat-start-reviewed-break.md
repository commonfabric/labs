---
status: historical
created: 2026-10-06
archived: 2026-10-06
reason: "Record of the deliberate contract break taken when a FabriChat room's `about` record came to require a reviewed start, which the pattern-update gate reads as a changed label on the room's `about` argument against the room's recorded baselines."
---

# FabriChat: a room is created only from a reviewed start

FabriChat's design admits `openDirect` and `createGroup` only as a trusted
gesture on `ChatStartSurface` (`docs/specs/fabrichat/clients.md`,
"Writing: the reviewed-gesture requirement"). The manager enforced none of it:
one handler, `commitManager`, performed every act, and the record a
manager-created room keeps about itself (`StoredAbout`,
`packages/patterns/fabrichat/room-records.tsx`) named that handler as its
writer with no gesture. Any code able to send to the manager's streams could
create rooms, and grant people access to them, as the user.

The starts now have a handler of their own, `commitStart`, and `StoredAbout`
is a `TrustedActionWrite` naming that handler and `ChatStart` on
`ChatStartSurface`. A start that creates a room commits only from the person's
reviewed act.

## What the gate reports

Against each of the room's four recorded baselines,
`20261002T164437Z-1xU0r9QuhxWHgK6y`, `20261003T224731Z-o9skqwp4KfLbCDBT`,
`20261005T182129Z-3RSVlUS0NdLuz2VP` and `20261005T224806Z-OeD1Mc2I_LQ_d8L_`,
the pattern-update proof reports `argument.about: ifc changed`. The room's
`about` argument is a `StoredAbout`, whose write policy is part of its label:
the recorded label names `commitManager` as the writer, and the candidate names
`commitStart` together with the reviewed action it requires.

## Why this could not be done compatibly

The write policy is the change. Any policy requiring the gesture differs from
the recorded one, which requires none, and leaving the recorded policy in place
leaves the start unenforced.

## What happens to rooms that exist

A room's `about` is written once, when the room is created, and never after.
A room created under the recorded contract keeps the record it has, labeled
`authored-by` its creator as before; what changed is only who may write a new
one.

## The decision

@danfuzz, 2026-10-06, asked whether the specification or the code was wrong
about starts: "(a) pls", enforcing the specification, as a change of its own.
@danfuzz, 2026-10-05: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed 'for
realsies'". The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives
only `argument.about`, and only against those four baselines; the contract
recorded with this change is gated as usual from then on.
