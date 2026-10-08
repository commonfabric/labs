---
status: historical
created: 2026-10-07
archived: 2026-10-07
reason: "Record of the deliberate contract break taken when a FabriChat room became its space's root, keeping its space's participants itself, and a manager's rooms came to be listed from the user's shared-space catalog."
---

# FabriChat: a room is its space's root, and the catalog lists a user's rooms

A room the manager creates is now its space's root
(`FabriChatRoom.inSpace(undefined, { grants, root: true })`), a social space in
its own right. Opening its space shows the room, and the room keeps the space's
participants itself: a roster in its own arguments, written only by the loom
roster's `addParticipant` (`packages/patterns/loom/participants.tsx`). Before,
the space's root was its default pattern, the system default app a host
created the first time someone opened the space, and the room read the
participants from that app through `wish({ query: "#default" })`. A room in an
existing social space, which isn't its space's root, still reads them there.

A manager's `rooms` is now a view over the user's shared-space catalog, Home's
(`packages/patterns/system/shared-space-catalog.ts`): each saved entry of kind
`fabrichat-room`, its room found as its space's root. The manager's own list of
rooms, a stored argument, is no longer read or written. Creating or accepting a
room registers its space in the catalog, forgetting one archives its entry, and
Home's share intake registers a room offered to the user. The intake admits a
`fabrichat-room` offer only when the room is its space's root, which is what
made the root a requirement.

## What the gate reports

Against two of the manager's recorded baselines,
`20261005T182129Z-yX4jdpH1wLhIowBh` and `20261006T233809Z-8LxrZWka1s7az21n`,
the pattern-update proof reports `argument.requests.*: a schema alternative
accepted previously is not accepted by the candidate`. A manager's index entry
gained `revision`, the revision of the room's entry in the user's catalog,
which a request to forget the room names so that a choice made since by another
client is not overridden. The recorded entry left extra fields open, so a
stored request outcome's entry admitted a `revision` of any type, and the
candidate types it as a string. No recorded outcome holds one. The entry in
`tasks/pattern-compat-accepted-breaks.ts` forgives only `argument.requests.*`,
and only against those two baselines. The room and Home apply over their
baselines unchanged; the rest of the break is in what the data a manager and a
room already hold now means.

## What happens to what exists

- **Rooms created before.** Their spaces' roots are default apps, where any
  host created one, so no catalog entry can find them as roots, and none was
  registered. A manager therefore lists none of them, though its stored list
  still holds their entries. A link to one, from a notice or a request's
  outcome, still opens it.
- **Their participants.** Such a room has the `about` a manager writes, which
  is what marks a room as its space's root, so it reads its own roster, which
  is empty, rather than its default app's. Those who joined through the default
  app are shown only once they write.
- **Home.** Home's contract applies over its baselines unchanged. What Home's
  Chats tab lists changes with the manager: none of the rooms created before.

## The decision

@danfuzz, 2026-10-05: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed
'for realsies'". @danfuzz, on 2026-10-06 and 2026-10-07, settled that a
standalone room is a social space in its own right and its space's root,
keeping its own roster, while a room that is part of another social space
leaves that space's root as the root. Nothing here migrates the rooms that
exist: they are play and trial data, abandoned rather than migrated, as the
earlier FabriChat breaks were.
