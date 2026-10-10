---
status: historical
created: 2026-10-10
archived: 2026-10-10
reason: "Record of the deliberate contract break taken when a FabriChat manager's room link gained the room's roster, which the pattern-update gate reads as a narrowed `requests` argument against the manager's recorded baselines."
---

# FabriChat: a manager's room link carries the room's roster

`ChatRoomLink` (`packages/patterns/fabrichat/schemas.tsx`) is the part of a
room a manager reads through the link it holds. It declared `about` and
`messages.count` and `messages.newestAt`. It now also declares `roster`, the
profiles of those who joined the room, each as a link, which the room's output
gained beside it. The manager reads each listed room's roster to derive its
`people`: the profiles of those its user shares a room with, keyed by the
principal each profile attests, which its rendering offers to name a new
group's members by, so that each is offered the group.

## What the gate reports

Against the manager's baselines `20261008T225324Z-Oj3DbCTq-94tEYN3`,
`20261009T161813Z-r7DggcJdZ7FzrPCR`, `20261009T210116Z-99YN5H9jf2UFET6M` and
`20261010T083035Z-Mp5ZALK-A2rUfm_u`, the pattern-update proof reports
`argument.requests.*: a schema alternative accepted previously is not
accepted by the candidate`. A request outcome that is `done` holds the
`ChatIndexEntry` it produced, whose `room` is a `Cell<ChatRoomLink>`. The
recorded `ChatRoomLink` leaves every field it doesn't declare open, so any
`roster` value was admitted. The candidate types `roster`, and so admits fewer
values there.

## Why this could not be done compatibly

Any typed field added to the link narrows it the same way, since the recorded
link admits anything under a name it does not declare. The room's
`participants` was no alternative: it adds every author to the roster, so
deriving it reads every message, and the link's schema is part of every
manager handler's declared reads. An untyped `roster` would leave the
manager reading each profile through the link, where typing each entry as a
link keeps the declared read at the roster itself.

## Why nothing stored is refused

A `room` in a stored outcome is always a link to a room's output, written by
the manager when it created, found or accepted the room. A room's output
either has no `roster`, which the optional field admits, or has the one the
room derives from its stored roster, a list of profile links, which the new
type admits.

## The decision

@danfuzz, 2026-10-05: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed 'for
realsies'". The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives
only `argument.requests.*`, and only against those four baselines; the
contract recorded with this change is gated as usual from then on.
