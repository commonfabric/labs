---
status: historical
created: 2026-10-28
archived: 2026-10-28
reason: "Record of the deliberate contract break taken when a FabriChat room's answers about its reader moved from per-user to per-session scope under new binding names, which the pattern-update gate reads as a changed scope against the room's, the placement's and the adapter's recorded baselines."
---

# FabriChat: a room's answers about its reader are per session

[`fabrichat-view-scopes-per-user-break.md`](fabrichat-view-scopes-per-user-break.md)
recorded the FabriChat values derived under the reader's access moving to per
user scope. This record moves four of a room's values, and what is derived from
them, one scope narrower, to per session.

## What changed

A room answers four questions about its reader: `canSend`, `viewer`,
`messageRights` and `canAdd`. The first three are derived from the reader's
`#profile` as well as their access, and `canAdd` from their access. The wish
result for `#profile` is user-scoped, and `spaceAccess()` narrows a
computation to per user, so each was stored once per user and shared by all of
the user's sessions.

A session's profile can resolve later than another session's of the same
person, and a session whose profile never resolves derives a `viewer` without a
profile and a `canSend` of `false`. Whichever session derived last decided the
shared answer. A client reported a room that wouldn't let its reader send, from
a session whose profile had resolved, while another session of theirs had none.

The values declared `PerSession`, each a `computed()` bound under a new name:

- in the room (`patterns/system/fabrichat/room.tsx`): `canSendForSession`,
  `viewerForSession`, `messageRightsForSession`, and the add control's
  `canAddForSession`, which are the room's `canSend`, `viewer`,
  `messageRights` and `canAdd`;
- the values the room's rendering derives from them: `cannotSendForSession`
  (the composers' `disabled`), `isOwnerForSession`, the two retitle controls'
  displays, and the add control's display;
- in the placement (`patterns/system/fabrichat/placement.tsx`):
  `canSendForSession`, its `chat.canSend`.

The output-type fields `ChatRoomView.canSend`, `viewer`, `messageRights` and
`canAdd`, `AddMemberOutput.canAdd`, and `FabriChatPlacementView.canSend` are
`PerSession<…>` too, and so is `PlacedRoom.canSend`, the placement's read of
the room's `canSend`. `docs/specs/fabrichat/ChatRoomOutput.md` gives the fields
those types, and its Scopes section lists them as per session.

The bindings were renamed for the reason the per-user record gives: the
transformer gives a `const`-bound reactive value the binding's name as its
cause, so the name is the identity of the document that stores it, and under a
new name each value gets a document no deployed piece wrote.

`isOwnerForSession` is declared with a default of `false`. The rows' map takes
it as an argument, and a room whose rows were stored before it was bound holds
no value for it there. Without the default, the update rehearsal (below) logged
40 refused commits, each `cfc-schema-migration-incompatible: required field
isOwnerForSession needs a default to preserve old documents`.
`cannotSendForSession`, which the map takes the same way, already defaults to
`true`.

## What it costs

A per-session value is written once for each session that reads it, and
nothing retires it. A probe counted the distinct targets of the links reachable
from a room's rendering, by the scope each is stored at, in one session, with
none, one and two messages (RUN):

| messages  | `main`: session | `main`: user | this change: session | this change: user |
| --------- | --------------- | ------------ | -------------------- | ----------------- |
| none      | 17              | 6            | 21                   | 2                 |
| one       | 21              | 12           | 28                   | 5                 |
| two       | 25              | 17           | 35                   | 7                 |

The space-scoped count was the same on both: 17, 53 and 87. So a session of a
room holds four more small documents of its own than on `main` (RUN), and
three more reachable from the rendering for each message row it renders, which
`main` held once per user (RUN). A row derives what its reader may do to its
message, its `rights`, from `cannotWrite`, which is now per session, and the
row's edit, delete and obliterate controls' displays from that. The three are
those displays. The rendering links no `rights`, so the probe does not count
it, and the row's increase is likely four documents (INFERRED).

## What an updated room does

`patterns/integration/fabrichat-update-rehearsal.test.ts` was run with
its deployed release refreshed to `main` at `fcc5fbd8b1` (#9340). It now also
reads the group room's `canSend`, directly and through `$VIEWS.room`, before
and after the update and after a room is started since, and reads `true` each
time. In both of its runs, with the views read before the update and without,
every check holds: Home and each room adopt the tree's source, nothing logs a
refused transition, a dropped stored slot or a failed start, every stored slot
reads back, and the updated room edits and reacts to a seeded message (RUN). A
CFC denial listener added to a copy of the test recorded no denial (RUN).

A copy of the test read the group room's `canSend`, `viewer`, `messageRights`
and `canAdd` before and after the update, in both runs, with the link each
resolves to (RUN). Before, each resolved to a document at the user scope;
after, to a different document at the session scope, holding the value the
updated room derives. The user-scoped document each had resolved to before
still holds its last value, and the room's result no longer links to it: an
updated room leaves one such document for each of these values, for each user
who read it, which nothing reads or retires. Each holds a value the room
derived from its records, the reader's access and their profile, and nothing a
person wrote, so nothing is lost with it.

## What the gate reports

Against every recorded baseline that declares one of these fields with no
scope, the pattern-update proof reports `scope changed` (RUN,
`deno task pattern-compat`):

- `system/fabrichat/room.tsx`, against 118 baselines: `result.canSend`,
  `result.canAdd`, `result.viewer` and `result.messageRights`, and each of
  them through `$VIEWS.room`, at whichever of those paths the baseline has;
- `system/fabrichat/placement.tsx`, against 5 baselines:
  `result.$VIEWS.chat.canSend`, `argument.room.canSend` and
  `result.room.canSend`;
- `system/fabrichat/adapter.tsx`, whose argument and result carry the
  placement, against 5 baselines: `argument.placement.$VIEWS.chat.canSend`,
  `result.$VIEWS.chat.canSend`, `result.placement.$VIEWS.chat.canSend`,
  `argument.placement.room.canSend` and `result.placement.room.canSend`.

In `tasks/pattern-compat-accepted-breaks.ts`, 105 of those 128 pairs are already
accepted for earlier FabriChat breaks. The nine entries holding them name the
paths their pairs blame beside their own, and their `reason` cites this record.
The other 23 pairs are the baselines recorded since those breaks, which no
entry named: 17 of the room's, 3 of the placement's and 3 of the adapter's.
They have entries of their own, which name this record.

A change of scope at `messageRights` is reported at that path alone, and no
longer at the paths below it. Three of the room's entries named paths below
`result.messageRights[]` and `result.$VIEWS.room.messageRights[]` for earlier
breaks, which none of their pairs blames now, and the gate refuses an entry
naming a path no pair blames. They no longer name them: one entry for
`fabrichat-pushed-messages-break.md` (six paths, under `message.reactions[]`,
`message.earlierVersions` and `message.replyTo.message`) and two for
`fabrichat-reply-split-break.md` (two paths each, under
`message.replyTo.message`).

## What it does not change

The placement's `state`, and everything a placement gates on it, stays per
user. It is derived from the reader's access alone, which the per-user record
put per user on purpose, and a session's answer differs from another's only
while its access is not known yet. The reaction tallies a placement and a
message row derive from the reader's profile, with each tally's `mine`, stay
per user as well: they are the same kind of value as `canSend`, but the
reproduction above, which stands in for an unresolved profile with a profile
only its owner may read, can't add a reaction for them to tally.

## The rulings

- 2026-10-28, @danfuzz: the room's `viewer`, `canSend`, `messageRights` and
  `canAdd` become per session (Q50-A).
- 2026-10-28, under the first ruling, by the agent coordinating the change for
  @danfuzz: the output types declare the scope, with the break accepted here,
  rather than leaving the types unscoped over per-session values, which the
  gate would not have reported.
- 2026-10-28, @danfuzz, once the per-row cost was measured: the rows'
  values stay per session in this change, and a follow-up moves the rows'
  display facts into one per-session record per room, keyed by message, and
  measures the cost again (Q51-A).
