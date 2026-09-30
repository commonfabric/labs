# Interaction cost in the unified inbox: what to fix, in order

The measurements behind every claim here are in
[the investigation record](../history/development/performance/2026-09-11-person-inbox-click-cost.md).
This plan turns them into work. It is ordered by what a person feels, and each
stage names the measurement that would show it landed. Before using its latency
figures as a release gate, repeat the measurements on the exact candidate build
and resolved CFC posture. The reference profile's observation accounting is
specified in stage 2; its acceptance evidence belongs in the
[reference rollout](cfc-precise-reference-rollout.md).

## What the measurements settled

Opening an already-loaded thread changes **one `<style>` text node**, at every
size and in every state. The pattern's design holds. So none of what follows is
about rendering, and none of it is the inbox's own code.

Three facts decide the order of work:

1. **A paced click costs ~124 ms.** Awaiting the runtime between clicks keeps
   eight consecutive opens at 112–147 ms on one person's data.
2. **Clicking faster than the runtime settles degrades the session, and it does
   not recover.** Eight eager clicks take 178 → 1032 ms; pacing afterwards
   still costs ~920 ms. A page reload restores ~124 ms; rewriting the data
   partly restores it.
3. **The degraded click does the same work, and pays more for it.** Identical
   logger deltas either side of the degradation — 238 operations, 146 cell,
   36 scheduler, 6 actions, 14 traversals — against 138–172 ms healthy and
   830–931 ms degraded. Worker CPU per click doubles for the same counted work.

That last one is the whole diagnosis. This is a **width** problem, not a
frequency one: nothing runs more often, each unit of work gets dearer. So the
fix is at the leaf, and it is available to every pattern rather than to this
one.

The profile names the leaf, and names what grows around it. Between the healthy
and degraded phases, holding the counted work fixed:

| frame | healthy | degraded | |
| --- | ---: | ---: | --- |
| busy worker CPU | 910 ms | 1822 ms | 2.0× |
| `isPrefix` | 278 ms (30.5%) | 547 ms (30.0%) | 2.0×, constant share |
| `resolveLinkTracingDereferences` | 55 ms (6.0%) | 287 ms (15.8%) | **5.2×** |

`isPrefix` scales with the whole; the dereference-trace machinery is the part
that grows out of proportion. Both sit on the same structure.

## Stage 8 — The degradation is delayed, not cured — and it is waiting, not compute

Stage 2's note that "a paced round after an eager one recovers fully" was taken
from sequences of three rounds. Over sixty clicks it does not hold.

**It is the product's, not the harness's.** The first readings came through a
recorder that attaches a MutationObserver per shadow root on every click and
re-walks the whole DOM on every animation frame — either could grow with the
click count. Re-measured with a prober that installs no observers, resolves the
shadow roots once, and waits by reading one `<style>` element, paced on
`rt.idle()`:

| clicks | 0-5 | 6-11 | 12-17 | 18-23 | 24-29 | 30-35 | 42-47 | 54-59 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| median ms | 386 | 335 | 318 | 835 | 817 | 772 | 737 | 768 |

It arrives around click 18-24, roughly doubles, and then holds flat for forty
more clicks. The machine's load *fell* across that run (8.72 to 7.4), so load
is not the cause.

**Only a new runtime clears it.** Reaching the plateau and then applying each
candidate, six clicks per round: rewriting `people` with the same value gives
447 then 727 — no recovery; reloading the page gives 376 then 415 — full
recovery. That is the same signature the pre-stage-2 degradation had, so stage 2
and stage 7 raised the threshold (about 8 clicks to about 24) without removing
the cause.

**And it is not CPU.** Profiling the worker over the first twelve clicks and
the last twelve of a sixty-click run:

| | fresh | plateau |
| --- | ---: | ---: |
| wall | 10276 ms | 11995 ms |
| busy worker CPU | 9697 ms | 6076 ms |
| idle share | 6% | **49%** |

Worker CPU per click *falls* — 808 ms to 506 ms — while wall time rises. Half
of a plateaued click is the worker doing nothing. Only one frame grows
materially (`ownKeys`, +346 ms), and it is nowhere near the gap.

**First readings from the waiting side, and a trap to avoid repeating.** The
worker's own timing statistics report durations under `totalTime`, not `total`;
a readout keyed on `total` returns zero for every row and reads as "the spans
record no time", which is wrong. With that fixed, over twelve clicks at each
end:

| key | fresh n / ms | plateau n / ms |
| --- | ---: | ---: |
| `runner.loop/workerLag` | 12 / 9340 | **45** / 5157 |
| `runner/start/syncCellsForRunningPattern` | 11 / 3709 | 12 / 2270 |
| `memory.v2.client/watchAdd/request` | 22 / 10428 | 24 / 6554 |
| `runner/start/resumeCellSync` | 2431 / 469271 | 2652 / 284214 |

Two things to read carefully. `resumeCellSync`'s totals are not wall time —
469 seconds inside a run of minutes, at a near-uniform 193 ms across 2431
calls, which is the signature of concurrent spans that
`skills/perf-investigation/SKILL.md` names with this exact row. The enclosing
`syncCellsForRunningPattern` is the number, and it does not grow.

What does change is `workerLag`'s **count**, and it replicates. Three
sixty-click runs, twelve clicks measured at each end, at machine loads from 9.7
to 14.6:

| run | fresh | plateau |
| --- | ---: | ---: |
| 1 | 12 | 45 |
| 2 | 11 | 41 |
| 3 | 11 | 50 |

Four times as many event-loop lag events for the same twelve clicks, while
`syncCellsForRunningPattern` holds at 11 against 12 — the work is the same and
the loop is blocked far more often. A count survives a loaded machine in a way
the millisecond columns beside it do not, which is why this is the row to
build on.

**So the plateau is the worker's event loop being kept from running**, not the
worker doing more. That is consistent with the 49% idle share, and it is the
statement the next pass should try to falsify. The milliseconds above were
taken on a machine climbing through load 10, so treat those as direction only.

**So the instrument has to change.** Every measurement in this plan above has
been a CPU profile or a logger count, and neither can see time in which nothing
runs. The next pass wants the waiting side: `CF_MEMORY_FRAME_LOG` with
`summarize-frame-log.ts` for what crosses the wire, the memory server's queue
time against handle time (a queue time that dwarfs handle time is head-of-line
blocking, fixed at the frame in front), and the IPC rows in
`collectBrowserLoadSummary`. `skills/perf-investigation/SKILL.md` covers all
three under "Frames are the sync point" and "A counter says how often; only a
span says by how much".

## Where this has got to

Measured on the same rig throughout — the unmodified pattern, live connector
stores linked read-only, `serverExecution` off at both ends, a machine at load
6-12 and never idle. The figures below are a paired alternating A/B against
`origin/main`: each arm rewrites the changed source files, restarts, relinks the
stores and re-measures, three rounds at each size with the arms alternated, so
the two columns differ only in this branch's own code.

| one person's data | `origin/main` | this branch |
| --- | ---: | ---: |
| paced click, median | 1220 ms | 284 ms |
| during eager clicking | 6781 ms | 1565 ms |
| paced after an eager burst | 1454 ms | 367 ms |
| after ~20 clicks | — | ~800 ms, half of it the worker idle; see stage 8 |

| five people's data | `origin/main` | this branch |
| --- | ---: | ---: |
| paced click, median | 1239 ms | 422 ms |
| during eager clicking | 6847 ms | 1463 ms |

Separation at one person is complete. Across the first paced round of each
pair, main's fastest single click was 1139 ms against the branch's slowest
376 ms; counting the paced rounds that follow an eager burst as well, 904 ms
against 798 ms.

What the five-people table is for is the branch's own column rather than the
ratio: 284 ms at one person against 422 ms at five. That is the finding that
started this, and it is what has gone. Cost used to track how many rows the
queries returned rather than how many were rendered — one person with 38 rows
on screen beat five people with 6 — and selecting five people now costs about
half as much again rather than an order of magnitude. Main's medians at five
people are the noisier of the two — 794-1460 ms across rounds, against the
branch's 346-422 — so the ratio moves more than the branch does.

These are not the investigation's own starting figures, which put five people
at 10.7-19.5 s. The live connector stores have drifted since — fewer threads,
and at both sizes the pane now renders 32 rows — so the two are not comparable
and main was re-measured here rather than quoted from the record. What the
record holds is the shape of the finding; what this table holds is the current
rig.

What is left is one measurement and three design questions. The measurement is
stage 8: a session that settles at ~800 ms after roughly twenty clicks, which
is waiting rather than compute, and which every instrument used here is blind
to. The design questions are what a child piece's identity should depend on
(stage 7's root), how a flow-relevance memo should be keyed (stage 3), and a
harness that can reproduce a cross-session write refusal (stage 4a). Stage 7's
pull half is closed: the start pull is removed, so nothing at start decides
what a result demands.

## Stage 1 — Bound retained dereference traces

`ExtendedStorageTransaction.recordCfcDereferenceTrace` appends each trace and
uses a separate equality check to decide whether it invalidates the CFC digest.
Measure duplicate retention through `dereferenceTracesRecorded` and
`dereferenceTracesMax` before changing that representation. Any deduplication
must preserve the traces a resolution returns, the acquisition history carried
by references, and digest invalidation.

## Stage 2 — Preserve reference observation accounting

`forEachFlowObservation` in `packages/runner/src/cfc/prepare.ts` classifies
link-resolution probes as `followRef` from their read metadata. Such a read
consumes the reference binding's confidentiality; target content contributes
through the reads that consume it. A recorded dereference does not exempt a
probe from its binding's label. The pass therefore needs no trace-membership
scan or index. `PathPrefixIndex` remains available as a tested path utility,
and `isPrefix` supplies wildcard-aware path comparisons.

Re-measure the inbox with the independently labeled reference profile before
attributing latency to this pass. The investigation record linked above is
measurement evidence for its recorded build, not an acceptance result for the
[reference rollout](cfc-precise-reference-rollout.md).

## Stage 3 — Avoid redundant flow-relevance probes

`flowLabelWorkExists` shares the observation walk with `deriveFlowJoin` and
memoizes negative verdicts against the transaction's activity epoch. Measure
`flowLabelProbesComputed` and `flowLabelProbeMemoHits` alongside CFC-relevant
transaction counts to determine whether narrowing that epoch would help.

A narrower memo key must include read shape as well as document identity. A
document holding only link-origin entries can contribute to `followRef` while
contributing nothing to a content read. Two reads of that document can therefore
disagree. Any change must also invalidate on writes and CFC metadata changes;
it needs the semantics in `docs/specs/cfc-commit-preparation.md` and regression
coverage for both observation classes.

## Stage 4 — Two write refusals that stop a host driving the pattern

Both block a host from setting `people` at all. Both are small, and neither is
a performance problem; they are here because they cost a day to route around.

**4a. An input refused by an unrelated input — root cause found, not yet
fixed.** Any `cf cell set --cell <piece>#argument <field>` on this piece fails
with `updated input does not match its schema: view: value does not match type
object`. The staged root is read as
`targetCell.asSchema(undefined).withTx(tx).get()`, so a scoped input arrives as
its stored **sigil link** rather than as a `Cell`; `schemaAcceptsOpaqueCellValue`
opens with `if (!isCell(value)) return false`, so the link is not admitted as an
opaque cell value and is validated against the referent's type instead. A write
to any input is then refused by whichever `asCell` input the piece happens to
have, naming that one.

The fix is to accept a sigil link at a position whose schema declares `asCell` —
the link is the stored form of exactly that — either by widening the shared
predicate or by passing a local `acceptOpaqueValue` at this call site.

What is missing is a test that fails without it.
`packages/piece/test/scoped-input-write.test.ts` guards the same-session case,
which passes today; the refusal needs a client whose session is not the one
that minted the link, and an attempt to build that in-process did not
reproduce — a second `PiecesController` over the same space did not fail the
way `cf` does. Land the fix behind a harness that can mint a second session
properly, or behind a CLI-level test, rather than behind a test that would pass
either way.

**4b. A conflict that is neither retried nor reported.** `cf cell set` against
the inbox's own backing document fails with `ConflictError: stale confirmed
read: of:fid1:… at seq 0 conflicted with seq 958` — a dozen documents the
writer read as absent that the server holds at the current sequence, which are
the query-result documents the piece re-mints on each `people` change. The same
write against a one-input holder piece in the same space at the same moment
commits every time, so this is the inbox's argument graph rather than a busy
space. Two defects, worth splitting:

- **Still open:** the transaction is not retried; repeated attempts against a
  piece that is still re-deriving fail repeatedly (5/5 observed).
- **Landed.** The operator used to see `Error: [non-error-thrown] [object
  Object]`, Cliffy having replaced the thrown `ConflictError` before
  `renderCliError` saw it; recovering the message needed a patch to
  `Command.prototype.handleError`. A commit failure now throws a real `Error`
  (`commitFailure`, `packages/piece/src/ops/utils.ts`), so the same refusals
  print `ConflictError: stale confirmed read: …`. This one went first because
  every later investigation of the retry defect is blind without it.

Routing the write through a **verb** goes through the event path, carries its
own retry, and reports `settled`. It is reliable where both direct spellings
are not, and that asymmetry is itself worth understanding before 4b is called
fixed.

## Stage 5 — What the pane says about itself

The pane reaches a state where every in-DOM check passes — no source chip
still pending, every row's detail present, every key non-empty and unique,
nothing mutating for 30 frames — **while showing the previous person's data**.
Five of seven transitions, checked against the piece's own `threadCount` read
out of band; the worst sat settled showing 38 threads and three chips reading
50 with nobody selected. Everything converged eventually, so nothing is lost.

The consequence for anyone writing an acceptance probe: **there is no predicate
inside the DOM that certifies completeness for this pattern**, because the
counters go stale exactly as the list does. A probe needs an oracle outside the
browser. That is a documentation change, in the loom project's own performance
notes, and it retires the reopen-verification strategy the earlier probe used.

Whether the lag itself is a defect is a separate question this pass did not
answer. It needs one measurement it did not take: whether the chips and the
list are published in one wave or two. Until then it is a known behavior, not
a filed bug.

## Stage 6 — A rule, and a benchmark

**The rule, and it is the easiest thing here to skip.** The pattern's cost is
set by how many rows the statements returned, not by how many are on screen:
one person with 38 rows rendered opens a thread in 320 ms, five people with 6
rows rendered take 1.4–3.5 s. Nothing at authoring time says so — the author
writes `slice(0, THREAD_LIMIT)` and reasonably expects cost to follow it. Add
to `skills/pattern-dev`, and as a check in `skills/pattern-critic`: a display
cap bounds the render and not the transaction; the number to hold down is the
rows a statement returns.

**The benchmark.** The click cost is now provokable directly — a piece, a
linked store, a list, and a paced-versus-eager click ladder — which is the test
of whether it is understood. Add it under the lane
`docs/development/BENCHMARKS.md` owns, sized so it runs in CI, and assert the
paced band rather than an absolute: what regresses is the gap between a paced
click and an eager one.

## Stage 7 — Every click re-instantiates a child piece, and its result pull walks the whole result twice

The largest item left, and the chain is now named end to end.

**The measurement.** Instrumented over five consecutive paced clicks on a
37-thread list, with a counter on each pull site:

| click | event → detail visible | child instantiations | traversals | traversal time |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 404 ms | 1 | 2 | 248 ms |
| 1 | 355 ms | 1 | 2 | 233 ms |
| 2 | 390 ms | 1 | 2 | 250 ms |
| 3 | 444 ms | 1 | 2 | 295 ms |
| 4 | 411 ms | 1 | 2 | 275 ms |

Exactly one instantiation and exactly two traversals per click, **about 65% of
the click**. Skipping the traversal outright — a diagnostic, not a fix, since it
is what registers the dependencies — took the same five clicks to 138, 217,
168, 144 and 180 ms. The prize is roughly halving what a click still costs.

**The chain.**

1. A click writes one session cell, which changes what a JavaScript action
   returns.
2. `#writeJavaScriptActionResult` hashes the returned artifact
   (`hashStringOf(flattenBuilderArtifacts(resultPattern))`) and compares it
   against `#resultPatternCache`. Any change at all takes the
   `!patternUnchanged` arm and **re-instantiates the child piece**.
3. That instantiation registered a one-shot pull of the result, whose deep
   traversal of the whole result was the two walks the table counts.

That chain is what this pattern was measured doing. It is **not** what any
changed artifact costs — a minimal pattern with the same click shape
instantiates no child at all, which is measured further down and was this
plan's own premise until it was tested. What provokes the re-instantiation here
is still unexplained; the cost, once provoked, scaled with the result's size
rather than with the change's.

**The pull is gone, and with it the question of what it should demand.** The
runner pulled a freshly started result once so that the eager built-ins in it
would run with nobody reading them. That is not what a pull is for: the
scheduler already holds demand for the nodes that must run unread — an effect
is a demand root, a computation that writes captured `Writable` inputs is a
materializer with standing demand, and a computation registered during a live
run gets provisional demand once — and the built-ins the pull was forcing are
computations whose work is a no-op when nothing reads it. `generateText`,
`generateObject`, `llm` and `sqliteQuery` were registered as effects to keep
the pull's promise; they are computations now, the `fetch` family and
`streamData` were always computations, and `navigateTo` stays an effect
because the navigation is the point. `llmDialog` is a computation as well: its
`flattenedTools` write carries only what a reader displays, which is what lets
it hold still over inputs that did not change, and it declares its `messages`
write as a materializer envelope so a piece that renders the transcript keeps
it scheduled. With no eager set to serve, both
start pulls are removed, and a child instantiated from a lift walks nothing at
start: its result is read by whoever reads it.

Narrowing the pull with the pattern's result schema had measured about a
quarter off a thread open and was reverted, because a schema-guided traversal
descends only declared `properties` and an eager node under an undeclared one
would never have run. Removing the pull keeps the quarter and closes the
hazard, since nothing at start decides what to demand any more; a reader's own
schema decides what it reads, which is the walk-versus-schema trade where it
belongs.

**What is left, and two corrections that go with it.**

*First correction.* An earlier draft called "stop the second traversal" the most
contained fix. That was wrong: the second run is the scheduler re-firing the
pull's effect, not a redundant convergence pass, so removing it would drop the
dependency registration the traversal exists for. It is not a candidate.

*Second correction, and the larger one.* An earlier draft said the root — a
click re-instantiating a child piece — was "worth more than the pull fix", and
that the cost generalised to any action whose returned artifact changes. Both
claims are now disproved, by two measurements taken on one build:

- A minimal pattern with the same click shape (a session write, a stylesheet
  computed, twenty rows) instantiates **no** child at all and clicks in 19-50 ms,
  even though its returned artifact changes on every click exactly as the
  inbox's does. So the re-instantiation is not what any changed artifact costs;
  something about this pattern's result provokes it.
- Timing the instantiation itself on the inbox: **8-11 ms of a 300-450 ms
  click**, about 3%.

So the re-instantiation mattered only because it dragged a schemaless pull
behind it, and that pull no longer exists. Measured before its removal, with
the index in, the walk was already cheap: `deepTraverse` was 2.0% of busy
worker CPU, which is why taking the schema back out had cost nothing
measurable, and is the clearest evidence that the narrowed pull was never
carrying the improvement the index did.

**The next lever was the read log's size, and it is pulled at its source.**
Profiled at the index over four paced clicks in phase A, 3% idle, the two
largest frames were `sortAndCompactPaths` at 8.5% of busy worker CPU and
`resolveLinkTracingDereferences` at 7.9%; with `addressesToPathByEntity` and
`comparePaths`, roughly a sixth of busy CPU was the scheduler sorting,
compacting and indexing the read log's paths once per action. That is the
shape the index fixed one layer down — a transaction journals many reads, and
per-read work over them is what a click costs — and profiling it in-process
found what feeds it. A lift over 128 linked documents journals about sixteen
reads per document, most of them link resolution's sigil probes, and 44% of
those probes repeat a position the same transaction already probed: the
element's own slot, once per property read through it. The whole-resolution
memo cannot catch that (12 hits in 10,536 resolutions, since each property
read resolves a distinct address); a memo of probe outcomes one level down
does, riding on the same snapshot memo every write drops. With it, the storage
commit's read compaction no longer sorts before it groups, and the scheduler
groups the read log by document before sorting and keeps an action's entity
grouping between registrations. On the note-create bench that stands in for a
wide read, alternated against main on a machine at load 8, the cycle is six
to seven percent shorter at 32 and at 128 notes — about what removing a fifth
of the journaled reads from a per-read tier that was a sixth of the cycle
predicts — and the memo answers 29% of the probes a cycle issues, a count no
load moves; the remaining repeats are made in transactions the memo is
withheld from, the sink's wrapper among them. The record with the profile, the counts and
the A/B is
[the link-probe memo record](../history/development/performance/2026-09-13-link-probe-memo.md);
it also records a variant left out as unmeasured rather than disproved,
forwarding the snapshot memo to the wrapper `sink()` reads through. The click
itself was not re-measured on the inbox rig, which this worktree does not
hold; what a click pays is the same per-read machinery over the same shape of
read log, with more documents per read than this bench has.

**One lead ruled out.** The render root looked like the same fault:
`cf-render` renders the `full` kind with a bare cast rather than
`rendererVDOMSchema`. Applying the schema there changed neither the counters
(766 logged operations either way) nor `deepTraverse`'s share (3.3% self
against 3.1%), and a separate instrument found **zero** traversing sinks during
a click. It was reverted — it touches every pattern's render path and bought
nothing. The traversal is in the pull, not the sink and not the render.

## Order, and why

1. ~~**4b's error rendering**~~ — landed. A few lines, and it unblinded the rest.
2. ~~**Stage 1**~~ — measured first, and the measurement said no. Rescoped.
3. ~~**Stage 2**~~ — landed, and it carried most of the win: 3.8× on a paced
   click, and the degradation delayed from about 8 clicks to about 24.
4. ~~**Stage 3's local half**~~ — landed; the pass is down to 7.1% of wall.
5. ~~**Stage 6**~~ — landed: a benchmark that guards the curve's shape, and the
   authoring rule in `pattern-dev` and `pattern-critic`.
6. ~~**Stage 7's pull half**~~ — closed by removing the start pull: the
   built-ins it forced are computations that run when read, and the scheduler
   already holds demand for what must run unread.
7. ~~**Stage 7's root**~~ — measured at 8-11 ms of a 300-450 ms click with the
   pull narrowed, and absent entirely from a minimal pattern with the
   same click shape. Not a performance item; left as a correctness question.
7. **Stage 4a** — small, and it is a correctness bug. The root cause is known;
   what is missing is a harness that reproduces it.
8. **Stage 3's structural half** — a CFC design decision, not a measurement.
9. **Stage 5** — the writing down, in loom's own performance notes.
10. **Stage 8** — the plateau, and the largest thing left by wall clock. It
    needs an instrument no other stage here used, so it is the one item that
    starts with a measurement rather than a design: the memory frame log, the
    server's queue time against handle time, and the browser summary's IPC
    rows.
11. ~~**The read log's per-read tier**~~ — landed as the link-probe memo,
    described at the end of stage 7: link resolution memoizes each sigil
    probe per transaction, which removes the repeated probes that were a fifth
    of the journaled reads, and the commit and scheduler passes over the log
    run over a smaller one.

After stage 2 the profile has no hotspot left, and the next tier — path and
link machinery, `sortAndCompactPaths`, `#findNode`, `createViewProxy`,
`resolveLinkTracingDereferences`, none of them dominant — is what the
link-probe memo (item 11 above, described under stage 7) shrinks by feeding it
a smaller read log rather than by speeding any one frame. Expect the next win of that kind to be in the number of probes
a walk issues at all, and the next structural one to be stage 3's "do not run
the pass".

Stages 1, 2 and 3 are labs runtime changes and belong in their own tasks, so a
pattern change cannot quietly grow a runtime refactor. Nothing in this plan
asks for a change to `cf-person-inbox.tsx`: at every size measured, it did
exactly what it was built to do.
