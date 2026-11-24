---
status: historical
created: 2026-10-29
archived: 2026-10-29
reason: "Record of the deliberate contract break taken when a FabriChat room's `#profile` wish and its answers about its reader moved to per-session scope, after an earlier per-session change was reverted, which the pattern-update gate reads as a changed scope against the room's, the placement's and the adapter's recorded baselines."
---

# FabriChat: the reader's profile wish and answers, per session

[`fabrichat-room-viewer-per-session-break.md`](fabrichat-room-viewer-per-session-break.md)
recorded a room's `canSend`, `viewer`, `messageRights` and `canAdd` moving to
per session (#9360), and
[`fabrichat-room-viewer-per-session-revert.md`](fabrichat-room-viewer-per-session-revert.md)
its revert. This record is of the change that makes them per session again,
together with the room's `#profile` wish they are derived from.

## What changed

- The room's and the placement's `#profile` wishes are declared
  `wish<PerSession<…>>`. A wish that reads Home is at least user-scoped unless
  its schema selects a scope (`docs/common/conventions/wish.md`), so the wish's
  state is now each session's own.
- The room's `canSend`, `viewer`, `messageRights` and `canAdd`, and the values
  its rendering derives from them, are per-session computeds under new binding
  names (`canSendForSession` and the rest), as #9360 had them. `canSend` and
  `canAdd` default to `false`, `messageRights` to `[]`, and `isOwner` to
  `false`. The rights follow #9358's rule.
- The room derives one per-session record, `rowFactsForSession`, keyed by
  message, of which of each row's edit, delete and obliterate controls show and
  whether its editor does. A row reads its own entry rather than deriving its
  rights and four displays itself.
- The output types declare the scope, as #9360's did.

## Why the wish

A session whose `#profile` wish finds no profile, or fails, writes that state
into the wish's document. Stored per user, that document is the one every
session of the same person reads, so the failure reaches the sessions that
found the profile, and they derive "no profile" from it.

`patterns/integration/fabrichat-room-profile-wish-multi-runtime.test.ts` shows
this (RUN). One runtime acts as a profile its home does not list, so its wish
fails; another of the same person's runtimes found the profile. The test then
checks, in this order, that the room's stored `viewer` the second runtime reads
still holds the profile, and that the first runtime's room offers the
profile-setup form. At `d0ba3b63a0`, 10 runs of each design:

| design | server execution off | on |
| --- | --- | --- |
| `main` at `9b1cf10426` (everything per user) | red, 10 of 10 | red, 10 of 10 |
| values per session, wishes per user (#9360's design) | red, 10 of 10 | red, 10 of 10 |
| this change (wishes per session too) | green, 10 of 10 | green, 10 of 10 |

With server execution off, both alternatives fail at the stored `viewer`. With
it on, they fail at the setup form: one served per-user wish answers both
runtimes and finds the person's profile, so the failing runtime is offered no
form. The test as first written showed the overwrite with server execution off
only, since it had no setup-form check yet.

## What it costs

Documents reachable from a room's rendering, by scope, counted as distinct
documents, in one session (RUN):

| | space | session | user |
| --- | --- | --- | --- |
| `main`, 0, 1, 2 messages | 18, 53, 87 | 17, 21, 25 | 8, 15, 20 |
| this change, 0, 1, 2 messages | 18, 53, 87 | 23, 30, 35 | 2, 3, 3 |

Per room, six documents move from per user to per session. Per message row,
`main` holds four per-session and five per-user documents, and this change five
per-session and none per user. A per-session document is written once for
each session that reads it, per tab and per reload, and nothing retires it;
a per-user one is shared by every session of its user. So the cost to weigh is
one more per-session document per row, even though a row's total drops from
nine to five. The fifth is the row's reaction tallies, whose "mine" reads the
reader's profile; the room's record could take it over.

## What the gate reports

Against every recorded baseline that declares these fields with no scope, the
pattern-update proof reports `scope changed` (RUN, `deno task pattern-compat`):
the room against 124 baselines, at `result.canSend`, `result.canAdd`,
`result.viewer` and `result.messageRights` and each of them through
`$VIEWS.room`; the placement against 5, at `result.$VIEWS.chat.canSend`,
`argument.room.canSend` and `result.room.canSend`; and the adapter against 5,
at the same three under `placement` and at `result.$VIEWS.chat.canSend`.

Of those 134 pairs, 105 are held by the nine entries that already held them
for earlier FabriChat breaks, which now also name these paths and cite this
record. The other 29 have entries of their own: 23 of the room's, 3 of the
placement's and 3 of the adapter's. The three entries the revert added, over
the baselines #9360 recorded, forgive nothing now, since this change's
contracts declare the same scopes as those baselines, and are removed. Three
room entries stop naming paths below `messageRights[]`, as #9360's change had
them, since a change of scope at `messageRights` is reported at that path
alone.

## The rulings

- 2026-10-29, @danfuzz: the room's `#profile` wish, and the placement's,
  declared per session at the pattern level, with no runtime change (Q66-A).
- 2026-10-29, @danfuzz: the change lands after #9358 (Q67-A).
