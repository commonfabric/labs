---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Point-in-time integration validation, benchmark comparison, and CPU profile."
---

# View-scoped replication: validation and benchmark comparison

The integration campaign's failures were corrected and their reruns passed.
Workload validation found a substantial navigation regression and a rendering
failure at 100 topics with view-scoped replication enabled. The default lunch
benchmark also failed before producing a valid measurement in both modes. This
snapshot does not support enabling the feature for deployments.

The serving CPU profile attributes the navigation regression primarily to
repeated dependency-ancestor scans during view-plan generation. Initial board
display improved at 30 topics, but the complete navigation journey became 5.26
times slower.

## Code and measurement conditions

- Checkout: `codex/view-scoped-client-replication`, based on
  `16de7e0c871d21023111729b40876497dbaf3e36`, with uncommitted feature and
  validation changes. The commit alone does not identify the measured code.
- Machine: Apple M3 Max, 128 GiB RAM; Deno 2.9.4, aarch64 macOS; headless
  Chrome.
- `EXPERIMENTAL_SERVER_EXECUTION=true` in both arms.
- `EXPERIMENTAL_VIEW_SCOPED_REPLICATION=false` versus `true`;
  `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` unset for the benchmark comparison.
- Each arm built its shell, started its toolshed, and used a fresh local store.
  The API and compiled shell were served at `http://localhost:8965/`.
- Runs were sequential. CPU profiling ran separately from timed benchmarks.
  Production code and workload code were unchanged between the compared arms.
- The snapshot of HEAD and modified/untracked file hashes has fingerprint
  `024e29e10ae1009e4d3ca55b380bd4850f19c43baed2613cf009deaeb21d90a4`: SHA-256 of
  Python's `json.dumps(source, sort_keys=True)` representation. Final
  documentation was written afterward.

[The result data](view-scoped-replication-2026-09-10.results.json) preserves the
source hashes, environment, commands, exit codes, timings, calibration readings,
integration accounting, and profile attribution. The local raw artifacts are
under `/tmp/view-replication-benchmarks/` and `/tmp/view-v5-profile/`.

Each measured workload ran as a separate process, alongside
`packages/dashboard/machine-calibration.bench.ts`:

```bash
deno bench --frozen --json -A --v8-flags=--expose-gc \
  packages/patterns/integration/topic-board-navigation.bench.ts \
  packages/dashboard/machine-calibration.bench.ts
```

The other workload files were `topic-board-scale.bench.ts` and
`lunch-poll-vote-burst.bench.ts` in the same directory. Workload settings were
`CF_TOPIC_BOARD_TOPICS=30`, `CF_TOPIC_BOARD_SCALE_LIMIT=100`, and initially
`CF_LUNCH_POLL_VOTERS=10` / `CF_LUNCH_POLL_OPTIONS=10`. The smaller lunch
control used 3 voters and 4 options. The 1,000- and 10,000-topic cases retained
their normal skips.

## Integration and flag verification

The full command was `deno task integration`, launched with server execution and
view-scoped replication enabled. It completed all seven suites in 42 minutes 11
seconds. Its exit code was **1**, with five suites green and two failing before
their test fixes. This was not a clean exit-zero run of the full command.

| Suite              | Evidence                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| runner             | 16 passed                                                                                                                            |
| runtime-client     | Corrected serialization wait; full suite rerun passed all 50 steps, both enabled and with the web-class override disabled            |
| shell              | 11 tests and 29 steps passed                                                                                                         |
| patterns           | Full run: 66 passed, one failed notebook case, 16 existing ignored steps; the corrected default-app file passed both tests and steps |
| cli                | Passed                                                                                                                               |
| generated-patterns | 146 passed                                                                                                                           |
| pattern-tests      | All 157 authored-pattern test files passed                                                                                           |

The generated and authored pattern harnesses own emulated stores and have no
serving host. Their launcher explicitly selects `serverExecution=false`; the
server-backed suites retain the supplied environment flags. This topology is
documented in `docs/development/TESTING.md` and enforced in
`tasks/integration.ts`.

The browser flag test inspected `/api/meta` and the actual encoded
`Worker.initialize` request, then waited for accepted initialization. It covered
global on with no web override, global on with web off, and global off with web
on. Both benchmark arms repeated the browser-worker check against their own
server and shell build.

Corrections and regressions exercised during validation included:

- Forwarding settled asynchronous computation errors through view plans and
  preserving their runtime error context.
- Installing SQLite factories for each canonical scoped owner identity.
- Carrying the originating scope identity through deferred list-container
  seeding and a conflicting commit retry; synchronizing the container through
  the scoped transaction. The regression failed before the fix and passed after.
- Waiting for the indexed button itself to become enabled, while retaining
  disabled buttons in the index. The helper regression failed before the fix;
  the clean Topics retraction test and the full campaign passed afterward.
- Waiting for the conditional VDOM child to arrive before the runtime-client
  serialization assertions, without changing those assertions.
- Resolving the notebook's reference cell to its metadata-owning cell before
  inspecting internal state. The seven-note persistence assertions and prompt
  reset assertions remained intact.

Earlier full package unit runs passed: runner 1,406 tests / 8,661 steps, memory
613 / 562, and runtime-client 29 / 646. Subsequent focused regressions covered
the final list-seeding, indexed-click, runtime-client, and notebook changes. The
full type check passed 407 paths in 46 groups, with focused checks for later
edits. These results supplement the integration campaign rather than replacing
its explicit exit-code accounting.

## Latency results

These are raw p75 values. The paired navigation runs are `off-3` and `on-3`; the
smaller lunch comparison is `off-3` and `on-4`. Deno reported six samples per
navigation segment, four for the successful 100-topic board run, and eleven per
smaller lunch arm.

| Workload / measured phase               |                  Flag off |                   Flag on | On / off |
| --------------------------------------- | ------------------------: | ------------------------: | -------: |
| 30 topics: page load                    |                    664 ms |                    659 ms |    0.99× |
| 30 topics: sign in                      |                    122 ms |                    131 ms |    1.07× |
| 30 topics: board display after sign-in  |                  1,055 ms |                    421 ms |    0.40× |
| 30 topics: open a topic                 |                    273 ms |                 10,557 ms |   38.67× |
| 30 topics: follow a cross-reference     |                    214 ms |                  3,058 ms |   14.29× |
| 30 topics: complete journey             |                  2,837 ms |                 14,921 ms |    5.26× |
| 100 topics: board display after sign-in |                  7,234 ms |                    Failed |        — |
| Lunch: 3 voters × 4 options             |                  1,568 ms |                  1,502 ms |    0.96× |
| Lunch: 10 voters × 10 options           | Failed before measurement | Failed before measurement |        — |

The smaller lunch arm recorded zero rejected commits and zero rolled-back writes
in its untimed accounting burst, over all three clients, in both modes. These
are ordinary worker clients without renderer mounts, so this workload is a
compatibility and overhead control, not a measurement of selective browser
replication.

### Noise and phase boundaries

The earlier `off-1` baseline measured a 2.464-second journey and a 4.211-second
100-topic board display. The repeated baseline measured 2.837 and 7.234 seconds.
The 100-topic repeat ranged from 3.839 to 8.701 seconds across only four
samples. Small changes therefore do not support a performance conclusion.

The geometric mean of the twelve calibration p75 ratios, on divided by off, was
0.7260 for navigation and 0.9933 for the smaller lunch control. Dividing out
that calibration changes the navigation journey ratio from 5.26× to 7.25× and
the lunch ratio from 0.958× to 0.964×. Calibration is a sensitivity check, not a
correction for every phase's browser/server contention. The navigation
regression is large under either reading; the small lunch difference is not a
demonstrated improvement.

The 100-topic benchmark starts its timer after load and sign-in. Its full
process took 351.69 seconds off, including 296.334 seconds seeding. The enabled
process took 876.99 seconds, including 309.520 seconds seeding, then failed
waiting for the last expected card, `Topic 0000 attention`, to appear. The
existing `waitForCondition` backstop was 300,000 ms. There is no successful
enabled latency to compare, and no timeout was raised to obtain one.

## Lunch benchmark integrity and the 10×10 blocker

The first flag-off attempt used the benchmark's existing budgeted
`harness.settle()`. It repeatedly returned with pending intents and began new
bursts before previous bursts completed. That run was stopped; none of its lunch
timings were accepted.

The benchmark was strengthened to await every writer's event consequences before
replica barriers. It also checks the configured participant and option counts
and validates every client's vote count and per-option color distribution
outside the timed interval. A 2×2 control in the emulated topology passed, as
did both server-backed 3×4 arms.

With those checks, the 10×10 runs failed during setup/warm-up:

- Flag off (`off-2`): exit 1 after 389.24 seconds, with no lunch result row. The
  JSON reporter omitted the module exception. Offline inspection found all 100
  vote memberships in the captured store; that does not prove that the clients
  received every consequence or the final color distribution.
- Flag on (`on-2`), using text diagnostics: exit 1 after 387.90 seconds with
  `[voter-9] awaitEventConsequences timed out after 120000ms`.

Both runs kept server execution enabled. The default-size comparison remains
blocked; no latency ratio is claimed. The exact flag-off exception and the
underlying consequence-completion cause remain unresolved. The enabled
diagnostic ended with low disk headroom, so it is not timing evidence. Failed
stores were archived and verified before the fresh numerical comparisons.

## Serving CPU profile

A separate fresh server used `start-local-dev.sh --inspect --inspect-port=9865`
with both server execution and view-scoped replication enabled. The fixture was
seeded before profiling. The existing `profile-toolshed.ts` tool sampled three
successive browser sessions loading the 30-topic board and opening a topic,
using the same `BoardSession` operations as the benchmark. The measured topic
opens in this diagnostic were 8.610, 10.059, and 7.453 seconds.

The profile covered 34.546 seconds, including 4.770 seconds classified idle.
Inclusive figures below overlap and must not be added.

| Profile attribution               | Sampled time | Share of non-idle sampled time |
| --------------------------------- | -----------: | -----------------------------: |
| View-plan publisher, inclusive    |     24.037 s |                          80.7% |
| `readsOverlapWrites`, self        |     19.197 s |                          64.5% |
| `collectViewAncestors`, inclusive |     14.516 s |                          48.7% |

Overlap checks appeared in three repeated ancestor searches: selection's call to
`collectViewAncestors`, error propagation's call to it, and the publisher's
producer-certification loop. Each accounted for roughly 6.4 seconds of overlap
checking. The relevant code is
[`view-replication.ts`](../../../runtime/runner/src/view-replication.ts) and
[`view-plan-publisher.ts`](../../../runtime/runner/src/executor/view-plan-publisher.ts).

The server recorded 40 wave cycles with 28.678 seconds of cumulative cycle time
during the profile. The CPU samples provide the attribution: repeated ancestor
traversal is the principal observed navigation cost. This profile does not
establish the root cause of the separate 100-topic rendering failure or the
lunch consequence timeout.

The profile and reports are at
`/tmp/view-v5-profile/navigation.server.cpuprofile`, `.server.report.txt`,
`.server.delta.txt`, and `attribution.json`. Failed stores are retained as
`/tmp/view-v5-lunch-off-2-store.tar.gz`, `/tmp/view-v5-lunch-on-2-store.tar.gz`,
and `/tmp/view-v5-on-3-store.tar.gz`; the original stores were removed only
after their servers stopped and archive contents were checked.

## Follow-up gates

Before rollout, replace repeated ancestor scans with indexed or reused graph
traversal while preserving identity, path, shallow-read, effect-boundary, and
producer-certification semantics. Re-run the same navigation workload and
resolve the 100-topic render failure. Separately establish completed 10×10 lunch
bursts and identify the consequence-wait blocker.

These latency measurements do not establish transferred-byte savings, browser
memory savings, or long-running multi-client stability. Those measurements and
the larger topic scales remain outside this snapshot.
