---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Record of the deliberate contract break taken when a FabriChat room's messages and reactions became objects pushed onto lists, its request memory, used times, activity log, and per-user act outcomes retired with the keyed records, which strands every room storing the old shape."
---

# FabriChat: messages as pushed elements

A FabriChat room (`packages/patterns/fabrichat/room-records.tsx`) stored each
message and each reaction as a keyed record, addressed through `elementById`
under a key derived from the sender and a request id, beside a request memory,
a set of used times, and an activity log with its numbering. Each existed for
a client that never came to exist: one that proposed times from its own clock,
followed the room through the activity log, and found the message its send
produced by request id. Together they made every act read lists that grow with
the room.

A message is now an object pushed onto the room's `messages`, a reaction an
object pushed onto its message's `reactions`, a list of its own the send
makes, and each is labeled `authored-by` its writer under a policy naming the
handlers that may write it and remove it. A message or a reaction is
identified by its cell. The room keeps no memory of the events it has acted
on, since the runtime delivers each durable stream entry to its handler once
(`docs/specs/server-side-execution/events.md`, "One entry, one COMPLETED
delivery" and §4), and no activity log, since nothing read it. The plan is
`docs/history/plans/fabrichat-messages-as-pushed-elements.md`.

## What the gate reports

Against sixty-three of the room's sixty-seven recorded baselines, the
pattern-update proof reports `argument.messages[]: ifc changed`: the stored
messages' write policy named the old handlers, and the new elements' policy
names the four send handlers, `commitEdit`, `commitDelete`, and
`commitObliterate`. The four oldest report `argument.about` instead, the
break `fabrichat-start-reviewed-break.md` records. The proof reports one
issue per role, so each baseline reports one result the room no longer offers
beside its argument: `result.recentActivity` for the thirty-five that offered
the activity log, `result.messageRequests` for seven that offered the per-user
act outcomes, which the room no longer keeps, and `result.closeWindow` for
the twenty-five newest, which offered that stream at the room's top level,
which the proof reports ahead of the outcomes they offered too; the room
offers no message windows.

The placement and the adapter each report `result.$VIEWS.chat.recentActivity`
against their two baselines, the field they passed through from the room.

## Why this could not be done compatibly

The messages' policy is the point: it is what admits a push from the new
handlers and refuses every other writer. A stored message's policy names
handlers that no longer exist, and a policy a later schema changes is refused
whole (`docs/specs/ts-transformer/cfc_authoring_contract.md`,
`WritePolicyAnyOf`, rule 4). Keeping the old records beside the new ones would
keep the lists every act had to read, which is what the change removes.

## What is left behind

Every room created before this change holds messages and reactions the new
handlers cannot write. Such a room never adopts the new source: each open
proposes the release, the write-policy gate refuses it (`writePolicyAnyOf
must remain stable at /messages/*`), and the room keeps running the code it
was deployed with, so what a person sees is the old room, not a broken new
one. The rooms on deployed fabrics, including shared ones, are among them.
They are not migrated: the decision, taken on 2026-10-15, is that breaking
the rooms is acceptable, as the system has not been deployed for keeps, and
`docs/history/fabrichat-room-link-messages-break.md` records the same ruling
for the manager's link.

## The decision

The entries in `tasks/pattern-compat-accepted-breaks.ts` forgive, for each
room baseline, the messages' `ifc` beside the one result the proof names, and
for the placement and the adapter the activity field; the three entries that
forgave the start reviewed break and the view scope breaks alone are replaced,
since they could forgive nothing once the messages broke beside them. The
contracts recorded with this change are gated as usual from then on.
