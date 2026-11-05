---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Six interleaved headless topic-open trials after updating the view-replication worktree to main."
---

# View replication after updating to main

Both arms used server-side execution. Only view-scoped client replication
changed. All six trials completed successfully, with no page errors, terminal
IPC failures, or pending requests at their final snapshots. The enabled arm
opened the topic faster in all three adjacent pairs. The median was 475 ms
enabled versus 691 ms disabled, a 31% lower observed duration. Including the
subsequent mount and idle acknowledgments, the medians were 548 ms and 735 ms, a
25% difference.

These are diagnostic results under substantial shared-machine load, not a
precise estimate of the flag's speedup. One-minute load at the start of the
browser measurements ranged from 36.7 to 123.9 on 16 logical CPUs. Interleaving
removes the earlier separation into batches; it cannot remove contention within
a pair. No samples were discarded or retried.

## Source and measurement posture

The worktree advanced 91 commits from `16de7e0c871d21023111729b40876497dbaf3e36`
to the fetched main head `2e5f76ebfc606e0ebdb8b64a653867f6b231df4a`. The local
feature work was preserved. Nineteen merge conflicts were reconciled, including
actor-scoped list initialization, guarded event dispatch, schema metadata, and
redirect reads. The merge retains the upstream implementations and adds the
local view-replication guards at their corresponding boundaries. No additional
performance optimization was introduced for this campaign.

The sequence was exactly **on-1, off-1, on-2, off-2, on-3, off-3**. Each trial
started a fresh local server and store, seeded the unchanged 30-topic board, and
opened a fresh headless browser against that still-running server. Thus the
server retained the execution read sets produced during seeding. The machine was
an Apple M3 Max running macOS 26.4.1 and Deno 2.9.4.

Every trial explicitly set `EXPERIMENTAL_SERVER_EXECUTION=true` and
`HEADLESS=1`. `EXPERIMENTAL_VIEW_SCOPED_REPLICATION` selected the arm; the web
override was unset, so the web client inherited the global selection. Each trial
checked `/api/meta` and passed the shell integration test that decodes the
actual browser worker initialization payload. All six source snapshots had
identical file hashes. Own type checks and unit suites finished before the first
benchmark trial. No CPU profiler or timing-measure collection was enabled.

## Per-trial results

All durations below are milliseconds. Startup includes loading, login, board
content, mount acknowledgment, registry readiness, and the final pre-click idle
acknowledgment. The registry column is a subset of startup. Topic open includes
the click, route change, topic title, cross-reference content, and view
settling. Completion is the following mount and idle acknowledgment, kept
separate so an early render cannot conceal unfinished mounting.

| Trial | Startup | Registry subset | Topic open | Completion after open | Starting load |
| ----- | ------: | --------------: | ---------: | --------------------: | ------------: |
| on-1  |   6,101 |           3,102 |        475 |                    73 |          36.7 |
| off-1 |   5,885 |               8 |        691 |                    45 |          73.1 |
| on-2  |   4,908 |           2,660 |        409 |                    51 |          75.0 |
| off-2 |   4,927 |              13 |        623 |                     7 |          44.2 |
| on-3  |   7,673 |           4,977 |        550 |                   466 |         112.1 |
| off-3 |   9,153 |               9 |      1,205 |                    14 |         123.9 |

Median startup was 6,101 ms enabled and 5,885 ms disabled. The enabled arm
rendered board content sooner but continued working after it appeared. Its
registry wait was 3,102 / 2,660 / 4,977 ms, versus 8 / 13 / 9 ms disabled. The
disabled arm spent most of its corresponding startup interval waiting for the
board content. Similar startup totals therefore do not mean the same work or
waits occurred in each mode.

The enabled arm's 466 ms final completion wait is included; quoting only its 550
ms topic-open phase would conceal nearly half of that trial's combined interval.
The three paired topic-open differences were -216, -214, and -655 ms (enabled
minus disabled). For open plus completion they were -187, -170, and -203 ms.
This distinction matters more than the rounded headline percentage.

## Server walks and remaining uncertainty

The server's accumulated view-replication counters were:

| Trial | Render walks | Render elapsed total (ms) | Plan calculations | Plan elapsed total (ms) |
| ----- | -----------: | ------------------------: | ----------------: | ----------------------: |
| on-1  |            2 |                     265.7 |                 2 |                   499.2 |
| on-2  |            2 |                     135.6 |                 2 |                   265.7 |
| on-3  |            4 |                     360.5 |                 4 |                   875.7 |

These counters span the running server, including setup and navigation. They are
elapsed logger spans, not a CPU partition, and render and plan spans can
overlap. The first two enabled trials recorded two walks and two calculations;
the third recorded four of each. These are bounded counts in these samples, not
proof that every walk was necessary or that none occurred while idle. The
material unresolved wait is still startup registry readiness in enabled mode.
This campaign did not collect a new CPU profile, so it does not establish
whether the remaining wait has the same cause as the earlier graph-registration
and read-validation findings.

The earlier final measurements used three fresh browsers per seeded server and
ran the arms in separate batches. This campaign uses a fresh seeded server for
each individual trial. That change and the variable machine load prevent a clean
before/after attribution to the 91 upstream commits. The measured comparison
here is the replication flag at one source state, with server execution enabled
throughout.

## Validation and retained evidence

- Repository type checking passed: 418 paths in 46 package groups.
- Focused runner tests passed: 32 groups and 423 steps, covering view
  replication, local reads, guarded events, scoped programs, list seeding,
  source reconciliation, and schema metadata.
- The full runtime-client suite passed: 32 groups and 668 steps.
- Focused memory tests passed: two groups and 23 steps.
- Formatting, lint, all 599 checked documentation examples, and the history
  index passed before measurement.
- All six browser flag integration tests and all six measured journeys passed.
  All 30 start/flags/seed/open/stop commands succeeded. Each own server was
  stopped and its closed temporary store removed after the trial.

The first runtime-client test run failed four local assertions that expected
non-pattern redirects to fetch unrelated data when view replication was off or
unsupported. Main now avoids those reads. Updating those expectations preserved
the upstream improvement; both the new upstream redirect tests and the local
read-boundary tests passed afterward. No product timeout was observed in this
campaign, and no timeout threshold was changed. This is not a rerun of the
entire root integration suite or the lunch-poll benchmark.

The accompanying
[results](2026-09-11-view-replication-main-interleaved.results.json) retain
source hashes, flags, commands and exit codes, individual phases, terminal
outcomes, pending requests, load readings, compact server counters, and
validation evidence. Full logs, browser snapshots, the exact harness, and a
backup of the pre-update work are in
`/Users/berni/.codex/artifacts/view-replication-main-2026-09-11/`.
