---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Measurement of the thirty-message FabriChat room's cold load on main after the day's three schema changes, October 2026: every count unchanged and the worker's busy samples down by a quarter; the ranking of what is left, with the per-row piece as the work a load could avoid altogether; and a room whose stored source differs from the deployment's failing every row's start on every load, because the update's stored-argument validation refuses a bigint slot holding an epoch-nanoseconds envelope."
---

# The FabriChat room's cold load after the schema changes, October 2026

Three changes landed or were pending on the day this was measured, each
aimed at a share the earlier records had named
(`2026-10-16-fabrichat-room-cold-load-phases.md`,
`2026-10-16-fabrichat-room-cold-load-local-session-documents.md`): a plan's
inputs document keeps its schemas as references and a node binds once per
load (commonfabric/labs#9020), a schema's confidentiality join is kept per
schema and a resolved definition view is frozen (commonfabric/labs#9025),
and two follow-ups of the second that freeze the inherited-definitions view
and mint a resolved definition view once per definition body. This record
measures the signed-in cold load of the same thirty-message, twelve-member
room with all of them in, ranks what is left, and reports a failure the
measurement ran into on the way.

## Setup

- One toolshed built from `main` at `e1f82339ed` with the two follow-ups
  cherry-picked on top (`5ed13063ff`, `a7f5702871`),
  `EXPERIMENTAL_SERVER_EXECUTION=false` baked in, `localSessionDocuments`
  off, over a store directory of its own.
- One room seeded by that binary with `fabrichat-room-seed.ts`, the
  benchmark's shape. Seeding took ten minutes where the morning's took two
  and a half: the machine's one-minute load was 300 to 560 throughout, from
  other sessions' test suites, and every wall time here is read with that
  in mind. Counts and profile shares are the evidence.
- Three loads with the earlier records' harness, on the arm's own built
  shell, the first discarded as the load that builds the rows.

## What a load pays

Every count the earlier records compared is the same as the morning's
`main` (`0b8e0561e6`): name-syncs 2, list-child syncs 1,663, cell syncs
285, scheduler runs 1,157, commits 190, CFC preparations 615, watch
additions 232 to 245. The changes removed work from inside those counts,
not the counts themselves.

The worker profile of the second load, against the morning's second load:

| per load | morning's main | after the changes |
| --- | --- | --- |
| samples not idle | 16,455 | 12,665 |
| `sink` (the render's and the host's subscriptions) | 5,141 | 3,005 |
| `hashOfInternal` | 2,479 | 1,747 |
| `validateAndTransform` | 2,387 | 1,608 |
| `joinSchema` | 761 | 278, all under module evaluation |
| pre-sync planning (`#cellsPatternNodes`) | 1,346 | 535 |
| scheduler runs (`runPullSettleOrder`) | 2,101 | 2,055 |
| module evaluation | 1,324 | 1,506 |
| `finalizeAction` | 1,274 | 1,028 |
| sign-in to last message, loads two and three | 25.0 s, 27.8 s | 16.5 s, 14.7 s |

A quarter of the busy samples are gone, two fifths of the sinks' among
them. The schema join now runs only where a pattern is built at module
load, and the pre-sync's planning is a third of what it was. The wall
fell further than the samples did, at a higher machine load, which the
samples do not explain and the load does not let this record claim.

## What is left, by what a load does

By the outermost frame, of the 12,665 busy samples:

1. Subscriptions, 3,005 samples, about a quarter. Every one is
   `subscribeToReferencedDocs`: each time a sink fires it reads its cell
   through `validateAndTransform` in a transaction of its own, the whole
   value with its schema, and the render fires 1,326 element-props sinks
   a load. Two fifths fire from the host's requests, a fifth from the
   render root, the rest from the replica's notifications.
2. Scheduler runs, 2,055 samples, a sixth: the rows' list reconcile
   starting its children (894, of them `#startWithTx` 77%), the patterns'
   own derivations (606), and the rest the run's bookkeeping.
3. Module evaluation, 1,506 samples, an eighth, once per cold worker: the
   compartment linking the room's 1.5 MB closure (`requireShim`, 884) and
   building its patterns at load (`trustedPattern`, 462: the schema join,
   interning and hashing a pattern does when it is made).
4. Commit finalization, 1,028 samples, a twelfth, 86% of it
   `prepareBoundaryCommitSteps` inside `#prepareCfc`.
5. The pre-sync, 910 samples, a fourteenth, of which planning is 535 and
   the list children 352; and beside it, under its own frame, the resume
   wave's family-cell syncs, 377 samples.

Two costs cut across those: hashing, 1,747 samples, three quarters of it
`cachedFrozenObjectHashElseUndefined` computing a frozen object's hash
for the first time, under the settle (26%), module evaluation (17%) and
the pre-sync; and schema-driven validation, 1,608 samples, under the
subscriptions, the settle and the host's requests.

## What a load could avoid

Reading the list as work rather than as frames:

- A sink that re-reads its whole value on every fire. The read is the
  same `validateAndTransform` the value's first reader paid, in a fresh
  transaction, so nothing is reused between fires or between sinks of one
  document. A validated view kept per document version and schema
  identity, handed to every sink of that document until the document
  changes, removes most of the quarter. This is the next mechanical lever.
- A row that is a piece. Thirty nested instances are what the list
  reconcile starts, what the pre-sync plans and syncs, what the settle
  commits, and what the session-scoped derivations of the earlier record
  are derived for. A row that is a view over its message's cell, with no
  instance of its own, would take the child starts, their commits, their
  share of the pre-sync and the per-row session documents out of the load
  together, about a third of the busy samples. That is a change to the
  pattern's shape and to what the runtime offers a list of rows, not a
  runtime optimization.
- A pattern built at module load. `trustedPattern` joins, interns and
  hashes each pattern's schemas every time a cold worker evaluates the
  program; the compile cache that hands the worker the program could hand
  it those artifacts too.
- A hash computed for an object the replica already knows. The settle
  hashes values the commit was built from and the pre-sync hashes inputs
  documents; where the hash exists on the other side of a boundary it
  could travel with the value.

The bench row was not run: the counts are unchanged, and the wall cannot
be read on this machine on this day.

## A room whose stored source differs from the deployment's

The first attempt at this measurement loaded the morning's seeded room
with the new binary, to spare the seed. Every load failed the start of
all thirty message rows (`piece-start-commit-failed`, thirty a load), the
name-syncs rose from 2 to 32, the cell syncs from 285 to 1,905, the
scheduler runs fell to 163, and a load took 110 to 170 s. The server
rejected nothing; the failure is a refusal thrown on the client. A
binary built from `main` alone did the same on a copy of that store, and
the morning's binary did the same on the room the new binary had seeded,
so the refusal belongs to no change of the day. A Deno runtime opening
the same room through the pieces controller started every row, since it
reconciles no source.

The text of the refusal, captured by forwarding the worker's console
with the error's message appended to the log line:

```
updated arguments do not match the candidate schema: params: places:
fid1:W0Lyxt77-Ppbq56zhHNRYjRHbgNBscWzQPb4o1xdSfg: latestReplyAt: value does
not match type integer|null
```

The day's room change (commonfabric/labs#8997, a composer disabled until
the viewer's right to send is known) moved the room's source, so the
shell's `piece:get` reconciled every room it opened to the deployment's
program, and each row was set up again with the argument its parent
carries: `Runner.#restageOverStoredSlots`, which judges the stored
argument against the new schema with `storedArgumentValidationIssue`. A
row's argument carries the room's `places` map; a thread root's entry
holds `latestReplyAt`, declared `bigint` in `logic.ts` and so typed
`integer` in the schema, and written as an epoch-nanoseconds envelope
(`{"/EpochNsec@1": …}`). The validator's `typeMatches` reads `integer`
as `Number.isInteger(value)`, which no envelope passes. A first start
never judges its stored argument, so the mismatch is latent until a
source change, and then every row fails on every load, since the failed
update never lands. Any deployed room with a thread will meet it on the
next deploy that moves the room's source. The fix belongs to the
validator, or to the schema the pattern's `bigint` is given, and the
pattern-update gate wants a room with a thread among its vintages.
