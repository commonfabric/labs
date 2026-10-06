---
status: historical
created: 2026-10-05
archived: 2026-10-05
reason: "Record of the deliberate contract break taken when a FabriChat manager's room link gained the room's message count and newest time, which the pattern-update gate reads as a narrowed `requests` argument against the manager's one recorded baseline."
---

# FabriChat: a manager's room link carries where the conversation stands

`ChatRoomLink` (`packages/patterns/fabrichat/schemas.tsx`) is the part of a
room a manager reads through the link it holds. It declared only `about`, so a
host listing a user's rooms through their manager, as loom's relay does,
found nothing of a room's activity. It now also declares
`messages: { count: number; newestAt?: FabricEpochNsec }`, which the room
derives from its messages alone and which its space shares with every member.

## What the gate reports

Against the manager's one recorded baseline,
`20261002T164437Z-O47ebJ7gn-iAk7TA`, the pattern-update proof reports
`argument.requests.*: a schema alternative accepted previously is not
accepted by the candidate`. A request outcome that is `done` holds the
`ChatIndexEntry` it produced, whose `room` is a `Cell<ChatRoomLink>`. The
recorded `ChatRoomLink` is `{ type: "object", properties: { about } }`, which
leaves every other field open, so any `messages` value was admitted. The
candidate types `messages`, and so admits fewer values there.

## Why this could not be done compatibly

Any typed field added to the link narrows it the same way, since the recorded
link admits anything under a name it does not declare. Leaving `messages`
untyped would keep the gate quiet and defeat the point of the link: the link's
schema is part of every manager handler's declared reads, and an untyped
`messages` reaches the room's `messages.windows`, which each session keeps for
itself, and `messages.latest`, which holds up to `maxWindowCount` messages. A
served handler whose declared reads reach a member's own documents never runs.

## Why nothing stored is refused

A `room` in a stored outcome is always a link to a room's output, written by
the manager when it created, found or accepted the room. A room's output has
always carried `messages.count` as a number and `messages.newestAt` as a time
or nothing, so every value the link reaches is one the new type admits.

## The decision

@danfuzz, 2026-10-05: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed 'for
realsies'". The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives
only `argument.requests.*`, and only against that one baseline; the contract
recorded with this change is gated as usual from then on.
