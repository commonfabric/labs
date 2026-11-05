---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Retained partial-graph bindings are verified by regression tests and a headless startup counter capture; server-currency adoption is sized separately."
---

# Retaining successful view graph bindings

The client now keeps successful node registrations when other nodes in the same
view graph lack local data. Coverage and plan updates retry only pending nodes.
A confirmed source replacement, removed view, or retired runtime still cancels
the registration. Missing data continues to suspend guarded local computation
without replacing authoritative output with an accidental `undefined`.

This removes the repeated successful bindings identified in the
[startup investigation](2026-09-11-view-replication-startup.md). It does not
initialize a computation as current from server evidence; that remains a
[separately sized proposal](../../plans/view-replication-server-currency.md).

## Change and regression evidence

`Runner.startViewPiece()` owns a pending-node set and returns a resumable
registration. Successful bindings leave that set and keep their existing
scheduler state. Each unavailable attempt releases its own partial ownership.
The client reconciles the registration by resuming it while its source remains
selected. Unexpected binding errors retire the registration and propagate.

Pending nodes are retried on the existing coverage and plan signals. Restricting
retries to the previous missing address would be unsafe: a changed input can
redirect the binding to a different address while the previous target remains
unavailable. More precise retry selection requires dependencies that include
such redirecting reads and is outside this change.

Two regressions failed against the previous implementation and pass with this
change. The real stored-graph test observes scheduler registration, an unrelated
coverage update, and then arrival of a missing handler stream. The visible
binding and its body remain single, and the newly available handler binds once.
The lifecycle test retains a partial registration across plan generations and
retires it on source replacement and unmount. Existing assertions also retain
input-basis and source guards. The focused view/local-read suite passes all nine
groups and 60 steps.

Full package test tasks pass for runner, memory, runtime-client, piece, UI,
patterns, and shell. The runner task reports 1,446 passed tests and 9,022 steps,
zero failures, and one ignored step. Repository formatting, lint, type checking,
documentation, history index, conflict-marker, package-cycle, and integration
waiting checks also pass. An initial type-check failure in the new test spy
types was corrected before the final passing checks. The source was restored
from temporary instrumentation before the full runner task started.

## Startup counter capture

The diagnostic used 30 topics, `HEADLESS=1`, and server execution and
view-scoped replication enabled. The source base was
`2e5f76ebfc606e0ebdb8b64a653867f6b231df4a` plus this branch's feature and fix.
An isolated checkout kept temporary counters out of the main checkout while its
package suites ran. Metadata and an actual worker-initialization assertion
verified flag propagation. Both the flag test and browser driver exited zero.

| Quantity before opening a topic                | Previous capture | Retained bindings |
| ---------------------------------------------- | ---------------: | ----------------: |
| Distinct graphs                                |               61 |                61 |
| Successful bindings in the first pass          |            1,033 |             1,033 |
| Total successful bindings                      |            3,862 |             1,033 |
| Repeated successful bindings                   |            2,829 |                 0 |
| Topic-name executions across 30 distinct nodes |               60 |                30 |
| JavaScript binding attempts                    |            5,910 |             2,569 |
| Attempts blocked by unavailable data           |            2,048 |             1,536 |

The new capture includes 123 binding passes: three for the board and each topic,
and one for each of 30 other graphs. Every successful binding belongs to its
first pass; subsequent passes attempt only unavailable nodes. The prior capture
had four passes for each board/topic graph, so the unavailable-attempt totals
are not a controlled measure of an additional optimization. Both captures have
the same 1,033 successful bindings in a single pass.

The browser verified the board and all 30 topic graph identities, opened a
topic, verified its content and linked-topic content, and completed the mount
and idle acknowledgments. Final snapshots contain no page errors, terminal IPC
failures, or pending requests. All sampling profiles completed. Chrome did not
finish exiting after the final snapshots; terminating that owned Chrome process
allowed cleanup to finish. This is an assisted-teardown diagnostic, not a clean
benchmark trial. Own servers were stopped, temporary sources restored, and the
closed store and isolated checkout removed.

## Measurement limits and a remaining delay

These are mechanism counts, not a startup speedup estimate. Machine load was
extreme and variable: the one-minute load was 94 at driver start and 266 at
exit. Package tests and other work were active on the shared machine.

An earlier after-fix capture stopped before any local graphs had installed and
is excluded. The replacement waits on an explicit graph-registration event and
then verifies the expected fixture identities. In this capture, the board was
visible before any nonempty plan arrived. Plans remained at generation zero
until about 83.5 seconds after the worker's timing origin; the graph-ready phase
waited 65.5 seconds after the initial mount, registry, and idle acknowledgments.
The plan eventually arrived and the registration event resolved naturally.

This delay precedes the changed binding code. It demonstrates that a rendered
page, acknowledged mount, and local runtime idle do not prove delivery of the
server's execution plan. The serving loop publishes view plans only after a
non-exhausted wave or quiet cycle; the contemporaneous server snapshot reports
684 budget-exhausted cycles. Those observations make serving-loop starvation a
hypothesis, not an established cause. Reproduce under controlled load and trace
publication/delivery before attributing or changing that behavior. Keep plan
readiness visible in future startup measurements instead of reporting an empty
snapshot as saved work.

## Second optimization

The separate proposal targets the remaining first executions. Its conservative
scope is one runner change: roughly 250–450 production lines and 350–650 test
lines, with no new Memory message expected. It reuses settled input/output
fingerprints and recursive producer evidence to establish initial clean state
and its invalidation dependencies atomically.

The important boundary is provenance: a server-adopted clean node must not
appear to have successfully executed locally, because that would bypass the
proof on downstream reads. Missing or invalid evidence keeps the existing
guarded path. Initial registration only bounds the interaction with in-flight
edits. The proposal specifies source, coverage, output/overlay,
transitive-dependency, plan-change, and retirement tests before implementation.

## Evidence

The [results](2026-09-11-view-replication-retained-bindings.results.json) retain
source hashes, exact commands, initial failing and final passing checks,
installation/action counters, phase timestamps, profile hashes, and the cleanup
intervention. Raw logs, profiles, temporary instrumentation, and the four-file
pre-fix source snapshot are retained at
`/Users/berni/.codex/artifacts/view-replication-retained-bindings-2026-09-11/`.
