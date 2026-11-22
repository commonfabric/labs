---
status: historical
created: 2026-11-22
archived: 2026-11-22
reason: "Record of the deliberate contract break taken when the FabriChat manager's `people` came to list the people its rooms hold only for a session that has asked for them, which the pattern-update gate reads as a changed scope against the manager's and Home's recorded baselines."
---

# FabriChat: the manager's people, for a session that has asked

The FabriChat manager's `people` listed, for each principal its rooms' rosters
attest, the profiles attesting it. It was derived per user from every listed
room's roster, one `RoomRoster` instance per room, whether or not anything
showed the people. `askedPeople`, beside it, listed the same people only for a
session that had sent `askForPeople`.

A client watches the output of every computation its runtime builds, and a
client that starts Home builds the manager's whole graph. So Home's serving
runtime ran `people`'s derivation and every room's `RoomRoster` for any client
of Home, and held about 197 documents of each room's space. With 50 rooms that
was 9,880 documents of room spaces in a cold Home runtime, against none once
the readers were gone.

`people` is now `askedPeople` under its own name
(`patterns/system/fabrichat/manager.tsx`): the people of the rooms a session
has asked about, declared `PerSession`, and no one for a session that hasn't
asked. The per-user derivation and its readers are gone.

## What the gate reports

Against each recorded baseline that declares `people` `PerUser`, the
pattern-update proof reports a changed scope at `result.people` and
`result.$VIEWS.chats.people`: 13 of the manager's baselines
(`system/fabrichat/manager.tsx`), and 42 of Home's (`system/home/home.tsx`),
whose result types its `chatManager` as `FabriChatManagerOutput`, at the same
paths under `result.chatManager`. Those are every baseline of either pattern
that declares `people` `PerUser`; the contracts recorded with this change
declare it `PerSession`, and are gated against as usual.

Five entries already named some of those baselines. The entry for the room
policy's `maxAttachments` named the `people` paths already, for its earlier
baselines, which declare `people` `PerSession`; of its baselines, only the last
now blames them. The four for the outgoing notices declared per user and for the
room handles name these paths beside their own. Each of the five cites this
record for them. The 8 manager baselines and 19 Home baselines no entry named
are named by two entries of this record's. Four older entries, for the
add-member offer and for the views declared per user, named `people` against
baselines that declare it `PerSession`. The proof no longer blames `people`
there, and the gate refuses an entry naming a path none of its pairs blames, so
those paths left those entries.

## What a running piece sees

- Nothing stored changes. `people` was derived, and the per-session
  derivation it now names is the one `askedPeople` already had.
- A host that reads `people` without sending `askForPeople` finds no one
  where it found everyone its user's rooms list. One that sends it first
  finds them as before.
- `offerRoom`, given a member by principal alone, no longer reads `people`.
  It finds the member's profiles in the roster of the direct room its user
  shares with them, and then in the roster of the room it offers, reading at
  most those two rooms. Someone its user knows only from another group room
  gets a notice where they were offered the room.
- Measured with `patterns/integration/home-interface-upgrade.test.ts` and
  `patterns/integration/fabrichat-update-rehearsal.test.ts`, an updated Home
  and FabriChat pass both.

## The decision

@danfuzz, 2026-11-22, accepting the break: "`people` becomes per-session and
is derived only from rooms a session has asked about, so a served Home no
longer reads every room's roster" (wording proposed by the lead and accepted by
Dan). Home is a required pattern, so its entry carries that ruling as its
`requiredPatternOverride`. FabriChat compatibility breaks are acceptable
until FabriChat is deployed, per his 2026-10-05 ruling: "in general it's okay
to break compatibility with pre-existing fabrichat stuff. this system has not
yet been deployed 'for realsies'". The entries forgive only the `people` paths,
and only against the baselines named. The contracts recorded with this change
are gated as usual from then on.
