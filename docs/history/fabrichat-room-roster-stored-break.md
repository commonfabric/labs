---
status: historical
created: 2026-11-22
archived: 2026-11-22
reason: "Record of the deliberate contract break taken when a FabriChat room's `roster` became a link to the participant list the room stores, which the pattern-update gate reads as a result field that is no longer required against the room's recorded baselines."
---

# FabriChat: a room's roster, linked to the list the room stores

A FabriChat room's result `roster` was a computed copy of the participant list
the room stores (`rosterProfiles()` over `participants`, in
`patterns/system/fabrichat/room.tsx`). Its stored value changes only when some
runtime runs the room's derivation, and a runtime runs it only when something
demands it. A handler reading `roster` reads it as last stored, so on a client
that had derived nothing of the room since a member joined, the handler did
not see that member. The manager's `dropJoinedNotices` and the re-offer in
`offerRooms` are such handlers. Measured with
`runtime/piece/test/fabrichat-notice-prune.test.ts`: on a fresh client with
server execution off, after the recipient had joined, the room's `roster` read
`[]`. The sender's next join kept the recipient's notice, and so did starting
the direct chat again with their profile.

`roster` is now a link to the stored list's `items`, so every reader, a handler
included, reads the list as stored. The list's `items` is absent until the
first `addParticipant`: the roster's write contract admits no default, which
would be a write no handler made. So `roster` is declared optional: absent
until someone joins, and in a room nobody can join, where the computed read
`[]`.

## What the gate reports

Against 176 of the room's 197 recorded baselines
(`system/fabrichat/room.tsx`), the pattern-update proof reports
`result field is no longer required` at `result.roster` and
`result.$VIEWS.room.roster`. The other 21 report nothing. No other pattern's
contract reports anything: the manager's and Home's results don't carry the
room's `roster`.

Seven entries already named 103 of those baselines, for earlier breaks. Each
names these two paths beside its own, and cites this record for them in its
reason. The 73 baselines no entry named are named by one entry of this
record's.

## What a running piece sees

- Nothing stored changes. The list the link reaches is the one the room already
  stored, and the computed's stored copy is left behind, unread.
- A reader of an empty room's `roster` finds it absent where it found `[]`.
  The manager's readers (`dropJoinedNotices`, `offerRooms`, and `RoomRoster`)
  already read an absent roster as empty, and the manager's `ChatRoomLink`
  already declared `roster` optional.
- A native client outside this repository reads neither `roster` nor
  `$VIEWS.room.roster`, by its session's reading of its own code. It reads
  `members` and `participantEntries`, which the room still derives from the
  same `rosterProfiles()` copy, so they are what they were in an empty room.

## The decision

@danfuzz, 2026-11-22, choosing option Q46-A (declare the break: the room's
`roster` becomes optional, a link to the stored participant list, so a handler
reads it current). FabriChat compatibility breaks are acceptable until
FabriChat is deployed, per his 2026-10-05 ruling: "in general it's okay to
break compatibility with pre-existing fabrichat stuff. this system has not yet
been deployed 'for realsies'". The entries forgive only the `roster` paths, and
only against the baselines named. The contract recorded with this change is
gated as usual from then on.
