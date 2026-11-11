---
status: historical
created: 2026-11-11
archived: 2026-11-11
reason: "Record of the deliberate contract break taken when the FabriChat manager's stored links to rooms became handles that declare nothing of the room, which the pattern-update gate reads as a wider type against the manager's and Home's recorded baselines."
---

# FabriChat: the manager's room links become handles

Every link to a room the FabriChat manager stores or derives was declared
`Cell<ChatRoomLink>`: the room's `about`, its `messages` summary and its
`roster`. A query-shaped walk goes through a cell position under the schema
it declares, so every sync of Home, every handler preflight reading the
manager's records, and every read of the list loaded every room's root, its
records and its roster, and the schema documents their labels name: 209
documents in each room's space while Home was brought up, measured with three
rooms, and 14.6k at the peak of a real Home of 59 rooms in a native client.

The links are now declared `Cell<unknown>`, a handle that declares nothing of
the room (`patterns/system/fabrichat/schemas.tsx`, `ChatIndexEntry` and
`ChatManagerNotice`; `patterns/system/fabrichat/manager.tsx`,
`RoomMembership.container`), and the manager lists its rooms from its own
records. A fresh client bringing Home up and listing the rooms loads nothing
in any room's space.

## What the gate reports

Against each recorded baseline, the pattern-update proof reports that the
candidate no longer accepts every previous type at each stored room link: the
manager's `rooms[].room`, `deletedRooms[].room`, `roomMembership[].room` and
`roomMembership[].container`, `direct.*.room`, `outgoingNotices[].room` and
`requests.*`, and each under `$VIEWS.chats` as well. That is 30 of the
manager's baselines (`system/fabrichat/manager.tsx`), and 73 of Home's
(`system/home/home.tsx`), whose result types its `chatManager` as
`FabriChatManagerOutput`, at the same paths under `result.chatManager`.

Most of those baselines were already named by an accepted break of their own.
Each such entry names these paths beside its own, and cites this record for
them; the baselines no entry named are named by two entries of this record's.

## Why this could not be done compatibly

What a walk loads at a link is what the declaration at its position says, so
a declaration that keeps describing the room keeps loading it. The proof reads
a declaration that describes less as a type a reader of the old contract
never admitted, which is the change itself.

## What a running piece sees

- Nothing stored changes. Each record holds the same link to the same room,
  and a reader that declares the room's shape itself reads the room through
  it as before.
- A reader that takes the manager's own declaration gets the link and nothing
  behind it. The manager's own derivations that read rooms, `people` and the
  notices left to deliver, re-type the links to `ChatRoomLink` first.
- Home follows a `system:` origin, which adopts a new release with no
  compatibility check; `cf piece setsrc` and `checkPattern()` refuse the
  change at these paths.

## The decision

@danfuzz, 2026-11-11, accepting the break: "This changes a type parameter in a
way that makes it possible to avoid unnecessarily sending large amounts of
unnecessary data. It doesn't affect the actual stored data, so it's a safe
change." Home is a required pattern, so its entry carries that ruling as its
`requiredPatternOverride`. FabriChat compatibility breaks are acceptable until
FabriChat is deployed, per his 2026-10-05 ruling: "in general it's okay to break
compatibility with pre-existing fabrichat stuff. this system has not yet been
deployed 'for realsies'". The entries forgive only the room-link paths, and only
against the baselines named. The contracts recorded with this change are gated
as usual from then on.
