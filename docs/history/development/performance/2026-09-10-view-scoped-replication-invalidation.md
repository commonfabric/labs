---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Measured UI-walk invalidation and incremental Memory query refresh."
---

# View-scoped replication: invalidation and incremental queries

The implementation caches the rendered read set and refreshes view-session
queries incrementally. Quiet serving cycles no longer walk the UI or rebuild
producer certificates when their dependencies and execution snapshot are
unchanged. The comparison below keeps server execution enabled in both arms;
only view-scoped replication changes.

## Changes and correctness boundaries

The publisher retains the UI walk by session/view lifetime and invalidates it
through the scheduler's existing scoped dependency index. It observes path,
shallow-read, missing-value, and replica-reset changes. Stream targets are
cached independently of handler observations: a handler acquiring a read set can
change eligibility without requiring another UI walk.

Selection has separate invalidation for registration metadata and the input and
output values consumed by producer fingerprints. The observed execution snapshot
also participates, so producer currency, errors, new nodes, and changed handler
logs remain current even with an unchanged UI. Dependency registration precedes
asynchronous publication; changes during publication are retained. Rejected
publications are not cached. Disconnected views keep invalidation active, and
runtime disposal releases the subscription.

Memory evaluates demand once and selected support separately, retaining both as
tracked graphs. Dirty-document refresh uses the existing incremental query
machinery. Ordinary watch additions extend staged demand graphs through the same
helper as ordinary sessions; a later failure cannot install partial additions.
View replacements and recovery still rebuild the graphs. Support updates remain
delivery-only. Unrelated commits produce no unchanged view frame unless a
catch-up marker or operation update is due.

The implementation retains complete manifests and complete document delivery. It
adds no navigation prefetch, changes no flag defaults, and leaves client effect
execution disabled under server execution.

## Rejected snapshot-hashing check

An intermediate cache implementation hashed the entire execution snapshot on
every check. Its enabled navigation benchmark regressed to a 6,199 ms p75 topic
open. Server counters isolated 154 checks totaling 38.74 seconds, averaging
251.56 ms each. This version was rejected before the final comparison. An
offline spike also found cloning and deep comparison too expensive.

The final check compares observation identities and current outcome fields. The
scheduler replaces observed logs and write surfaces when they change; the
publisher retains the small node records while sharing those read-only
observations. Tests cover stable identity between observations, replacement
after execution, and changed currency with an otherwise unchanged view. Seven
captured 1,108-node graphs took roughly 0.03–0.2 ms per warmed identity check;
these are mechanism measurements, not browser timings. The cache retains node
references per live view and releases them with the view/runtime lifetime.

## Headless comparison

The final pair (`v12-on`, `v12-off`) completed the 30-topic navigation workload
with fresh stores and browser sessions. The table reports p75 milliseconds;
navigation phases each contain six measured samples.

| Workload                               | Enabled | Disabled |
| -------------------------------------- | ------: | -------: |
| Board                                  |   953.1 |  4,952.2 |
| Open topic                             | 2,142.2 |    593.9 |
| Cross-reference                        |   596.3 |    473.8 |
| Full journey                           | 5,110.9 | 12,369.7 |
| Lunch vote burst, 3 voters × 4 options | 4,148.4 |  3,950.6 |

These results do not establish a consistent latency improvement. Enabled topic
opening remained 3.6 times slower in this pair, even though its board and
journey were faster. The machine was shared with unrelated work. Calibration
JSON round-trip p75 was 3.16 ms enabled and 2.71 ms disabled, compared with
about 1.4 ms in the earlier comparison. Calibration is evidence of changing
conditions, not a valid multiplier for normalizing application latency.

An earlier run of the final code (`v11-on`) failed during cross-reference
navigation with `RuntimeClient request timed out: runtime:idle`. Its successful
open-topic samples ranged from 2.16 to 13.45 seconds. Load samples reached 34–42
on the 16-logical-CPU machine, and calibration JSON round-trip p75 was 6.2 ms.
The disabled arm also had a 14.52-second journey. The failure and raw results
are retained: contention is a plausible contributor, but the passing final run
does not prove that it caused the timeout. No timeout was changed.

## Frequency and attribution

A separate successful diagnostic followed board → topic → cross-reference with
server execution enabled. It recorded:

| Counter             | Previous diagnostic | Cached implementation |
| ------------------- | ------------------: | --------------------: |
| Serving cycles      |                  16 |                    22 |
| Server actions      |                  90 |                    90 |
| UI walks / plans    |                   5 |                     4 |
| All traversal calls |               5,263 |                 2,902 |
| Cell reads          |               3,358 |                 1,324 |

Total traversal calls fell 44.9%, and cell reads fell 60.6%, with unchanged
server action count. These counters cover the whole diagnostic; they are not
counts of UI nodes. The final run performed only four UI walks across 22 serving
cycles. Quiet-cycle unit tests independently establish that unchanged reads do
not trigger a walk or publication. Four walks across three visits do not imply
an exact one-walk-per-click contract: new mounts and actual read changes can
require additional walks.

Seven execution-snapshot checks took 29.9 ms combined. The four actual UI walks
took 674 ms, within 1,407 ms of planning. Memory frame handling took 2,491 ms
across 58 calls, and storage watch refresh took 2,294 ms across 17 calls. These
spans overlap and must not be summed. The command completed in 9,856 ms.

The CPU profile still shows tracked-document enumeration, query traversal,
demanded-structure loading, and graph extension. Eleven slow-query records
include full evaluations during watch/view changes and an ordinary watch add
with 507 roots. The implementation removes full reevaluation on ordinary dirty
refreshes; it does not eliminate reevaluation when the interest or selected
support changes. Subscription/query bookkeeping and the four remaining walks
remain useful next targets, but this profile does not isolate a single cause for
the remaining topic-open latency.

## Validation

The initial invalidation implementation passed the full runner suite with 1,408
tests and 8,678 steps, and the full runtime-client suite with 30 tests and 655
steps. The final Memory suite passed 613 tests and 570 steps. After replacing
the expensive snapshot hash with observation identity checks, the focused cache,
publisher, producer-basis, renderer, and lifecycle tests passed five top-level
tests and 21 steps. The Memory view-interest tests passed 15 steps.

The initial invalidation implementation passed enabled integration runs for
runner, runtime-client, and shell. The final implementation passed both headless
benchmark arms and the separate navigation profile. Repository type checking,
formatting, lint, and whitespace checks passed on the final implementation.
Documentation code-block checks passed earlier in this change. The
environment-to-browser-worker flag check ran again in both benchmark arms.

The full root integration campaign was not rerun here; prior failures outside
these suites are not declared fixed. The small lunch benchmark is a control for
ordinary clients without renderer mounts. It does not establish a repair of the
previously recorded 10-by-10 lunch consequence-completion failure.

No commit, deployment, or default flag change was made.

## Reproduction and evidence

The source was the uncommitted implementation on
`codex/view-scoped-client-replication`, based on
`16de7e0c871d21023111729b40876497dbaf3e36`, with Deno 2.9.4 on the same M3 Max
machine. The benchmark arms used fresh stores and shell builds, `HEADLESS=1`,
`EXPERIMENTAL_SERVER_EXECUTION=true`, and respectively true/false for
`EXPERIMENTAL_VIEW_SCOPED_REPLICATION`, without a web override. Server metadata
and actual browser worker initialization were checked. The workload and
benchmark source were unchanged. Benchmarks ran sequentially, without this task
running tests concurrently. Unrelated work on the machine continued.

The
[machine-readable results](2026-09-10-view-scoped-replication-invalidation.results.json)
retain all comparison arms, calibration benches, source hashes, flag metadata,
validation outcomes, load samples, and diagnostic counters.

Local logs and profiles are in `/tmp/view-v10-validation/`,
`/tmp/view-v10-integration/`, `/tmp/view-replication-benchmarks/v10-on/`,
`/tmp/view-replication-benchmarks/v11-on/`,
`/tmp/view-replication-benchmarks/v11-off/`,
`/tmp/view-replication-benchmarks/v12-on/`,
`/tmp/view-replication-benchmarks/v12-off/`, and `/tmp/view-v11-profile/`.
