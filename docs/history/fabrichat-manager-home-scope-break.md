---
status: historical
created: 2026-10-12
archived: 2026-10-12
reason: "Measurements and decision record from labs #8909, whose change landed on main as #9206 and #9244 under other binding names; kept for the numbers. Record of the deliberate contract break taken when the FabriChat manager stopped deriving its rooms and people per session, which the pattern-update gate reads as a changed scope against the manager's and Home's baselines recorded since those fields declared `PerSession`, and of what the change was measured to do to Home's load and to a Home rolled forward in place."
---

# FabriChat: the manager's rooms and people are stored once for a home space's user

> **Superseded on landing (2026-10-27).** This record was written for labs #8909.
> The same change reached `main` first as #9206 (per-user `FoundRoom`, rooms,
> people and shown, in documents named `foundForUser`, `roomsForUser`,
> `peopleForUser`, `shownForUser`) and #9244 (per-user outgoing notices), with
> the output fields declared `PerUser<>` rather than left undeclared as below;
> their decision records are `fabrichat-view-scopes-per-user-break.md` and
> `fabrichat-outgoing-notices-per-user-break.md`. The names `foundRooms`,
> `rooms`, `shownRooms`, `peopleByPrincipal` and `roomRows` below never
> shipped. What #8909 still contributed is the measurement here and
> `fabrichat-manager-sessions-multi-runtime.test.ts`, which pins that a later
> session's session-scoped writes do not grow with the number of rooms; on
> `main`'s manager it passes, and against the manager as it was before #9206
> it fails on the count.

The FabriChat manager derived everything about the rooms it lists per session:
each room found (`FoundRoom.asScope("session")`), the list of rooms, their
labels, the rows rendering them, and the people their rosters hold. A page load
is a new session, so each load derived and committed all of it again.

The manager lives in its user's home space, which admits that user alone, so
every session there derives the same values. `FabriChatManagerCore` now derives
them per user, which in a home space is one instance, and
`FabriChatManagerOutput`'s `rooms` and `people` declare no scope. The session's group draft and the reason its latest
start was refused stay per session, and so does the list of people the draft's
form offers, which says whether the draft has picked each.

A manager more than one principal reads is still a case: a room's space
refuses some readers, and they derive different rooms and people. Per user,
each principal keeps its own. The core first derived these in the scope it was
created in, with such a manager created through `asScope()`. With server
execution on, at main's `560bcd9f20`, a core created with `asScope("user")` or
`asScope("session")` let a reader the room's space refuses list the room, with
the kind only a member can read (`fabrichat-manager-quiet-multi-runtime`, three
runs of three, where main passed three of three); main's own manager failed the
same way once its fixture created it with `asScope("user")`. The same scope
declared on the derived cells inside the core passes, so the core declares it
there.

## What the gate reports

Against each baseline recorded since the fields declared their scope, the
pattern-update proof reports `scope changed`:

- `fabrichat/manager.tsx`, at `result.$VIEWS.chats.people`, against six
  baselines;
- `system/home.tsx`, whose result types its `chatManager` as
  `FabriChatManagerOutput`, at `result.chatManager.$VIEWS.chats.people`, against
  eleven baselines.

The proof reports at most one issue per role, so `rooms`, which changed the
same way, is reported behind `people`. The new entries name both.

The same change makes every baseline recorded before the fields declared their
scope apply again at those paths, so the entries that forgave the declaration
against them forgive nothing, and the gate refuses an entry that forgives
nothing. This change therefore also:

- removes the manager's and Home's entries of
  `fabrichat-view-scopes-break.md`, and leaves the room's two, whose fields
  still declare their scope;
- takes `result.$VIEWS.chats.rooms` back out of the manager's three older
  entries, and `result.chatManager.$VIEWS.chats.rooms` out of Home's entry of
  `fabrichat-add-member-offer-break.md`;
- returns the two default-profile slot baselines to the slot break's entry;
- moves the one manager baseline and the one Home baseline that have `people`
  without a scope, `20261011T013628Z-pqvm47igo4Famzxe` and
  `20261011T013629Z-onNetb9BZoDKytX7`, to the entries of
  `fabrichat-add-member-offer-break.md`, whose `requests` finding they now
  report, and moves the baselines those entries named, which now report the
  scope in its place, to entries of this record's that name both paths.

## Why this could not be done compatibly

The gate compares a field's scope as part of its contract. Keeping the
declaration while storing the values once for the space would keep the gate
quiet and leave a contract that misstates where each field's value lives,
which is what the declaration was added to end.

## What a running piece sees

Measured on local dev servers (`scripts/start-local-dev.sh`), server execution
off, with a browser harness that loads a control Home and a Home holding chats
in alternation, and with the store read from a copy of the space's database.
The unchanged code is `6986fd8f47`.

- **A fresh Home.** A load writes six session-scoped documents and ten commits
  whether the Home holds no chats, six, or twelve. On the unchanged code a
  load writes 10 documents in 15 commits with no chats, 64 in 38 with six, and
  118 in 56 to 60 with twelve, about 81 KB and 160 to 172 KB.
- **Where the values land.** In the version measured, the found rooms were
  stored in the space's scope, and the list of rooms, their labels, their
  rows, and the people under the user's own key, `user:<did>`, because they
  are derived from the user's profile, which a `#profile` wish resolves per
  user. The version merged with main stores the found rooms per user as well.
  In a home space either is one instance.
- **A Home rolled forward in place.** Its root follows a `system:` origin and
  adopts the new source on its next load. A Home holding six chats, created
  on the unchanged code and loaded on this change's, lists the same six rooms
  under the same labels, and from its second load on writes the same six
  session-scoped documents a fresh Home does. That depends on the names this
  change gives the derived cells. With the names the unchanged code used
  (`found`, `newestFirst`, `shown`, `people`), and with the rows made by a
  `map()` inside the rendering, the rolled-forward Home kept writing 28
  session-scoped documents a load, 63 KB: the list of found rooms it stored
  holds links declared per session, and a read through one narrows what is
  derived from it to the session, while a cell that stored a link to its own
  per-session instance keeps writing behind that link. The cells are named
  `foundRooms`, `rooms`, `shownRooms`, `peopleByPrincipal`, and `roomRows`
  for that reason.
- **Readers.** A reader that demands `rooms` or `people` follows the link at
  that path to the value wherever it is stored. The room's own
  `RoomManager.people` still declares `PerSession`, and reads the stored value.
- **A served handler.** `offerRoom` reads `people` to offer a room to a member
  named by address alone. With server execution on, a served run of it found
  no one listed while `people` was per session, and queued a notice. Stored
  once for the space, before the merge with main, it read the stored value and
  offered the room under either posture. Stored per user, as merged, a served
  run cannot read the user's instance either, and queues a notice as on main;
  `fabrichat-add-offer` across runtimes and `fabrichat-join` in two browsers
  keep main's expectations.
- **Server execution on.** `fabrichat-manager-sessions` across runtimes counts
  the documents a later session of the same user writes in its own scope in
  the manager's space. On this change it is the same with one room and with
  three, under either posture. On the unchanged code it is 19 and 37 with
  server execution off, nine a room, and 10 and 12 with it on, one a room. With
  it on, on either code, the serving loop also writes 12 documents in the
  session's scope in each room's own space, the room's per-session state,
  which this change leaves as it is.

## What it does to Home's load

Twelve chats, six loads of each Home on each of two server pairs, the
unchanged code and this change, measured in alternating invocations on one
machine under heavy load from other work (load average 370 to 415). Milestones
are medians, as a ratio to the control Home loaded in the same invocation.

| | unchanged | this change |
| --- | --- | --- |
| session-scoped documents written per load | 118 | 6 |
| commits per load | 56 to 60 | 10 |
| scheduler action runs (control) | 157 to 187 (83) | 113 (77) |
| `storage.v2/watchRefresh/watchAddSync` (control) | 179 to 198 (62 to 66) | 161 to 186 (61 to 65) |
| `runner/start/resumeListChildSync` (control) | 215 (14) | 287 (11) |
| `runner/start/syncCellsForRunningPattern` (control) | 16 (4) | 4 (4) |
| Home first painted | 1.61x (1.29 to 1.95) | 1.93x (1.83 to 2.17) |
| rooms listed | 2.26x (1.89 to 2.61) | 1.93x (1.83 to 2.17) |
| every opened space synced | 2.44x | 2.19x |
| renderer CPU over the control | 4.70 s | 4.04 s |
| toolshed CPU over the control | 1.57 s | 1.00 s |

The writes are gone, and the rooms are listed sooner. Home itself paints
later: the rooms now arrive with the first paint, where on this machine they
arrived about three seconds after it, and the first paint waits for them. The runtime syncs
what a resumed piece's stored derivations read before it starts the piece, and
those now include the rooms' spaces. Most of what a chat costs a load is
unchanged, because it is reading: each room's space is opened and watched on
every load whether or not anything is derived again.

At six chats, three loads each, run one arm after the other, the times do not
separate the two arms: rooms listed at 1.62x to 2.37x on the unchanged code and
1.72x to 3.01x on this change, and renderer CPU over the control at 2.5 s and
2.4 s.

## The decision

Berni, 2026-10-12, directing the change: "the manager lives in the user's Home
space, which is already per user, so its derived state can stay per space."
FabriChat compatibility breaks are acceptable until FabriChat is deployed, per
@danfuzz's 2026-10-05 ruling, which `fabrichat-view-scopes-break.md` quotes.
Home is a required pattern, so its entries carry the 2026-10-12 ruling as
their `requiredPatternOverride`. The entries in
`tasks/pattern-compat-accepted-breaks.ts` forgive only the paths above, and
only against the baselines named. The contracts recorded with this change are
gated as usual from then on.
