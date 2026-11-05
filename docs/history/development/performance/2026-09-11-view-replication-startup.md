---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Matched startup profiles and temporary counters identify repeated partial-graph installation and speculative name lookup costs."
---

# Startup with view-scoped replication

The enabled startup performs avoidable repeated work. A graph with some missing
local inputs is treated as an incomplete registration, so later coverage
notifications cancel its successful bindings and install them again. In the
30-topic diagnostic, the board and all 30 topics were each installed four times.
The other 30 graphs were installed once. The 30 topic-name computations each ran
twice before the user opened a topic.

This explains why the registry-ready phase is expensive even though reading the
registry itself is small. `getPieceRegistry()` pulls a narrow stored export, but
`Cell.pull()` waits for scheduler-wide pending work and the shared pool of
pending loads. The reported registry wait includes graph installation and
speculative computation elsewhere in the runtime.

## Measurement posture

All runs used an Apple M3 Max, Deno 2.9.4, 30 topics, `HEADLESS=1`, and server
execution enabled. The source base was
`2e5f76ebfc606e0ebdb8b64a653867f6b231df4a` plus the existing view-replication
work. The first two runs toggled only the global replication flag, with the web
override unset. They had identical source hashes. Each used a fresh store,
seeded the board on a running server, and opened a fresh browser. Server
metadata and the actual browser-worker initialization payload were checked.

The first pair captured worker, main-thread, and server sampling profiles. The
worker capture began as its target became available and ended after the final
startup idle acknowledgment, before the topic click. Initial worker setup can
precede profiler attachment; these captures describe the subsequent startup work
rather than every instruction from worker creation. Server counters were
differenced around browser startup to exclude seeding.

A third enabled run added temporary runtime counters for installation attempts
and action invocations. It changed no pattern code or execution decisions. All
three measured journeys and their flag tests passed without page errors,
terminal IPC failures, or pending requests at the final snapshots. All profiler
captures succeeded. Every own server was stopped and its closed temporary store
removed. The three instrumented runtime files were then restored to their exact
pre-diagnostic hashes; no runtime change is retained from this investigation.

Shared-machine load remained substantial and changed between captures. These are
attribution runs, not new speedup estimates. The preceding
[interleaved measurements](2026-09-11-view-replication-main-interleaved.md)
remain the unprofiled latency record.

## Why the waits occur in different phases

| Observed phase in the matched profiles    |  Enabled | Disabled |
| ----------------------------------------- | -------: | -------: |
| Wait for board content after initial idle |   931 ms | 4,831 ms |
| Remaining board mount acknowledgment      | 1,732 ms |     1 ms |
| Explicit registry readiness               | 3,962 ms |    10 ms |
| Following idle acknowledgment             | 2,075 ms |     4 ms |

With replication disabled, ordinary `runtime.start()` walks and synchronizes the
graph dependencies before the board appears. The worker's enclosing
`piece/phase/get.runtime.start` span was 3,264 ms. It recorded 31
`syncCellsForRunningPattern` calls, including 883 `resumeCellSync` calls and 240
list-child sync calls. These overlap heavily: their accumulated elapsed time
cannot be added to produce wall time. In the board-content interval, the worker
profile attributed approximately 2,705 ms to idle, 1,795 ms to other work, 257
ms to scheduler actions, and 75 ms to garbage collection. The server's startup
`watchAdd` total was 1,905 ms across 62 calls.

With replication enabled, the narrower display path makes the board visible
sooner. Accepting plans and receiving coverage also schedule local graph
installation, tracked as background scheduler work. Much of this work happens
after the display appears. The explicit registry request was delivered in less
than a millisecond; its delay was inside the handler. Its small default-root
sync/open phases totaled about 31 ms across both registry requests in the
capture. The eventual `syncPieces()` call uses `Cell.pull()`, whose global
settlement wait absorbs the remaining background work.

Within the enabled 3,962 ms registry interval, the worker samples partitioned
approximately into 1,874 ms graph installation, 1,352 ms scheduler actions, 585
ms other work, 92 ms garbage collection, and 59 ms idle. The following idle
request encountered another burst: 640 ms installation and 1,074 ms scheduler
actions. That request spent 2,011 ms awaiting delivery to the worker. Thus the
registry request's own delivery was prompt, while the subsequent idle request
was also held behind synchronous work.

Phase clipping uses the profiler-start command's epoch anchor; command
acknowledgment bounds are retained with the results. Treat these as approximate
sample attribution, not exact CPU accounting under contention. Across the worker
capture, graph installation accounted for 2,518 ms and scheduler actions for
2,455 ms. Schema binding, normalization, and hashing dominate the installation
branch. The server was 72% idle across its longer enabled capture; its two view
render walks totaled 326 ms and its two plan calculations 553 ms. Those elapsed
spans overlap and are not an additional partition of worker time.

## The repeated-installation defect

`Runner.startViewPiece()` tries every JavaScript node in a piece. A local-read
failure cancels that node's attempt and sets a graph-wide `complete` flag to
false. The returned registration reports that flag through `graphIsInstalled()`.

`ViewReplicationClient.#install()` then uses that graph-wide result when
reconciling existing registrations: if a piece is still wanted but incomplete,
it cancels the whole registration and deletes it. The following loop invokes
`startViewPiece()` for that piece again. Coverage notifications call this path,
even when the plan generation has not changed.

The diagnostic counted passes that reached node binding; stale exits before
binding are not included. It recorded:

| Quantity before the topic click                  |   Count |
| ------------------------------------------------ | ------: |
| Installation requests / current passes           | 11 / 10 |
| Distinct graphs                                  |      61 |
| Graph installation attempts                      |     154 |
| Board and topic graphs installed four times each |      31 |
| Other graphs installed once                      |      30 |
| JavaScript binding attempts                      |   5,910 |
| Binding attempts in one pass over those graphs   |   1,545 |
| Successful bindings, including repeats           |   3,862 |
| Successful bindings in one pass                  |   1,033 |
| Binding attempts blocked by local availability   |   2,048 |

Each topic had 48 JavaScript nodes: 31 bound successfully and 17 were
unavailable, on all four attempts. The board had 15 JavaScript nodes: 13 bound
and two were unavailable. The partial registrations never became complete in
this startup. The counter recorded three installations of a representative topic
within the same view-plan generation, followed by another installation under the
next generation. Its first successful `ownName` invocation occurred before that
final reinstall, and its second followed it.

There were therefore 2,829 repeated successful bindings. The one-pass total is a
comparison baseline, not a claim that every blocked node should be tried only
once: newly available inputs can require another attempt. What is unnecessary is
discarding the bindings that already succeeded merely because another node
remains unavailable. A deliberately partial replica also cannot assume that
every node in an installed pattern will eventually have local data.

## Why the name lookup is expensive

The worker performed 437 scheduler attempts in the enabled profile, versus 196
disabled. It entered 152 JavaScript implementations versus 98. The enabled
profile attributed about 2,004 ms inclusively to `ownName()`, of which most was
runtime materialization, link resolution, and local producer-currency checking.
The underlying name lookup is a `table.find()` over the board's naming rows. It
is invoked independently for each topic, so the collection performs repeated
scans even though the table is shared. The profile does not show slow string
comparison as the dominant cost.

The counters confirmed 60 successful `ownName` action attempts for 30 distinct
topic nodes: two each, totaling 1,714 ms of cumulative attempt elapsed time in
that separate diagnostic. Reinstalling a binding recreates its action
registration, so its local scheduler state starts over. The producer basis
currently validates reads from upstream outputs; it does not initialize this new
action as already completed from the server's current-output evidence. The
startup consequently pays local execution and its per-read checks before any
user edit.

## Fix order and trade-offs

1. Preserve successful node registrations within a partially installed graph.
   Reconsider blocked nodes when relevant coverage or plan eligibility changes,
   and coalesce redundant queued installation passes. A changed pattern
   identity, removed view, or retired runtime must still tear the appropriate
   registrations down. Test partial coverage followed by unrelated coverage,
   newly available inputs, changed source, and unmount, while retaining the
   checks that prevent missing inputs from overwriting authoritative values.
2. Consider initializing eligible nodes from valid server output/read-basis
   evidence, with subscriptions that invalidate that evidence on local edits or
   changed inputs. This could avoid unnecessary first execution as well as
   repeated execution. It is a scheduler-currency change and needs stronger
   correctness tests than simply retaining an existing node.
3. After eliminating repeated installation and execution, reassess the naming
   scans and currency-check cost. Optimizing them first would leave the larger
   multiplier in place.

Separating passive registry readiness from runtime-wide settlement may also
improve responsiveness and make the metric more specific. It does not remove
background CPU work. Changing `Cell.pull()` globally to return early would
weaken a synchronization contract; any registry-specific change should instead
state which stored-data and freshness guarantees that caller needs.

## Evidence

The [results](2026-09-11-view-replication-startup.results.json) retain all three
source snapshots, flags and verification outputs, commands and outcomes, phase
timestamps, profiler hashes and anchors, selected worker counters, server
deltas, full temporary probe records, and restoration hashes. Raw profiles,
logs, harnesses, and the temporary instrumentation patch are in
`/Users/berni/.codex/artifacts/view-replication-startup-2026-09-11/`.

The source paths establishing the causal chain are
`packages/piece/src/ops/pieces-controller.ts` (`getPieceRegistry()` and
`syncPieces()`), `packages/runner/src/cell.ts` (`pull()`),
`packages/runner/src/view-replication-client.ts` (`#install()`),
`packages/runner/src/runner.ts` (`startViewPiece()`), and
`packages/runner/src/scheduler/facade.ts` (`prepareViewAction()`). The lookup is
`packages/patterns/collection-naming/naming.ts` (`nameOf()` and `ownName()`).
