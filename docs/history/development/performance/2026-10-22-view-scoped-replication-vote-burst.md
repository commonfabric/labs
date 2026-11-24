---
status: historical
created: 2026-10-22
archived: 2026-10-22
reason: "View-scoped replication measured under the served vote burst: a 25.9 s burst against 4.8 s with it off, traced to a plan per view per wave that re-walked the UI each time and a full re-evaluation of every session's watch set on each changed plan; the two changes that take it to 9.1 s on the main thread and 5.4 s in the worker; and where the remaining time goes."
---

# View-scoped replication under the served vote burst

The [work census](2026-10-21-served-vote-work-census.md) found the memory
server's per-session walks to be the largest multiplier on the served vote
burst, and view-scoped replication (`EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION`,
[registry](../../../development/EXPERIMENTAL_OPTIONS.md#viewscopedreplication--webviewscopedreplication))
has the server choose what each session receives instead of walking what the
client subscribed to. It had measured slow when last tried
([2026-09-10](2026-09-10-view-scoped-replication-performance.md)). This record
turns it on under the burst, says where its time went, lands the two changes
that reading selected, and measures them.

## How it was measured

The census probe hosts the vote-burst benchmark's harness with every realm's
timing measures and the sessions' scheduler traces drained around one burst of
25 votes (five voters, five options). View-scoped replication applies only to a
web-class client, so the harness's sessions can now declare `clientClass: "web"`
([`multi-runtime-harness.ts`](../../../../packages/patterns/integration/multi-runtime-harness.ts)),
which the benchmark and the probe do for every voter: the piece opens through
its name and UI tip, the rendered view registers as a view interest, and the
client runs locally only what the plan admits, as a browser tab does. The arm
otherwise is the census's main-thread arm with the store read-through on, the
overlap off, and the flush deadline growing to a 1000 ms cap
([wave costs](2026-10-22-served-vote-wave-costs.md)); the worker arm is the same
with the serving loop in the worker. Every count below is one burst, the
probe's second round, on the same four-core container as the census.

## The first capture: 25.9 s against 4.8 s

| Count, one burst of 25 votes | cap, view-scoped off | cap, view-scoped on |
| --- | ---: | ---: |
| Probe burst | 4.8 s | 25.9 s |
| Waves | 8 | 14 |
| Flush passes (time in them) | 17 (0.8 s) | 24 (7.5 s) |
| Session walks, root evaluations | 75, 10,206 | 90, 45 |
| View plans, time in them | — | 65, 14.9 s |
| UI walks for plans, time in them | — | 50, 10.1 s |
| Host traversals, time in them | 10,321, 0.4 s | 34,068, 10.4 s |
| Frames encoded | 202 | 253 |
| Serving scheduler runs | 888 | 789 |
| Client scheduler runs, each of five clients | 315 | 552–564 |

The selection does what it is for: the root evaluations the memory server's
incremental walks count fall from 10,206 to 45, since the sessions' graphs are
now the rendered roots and the documents the planner selected rather than
everything the clients had subscribed to. The count leaves out the full
evaluations of a session's watch set, which the second finding below accounts
for. What replaces the walks' work is the planner.

**A plan per view per wave, each walking the UI again.** The publisher
considers every attached view after every cycle: 16 publishes by 5 views here,
80 snapshot comparisons, of which 15 found the view's caches and execution
snapshot unchanged and 65 planned. 50 of the 65 plans walked the rendered tree
through the renderer schema to collect its reads, at about 200 ms a walk. The walk is cached and invalidated by the
scheduler's read matching, and every vote changes values the UI reads, so the
cache held for almost nothing in a burst even though the set of documents the
UI reads changed in none of these waves. The walk itself is a schema traversal
with a seven-branch `anyOf` at every node; the memory server logged 31 slow
traversals of the UI document at 100 to 220 ms each.

**A full re-evaluation of every session's watch set for every changed plan.**
A plan carries each selected producer's basis, fingerprints of the values it
read and wrote, and a vote changes those, so the selection the planner
published differed every wave. Publishing a selection set the session's
full-resync flag, and the next flush pass then re-evaluated the whole watch
set, rendered roots and support roots alike, through the renderer schema
again: 15 full evaluations at about 400 ms (488 traversals each), the bulk of
the 7.5 s the flush passes took. The frames that followed carried the
re-evaluated union, and each client ran half again as many actions integrating
them.

## Two changes

**The planner plans a cut wave over its last UI walk.** The serving loop tells
the publisher whether the settlement it follows reached quiescence or the
flush deadline. After a cut, a view whose walk a change invalidated is planned
over the walk it has, with the current execution snapshot and producer bases;
the walk is redone at the next settlement that reaches quiescence. A burst
walks the UI once per view, as it ends. What this trades: a UI subtree that
appears during a burst and reads documents no selected computation reads is
not delivered until the next settlement that reaches quiescence. The cap
bounds each cut settle, not the deferral: a space under continuous input
defers the walk for as long as the input lasts, and a bound on that wait is
open. Documents a computation reads are selected from the fresh snapshot
either way, and the rendered outputs flow through the support graph as before.

**A plan that changes only what a view may run or adopt rides the next frame.**
`setViewSelection` compares the selection's delivery queries with the view's
current ones. When they match, the session's graphs stand, the schema closure
is not resolved again, and a new session flag has the next frame carry the
plans, a frame of plans alone when nothing dirtied the session. Only a
selection that changes what the view is delivered takes the full re-evaluation
and the diff against the session's delivery state.

| Count, one burst of 25 votes, view-scoped on | before | after (main) | after (worker) |
| --- | ---: | ---: | ---: |
| Probe burst | 25.9 s | 9.1 s | 5.4 s |
| Waves | 14 | 8 | 4 |
| Flush passes (time in them) | 24 (7.5 s) | 16 (1.5 s) | 31 (1.1 s) |
| Session walks, root evaluations | 90, 45 | 130, 5,665 | 120, 6,615 |
| View plans, time in them | 65, 14.9 s | 35, 3.2 s | 21, 2.6 s |
| UI walks for plans | 50 | 5 | 2 |
| Host traversals, time in them | 34,068, 10.4 s | 8,752, 1.4 s | — |
| Frames encoded | 253 | 190 | 194 |
| Client scheduler runs, each client | 552–564 | 393 | 309–326 |

The root evaluations rise from 45 to 5,665 because the earlier capture's
sessions were being re-evaluated in full, which the walk counters do not see,
and are now refreshed incrementally, which they do. The benchmark without the
measures reads 8.8 s on the main thread with view-scoped replication on against
4.7 s with it off; the worker's second round read 7.9 s.

## Where the remaining time goes

Per plan, from one instrumented run of 40 plans: the UI walk amortizes to
31 ms (five walks), selecting the interaction cone 9 ms, reading the pieces'
registration metadata 4 ms, the producer ancestry 8 ms, the producer bases
12 ms, installing the caches 5 ms, comparing with the published selection
8 ms, and publishing to the memory server 11 ms. No one phase dominates. What
multiplies them is the same pair the census named for the walks: a plan per
session (five identical views, planned five times over the same snapshot) and
a plan per wave (eight here, each changing every producer's basis).

The renderer-schema walk is the one leaf that counts twice. The planner walks
it once per view per burst now, at about 250 ms; the memory server walks it
per session per batch as the view's demand root, and that walk is what makes
the flush passes 1.5 s instead of 0.8 s with the selection off (the host's
traversals peak at 6,576 schema calls, against 176 before). Every view frame
also carries the complete manifest, producers and bases included, so a frame
encodes in 10.5 ms rather than 4.8 ms and each client re-applies a plan per
frame; the clients run 393 actions per burst against 315.

On this workload every viewer sees everything, so the selection delivers
what ordinary replication delivers and the planning is overhead over it; the
mechanism pays where a view shows a small part of a large space. What is
left to take out, with the share of the 9.1 s burst each stands for:

1. One plan per snapshot rather than per session: the selection and ancestry
   are pure functions of the observed nodes and the render reads, and the
   bases of a document and path are the same for every session that holds
   the same document, so sessions with identical snapshots can share them.
   About 1 s.
2. Manifests only when they change: a frame carries the plans when a
   selection changed or a resync owes them, and otherwise the documents
   alone. About 1 s of encoding, and whatever the clients spend re-applying
   unchanged plans.
3. Plans deferred to quiescence, as the UI walk now is. About 3 s, against a
   newly visible document waiting for the next quiescent settlement, which
   the cap bounds per settle and not as a whole; the same bound the walk's
   deferral wants.
4. The renderer-schema walk itself, in the planner and in the memory server's
   demand graph: a leaf, 250 ms a walk here, for the round that returns to
   leaves.

## Validation

`deno fmt`, `deno lint` and `deno check` on the publisher, the space server,
the memory server and its session registry, the runtime presets, the piece
controller, and the harness files. The planner suite pins the cut-wave plan
over the last walk and the re-walk at quiescence; the memory view-interest
suite pins the plan delivered over an unchanged delivery without a watch-set
evaluation and the re-evaluation for a changed one; the view replication
client, lifecycle, flags, presets and space-server suites pass, except one
lifecycle step (a piece's source identity awaited before its graph installs)
that fails on this branch with and without these changes. The probe ran the
view-scoped main-thread arm three times (before, after, and once instrumented
for the per-plan split) and the worker arm once; the benchmark ran once with
the flag on. The harness's client class is committed; the probe stays
uncommitted, as the records' probes do.
