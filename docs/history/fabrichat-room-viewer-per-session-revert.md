---
status: historical
created: 2026-10-29
archived: 2026-10-29
reason: "Record of the deliberate contract break taken when the change that made a FabriChat room's answers about its reader per session was reverted, which the pattern-update gate reads as a changed scope against the three baselines that change recorded."
---

# FabriChat: the per-session reader answers, reverted

[`fabrichat-room-viewer-per-session-break.md`](fabrichat-room-viewer-per-session-break.md)
recorded a room's `canSend`, `viewer`, `messageRights` and `canAdd`, the values
its rendering derives from them, and a placement's `canSend` moving from per
user to per session, under new binding names (#9360). This record is of that
change's revert.

## Why it was reverted

After #9360 merged, two of `main`'s continuous-integration runs failed
`fabrichat-join`'s "offers a group to someone its owner adds from the room,
through the owner's manager" with server execution on: the room's add control
never became visible to its owner (`Timed out filling cf input
"#fabrichat-add-member-address"`). One of those runs also failed
`fabrichat-spaces-multi-runtime`'s "refuses an add to a direct room, even from
its counterpart's own control" with server execution off, reading the room's
`canAdd` as `undefined` where it expected `false`.

Run locally with server execution on, `fabrichat-join` failed the same way
once in six runs at #9360's merge, and passed five of five at its parent
(RUN). Why the owner's add control sometimes never showed was not found. With
`main` failing in two lanes for a reason not understood, the change was
reverted rather than fixed forward.

## What changed

`patterns/system/fabrichat/room.tsx` and
`patterns/system/fabrichat/placement.tsx`, the three FabriChat specs, and the
FabriChat entries #9360 changed in `tasks/pattern-compat-accepted-breaks.ts`
are as they were before #9360. The values are per user again, under their
earlier binding names. The per-session viewer test and its fixture are
removed.

One line differs from the code before #9360: the room's `isOwner` defaults to
`false`. The rows' map takes it as an argument, and a room whose rows were
stored by #9360's code holds `isOwnerForSession` there instead. Without the
default, the update rehearsal below logged 20 refused commits, each
`cfc-schema-migration-incompatible: required field isOwner needs a default to
preserve old documents` (RUN, a CFC denial listener in a copy of the test).

The bug #9360 fixed returns with the revert: a session whose `#profile` hasn't
resolved can again tell the person's other sessions that they can't send.

## What stays

The three baselines #9360 recorded stay, since a recorded contract is never
removed, and so does its record. The update rehearsal keeps its reads of the
group room's `canSend`, directly and through `$VIEWS.room`.

## What an updated room does

`patterns/integration/fabrichat-update-rehearsal.test.ts` was run with its
deployed release refreshed to `main` at `e83332a2f1`, which carries #9360's
per-session code, so it rehearses the revert itself. Moving a value back to a
broader scope under its earlier name was the risk: a room #9360's code ran
holds result slots linking to session-scoped documents, and a position
declared at the user scope may not follow a link to the session scope, which
made an updated manager read `undefined` in the update
[`fabrichat-view-scopes-per-user-break.md`](fabrichat-view-scopes-per-user-break.md)
records.

That did not happen here. In both of the rehearsal's runs, with the views read
before the update and without, the group room's `canSend` reads `true`,
directly and through `$VIEWS.room`, before and after the update and after a
room is started since; Home and each room adopt the tree's source; nothing
logs a refused transition, a dropped stored slot or a failed start; and every
stored slot reads back (RUN). The log holds no `ReadOnlyAddressError` and no
`schedule-error` (RUN).

## What the gate reports

Against the three baselines #9360 recorded, the pattern-update proof reports
`scope changed` (RUN, `deno task pattern-compat`):

- `system/fabrichat/room.tsx`, against `20261029T035049Z-H1WYs_4rIJVXq3N5`:
  `result.canSend`, `result.canAdd`, `result.viewer` and
  `result.messageRights`, and each of them through `$VIEWS.room`;
- `system/fabrichat/placement.tsx`, against
  `20261029T012601Z-DvhNFxSKBXqtZjw2`: `argument.room.canSend`,
  `result.room.canSend` and `result.$VIEWS.chat.canSend`;
- `system/fabrichat/adapter.tsx`, against
  `20261029T012601Z-IIPTt7RKzLCix33Y`: `argument.placement.room.canSend`,
  `argument.placement.$VIEWS.chat.canSend`, `result.placement.room.canSend`,
  `result.placement.$VIEWS.chat.canSend` and `result.$VIEWS.chat.canSend`.

Each has an entry of its own in `tasks/pattern-compat-accepted-breaks.ts`,
which names this record. Every other FabriChat entry is as it was before #9360.

## The rulings

- 2026-10-29, @danfuzz decided to revert.
