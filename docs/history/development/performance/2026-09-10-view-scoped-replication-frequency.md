---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Follow-up traces attribute redundant view planning to serving-loop cycles and distinguish it from pattern execution and query refresh."
---

# View planning frequency and repeated query evaluation

The follow-up investigation confirmed redundant view planning. A 30-topic board
was planned three times while opening a topic; the second and third selections
were identical to the first. Both repeated passes ran in quiet serving-loop
cycles with no contributions, pending effects, or watermark advance. Selection
equality prevented publication but was checked after the expensive work.

This follows the
[planning and delivery investigation](2026-09-10-view-scoped-replication-performance.md).
The
[companion trace data](2026-09-10-view-scoped-replication-frequency.results.json)
contains phase markers, planner stages, comparison outcomes, request counts,
source hashes, resolved-posture diagnostics, and profiler statistics.

## Scope and controls

All three scenarios used headless Chrome, Deno 2.9.4, a fresh local store, and
30 seeded topics on the same M3 Max machine. Server execution was enabled in
both flag arms. The shell flag integration test passed before each scenario; the
server profiler separately verified matching server and client server-execution
posture. Server sets ran sequentially.

The first enabled scenario opened one topic. A second enabled scenario and a
disabled control also followed a cross-reference. Temporary probes were added
only to the planner, serving loop, and Memory server. Authored patterns and
benchmark files were unchanged. No CPU benchmark or test suite was scheduled
alongside these captures. Background machine load was not controlled.

These are individual diagnostic captures, with profiling and trace overhead, not
new p75 benchmarks. Their counts and equality checks establish mechanisms; the
durations locate work and vary substantially between captures. Every probe was
removed afterward, and the three instrumented source files were verified
byte-identical to their pre-investigation copies. No production fix was made in
this follow-up.

## The planner follows loop cycles, not relevant changes

`SpaceServer` calls `ViewPlanPublisher.publish()` at two points:

- After a successful, non-exhausted wave commit.
- On a non-exhausted quiet cycle, even when no commit or watermark advance is
  needed.

Each invocation enumerates all attached views in the space. For each view it
copies the observed execution graph, walks the rendered tree, selects local
execution dependencies, identifies producers, and constructs value certificates.
Only then does it compare the resulting selection with the last published
selection. There is no dependency-based guard before the UI walk.

A serving-loop cycle is not a user event. Watch additions and replacements
notify demand changes; those notifications coalesce through the existing demand
wake mechanism. The loop also processes its own committed wave records and
watermark bookkeeping. A pending demand wake can survive a cycle that already
read the current demand and cause another quiet cycle. These are existing loop
behaviors in both arms; adding unconditional planning to their ends makes them
costly for a mounted view.

The longer enabled capture recorded these board passes:

| Pass   | Start after board-visible marker | Trigger branch                               | Total planning | UI walk | Selection changed |
| ------ | -------------------------------: | -------------------------------------------- | -------------: | ------: | ----------------- |
| First  |                           378 ms | Bookkeeping commit, no content contributions |         219 ms |  126 ms | Initial selection |
| Second |                           911 ms | Quiet cycle                                  |         683 ms |  615 ms | No                |
| Third  |                         1,619 ms | Quiet cycle                                  |         137 ms |   81 ms | No                |

The second and third cycles had no feed entries, contributions, pending effects,
or watermark movement. Their demand generation and watermark were identical. All
three passes saw 1,108 execution nodes, 5,010 renderer reads, 659 input
documents, and 216 producers for the same view lifetime. The repeated passes
published nothing. The slowest UI-walk duration is not a stable unit cost: the
other capture repeated the board plan in 156 ms, including a 92 ms walk.

Across the longer enabled capture there were five plans: three for the board,
one for the opened topic, and one for an auxiliary rendered view. The two board
repeats accounted for 820 ms of its aggregate 1,167 ms of planning. The shorter
capture also had five plans, of which three were identical to an existing
selection. Plan counts depend on the timing of mounts and demand changes.

The page's visible-text and view-settle markers do not wait for initial
replication-plan publication. In both enabled captures, the board was already
visible before its first plan completed, so part of its initial planning landed
inside the subsequent topic-open interval. This is real overlapping startup
work, but it prevents treating every plan after a click as work caused by that
click. Several independently mounted renderers also mean one page need not mean
one view interest.

## Pattern computation did not account for the difference

The longer enabled and disabled profiles each recorded exactly 90 server action
executions, taking approximately 53 ms and 54 ms in the logger's action spans.
The enabled profile recorded 16 serving-loop cycles; the disabled one recorded
22. The enabled arm was not running more pattern computations in this pair.

The additional work was in replication planning and reading/query machinery. The
enabled profile recorded 5,263 traversal calls versus 953 in the disabled
control. These are server counts over each complete profiled browser scenario,
not per-click counts or a general guarantee that both modes execute equally.
Different demand can change actual computation in other workloads.

## Memory also repeats the query walk

Two separate code paths bypass incremental reuse for a view session:

1. In `Server.#syncSessionForConnection`, the presence of any view clears
   `dirtyIds` and `dirtyOrigins`. The session bypasses both the
   untouched-session check and incremental tracked-graph refresh, entering full
   watch evaluation. This can happen on a space refresh whose changed documents
   are irrelevant to that view.
2. View-aware watch additions delegate to watch replacement. The earlier fix
   made their delivered documents incremental, but evaluation still rebuilds the
   watch union. `#evaluateViewWatchSet` evaluates ordinary watches plus render
   roots for demand, then evaluates that same set plus support roots for
   delivery. When support roots exist, ordinary/render queries are evaluated
   twice within that call.

The longer enabled scenario recorded 14 evaluations with active views, totaling
670 ms for demand evaluation and 224 ms for the additional delivery evaluation.
Four of those calls had support roots and therefore repeated the base queries.
These are evaluator wall spans; they must not be added to planner and frame
spans as though the categories were disjoint. The disabled arm had no active
view evaluations and retained ordinary tracked-query refresh.

Keeping demand separate from delivery is necessary: support documents must not
cause the server to execute off-screen dependencies. Re-evaluating their shared
query roots twice is an implementation cost, not a requirement of that contract.

## Direction for the next change

The intended trigger is a relevant change, not a user-event count. A remote
edit, effect completion, or clock update can change the view without a local
handler. One handler can also yield several meaningful settled states. Those
updates still need to refresh the plan.

The next implementation should separate three kinds of invalidation:

- **Renderer reads:** retain the UI walk's observed read log and results for the
  view lifetime. Re-walk when those reads change or the view's identity,
  revision, or component contract changes. A watch addition or bookkeeping
  watermark alone should not invalidate it.
- **Execution selection and certificates:** respond to relevant execution-log,
  graph-registration, outcome/currentness, and input-value changes. A handler's
  newly observed reads may change eligibility while the rendered UI stays the
  same. Likewise, a producer certificate can need updating without re-walking
  the UI. A space sequence alone is not sufficient to describe these changes.
- **Query delivery:** preserve tracked incremental evaluation for demand and
  support, reusing their shared ordinary/render evaluation. New roots need an
  initial evaluation, and removals or authorization changes must retain the
  existing retraction behavior.

Useful regression boundaries are a quiet demand wake that performs no new UI
walk; an unrelated document update that leaves the view alone; a visible change
that re-walks and updates the selected roots; a changed handler read set with
unchanged UI; a producer-currentness change with unchanged output; and a
mount/replacement/reconnect that receives a complete valid initial plan.

The correctness guard against overwriting authoritative values should stay in
place. The waste demonstrated here can be removed before weakening that guard or
adding navigation prefetch.

## Local evidence

- `/tmp/view-v9-on/`: first enabled open and five-pass trace.
- `/tmp/view-v9b-on/`: enabled open plus cross-reference, including query-stage
  timings and page render references.
- `/tmp/view-v9b-off/`: disabled control with the same extended scenario.
- `/tmp/view-v9-instrument.py`, `/tmp/view-v9b-instrument.py`, and
  `/tmp/view-v9b-off-instrument.py`: probe installation and automatic
  restoration.
- `/tmp/view-v9b-open.ts`: browser scenario and phase markers.
- `/tmp/view-v9-summarize.py`: companion-data extraction.

All three browser scenarios, their flag checks, and their server teardown
commands exited successfully. Disposable stores were removed after teardown.
