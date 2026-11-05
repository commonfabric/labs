---
status: historical
created: 2026-09-20
archived: 2026-09-20
reason: "Measurement of the serving loop's demand-pass structure loads on the topics seed, the attempt that was withdrawn for unsoundness, and the paired rounds behind the one that shipped."
---

# The demand pass's first structure load, measured and cut (2026-09-20)

The 2026-09-09 server-execution topics benchmark record — landing separately
as `2026-09-server-execution-topics-benchmarks.md`, and not in this tree when
this was written — names two halves in its §5 item 1. The first — confirming no-pattern-metadata from
the co-hosted engine instead of re-traversing — shipped as #7749 and moved
nothing. This record is the second: taking the never-a-piece roots off the
wave's settle path. It holds what the cost turned out to be, an attempt that
was built and withdrawn, and the paired rounds behind the change that shipped.

The data is in
[`2026-09-20-demand-pass-root-pull.results.json`](2026-09-20-demand-pass-root-pull.results.json)
beside this file. Every figure below names which part of it it comes from, or
says it comes from somewhere else.

## Read this before the figures

**The counts carry the result; the milliseconds do not.** The measuring box ran
between one-minute load 10 and 108 throughout, with other work on it that this
session did not control. Arms alternate within a round and the order flips each
round, so a count's comparison is between adjacent runs. Wall clock is recorded
and is not read: the seed times of the two arms overlap completely.

**One counter is not load-insensitive either.** `watchAddSync` counts a pull,
and a contended run makes more demand passes, so it makes more pulls. Round 5's
base arm ran at load 26 rising to 59 and is the highest base count of the six.
That is why the result below is stated as a per-round delta as well as a mean.

## What ran

*Source: `workload`, `arms` and `order`.*

`packages/patterns/integration/topic-board-seed.ts` at 30 topics with
`demand=index`, against a toolshed binary built with
`EXPERIMENTAL_SERVER_EXECUTION=true`, each run against a fresh store on its own
port. Six rounds, two runs each, the arms alternating and the order flipping
per round. Each run probed `/api/meta` and `/api/health/stats` before the
workload and differenced the stats afterwards.

The seed is the workload because it is where the cost is: on the 30-topic
navigation benchmark that record puts 88 s of a 90 s run in the seed.

## Where the demand pass's time goes

*Source: a separate instrumented binary at `116d366639`, whose per-attempt
spans are not in the results file.*

A build carrying temporary spans around each first `#attemptStructureLoad`,
run once on the same workload:

| span | count × mean |
| --- | --- |
| every first attempt | 1 673 × 5.5 ms |
| attempts ending `no-pattern-meta` | 660 × 12.7 ms |
| attempts that started a piece | 1 013 × 0.9 ms |
| attempts reading ONE document | 669 × 12.8 ms |
| attempts reading two | 968 × 0.7 ms |
| the root loop as a whole | 301 × 31.2 ms = 9.41 s |
| `demandPassMs` | 12.47 s |

Three things follow. The never-a-piece confirmations are 8.37 s of the root
loop's 9.41 s. A traversal that reads one document costs 12.8 ms and one that
reads two costs 0.7 ms, which is the difference between a document the serving
replica has to fetch and one it already holds — so the cost is the fetch, not
the walk. And the same build counted 626 first terminal parks against 34
repeats of a root that had already answered, which is what ruled out
remembering a terminal verdict across demand departure: it would have reached
5 % of them.

## The attempt that was withdrawn

A build answered the never-a-piece question at the co-hosted engine — a
document the engine holds carrying neither a `result` backlink nor a pattern
pointer is one the traversal would walk in a single hop and classify
`no-pattern-meta` — and parked the root terminal without syncing it. It passed
its own five cases and `deno task check`.

`packages/runner/test/executor-events-down.test.ts` failed on it, in the arm
that pins a served receipt write as a write-once no-op: the standing `tok-99`
receipt became `tok-7`. The served handler overwrote it. The demanded root
whose sync was skipped is the receipt document itself, and the write-once check
is a `getRaw` that reads the replica locally and does not sync, so with the
document absent from the replica the check reads an empty cell and writes.

The demand pass's structure-load sync is therefore how a demanded root reaches
the serving replica's basis, and not only how its metadata is read. No variant
that removes that sync is sound. The attempt was withdrawn rather than narrowed.

## What shipped, and what it moved

*Source: `runs`.*

The loads stay sequential and every sync they issue still happens; what changed
is when the pass waits. The root documents the pass's loads will read are
pulled together first, so the replica's refresh queue coalesces them into one
`session.watch.add` instead of one per root, and each traversal then finds its
document held. Rounds 5 and 6 carry a second commit, which opens the pass's
changed-document collection at that pull rather than per root: the pull is what
registers each root's watch, and a registered watch is what lets a traversal
read instead of fetch, so a root's reading is taken over the span from the pull
to its own turn and the terminal arm's invalidation has to test that span.

A third change is not measured here. It also pulls a scoped root's
space-instance fallback, and it came after every round. It changes the pull
only for demanded roots at a scope other than `space`, and the rounds do not
record how many of this workload's roots were scoped, so the figures below are
the two commits above and nothing later.

| round | arm | `watchAddSync` count | `demandPassMs` | terminal | deferred |
| --- | --- | --- | --- | --- | --- |
| 1 | base | 966 | 10 206 | 659 | 1 |
| 1 | fix | 760 | 9 884 | 661 | 0 |
| 2 | base | 984 | 13 137 | 658 | 2 |
| 2 | fix | 774 | 12 979 | 669 | 2 |
| 3 | base | 987 | 13 361 | 659 | 2 |
| 3 | fix | 764 | 8 721 | 662 | 0 |
| 4 | base | 963 | 10 603 | 659 | 0 |
| 4 | fix | 723 | 6 577 | 660 | 0 |
| 5 | base | 1 022 | 19 355 | 661 | 0 |
| 5 | fix | 739 | 10 029 | 661 | 3 |
| 6 | base | 986 | 13 008 | 661 | 0 |
| 6 | fix | 753 | 7 121 | 663 | 9 |

`storage.v2/watchRefresh/watchAddSync` count: base mean 984.7 over 963 to
1 022, fix mean 752.2 over 723 to 774. The per-round deltas are −206, −210,
−223, −240, −283 and −233, and the two arms' ranges do not overlap in any
round or across all twelve runs.

`servingLoop.demand.demandPassMs` falls in every round, by −322, −158, −4 640,
−4 026, −9 326 and −5 887 ms. Those deltas span a factor of sixty and the
largest of them belong to the rounds whose base arm caught the machine's load,
so this record states the direction and no size.

`structureLoadTerminal` is 659.5 against 662.7 and `ensurePieceCalls` — the
traversals themselves — 2 979 against 2 980, so the same roots terminalize and
the same traversals run. `structureLoadFailures` and `structureLoadStuck` are
zero in all twelve runs.

`structureLoadDeferred` is not, and the widened invalidation span shows in it.
The base arm defers 1, 2, 2, 0, 0 and 0; the fix arm 0, 2, 0, 0, 3 and 9, and
the two largest belong to rounds 5 and 6, which are the rounds carrying that
span. A deferral there is the guard doing what it was widened to do — a commit
touched a root's document between the pull that read it and the root's own
turn, so the reading is not trusted and the root retries inside the same
settle. What it is not is free, and this record does not claim it is: against
661 and 663 terminal parks it is 3 and 9 retries, and those two rounds hold the
largest and the third-largest per-round saving of the six, −283 and −233, so
the retries did not eat it. That is the delta rather than the absolute count,
because the count rides whatever load the base arm caught.
`structureLoadStuck` staying zero is what says none of them became a root that
stops resolving.

## What this does not establish

The rounds measure one workload at one size against one seeding client. A
browser navigation's demand pass reaches the same code with a different arrival
pattern — the benchmark record counts about 15 terminal confirmations per
navigation against 23 per seeded topic — and nothing here measures it.

The saving is bounded by how the roots arrive. A pass with one new root
coalesces nothing, and the 1 677 documents a run pulls produce a saving of
about 230 pulls, because most of them are already held. A change that made
fewer passes, or that put more new roots in each, would raise this one's
ceiling.

## Files

The run driver, the per-run artifacts, the instrumented binary's spans, and
both arms' binaries are in the session's scratch directory on the measuring box
and are not archived. The withdrawn attempt is described in full above and was
not committed.
