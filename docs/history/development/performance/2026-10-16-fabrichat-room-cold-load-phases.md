---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Investigation of where a signed-in cold load of a thirty-message, twelve-member FabriChat room spends its time on a local toolshed, October 2026: three phases of about a third each, none of them the members' profiles; the eleven name-syncs a load paid, nine of them holds of families the pre-sync had already named; and the counts and bench rows before and after the gate stopped holding on an examined absence."
---

# Where a FabriChat room's cold load goes, October 2026

The room-scale benchmark's cold load at thirty messages was 27 s on each
side of commonfabric/labs#8931, where its send halved, and the record
that pull request carries (`2026-10-fabrichat-room-send-30-profile.md` on
its branch, not in this tree as this is written) read the floor as the
twelve members' profiles, from a reactive body's read count that was the
same at every room size. This record is the
measurement that question needed: which phases the load has, what each
one does, and what the pre-sync's 3,976 list-child syncs were for.

## Setup

- The server: `dist/toolshed` built from this tree with
  `EXPERIMENTAL_SERVER_EXECUTION=false` baked in, which the room
  benchmarks refuse to run without, over a store directory of its own,
  server execution off at both ends.
- The room: `packages/patterns/integration/fabrichat-room-seed.ts`, twelve
  members, thirty messages, one thread of five replies, a reaction every
  third message, the shape the benchmark seeds. Seeding took about three
  seconds a message here, where the earlier record saw fifty.
- The client: a throwaway Deno script that opens a headless browser,
  loads the room's URL, signs in as the room's starter, attaches the
  worker profiler once the runtime worker exists, and waits for the last
  message and every member's badge, the way `RoomSession.showMessages`
  does. It writes the worker's CPU profile, `collectBrowserLoadSummary`,
  and the worker's whole logger counts. For the counts by kind, three
  temporary `logger.info` lines in the runner keyed each list-child sync
  by site, space, scheme, scope and whether its document had been synced
  before, and each hold by stage and cell. The runtime worker came from a
  dev shell served from source (`SHELL_PORT=5199 deno task dev-local`), on
  a port of its own: two other checkouts' dev shells held 5173 and 5174.
- The machine: an M3 Max with sixteen cores, never idle; its one-minute
  load was 40 to 350 across the day, and above 300 while the bench rows
  below were taken. Wall times vary by two between loads of one room, so
  what follows is counts, profile shares and the differences between arms
  run one after the other.

Every load here is the room's second or later: the benchmark's untimed
first load, which builds and commits the rows, is what a seeded room's
first visit pays once.

## Three phases, none of them the profiles

A load of the thirty-message room sampled for 24.2 s from sign-in to the
last message rendered, the worker idle 10% of it. By the outermost named
frame of each sample:

| share | frame | what it is |
| --- | --- | --- |
| 17.6% | `#syncCellsForRunningPatternInner` | the resume pre-sync: planning every node of every nested instance |
| 12.6% | `runPullSettleOrder` | the scheduler running 1,406 actions |
| 9.9% | idle | waiting on the server or the main thread |
| 9.4% | `evaluateCachedModules` | evaluating the compiled pattern closure |
| 9.0% | `handleMessage` | IPC from the main thread, mostly `vdom:mount` |
| 7.5% | `finalizeAction` | committing each action's transaction |
| 2.7% | `#syncResumeListChildren` | naming the list coordinators' children |
| 2.6% | `#kickResumeWave` | the pre-sync's sync waves |
| 2.4% | garbage collector | |

On the timeline the load has three stretches of roughly a third each:

- 0 to 9.8 s, `piece:get`: the room piece's start. Its pre-sync plans the
  tree; `#nodePlan` → `#nodeIOBinding` → `getImmutableCell` → `#findSnapshot`
  → `hashStringOf` is 2,073 of the profile's 6,348 hashing samples, since
  every node's inputs document is minted and hashed with its link schemas
  inlined. Module evaluation is 1.1 s of this stretch. Then the nested
  instances start, and nine of them are held (below).
- 9.8 to 16.3 s, `vdom:mount` and the first render, the worker 0% idle:
  `renderRoot` → `#reconcileIntoWrapper` → `#bindCellProps` → `#sinkCell`
  over the rows' trees, 4.5 s of `sink` in all, `validateAndTransform`
  2.6 s of it (1,859 samples from the sinks' first reads, 866 from lifts
  reading through `child`), `internSchema` 1.8 s (resolving `$ref`s in
  `joinSchema` and in the CFC schema walk, decomposing alias bindings,
  interning link schemas at `vdom:mount`). The room core's name-sync, held
  below, runs inside this stretch and re-plans the whole room: 1,704
  samples of `getImmutableCell` under `bind2` with the binding memo
  missing on the second walk.
- 16.3 s to the end, the settle, the worker 4% idle: `runSchedulerAction`
  3.2 s, of which `finalizeReactiveActionCommit` 1.8 s (`prepareTxForCommit`
  → `#prepareCfc`) and `#runWithStartOwnership` 1.6 s, the rows starting
  inside their list's run.

The members' profiles are not on that path. Every badge had its name
before the last message rendered; the twelve participants cost 28
cross-space slot syncs, and the 131 `cell:subscribe` requests the badges
make wait a median of two seconds not for a profile space but for the
worker, whose event-loop lag reaches five seconds while it plans and
renders. The ten-message room's second load had half the list-child syncs
(1,599 to 1,800) and half the action runs (718 to 1,083) and about the
same wall time, 22 to 25 s against 17 to 35 s: the fixed costs, not the
rows, set the floor, and the profiles are a small part of the fixed
costs.

## The 3,976 list-child syncs

By site, scheme, scope and whether the document had been synced earlier
in the same load:

| syncs | site | scheme | scope | repeat |
| --- | --- | --- | --- | --- |
| 985 + 986 | an instance's owned cell | `computed:` | space | first + repeat |
| 772 + 772 | an instance's owned cell | `of:` (handler streams) | space | first + repeat |
| 49 + 50 | a list child's result | `of:` | space | first + repeat |
| 40 + 41 | a list slot's resolution | `of:` | space | first + repeat |
| 37 + 39 | an instance's owned cell | `of:` | session | first + repeat |
| 30 + 30 | an instance's owned cell | `computed:` | user | first + repeat |
| 20 + 20 | a list child's result | `of:` | user | first + repeat |
| 20 + 20 | an instance's owned cell | `of:` | user | first + repeat |
| 12 + 16 | a list slot's resolution, another space | `of:` | space | first + repeat |
| 10 + 10 | a list slot's resolution | `of:` | user | first + repeat |
| 4 + 7 | a list slot's resolution | `of:` | session | first + repeat |
| 2 + 4 | an instance's owned cell | `computed:` | session | first + repeat |

Half of every row is a repeat: the root's pre-sync synced 1,981 distinct
documents, and the room core's name-sync synced them again. Only 28 of
them are in another space.

## Eleven name-syncs, nine of them holds

`runner/start/syncCellsForRunningPattern` counted eleven per load. Two
are the root piece's own and Home's. The other nine were holds of
`Runner.#familyAbsent` at the stage "an owned cell", every one on a family
the root's pre-sync had planned and named (`#presyncNamedInstances`), each
on a document no name-sync could deliver:

| held | cell | why absent |
| --- | --- | --- |
| the room core | a session-scoped `of:` cell with no default | the session's own instance, which no store holds before the session writes it |
| the add-member surface | a session-scoped `of:` cell with no default | the same |
| the manager core, a nested instance of two nodes, and one of one node | a session-scoped `computed:` cell, its record probed | the same |
| four nested instances of three to twelve nodes | a space-scoped `of:` cell with no value and no default, such as the cell a `wish` writes to | nothing has resolved it anywhere |

The gate took a derived cell's record for a named family
([`2026-10-13-fabrichat-row-name-syncs.md`](2026-10-13-fabrichat-row-name-syncs.md)),
and read every other owned cell's value presence. The pre-sync had asked
the store for each of these under the same identity and been told nothing;
holding on them named the family again for the same answer, and the room
core's name-sync re-planned the whole room before the room could render.

The gate now asks the replica whether an absence is one it has examined
(`IStorageProvider.unexaminedAbsences`), which counts a fresh session's own
instance of a session-scoped document as examined without asking, and
holds a named family only on an absence the replica has not examined. A
cell owed a default at a narrower scope than its owner's result still
holds the run: the hold's preparation is what seeds it, and
`packages/runner/test/resume-presync-plan-count.test.ts` pins both.

## Before and after

The same room, loaded twice on each side through the built shell, the
after side on the binary carrying the gate change; counts from the
worker's logger:

| per load | before | after |
| --- | --- | --- |
| `start/syncCellsForRunningPattern` | 11 | 2 |
| `start/resumeListChildSync` | 3,976 | 1,983 |
| `start/resumeCellSync` | 776 | 299 |
| `start/resumeInstanceNodesSync` | 11 | 2 |
| scheduler runs | 1,406 to 1,478 | 1,437 |
| commits (`commitNative`) | 220 | 217 |

In the after profile the pre-sync is 1,678 samples where it was 6,419, and
`finalizeAction` 1,970 where it was 2,742, since nine deferred starts and
their commits are gone. The after loads were taken at a one-minute load
above 300 with the worker 59% idle waiting on a starved server, so their
wall times say nothing; the bench rows below were taken interleaved.

`packages/patterns/integration/fabrichat-room-scale.bench.ts`, the `30`
row alone (`--filter '/^30$/'`), each arm on its own binary, port and
store, three pairs run one arm after the other, three measured iterations
each. The one-minute load fell through the evening as other sessions'
work ended, which is why the third pair ran the arms in the other order:

| pair | first arm | second arm | load, first to second |
| --- | --- | --- | --- |
| 1 | before 31.7 s (28.5 … 34.6) | after 29.5 s (26.2 … 35.6) | 320 → 360 → 116 |
| 2 | before 28.7 s (28.5 … 29.0) | after 24.9 s (24.3 … 25.7) | 116 → 137 → 59 |
| 3 | after 24.7 s (23.6 … 26.4) | before 25.9 s (25.6 … 26.1) | 74 → 32 → 22 |

The after arm is the faster in every pair, by 1.2 to 3.9 s, including the
pair where it ran first and the before arm had the lighter load. That is
the size of the pre-sync work the change removes, not of the load: the
three phases above remain.

The same row again the next morning, after the branch caught up with
`main` at `126a4eb0a8` (nine commits past the branch point, among them the
CFC handle and link-label changes of commonfabric/labs#8790, #8788 and
#8767): the before arm built from that `main`, the after arm from the
branch merged with it, four pairs alternating which arm ran first, at a
one-minute load of 15 to 58:

| pair | first arm | second arm | load, first to second |
| --- | --- | --- | --- |
| 1 | before 19.6 s (17.3 … 21.0) | after 16.9 s (15.7 … 17.8) | 19 → 18 → 15 |
| 2 | after 25.2 s (20.3 … 28.2) | before 22.3 s (16.2 … 26.6) | 15 → 21 → 38 |
| 3 | before 21.8 s (20.2 … 24.1) | after 26.0 s (25.2 … 26.8) | 35 → 23 → 58 |
| 4 | after 16.6 s (14.5 … 18.0) | before 24.9 s (20.5 … 27.2) | 58 → 25 → 26 |

These four pairs are inconclusive. One binary spans 16.6 to 26.0 s
across them, the after arm is the faster in two and the slower in two,
and the load moved within each pair by more than the two arms differ, so
no pair separates the arm from the machine. On this shared machine the
benchmark's `30` row cannot resolve a change of two or three seconds; the
pairs taken the evening before, at loads that fell steadily, could, and
the counts above are what the change is measured by.

A full run of the benchmark on the before binary earlier in the day, at
a lower load, gave 16.2 s (16.0 … 16.3) for `10`, 2.1 s for `send 10` and
14.4 s (14.1 … 14.9) for `30`; its `send 30` timed out after the server
received a shutdown signal from outside the run.

## What is left, and where

In order of the share each had of the 24 s load, every one of them in the
runtime:

1. The render's sinks, 4.5 s: `#bindCellProps` and `#reconcileIntoWrapper`
   over about 25 bound cells in each of thirty rows, each first read a
   `validateAndTransform`, with `internSchema` resolving `$ref`s inside
   `joinSchema` on the way. The row's tree is as wide as it is because a
   branch chosen per session cannot be stored, so every control is in the
   tree and hidden by a prop; the cost is per bound prop.
2. The pre-sync's planning, 2.8 s of hashing: each node's inputs document
   is minted and hashed with its schemas inlined, 10 to 30 KB each, and
   `#findSnapshot` hashes the whole value to find a snapshot. The binding
   memo (`NodeBindingMemo`) holds a binding from the pre-sync to the
   instantiation but missed for the room core's second walk, so a memo
   keyed on something the second walk shares would not help the first
   walk, which is most of it.
3. The settle's commits, 1.8 s of `#prepareCfc` over 812 preparations for
   1,406 runs, and 1.6 s of child starts inside the rows' list run.
4. Module evaluation, 2.3 s for the room's 1.5 MB compiled closure, once
   per cold worker.

Two things beside the load. The binary built without the posture define
answered `page.goto` after thirty seconds where the dev shell and the
binary with it answered in half a second; the benchmark's timed interval
starts after that, but every browser it opens waits it out. And the
benchmarks refuse a toolshed whose shell carries no posture define, so a
`deno task build-binaries toolshed` for them needs
`EXPERIMENTAL_SERVER_EXECUTION` set, as the Benchmarks workflow sets it.
