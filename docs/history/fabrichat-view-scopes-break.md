---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Record of the deliberate contract break taken when the FabriChat manager's and room's per-session view fields declared their scope, which the pattern-update gate reads as a changed scope against the manager's, the room's and Home's recorded baselines."
---

# FabriChat: the per-session view fields declare their scope

Four fields of FabriChat's views are derived per session. Readers with
different access derive different values, and the computed that derives each
one was already declared `PerSession`:

- the manager's `rooms` and `people` (`packages/patterns/fabrichat/manager.tsx`);
- the room's `participantEntries` and `participantPrincipals`
  (`packages/patterns/fabrichat/room.tsx`).

The output types declared those fields as plain values, so the recorded
contract did not say they were per session. They are now declared
`PerSession<…>` in `FabriChatManagerOutput` and `ChatRoomView`, and in the
specs that mirror them.

## What the gate reports

Against each recorded baseline that has one of these fields, the
pattern-update proof reports `scope changed` at the field's path:

- `fabrichat/room.tsx`: `result.$VIEWS.room.participantPrincipals` or
  `result.$VIEWS.room.participantEntries`, against six baselines;
- `fabrichat/manager.tsx`: `result.$VIEWS.chats.rooms`, or
  `result.$VIEWS.chats.people` against the one baseline that has `people`, ten
  baselines in all;
- `system/home.tsx`, whose result types its `chatManager` as
  `FabriChatManagerOutput`: the same paths under `result.chatManager`, against
  23 baselines.

The proof reports at most one issue per role, so a baseline that has both of
a pattern's fields reports only one of them. An entry names both fields only
for the baselines that have both, and names one for the baselines that have
one.

Eleven baselines already carried an accepted break of their own: nine of the
manager's, under its three `argument.requests.*` breaks, and two of Home's,
under its default-profile slot break. The manager's findings now blame the
scope change beside their own paths, so each of those three entries names
`result.$VIEWS.chats.rooms` beside its own path and cites this record for it.
The two Home findings now blame the scope change where they blamed
`result.defaultProfile`, so those two baselines move to an entry of this
record's that names both paths, and the slot break's entry keeps its other
three baselines.

## Why this could not be done compatibly

The gate compares a field's scope as part of its contract, and any declaration
of the scope these fields already have changes it. Leaving the declarations
off would keep a contract that misstates where each field's value lives.

## What a running piece sees

These were measured while the change was being decided.

- Readers see nothing new. A client that demands the fields with its own
  schema, plain arrays with no scope, reads each session's own values with or
  without the declarations, with server execution off and on. A handler that
  captures a whole room or manager as state receives it either way.
- Home follows a `system:` origin, which adopts a new release with no
  compatibility check. A Home rolled forward in place to a manager whose
  `rooms` declares its scope still delivers `chatManager.rooms`, from the new
  code. `cf piece setsrc` and `checkPattern()` do refuse the change, as
  `scope changed`.
- Nothing is stored at these paths for a reader to refuse: each value is
  derived per session, and stored as that session's own instance, as before.

## The decision

@danfuzz, 2026-10-10, choosing to declare the scope once the measurements were
in: "it looks like (b) is more correct to me", and "(a) sounds good". FabriChat
compatibility breaks are acceptable until FabriChat is deployed, per his
2026-10-05 ruling: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed 'for
realsies'". Home is a required pattern, so its entry carries his 2026-10-10
ruling as its `requiredPatternOverride`. The entries in
`tasks/pattern-compat-accepted-breaks.ts` forgive only the scope paths, and
only against the baselines named. The contracts recorded with this change are
gated as usual from then on.
