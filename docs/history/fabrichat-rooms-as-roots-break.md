---
status: historical
created: 2026-10-08
archived: 2026-10-08
reason: "Record of the deliberate contract break taken when a FabriChat room the manager creates became its space's root, in a space declaring itself a `fabrichat-room`, keeping its space's participants itself."
---

# FabriChat: a room is its space's root, and keeps its own participants

A room the manager creates is now its space's root, in a space that declares
itself a `fabrichat-room`
(`FabriChatRoom.inSpace(undefined, { grants, root: true, spaceKind: "fabrichat-room" })`).
It is a social space in its own right: opening its space shows the room, and
the room keeps the space's participants itself, in a roster that is a new
argument of the room, written only by `addParticipant` from
`packages/patterns/loom/participants.tsx`. The room offers that writer as its
own `addParticipant`, and the manager sends its user's profile there when it
creates or accepts a room. Before, the space's root was its default pattern,
the system default app a host created the first time someone opened the space,
and the room read the participants from that app through
`wish({ query: "#default" })`. A room in an existing social space, which isn't
its space's root, still reads them there, and then lists its own roster.

Home's share intake admits an offer of a `fabrichat-room` space only when the
space declares that kind and its root is at the address the space's genesis
reserves for one ([`space-kinds.md`](../features/space-kinds.md)). Rooms made
this way are the first that can pass it.

## What the gate reports

Nothing incompatible. The room's contract gained an optional argument, the
roster, and a result member, `addParticipant`, and it applies over every
recorded baseline of the room as it did before; the new contract is recorded
beside them. The manager's contract and Home's are unchanged, since what the
manager does differently is inside its handlers. The break is in what the data
a room already holds now means, which no contract proof reads.

## What happens to what exists

- **Rooms created before.** Their spaces' roots are default apps, where any
  host created one. Such a room has the `about` a manager writes, which is
  what marks a room as its space's root, so it reads its own roster, which is
  empty, rather than its default app's. Those who joined through the default
  app are shown only once they write, as authors. A link to such a room, from
  the manager's list, a notice or a request's outcome, still opens it.
- **Their spaces' kind.** They declare none, and a space's kind is sealed at
  its creation, so the share intake refuses an offer of one for good, as
  `space-kind-undeclared`.
- **Home and the manager.** Their stored data means what it did. The
  manager's list still holds the rooms created before.

## The decision

@danfuzz, 2026-10-05: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed
'for realsies'". @danfuzz, on 2026-10-06 and 2026-10-07, settled that a
standalone room is a social space in its own right and its space's root,
keeping its own roster, while a room that is part of another social space
leaves that space's root as the root; and that a space declares its kind at
its creation, a FabriChat room's space declaring `fabrichat-room`. On
2026-10-08 he asked for this change to come early, so that the share intake,
which reads the kind, and the rooms it vets line up. Nothing here
migrates the rooms that exist: they are play and trial data, abandoned rather
than migrated, as the earlier FabriChat breaks were.
