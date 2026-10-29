---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Three topic-open repetitions and profiles separate navigation startup cost from a client validation stall."
---

# Topic-open replication gap

Three unprofiled topic opens reproduced a median enabled/disabled gap of 658 ms.
A separate cold-server capture located most of its opening delay in server query
and graph-startup work while the browser worker was idle. Another setup, which
inserted profiler preparation after the board became ready, reproducibly exposed
a much larger client producer-validation stall before the click. These are
distinct findings. The stalled profiles do not establish that producer
validation accounts for the ordinary 658 ms gap.

## Three ordinary repetitions

Both arms used `HEADLESS=1`, 30 seeded topics, and server execution enabled.
Only `EXPERIMENTAL_VIEW_SCOPED_REPLICATION` changed. Each arm had a fresh
server/store; each repetition used a fresh browser. The harness called the
existing `BoardSession.load`, `signIn`, `showBoard`, and `openTopic` methods,
without profiler preparation or diagnostic reads between board readiness and
opening. Only `openTopic` was timed. There was no discarded warm-up.

| Repetition |  Enabled | Disabled |
| ---------- | -------: | -------: |
| 1          | 2,185 ms | 1,111 ms |
| 2          | 1,649 ms |   730 ms |
| 3          | 1,441 ms |   991 ms |
| Median     | 1,649 ms |   991 ms |

All six completed successfully. The median difference is 657.8 ms, or about 66%
of the disabled median. These are three observations under changing
shared-machine load, not a population latency estimate. The ordinary arms ran
enabled then disabled; the preceding diagnostic arms alternated flags.

## Navigation delay: server queries and graph startup

For a matched diagnostic, each server started from a separate copy of the same
closed fixture store. That snapshot came from the third enabled diagnostic; its
board was stored and its server runtime was cold after restart. Profiler
connections and counter baselines were prepared before the final board settle.
The harness then opened the topic immediately after the board settled, keeping
the benchmark's board-to-click sequence intact.

The CPU captures include that final board settle. Server `performance.measure`
entries were additionally clipped to the opening interval, so the table's server
work describes the opening window. Concurrent and nested spans are not summed
into wall time.

| Phase or server work during opening      |  Enabled | Disabled |
| ---------------------------------------- | -------: | -------: |
| Complete open                            | 8,018 ms |   860 ms |
| Click helper                             |    51 ms |    39 ms |
| Route wait                               |     3 ms |     4 ms |
| Topic-title wait                         | 7,753 ms |   218 ms |
| Citation wait                            |   207 ms |   595 ms |
| Final settle                             |     4 ms |     4 ms |
| Server watch refreshes overlapping open  |      126 |       16 |
| Union of server watch-refresh spans      | 5,133 ms |   507 ms |
| Server graph-sync spans overlapping open |       30 |        8 |
| Server serving cycles overlapping open   |       36 |        6 |
| Server UI-walk span inside open          |   165 ms |     0 ms |

The enabled UI walk lasted 240 ms in total, with its first part preceding the
opening window. The worker was about 96% idle in the approximate clipped open
profile (alignment uncertainty about 46 ms), and 93% idle over the complete
capture. Main-thread rendering was also a small part of the capture. The
server's CPU profile instead shows query-state cloning and extension, schema
processing, and pattern instantiation. A prominent chain is
`cloneTrackedGraphState → #extendWatchGraphs → #watchAdd`; another enters schema
canonicalization through raw-node instantiation.

The waiting client requests include `piece:get` and `piece:getAll`; the worker's
`get.piece.sync`, storage watch refresh, and idle spans account for waits rather
than active browser computation. `piece:getAll` opens the piece registry, and
`getPieceCell` synchronizes the addressed cell through `viewPieceSchema` in the
enabled arm. The server's demand-driven structure loader resumes graphs for
arriving root demands. During the opening window, 30 graph-sync spans overlap
126 server watch refreshes; those refreshes repeatedly extend tracked queries.

This colder diagnostic amplifies the gap and must not be used as the numerical
decomposition of the ordinary 658 ms median difference. It establishes that
opening can wait behind substantial server query/startup work after the board is
already visible. The timing is consistent with work moving from board startup
into the first navigation when the board can render from stored UI. Which
originating demand roots account for all 30 graph-sync operations remains
unassigned; the capture does not prove that every one was necessary for the
selected topic.

Relevant source locations:

- [`PiecesController.getPieceCell`](../../../../runtime/piece/src/ops/pieces-controller.ts)
  and `getPieceRegistry` perform the client syncs.
- [`SpaceServer.#loadDemandedStructure`](../../../../runtime/runner/src/executor/space-server.ts)
  responds to root-demand arrivals.
- [`Server.#extendWatchGraphs`](../../../../runtime/memory/v2/server.ts) stages
  watch additions through tracked-graph cloning and extension.

## Separate stall: repeated client producer validation

The first diagnostic design prepared the profilers after the board had settled,
then called the same topic-open helpers. Its three enabled attempts timed out
inside `runtime:idle` after 60.95, 60.14, and 60.69 seconds. In attempts 2 and
3, the click-event capture confirms that no click was dispatched. The first
attempt failed within the click helper but did not retain its click capture.

| Enabled diagnostic | Producer lookup, worker sample time | Producer currency, inclusive worker sample time |
| ------------------ | ----------------------------------: | ----------------------------------------------: |
| 1                  |                               74.8% |                                           89.1% |
| 2                  |                               74.5% |                                           89.2% |
| 3                  |                               70.6% |                                           84.1% |

Sample-count percentages agree closely with the time-weighted percentages. The
server was 95–98% idle in the first two captures; the main thread was
essentially idle. Attempts 2 and 3 each recorded one server UI walk, taking 6.3
ms and 4.2 ms respectively. This was active client work, not a minute-long
server UI walk.

The hot source chain is:

1. `prepareViewAction` installs the speculative read-permission callback.
2. Each read and `validateLocalReadBasis` invoke that callback.
3. `producerCurrent` checks fingerprints and traverses producer ancestors.
4. For each ancestor read, `producers(address)` scans every manifest producer,
   reconstructs its write addresses, and performs overlap checks.

`producerCurrent` rebuilds its producer-ID map on each invocation. Its
`visiting` set detects recursion cycles but does not memoize already-proven
ancestors. Completion rechecks the transaction's read basis, reaching the same
lookup repeatedly through `parkUnavailableRun`, `beforeCommit`, and `commit`.
About 65–69% of the worker sample time in these stalled captures lies under
`validateLocalReadBasis`.

The corresponding disabled diagnostics completed in 2.45 s, 533 ms, and 408 ms,
with no producer-currency samples. The 2.45-second result overlapped system
sleep and is not a clean latency control. The ordinary enabled repetitions
completed promptly, so the paused diagnostic setup exposes a different timing
case rather than reproducing the ordinary navigation latency.

The client optimization suggested by this evidence is to index producer write
surfaces by document/scope/path and retain the producer-ID map per admitted
plan. Reusing currency proofs also needs a sound invalidation boundary for plan
generation, local coverage, document/overlay changes, and producer outcomes.
Read and commit safety checks must remain effective; deleting those checks would
reopen the unavailable-input overwrite risk.

Relevant source locations are
[`ViewReplicationClient.producers` and `producerCurrent`](../../../../runtime/runner/src/view-replication-client.ts),
[`SchedulerFacade.prepareViewAction`](../../../../runtime/runner/src/scheduler/facade.ts),
and
[`validateLocalReadBasis`](../../../../runtime/runner/src/storage/local-read-policy.ts).

## Evidence and limits

The source was the uncommitted implementation on
`codex/view-scoped-client-replication`, based on
`16de7e0c871d21023111729b40876497dbaf3e36`, with Deno 2.9.4 on the M3 Max.
Hashes of all 84 modified/new package and task source files matched across the
arms. Server `/api/meta` and the maintained browser-worker flag test verified
server execution and replication settings in every arm. No runtime or pattern
source was changed during this investigation, and no timeout was increased.

Machine load varied substantially, including load averages above 100 on 16
logical CPUs. The system sleep log confirms clamshell sleep and dark wakes
during the first disabled diagnostic. All such results are retained. The third
enabled diagnostic's harness was terminated only after its failure and all CPU
profiles were written and its browser children had exited; its remaining harness
process did not finish cleanup. This does not change its recorded measurement
timeout.

The [machine-readable evidence](2026-09-10-topic-open-gap.results.json) includes
individual results, phase timings, clipped server spans, profile attribution,
source hashes, flag checks, command outcomes, and sleep evidence. Throwaway
harnesses, raw profiles, complete counter snapshots, and logs remain in
`/tmp/view-open-gap/`. Failed diagnostic stores are retained there by reference.
All dev servers launched by this investigation were stopped.
