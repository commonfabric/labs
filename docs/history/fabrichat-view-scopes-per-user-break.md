---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Record of the deliberate contract break taken when FabriChat's views derived under the reader's access moved from per-session to per-user scope under new binding names, which the pattern-update gate reads as a changed scope against the manager's, the room's and Home's recorded baselines."
---

# FabriChat: the views derived under the reader's access are per user

[`fabrichat-view-scopes-break.md`](fabrichat-view-scopes-break.md) recorded the
declaration of four FabriChat view fields as `PerSession`. This record follows
on from it. Those fields, and the values they are derived from, are declared
`PerUser` now, and the values derived from them are bound under new names.

## What changed

What these values have in common is that each is derived from data stored in a
space (a room's roster, its `about`, a profile's `represents-principal` label)
under the reader's own read access. A reader that space refuses derives a
different value. Read access is a property of the principal, so every session
of one user derives the same value, and one instance per user serves them all.
Per session, each tab and each reload wrote its own copy of every such value,
which nothing retires.

The values declared `PerUser`:

- in the manager (`packages/patterns/fabrichat/manager.tsx`): the `FoundRoom`
  instances the saved rooms resolve to (`FoundRoom.asScope("user")`), the
  rooms newest first (behind `rooms`), `people`, the rendered room list, and
  the outgoing notices it shows (behind `outgoingNotices`);
- in the room (`packages/patterns/fabrichat/room.tsx`): `participantEntries`,
  `participantPrincipals`, and the add control's candidates;
- the slots that receive them (`RoomManager.people`,
  `AddMemberInput.present`), and the output-type fields `rooms`, `people`,
  `participantEntries` and `participantPrincipals`.

The transient interface state (the composer, the group draft, refusals, the
reaction picker, and the two values derived from those, `shownPeople` and
`threadMessages`) stays `PerSession`.

The eight values above are bound as `foundForUser`, `roomsForUser`,
`peopleForUser`, `shownForUser`, `noticesForUser`, `candidatesForUser`,
`participantEntriesForUser` and `participantPrincipalsForUser`. The
transformer gives a `const`-bound reactive value the binding's name as its
cause, so the name is the identity of the document that stores it.

## Why the bindings were renamed

A manager or room that has run the per-session pattern holds, in each of these
values' documents, a permanent redirect from the broad slot to a per-session
instance. A position declared `user` may not follow a `session` link.

Under the old names, an updated manager whose rooms no client had read before
the update listed nothing, permanently. Its `rooms` read as `undefined` after
the update, and stayed `undefined` after a room was started, with a
`ReadOnlyAddressError` each time the rooms were derived again. The manager's
rooms were derived from the `FoundRoom` instances it had stored per session,
and reading those narrowed the derivation to the session scope, so the runtime
placed its result where its own per-user position could not read it.

Under new names each value gets a document no deployed piece wrote. Renaming
`found` alone fixed the manager in a rehearsal of the update. All eight were
renamed, so every per-user value in an updated piece is stored per user.

## What an updated manager and room do

Measured with `packages/patterns/integration/fabrichat-update-rehearsal.test.ts`
and a probe derived from it, with `main` at `ad88bbc9e3` (#9203) as the
deployed release. The probe reads every view after the update, idles, renders
Home and the room, creates a group, and reads again. These figures are for a
manager and room whose views no client read before the update:

| | `main`'s code | per user, old names | per user, new names |
| --- | --- | --- | --- |
| `rooms` after the update | listed | `undefined` | listed |
| `rooms` after a room is started | listed | `undefined` | listed |
| room's participant views | listed | listed | listed |
| `ReadOnlyAddressError` | 0 | 5 | 0 |
| `schedule-error` | 0 | 12 | 0 |
| blocked narrower link follows (warning lines) | 0 | 92 | 20 |
| scheduler runs while idle | flat | flat | flat |

With the views read before the update, both the old and the new names list
everything, with no error and the same 20 warning lines.

The 20 blocked follows under the new names come once, while the update opens
each piece, and not afterwards:

- 8 on Home's manager: `rooms` and `people`, each directly and through
  `$VIEWS.chats`, twice;
- 4 on each room: `participantEntries` and `participantPrincipals`, each
  directly and through `$VIEWS.room`;
- 2 on each room's add control: its `present` slot.

Each reads a link the piece's own stored result or argument holds to the old
per-session document, through the new per-user schema, before the new setup
rewrites it. No binding name reaches those links. A runner change that does not
read a piece's stored result under the new schema before setup would remove
them.

## What the gate reports

Against each recorded baseline that declares one of these fields per session,
the pattern-update proof reports `scope changed`:

- `fabrichat/manager.tsx`: `result.$VIEWS.chats.people`, against 15
  baselines;
- `fabrichat/room.tsx`: `result.$VIEWS.room.participantEntries`, against 25
  baselines;
- `system/home.tsx`, whose result types its `chatManager` as
  `FabriChatManagerOutput`: `result.chatManager.$VIEWS.chats.people`, against
  26 baselines.

The proof reports at most one issue per role, so it names the first field it
finds of each pattern's. Some of those pairs were already accepted for another
break whose path the proof reports beside or behind this one, and those entries
name both paths: three for `fabrichat-add-member-offer-break.md`, and thirteen
of the manager's for `fabrichat-max-attachments-break.md`, which also covers
one manager baseline recorded with the per-user scope. The rest have entries of
their own in `tasks/pattern-compat-accepted-breaks.ts`, which name this record.

## The rulings

- 2026-10-22, @danfuzz: FabriChat drops old-pattern rooms rather than migrating
  them.
- 2026-10-23, @danfuzz: on condition that an old room fails loudly, and without
  any CPU, network or memory spiral.
- 2026-10-23, @danfuzz, after the rehearsal showed an updated manager listing
  nothing:
  - the views derived under the reader's access are per user;
  - they get new document identities by renaming their bindings, rather than
    accepting an empty chat list on an updated manager, or adding an authored
    way to name a `computed`'s cause;
  - the warnings an update logs while it opens each piece are accepted.

Under these rulings no deployed room is dropped: a manager and room rolled
forward keep working. Home is a required pattern, and its entry carries the
2026-10-23 ruling as its required-pattern override.
