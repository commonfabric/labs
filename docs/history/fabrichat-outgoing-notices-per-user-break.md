---
status: historical
created: 2026-10-24
archived: 2026-10-24
reason: "Record of the deliberate contract break taken when the FabriChat manager's outgoing notices were declared per user in its output type, which the pattern-update gate reads as a changed scope against the manager's and Home's recorded baselines."
---

# FabriChat: the manager's outgoing notices are declared per user

[`fabrichat-view-scopes-per-user-break.md`](fabrichat-view-scopes-per-user-break.md)
recorded the FabriChat values derived under the reader's access moving to per
user scope. This record follows on from it, and completes it for one field.

## What changed

The manager's outgoing notices leave out a notice whose room's roster attests
its recipient. The roster is read under the reader's own access, so the list is
one of those values. The value behind it, bound as `noticesForUser` in
`packages/patterns/fabrichat/manager.tsx`, was declared `PerUser` with the
others, but the output type's field was not:
`FabriChatManagerOutput.outgoingNotices` stayed `ChatManagerNotice[]`. It is
`PerUser<ChatManagerNotice[]>` now. `docs/specs/fabrichat/ChatManagerOutput.md`
gives the field that type, and its Scopes section lists `outgoingNotices` with
`rooms` and `people`.

No binding changed, so the documents a deployed manager stores for the notices
are the ones the per-user record already gave them.

## Why it was a change of its own

The per-user change left this field undeclared on purpose. The pattern-update
proof then reported at most one issue per role for each baseline. Declaring the
field puts a new `scope changed` first in the result role for every manager and
Home pair the registry held: 26 manager baselines and 49 of Home's, 75 pairs in
13 entries (RUN: the one-issue proof over this change's contracts and `main`'s
registry). Under that proof those 13 entries would have forgiven nothing until
each named the path as well. Each would then have forgiven, behind the path it
named, every later break the proof did not report.

`pattern-compat-every-issue-paths.md` records the proof reporting every issue,
and an entry naming exactly the paths its pairs blame. With that in place, this
declaration needs exactly the entries its paths call for.

## What the gate reports

Against every recorded baseline that types the field without a scope, the proof
reports `scope changed` at two paths (RUN, `deno task pattern-compat`):

- `fabrichat/manager.tsx`, against all 27 of its baselines:
  `result.outgoingNotices` and `result.$VIEWS.chats.outgoingNotices`;
- `system/home.tsx`, whose result types its `chatManager` as
  `FabriChatManagerOutput`, against the 51 baselines recorded with a
  `chatManager`: `result.chatManager.outgoingNotices` and
  `result.chatManager.$VIEWS.chats.outgoingNotices`.

In `tasks/pattern-compat-accepted-breaks.ts`, 75 of those 78 pairs are already
accepted for earlier FabriChat breaks. The 13 entries holding them name these
two paths beside their own, and their `reason` cites this record. Seven of the
entries are the manager's, and six are Home's. The other three pairs are the
baselines the per-user change recorded, which no entry named: one manager
baseline and two of Home's. They have entries of their own, which name this
record.

## What an updated manager does

`packages/patterns/integration/fabrichat-update-rehearsal.test.ts` was run with
its deployed release refreshed to `main` at `71ed556a5d` (#9239). It now also
reads the manager's `outgoingNotices`, directly and through `$VIEWS.chats`,
before and after the update and after a room is started since. In both of its
runs, with the views read before the update and without, the notices list every
seeded recipient after the update, as before it, and the new room's member is
added. Its other checks hold as well: Home and each room adopt the tree's
source, nothing logs a refused transition, a dropped stored slot or a failed
start, and every stored slot reads back (RUN). How many blocked link follows the
update logs was not measured. The test's log at `LOG_LEVEL=warn` shows none
even for a deployed release from before the per-user change, which the earlier
record measured at 20 lines, so that log cannot settle the count.

## The rulings

- 2026-10-24, @danfuzz, on the per-user change's review: `outgoingNotices`
  stays undeclared there, and a follow-up declares it (Q8-A, then Q8-B for the
  follow-up's shape).
- 2026-10-24, @danfuzz: the follow-up runs as two changes in turn. First the
  update proof reports every issue in each role, and then `outgoingNotices` is
  declared `PerUser` with the entries that needs (Q9-B).

Home is a required pattern. Its new entry carries the second ruling as its
required-pattern override. The six Home entries that name these paths beside
their own keep the overrides they carry.
