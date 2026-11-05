---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Unprofiled timeout reproduction, client validation fixes, and terminal IPC failure accounting."
---

# View-replication timeouts and hidden failures

An unprofiled browser reproduced the 60-second timeout with the original
client validator. This was an active client execution defect, not merely
profiler overhead or a slow server UI walk. A separate reporting defect omitted
requests that timed out from the IPC timing histograms. The changes recorded
here address both defects while preserving the local-input checks that prevent
speculative execution from overwriting authoritative outputs with unavailable
values.

The source base was `16de7e0c871d21023111729b40876497dbaf3e36`, with the
in-progress view-replication changes. Per-arm source hashes, commands, flags,
phase timings, failure records, and CPU attribution are in the accompanying
[results](2026-09-10-view-replication-timeouts.results.json).

## Why the timeout disappeared from the stats

`RuntimeConnection` recorded elapsed time only in its response handler. A
request that reached the timeout callback was removed from the pending map and
rejected without recording a duration or completing its timeline entry. It
therefore appeared neither in the completed timing histogram nor in the pending
request snapshot. The bounded boot timeline could retain an apparently pending
entry, but entries beyond its 96-request cap were absent altogether.

The topic benchmark also skipped its normal summary when setup or measurement
threw. Asking the worker for its counters after it had stalled could itself
require another 60-second wait.

All terminal request paths now record a wait duration and an explicit outcome:
success, error response, timeout, cancellation, or send error. Aggregate outcome
counts remain available after the boot timeline fills. Late responses cannot
count a request twice. These are client wait durations: a timed-out wait is not
an assertion that the worker completed in 60 seconds.

Browser summaries retain every failure outcome separately from ranked timing
rows. They can collect main-thread diagnostics without another worker request,
and explicitly mark missing worker statistics. A failed topic benchmark writes
its phase, elapsed time, error, and main-thread diagnostics to stderr before
rethrowing. The benchmark still fails; a failure is not converted into a
successful latency sample.

## Reproduction and attribution

All browser arms used 30 topics, `HEADLESS=1`, an Apple M3 Max, Deno 2.9.4,
and server execution enabled. The global view-replication flag selected each
arm; the web override was unset. Each arm checked the server metadata and ran
the shell flag integration test to verify the client's resolved mode.

Two server states mattered. Restarting from the same closed store produced a
cold runtime and did not reproduce the minute-long stall. Freshly seeding the
board on a running server retained its observed execution read sets and did
reproduce it. The unprofiled warm control reached board rendering, acknowledged
the mount, then timed out in `piece:getAll`: the measured phase lasted
60,152 ms. The repaired telemetry recorded one
`ipc-outcome/timeout/piece:getAll` wait of 60,001.5 ms. No topic click occurred.

The client validator had several layers of repeated work:

1. Each producer lookup scanned manifest producers and reconstructed write
   surfaces. Indexing producers and their write surfaces by document and scope
   removes that repeated scan while retaining path-overlap checks.
2. The recursive proof detected cycles but revisited shared ancestors through
   every incoming path. An 18-producer graph with two predecessors per producer
   caused 13,527 basis observations for 51 distinct entries. A memo local to one
   proof reduces this to at most 51, without skipping the wake dependencies.
3. Commit validation started a fresh proof for every previously read address.
   One memo now spans a single synchronous validation pass. A later read or
   validation pass gets a fresh memo; no proof survives an asynchronous boundary.
4. Unchanged observed values were repeatedly hashed. The cache reobserves the
   value and reachable path depth every time, reusing a fingerprint only for
   an identical primitive or a value proven deeply frozen. Mutable values are
   rehashed. A changed document wrapper alone does not invalidate an unchanged
   immutable observation.
5. Admitted-input checks scanned every plan input for every read. A document
   and scope index now answers those membership checks and is rebuilt on plan
   acceptance.

The first two changes prevented the reproduced timeout but were insufficient:
an unprofiled warm run still spent 22,970 ms awaiting the registry and 19,964 ms
in the following idle wait. Its topic open after that startup took 544 ms.
A separate warm profile showed 72.2% of worker sample time under producer
currency checks, 59.8% under commit read-basis validation, and 57.7% under input
fingerprinting. These inclusive percentages overlap and must not be added.

After batching validation and caching immutable fingerprints, three unprofiled
runs opened the topic in 415, 481, and 442 ms, but still spent 4.4–5.5 seconds
awaiting the registry; one also spent 2.8 seconds in the following idle wait.
The next profile attributed 22.7% of worker sample time to the linear admitted
input scan. That evidence motivated the final input index.

## Final browser checks

| Flag / run | Startup before open | Registry subset | Topic open | Completion after open |
| --- | ---: | ---: | ---: | ---: |
| On / 1 | 6,882 ms | 2,803 ms | 404 ms | 49 ms |
| On / 2 | 4,586 ms | 2,501 ms | 361 ms | 44 ms |
| On / 3 | 4,355 ms | 2,407 ms | 403 ms | 49 ms |
| Off / 1 | 3,542 ms | 16 ms | 337 ms | 2 ms |
| Off / 2 | 2,430 ms | 5 ms | 315 ms | 3 ms |
| Off / 3 | 2,351 ms | 7 ms | 329 ms | 2 ms |

Each arm used a freshly seeded server and three fresh browsers, with no
discarded warm-up. The sequence separately acknowledged the board mount,
awaited registry readiness and idle, measured opening the topic, then awaited
the topic mount and another idle acknowledgment. Terminal IPC failures made
the diagnostic fail even if the visible content assertions passed. This keeps
unfinished worker-side mounting visible after the page has rendered.

The enabled arm ran with one-minute load averages of 43.4 down to 37.5; the
disabled arm ran at 23.0 down to 21.1, on 16 logical CPUs. These are diagnostic
samples under substantial, changing shared-machine load.
Own unit suites finished before the final browser runs, but unrelated work
continued. The enabled and disabled arms ran sequentially. They are not a
release-grade estimate of the flag's latency effect. Startup is reported
separately and cannot be erased by quoting only the subsequent topic-open time.

The earlier cold-store navigation profile attributed delay to server query
extension and graph startup while the client worker was mostly idle. That
remains a separate finding; removing the warm client stall does not establish
that all server startup work, or the earlier ordinary navigation gap, is fixed.

The final warm profile retained a 2,158 ms pre-click wait within a 2,477 ms
opening helper. Its worker capture spans 3,528 ms and includes startup around
that helper. Input membership checking accounts for only 9 ms (0.25%), and
commit read-basis validation for 104 ms (2.9%). Individual read admission still
accounts for 512 ms (14.5%). These are inclusive sample durations, not a wall-time
partition.

Graph registration is the largest remaining worker branch: `startViewPiece`
accounts for 991 ms (28.1%). Within it, binding node inputs and constructing
actions reach canonical hashing for 514 ms and schema interning for 422 ms;
those branches overlap. The source path is
`startViewPiece → #instantiateJavaScriptNode → #bindNodeIO` and action
registration, through `unwrapOneLevelAndBindToDoc`, schema externalization,
and `internSchemaReturningSchemaAndHash`. The capture identifies repeated
schema normalization and hashing during registration as the next concrete
investigation target. It does not prove that every registration is necessary.

The server is 87.6% idle and the main thread 95.2% idle in their captures. Server
counters report one view render walk (1.8 ms), one plan calculation (7.6 ms), and
12 snapshots totaling 21.9 ms. The remaining delay in this warm setup is not
explained by frequent or expensive server UI walks.

## Validation and boundaries

- Full runner suite: 1,408 tests and 8,686 steps passed; one step ignored.
- Full runtime-client suite: 30 tests and 658 steps passed.
- Focused runtime regressions: four test groups and 29 steps passed.
- Browser helper tests: one test group and 42 steps passed.
- Six final headless browser trials passed, with no terminal IPC failures or
  pending requests at their final snapshots. Both arms passed the deployment
  flag integration test, including the browser worker's initialization payload.
- Repository type check, formatting, lint, documentation examples, and history
  index checks passed. An initial lint run found unused test stub bindings;
  those were corrected before the final lint pass.

The regression tests cover timeout accounting, late responses, cancellation,
send errors, failures beyond the timeline cap, and main-only failure summaries.
The runtime tests cover shared-ancestor work bounds, cycles, scope and path
boundaries, plan replacement, changed values, shallow freezing, reachable path
depth, and fresh proof state between validation passes.

A maintained producer-proof benchmark exercises 10, 14, 18, and 36 producers.
Early diagnostic means for 18 producers moved from 60.3 ms to 168.9 microseconds
after the first indexing and deduplication changes. Its initial fixture emitted
teardown warnings outside timing; the final fixture drains setup and preserves
normal reads for non-synthetic documents. The later JSON run validates that
fixture and output format, not a comparable performance result under concurrent
test load. The deterministic 13,527-to-51 observation regression is the stronger
proof of the algorithmic change.

No timeouts were increased, no waits were replaced with sleeps, and no
unavailable-input or commit validation checks were removed. The feature flags
and their defaults are unchanged. The new terminal IPC accounting applies to
both flag modes. This validation does not claim a fresh run of the entire root
integration suite or the lunch-poll campaign.

Raw captures and harnesses are under `/tmp/view-stall/`; the results file retains
compact evidence and source hashes independently of those temporary profiles.
The discarded initial mount-hook experiments and a diagnostic driver handle
that needed cleanup are not counted as product timeout reproductions.
