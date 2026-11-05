---
status: historical
created: 2026-10-21
archived: 2026-10-21
reason: "A census of the work one vote burst causes on each arm, counted rather than timed: how many flush passes, session walks, root evaluations, traversals, waves, frames and scheduler runs a burst of 25 votes costs, what multiplies each, and which of the multipliers is removable."
---

# The served vote's work census: what runs, how often, and what multiplies it

The records before this one timed the leaves of a vote burst and took the
slow ones out: the send that waited, the serving loop's round trips, the
pattern's per-viewer tallies. The burst did not move. This record counts
instead of timing: for one burst of 25 votes it lists every kind of work the
runtime does, on each arm, how many times it does it, and which input
multiplies the count. The point is the multipliers, since a hotspot that runs
ten thousand times is cheaper to call less than to make faster.

## Method

The workload is the vote-burst benchmark's: the `lunch-poll-keyed-votes`
fixture with the poll rendered, five voters each holding a rendered view in a
Deno worker of its own, five options, 25 votes a burst, each burst recoloring
every vote. An uncommitted probe hosts the benchmark's own harness and
drives the same burst, with the harness's diagnostics on (the scheduler's
action-run and trigger traces in every session) and `CF_TIMING_MEASURES=1`,
so every logger span of every realm is emitted with its occurrence detail.
Two warm-up bursts run uncaptured; then two bursts are captured, each from
the first vote's dispatch through the harness's after-burst wait (every
session's event consequences arrived, two settle rounds), and the probe
drains each realm's measures, the sessions' traces and logger counts, and
the serving loop's counters and timing statistics around that window. The
numbers below are the first captured burst of each arm unless two are given;
the second burst agreed within a few percent everywhere.

Three arms, on a four-core Linux container with Deno 2.9.4, the box otherwise
idle:

- **OFF**: `EXPERIMENTAL_SERVER_EXECUTION=false`.
- **ON, main thread**: the loop on the test process's thread with
  `SERVER_EXECUTION_STORE_READ_THROUGH=true`, the overlap off.
- **ON, worker**: the same with `SERVER_EXECUTION_WORKER=true`.

Three limits. Emitting a measure per span slows every realm, so the wall
times here are diagnostic and several times the benchmark's; the counts are
the data. The worker arm's serving realm reaches the probe only as the
timing statistics the worker posts, not as measures, so its per-occurrence
rows (which action, which root) are the main-thread arm's. And the trigger
trace keeps 400 entries, which the OFF arm and the main-thread arm's first
burst exceeded; their trigger counts are the last 400 notifications of the
window.

The probe is a copy of the benchmark's setup with the capture around the
burst and stays uncommitted, as the records' probes do
(`docs/specs/server-side-execution/testing.md` §1); the capture it writes
is read back with a script that reconstructs the containment forest of each
realm's measures (`skills/perf-investigation/scripts/measure-forest.ts` is
the same construction), decodes each measure's detail, and groups by batch,
walk and session. The harness change this census needed, the trigger trace
in a session's diagnostics snapshot, is committed.

## The burst, end to end

| arm | burst, first and second | after-burst wait |
| --- | --- | --- |
| OFF | 5.3 s, 4.9 s | 2.3 s |
| ON, main thread | 10.7 s, 9.5 s | 0.02 s, 0.1 s |
| ON, worker | 8.1 s, 7.7 s | 0.06 s, 0.01 s |

The after-burst wait is the time between every client's rows being current
and every fired event's consequence having arrived: on the OFF arm the clients
are current long before the server has finished absorbing their derived
writes; on the served arms the row convergence is the consequence.

## The memory server

One burst, the server's thread, counted from the measures:

| | OFF | ON, main | ON, worker |
| --- | --- | --- | --- |
| flush passes | 10 | 76 | 39 |
| refresh batches (dirty spaces per pass) | 8 | 74 | 38 |
| session refreshes, touched / untouched | 39 / 1 | 330 / 40 | 185 / 0 |
| root-selector evaluations | 60,713 | 18,124 | 16,440 |
| distinct (document, path, schema) among them | 4,246 | 1,966 | 1,966 |
| evaluations repeating a tuple within one batch | 44,932 (74%) | 13,728 (76%) | 12,368 (75%) |
| sessions evaluating the same tuple in one batch, mean | 3.85 | 4.12 | 4.04 |
| traversals | 46,917 | 18,198 | 20,983 |
| distinct (document, path, schema) among them | 2,909 | 1,989 | 3,137 |
| traversals ending in a validation failure | 13,916 (30%) | 4,838 (27%) | 4,550 (22%) |
| documents updated across all walks | 5,151 | 1,675 | 1,515 |
| frames sent (`send/encode`) | 2,262 | 660 | 439 |
| frames received (`memory/frame/handle`) | 2,223 | 330 | 252 |
| cumulative inbound queue wait | 186 s | 0.2 s | 0.06 s |

Every root evaluation sits inside a session's walk inside a batch, and a root
evaluation traverses at most one document: 526 of the main-thread arm's
18,124 root evaluations and 13,796 of the OFF arm's 60,713 traversed nothing,
coverage or absence having answered them, and none traversed twice. The
memory server's traversals have no other caller on this thread; the 600
traversals outside any root on the main-thread arm are the serving runtimes'
own. Four things multiply the counts.

**The per-session walk.** A batch refreshes every session that tracks a dirty
document, and the five sessions track the same view of the same documents, so
a (document, path, schema) tuple is evaluated about four times per batch, once
per session, under a different identity each time. That is three quarters of
all root evaluations on every arm. It is the fan-out the earlier records
named; the census puts a number on it that does not depend on the arm.

**The schema multiplicity of one path.** A session tracks a (document, path)
under every schema a reader declared for it, and the walk evaluates each
(document, path, schema) as its own root. On the OFF arm the 60,713 root
evaluations cover 1,021 distinct (document, path) pairs, 697 of which are
tracked under more than one schema; the pairs with more than one schema take
55,943 of the evaluations, 92%, and 3,467 of the 3,890 ms the evaluations
sum to. The spread is wide: 324 pairs under one schema, 193 under two, 111
under eleven, and five root documents under 43 or 44 schemas each, 875
evaluations apiece in one burst. The same shape holds on the served arms
over 1,966 distinct tuples.

**Traversals that cannot succeed.** The failed traversals are the same every
burst, 4,838 on the main-thread arm both times, and they fall on 638
(document, path, schema) tuples over 128 documents and seven schemas; on the
OFF arm 13,916 over 968 tuples, 240 documents and fourteen schemas. Most are
a document's top-level path (488 of the 638 tuples), and 150 are the tally
computation's `voters/<n>/name` under six schemas. A tuple fails once to 25
times a burst on the main-thread arm and once to 75 on the OFF arm, with a
median of one and five: a selector that does not match the document it is
evaluated against is re-evaluated at every refresh of every session that
tracks it, and the failures are a quarter to a third of all traversals.

**A flush pass per derived commit, and frames to match.** On the served arms
the loop commits a wave, the commit dirties the documents it wrote, and the
server runs a flush pass that refreshes every session tracking them and sends
each a frame. The main-thread arm's 68 derived commits became 76 flush passes,
330 session refreshes and 660 frames; the worker arm's 31 became 39, 185 and
439. The batches alternate between two shapes. About half carry a vote's
consequences, four to eighteen dirty keys, and cost each of the five sessions
100 to 140 root evaluations, 500 to 690 in all, with 30 to 50 documents
updated. The other half carry one to four dirty keys and still touch all five
sessions: nine of the main-thread arm's 74 batches held one dirty key, six of
them the event stream document `of:stream-events:…`, one the serving
watermark, and each cost five session refreshes of five root evaluations, no
traversal, and five frames carrying that one document. The encode of the
frames is 3.5 s of overlapping asynchronous time on the main-thread arm and
5.2 s on the worker arm, 5 to 12 ms a frame.

On the OFF arm the shape differs: five clients derive and write the same
documents, so the server's inbound side takes 2,223 frames in a burst,
commits, acknowledgments and watch adds, and the cumulative time those frames
spent queued behind one another was 186 s, 84 ms a frame. The server's
outbound side is ten passes over eight batches: five batches of 150 to 360
dirty keys walking all five sessions at 9,400 to 12,700 root evaluations
each, and three smaller ones of 570 to 2,650. It also repairs 966 conflicts a
burst, re-dirtying the rejected commits' read sets.

## The serving loop

| | ON, main | ON, worker |
| --- | --- | --- |
| authored events seen | 25 | 25 |
| waves, and waves cut at the flush deadline | 68, 67 | 31, 28 |
| derived commits | 68 | 31 |
| wave cycle, count × mean | 71 × 149 ms | 33 × 246 ms |
| settle inside the cycle | 71 × 129 ms | 33 × 112 ms |
| wave commit | 68 × 13 ms | 31 × 75 ms (port round trip 70 ms) |
| scheduler action runs, over distinct actions | 858 over 154 | 833 |
| handler runs (`handlerAction`) | 25 | 25 |

Twenty-five votes became 68 waves on the main thread and 31 in the worker,
and all but one or three of them ended at the flush deadline rather than at
quiescence. A vote's cascade (tally, ranking, cards, per-instance copies) runs
over more than one wave when the deadline cuts it, and each cut is one more
derived commit, which the memory server answers with a flush pass over the
sessions tracking what it wrote. The wave count and the pass count are two
multipliers, not one: 68 derived commits sat under 76 passes and 74 batches on
the main-thread arm, 31 under 39 and 38 in the worker, the difference being
the votes' own appends and the bookkeeping documents. The 154 distinct actions run 858 times, 5.6 runs each per burst:
25 of them, the handler-adjacent lifts and maps, run exactly once per vote,
and the rest run per instance and per re-trigger. On the worker arm the
cycle is longer and the waves fewer, so the same 25 votes cost half the
derived commits; the worker also made one `server.flushSessions` request
that took 1.7 s to answer, the server being in its own flush passes.

## The clients

Per client, one burst:

| | OFF | ON, main | ON, worker |
| --- | --- | --- | --- |
| scheduler action runs, over distinct actions | 695 over 230 | 643 over 232 | 581 over 232 |
| of them computations / effects | 446 / 249 | 393 / 250 | — |
| runs of an action already run this burst | 465 (67%) | 411 (64%) | 349 (60%) |
| runs of actions the serving side also ran | — | 336 to 393 (52 to 61%) | — |
| trigger notifications, by type (last 400) | commit 267, revert 129, integrate 4 | commit 322, integrate 78 | commit 194, integrate 186 |
| actions matched by those notifications | 594, 285, 8 | 751, 189 | 332, 550 |
| rejected commits / rolled-back writes | 155 / 219 | 0 / 0 | 0 / 0 |
| runs that ended in an error | 219 | 5 | — |
| watch-add round trips | 4, 4.97 s in all | 0 | 0 |
| traversals, distinct tuples | 417, 127 | 405, 128 | — |

**Under serving, the client still derives everything.** Of the 154 actions
the serving side ran, 144 also ran on every client: 1,738 client runs of them
across the five clients against 858 server runs in the main-thread burst, 336
to 393 runs per client. They are 54% of the clients' runs and 71% of their
run time. The trigger trace says how they are reached: a served
result arriving is an `integrate` notification, 78 of which matched 189
actions, and each action that runs writes its result, which is a `commit`
notification to the actions downstream, 322 of which matched 751. So a
served value does not replace the client's derivation of it; it re-triggers
it, and the chain below runs again on the client as it ran on the server.
The echo of the client's own five votes is the smaller part of this: the
same shape holds for the twenty votes it did not cast.

**On the OFF arm the client pays for contention and waits for the server.**
Of 695 runs, 219 ended in an error, which is the rolled-back write of a
rejected commit, and 129 `revert` notifications re-triggered 285 actions. The
burst's length is something else, though: each client made four watch-add
round trips in the burst, one from the vote handler's run and three from
frames that arrived carrying links the view had not yet watched, and each
took about 1.25 s to answer because the server answers between its flush
passes, each of which walks five sessions over ten thousand roots. The
client's scheduler ran inside those waits, 15 of its 21 execute rounds, and
the four waits sum to 4.97 s of a 5.3 s burst.

**The client's own traversals** are the view's: of 417, 219 run under the
rendered view's sink, 30 in the event's dependency population and 15 in the
handler's reads. 290 of them repeat a tuple another traversal of the same
burst used, and the hot one is the votes list under the view's schema, 14 to
53 times a burst.

## What multiplies what

Reading across the tables, one vote on the main-thread served arm costs:

- 2.7 waves, each a derived commit;
- 3 flush passes (one per derived commit, plus the vote's own append and the
  bookkeeping documents), 13 session refreshes, 26 frames encoded and sent;
- 725 root evaluations on the server, about 190 of them distinct, 550 of
  which repeat a tuple another session evaluated in the same batch, and 194
  traversals that end in validation failures;
- 34 scheduler runs on the serving side, over the pattern's 154 actions;
- 26 scheduler runs on each of five clients, 14 of them re-running an
  action the server ran for the same change.

The multipliers are, in the order of the counts they drive: the number of
sessions tracking the same documents (×4 on every server-side count), the
number of schemas a path is tracked under (×2.8 on root evaluations over the
pairs with one schema, with a long tail to ×44), the number of waves a vote's
cascade is cut into (×2.7 on commits, passes, walks and frames), the re-run
of the served chain on every client (×5 on the served computation), and, on
the OFF arm alone, the conflict repair of five writers (×1.4 on client runs)
and the serialization of a client behind the server's watch-add answer.

## What this selects

Each of these takes work out rather than making a leaf faster, and each
names the invariant the removal has to keep.

1. **Evaluate a (document, path) once per walk and validate its schemas
   against that one evaluation**, or merge the schemas a session tracks for
   one path before the walk. Removes up to 92% of root evaluations where
   paths carry several schemas. Invariant: each selector still gets its own
   validation result and its own coverage.
2. **Remember a selector that failed against a document version** and skip it
   until that version changes. Removes a quarter to a third of traversals,
   the same 638 to 968 tuples every burst, most of them a document's top-level
   path under a schema it does not satisfy. Invariant: a new version
   of the document re-validates every selector.
3. **Share the space-pure part of a root evaluation across the sessions of
   one batch**, the candidate the fan-out plan already names. Removes up to
   three quarters of root evaluations. Invariant: nothing that resolved a
   user- or session-scoped instance is reused across identities.
4. **Let a bookkeeping-only commit skip the refresh pass**, or carry the
   stream-events and watermark documents to sessions outside the per-session
   walk. Removes about one batch in eight, each costing five refreshes and
   five frames for one key. Invariant: a session that tracks those documents
   still learns their new version, and a read-boundary wait that watches the
   watermark still resolves.
5. **Finish a vote's cascade in fewer waves**, by letting a cycle run a
   cascade to local quiescence before it commits or by coalescing the flush
   passes several commits cause into one. Removes up to 63% of derived
   commits and the passes, walks and frames behind each. Invariant: a frame
   still carries a consistent prefix, and the read-boundary wait still
   covers the authored commit.
6. **Under serving, integrate a served value as the derivation's result
   rather than as a trigger for it.** Removes about half of each client's
   runs and seven tenths of their time.
   Invariant: the client's own in-flight intents keep their echo until the
   served consequence lands, and a client that renders a derived value never
   shows a stale one.
7. **On the OFF arm, answer a watch add without waiting for a flush pass to
   end**, or let the client keep scheduling without the answer. Removes the
   serialization that is the OFF burst's length. Invariant: the watch's first
   frame still carries a consistent snapshot.

Items 1 to 3 are the memory server's and move every arm; 4 and 5 are the
serving loop's; 6 is the client's under serving; 7 is the OFF arm's. Items 1
and 2 are the cheapest to try and the least entangled with the identity
rules, and 6 is the one whose removal the headline would show most directly,
since the client's runs sit on the critical path to its own rows.

## What this does not settle

The schema hashes identify a selector's schema without naming the reader
that declared it. Mapping the 44 schemas of one path back to the pattern's
reads, which is what items 1 and 2 need, takes a dump of a session's tracked
selectors with their schemas, which the probe does not take. The worker
arm's serving realm is counted only through its timing statistics. The
trigger traces of the OFF arm and the main-thread arm's first burst are the
last 400 of more. And every duration here is inflated by the measures
themselves; the counts are what the next change is measured against.

## Reproducing the capture

From `packages/patterns`, one arm at a time, with a probe that hosts
`MultiRuntimeHarness` as `integration/lunch-poll-vote-burst.bench.ts` does
(five sessions with `renderView: true`, `input: { renderPoll: true }`,
`watchPaths: []`, `diagnostics: true`), joins the voters and adds the options,
runs two warm-up bursts, and around each captured burst drains
`performance.getEntriesByType("measure")` on the host, each session's
`timingMeasures()`, `diagnostics()` and `loggerCounts()`, and the harness's
`servingStats()` and `servingDiagnostics()`:

```sh
CF_TIMING_MEASURES=1 CF_TIMING_MEASURES_CAP=3000000 \
CF_LUNCH_POLL_VOTERS=5 CF_LUNCH_POLL_OPTIONS=5 LOG_LEVEL=warn \
EXPERIMENTAL_SERVER_EXECUTION=true SERVER_EXECUTION_WORKER=false \
SERVER_EXECUTION_STORE_READ_THROUGH=true SERVER_EXECUTION_OVERLAP_COMMIT=false \
deno run -A --no-check integration/<probe>.ts
```

A measure's name is `cf:<key>|<detail>#<sequence>`; `detailOfMeasure` in
`@commonfabric/utils/logger` decodes the detail. A root evaluation's enclosing
batch, walk and session are the nearest enclosing `memory/refresh/batch`,
`memory/refresh/walk/total` and `memory/refresh/session/touched` spans in the
containment forest.
