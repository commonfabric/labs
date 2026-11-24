---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Record of the deliberate contract break taken when the FabriChat manager gained `offerRoom` and its request outcomes a `delivery` and a `shared-inbox` refusal code, which the pattern-update gate reads as a narrowing of the manager's and Home's recorded `requests`, and of what a Home rolled forward in place sees, the manager's stored records emptied by any roll to changed manager code among it."
---

# FabriChat: a room's add is offered through the adder's manager

A room's `addMember` now has the adder's chat manager tell the person added of
the room, through the manager's new `offerRoom` stream, and the room's
`addRequests` reads back how they were told. The manager records that verdict
as a request outcome:

- `ChatRequestOutcome`'s `done` gained `delivery?: "offered" | "noticed"`;
- `ChatRefusalCode` gained `shared-inbox`, the code `createGroup` refuses with
  when profiles of two people point at the same share inbox;
- `FabriChatManagerOutput` gained the `offerRoom` stream.

The room's own contract changes too (`addMember`'s `profile`, and `delivery` and
`deliveryRefusal` on a done add), but the gate reads it as compatible with
every recorded room baseline: the room only needs a new baseline.

## What the gate reports

Against each recorded baseline, the pattern-update proof reports "a schema
alternative accepted previously is not accepted by the candidate":

- `fabrichat/manager.tsx`, at `argument.requests.*`, against six baselines.
  Five of them also report `result.$VIEWS.chats.requests.*`, and the one that
  has `people`, `20261011T013628Z-pqvm47igo4Famzxe`, reports
  `result.$VIEWS.chats.people` instead, as it did before.
- `system/home.tsx`, whose result types its `chatManager` as
  `FabriChatManagerOutput`, at `result.chatManager.$VIEWS.chats.requests.*`,
  against six baselines.

The recorded outcomes left a `done` outcome's extra fields open, and typed a
refusal's `code` as `space-own-chat` alone. So a stored outcome admitted a
`delivery` or a `code` of any value, and the candidate admits only the values
it names. No outcome stored before this change holds either.

The proof reports at most one issue per role, so for four of the manager's
baselines the result role now blames `requests` where it blamed `rooms`, and
for four of Home's it blames `chatManager…requests` where it blamed
`chatManager…rooms`. The manager's entries those baselines already carried,
under `fabrichat-room-link-roster-break.md` and
`fabrichat-view-scopes-break.md`, name the new path beside their own and cite
this record for it. The four Home baselines move from the entry of
`fabrichat-view-scopes-break.md` to one of this record's naming both paths, as
that record moved two of its own. The manager's and Home's baselines recorded
with `fabrichat-view-scopes-break.md`, and Home's recorded with the action that
replaces a refused private inbox, carry no entry before this one, and get
entries of this record's.

## Why this could not be done compatibly

The gate reads any type given to a field the recorded schema left open, or any
value added to an enumeration it closed, as a narrowing, and each of these is
the contract the change exists to state. A verdict left untyped would be one
the native client cannot rely on, and so would a refusal code that is not
named.

## What a running piece sees

Measured with a `PiecesController` driving a fixed identity against a
source-run toolshed and shell (`scripts/start-local-dev.sh`), with the servers'
data kept across a restart onto the newer source:

- Home follows a `system:` origin, which adopts a new release with no
  compatibility check and no step from the user. Its root, on servers built
  from `49c8d65016`, ran pattern `JxdiGg…` with origin `system:system/home.tsx`,
  and its `chatManager` had no `offerRoom`. After a restart on this change's
  source, the same Home entity ran pattern `7Zmk6b…`, the toolshed's
  `?identity` for `system/home.tsx`, with the same origin, and its
  `chatManager` had `offerRoom`.
- The rolled-forward Home delivers `chatManager.requests` with `delivery`: an
  `offerRoom` of a room its catalog lists, naming a member it shares no room
  with, recorded `{ "status": "done", "delivery": "noticed" }`, and queued the
  notice.
- A roll to changed manager code leaves the manager's stored records empty,
  and keeps Home's own. This change's roll left `requests` empty, though it
  is the same document. A Home seeded with a profile, its private inbox, one
  refused request, and a direct room with a counterpart who has no profile,
  which the manager records in `requests` and `direct`, lists in Home's
  shared-space catalog, and queues a notice for, was rolled three ways: from
  `ee09b094e6` to `49c8d65016`, the change `fabrichat-view-scopes-break.md`
  records, and from `49c8d65016` to it plus `delivery` alone, and to it plus
  an added manager input with a `Default`. Each gave the same results:
  - the manager's `requests` read `{}` after the roll, its `direct` `{}`, and
    its `outgoingNotices` `[]`, the last now a link to a different document;
  - Home's shared-space catalog kept the room's entry, `privateInbox` kept its
    inbox, and `profiles` kept the profile, each unchanged;
  - the manager's `rooms` still listed the room, from the catalog, but without
    its counterpart, which only `direct` held;
  - an `openDirect` with the same counterpart after the roll created a second
    direct room, in a space of its own, which `direct` then held, and the
    catalog then listed both rooms.
- Rolling to a Home differing only in a comment in `home.tsx` kept `requests`.
- The room's views read the manager's verdict per user, from the reader's own
  manager. With server execution off and on, `fabrichat-add-offer` across
  runtimes shows the adder reading `offered` through the room, and another
  member reading none of the adder's adds.

## The decision

@danfuzz, 2026-10-11, on taking Home's part of the break: "assuming the
contract breakage can be automatically handled the way the previous one was,
then that's okay." FabriChat compatibility breaks are acceptable until
FabriChat is deployed, per his 2026-10-05 ruling: "in general it's okay to
break compatibility with pre-existing fabrichat stuff. this system has not yet
been deployed 'for realsies'". Home is a required pattern, so its entries carry
the 2026-10-11 ruling as their `requiredPatternOverride`. The entries in
`tasks/pattern-compat-accepted-breaks.ts` forgive only the paths above, and
only against the baselines named. The contracts recorded with this change are
gated as usual from then on.
