---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Measurement of the FabriChat room cold load on main after commonfabric/labs#8993 with `localSessionDocuments` off and on, October 2026: the flag keeps the session derivations out of the server store as designed and changes nothing a load pays beyond the three commits that no longer travel, because the 167 other commits it empties still carry shared reads and travel for validation."
---

# The FabriChat room cold load with session documents kept local, October 2026

`docs/history/development/performance/2026-10-16-fabrichat-room-cold-load-phases.md`
left the signed-in cold load of a thirty-message, twelve-member room at
three phases of about a third each, and ranked the settle's commits among
what remained. About 170 of a load's commits write the session's own
derivations, and the `localSessionDocuments` flag
(`docs/development/EXPERIMENTAL_OPTIONS.md`) keeps those documents on the
replica, with no remote watch and no operations in the outgoing commit. Its
registry entry recorded its performance as unmeasured. This record measures
it on that load, on a `main` that had taken several smaller changes since
the earlier record's baseline.

## Setup

- Two toolsheds from one tree, `main` at `0b8e0561e6` merged with nothing
  else, each with `EXPERIMENTAL_SERVER_EXECUTION=false` baked in, which the
  room benchmarks require. The flag-off arm was built with nothing more.
  The flag-on arm was built with `EXPERIMENTAL_LOCAL_SESSION_DOCUMENTS=true`
  so the shell's define carried it, and served with the same variable in the
  toolshed's environment, which is the deployment value the shell adopts.
  Each arm had a port and a store directory of its own. `/api/meta` on each
  reported its posture before anything ran: `localSessionDocuments: false`
  on the one and `true` on the other, `serverExecution: false` on both.
- One room per arm, seeded by `fabrichat-room-seed.ts` with twelve members,
  thirty messages, one thread of five replies, and a reaction every third
  message, the benchmark's shape. Each seed took about two minutes and
  twenty seconds and reported no rejected commit.
- Three loads per arm with the earlier record's harness, alternating the
  arms (off, on, off, on, off, on): a headless browser opens the room's
  URL on the arm's own built shell, signs in as the starter, attaches the
  worker profiler, and waits for the last message and every badge, writing
  the worker's CPU profile, the browser load summary and the worker's
  logger counts. The first load of a room builds its rows and is not
  compared; loads two and three are the cold loads below.
- The machine's one-minute load was 30 to 58 throughout, from other
  sessions' test suites. Wall times are reported as pairs and read as
  noise unless they disagree with the counts.
- Both built binaries answered `page.goto` in about 0.6 s. The thirty
  seconds the earlier record saw was the binary without the posture
  define, as it said.

## What a load pays, by arm

Counts from the worker's logger, loads two and three of each arm, which
were identical to each other within an arm except where a range is given.

| per load | flag off | flag on |
| --- | --- | --- |
| `start/syncCellsForRunningPattern` | 2 | 2 |
| `start/resumeListChildSync` | 1,663 | 1,663 |
| `start/resumeCellSync` | 285 | 285 |
| scheduler runs | 1,157 | 1,153 |
| `commitNative` | 190 | 190 |
| `prepareCfc` | 615 | 615 |
| `watchAddSync` | 232 to 241 | 234 to 237 |
| frames received | 757 to 785 | 770 to 771 |
| commits rejected, reverted, conflicted | 0 | 0 |
| sign-in to last message, load 2 | 25.0 s | 24.9 s |
| sign-in to last message, load 3 | 27.8 s | 27.0 s |
| sign-in to last message, load 1 (row-building) | 36.7 s | 35.5 s |

The worker profile's partition by outermost frame was the earlier record's
in both arms, with run-to-run variation larger than any difference between
them: idle 12 to 20%, `runPullSettleOrder` 10 to 21%, `handleMessage` 7
to 11%, the pre-sync 5 to 14%, module evaluation 7 to 11%,
`finalizeAction` 5 to 9%.

Against the earlier record's baseline (`main` at `d05864c47a` with
commonfabric/labs#8993, second load), `main` had already taken some of the
settle: list-child syncs 1,983 to 1,663, cell syncs 299 to 285, scheduler
runs 1,437 to 1,157, CFC preparations 840 to 615, commits 217 to 190,
name-syncs 2 in both. The wall is not comparable across the two days'
machine loads.

## What the server stored

The two store directories, read with SQLite after the loads, grouped by
the runtime session that committed. The room's space holds, per cold load:

| per load, room space | flag off | flag on |
| --- | --- | --- |
| commits stored | 171 | 168 |
| commits with no operations | 0 | 167 |
| operations, session scope | 174 (130 `computed:` sets, 39 `of:` sets, 5 patches) | 0 |
| operations, other scopes | 1 | 1 |
| operation bytes | 43 KB | 4 KB |
| reads carried, space scope | 490 | 490 |
| reads carried, session scope | 456 | 0 |
| reads carried, user scope | 15 | 15 |

So the flag did what its entry says. The session derivations left the
server store, their reads left the commits, and the three session-only
commits each load had made did not travel. What travelled instead was
167 validation-only commits a load, three fewer than the flag-off arm's
171, each carrying the space-scoped reads its derivation had made, on
average three. The registry's "shared reads still require server
validation, even when all writes are local" is the whole of the
difference between the arms, and it leaves all but three of the round
trips in place.

## Why nothing moved

A load's settle is paid per commit, not per byte. Each of the 190 commits
is a scheduler run's `#prepareCfc`, its `commitNative`, a push, and a
verdict to await before dependents can settle on it; the flag-on arm did
every one of those for the 167 commits that wrote nothing, because those
derivations read the room's space documents. The flag's local settle,
which skips the connection, applied to the three session-only commits a
load makes with no shared read, and to nothing else.

For the ranking the earlier record left, this moves the settle's lever.
Stripping the session writes from the commits is not it. Either the
derivation is not committed at all, with the watch on its space-scoped
reads as the signal that it is stale, which is what a validation verdict
of "rejected" would tell the replica anyway and what the watch tells it
first, or the room makes fewer per-session derivations in the first
place. Both are runtime questions, not the flag's.

## The bench row

Not run. The row cannot resolve a change under about three seconds on
this machine, and the counts and the paired walls agree that there is no
change to resolve.
