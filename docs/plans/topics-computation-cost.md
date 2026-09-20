# Topics computation cost and live upgrade

## Objective

Reduce repeated collection work in Topicboard and individual Topics while
preserving their authored data, public behavior, identities, and bounded demand
shapes. Use maintained collection indexes and named aggregates where
measurements justify them. Ship improvements in independently reviewable
changes, rehearse the upgrade on copies of existing pieces, and upgrade test
Topics instances live.

This plan authorizes no live writes by itself. Implementation, synthetic demos,
and isolated copy rehearsals can proceed before a deployment window is chosen.

The implementation surfaces are
[the board](../../packages/patterns/topics/main.tsx) and
[the topic](../../packages/patterns/topics/topic.tsx). Contracts are documented
in [collection indexes](../features/collection-indexes.md),
[aggregates](../features/collection-aggregates.md), and
[read accounting](../features/read-accounting.md). Authoring examples and
operation-selection guidance live in
[reactive collections](../common/concepts/reactive-collections.md).

## Expected improvements and limits

The board's `crossrefTable` materializes narrow mention lists once, then scans
source lists for each destination. Each topic's `backlinksOf` scans the
resulting table to find its own row. Topic rendering separately derives active
comments, active links, presence booleans, and link-resolution inputs.
`lastActivityOf` scans comments and links, including edits and retractions.

Let N be board topic occurrences, E be total mention occurrences, C be comments
in a topic, and L be links in a topic. These are work hypotheses to test, not
latency predictions or unconditional complexity guarantees.

| Candidate                                                   | Expected benefit                                                                                                                           | Remaining cost or risk                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared keyed backlink-row lookup                            | Remove each demanding topic's repeated search through N cross-reference rows. With N consumers, eliminate a potential N-by-N lookup stage. | The pivot producer remains. Index maintenance and consumer demand can add graph work; putting an index inside every topic would duplicate maintenance. |
| Reuse active counts/views                                   | Avoid duplicate C- and L-sized filtering for presence and link resolution.                                                                 | Likely a modest constant-factor benefit; sharing a broader view can increase demand.                                                                   |
| Maintain source-to-destination edges grouped by destination | On a local mention edit, update affected edges and destination buckets instead of rescanning all source lists for every destination.       | Building all edges afresh retains producer cost. Ordering, duplicate occurrences, membership reconciliation, and large buckets require work.           |
| Maintained comment count                                    | Reduce repeated predicate work for large threads when one independently linked comment changes.                                            | Shared captures or broad source edits can invalidate many predicates; small threads may not benefit.                                                   |
| Maintained activity maxima                                  | Reduce full comment/link timestamp scans on localized activity edits.                                                                      | Must include edit and removal timestamps; score production and public Cell typing can dominate the benefit.                                            |

A reduction in reads can coexist with increased startup cost, graph size,
storage, or latency. Do not promise a percentage speedup before matched
measurements. Client replication and network narrowing are separate work; index
buckets returning links do not establish smaller network demand.

## Compatibility requirements

Keep titles, bodies, authors, comments, links, attachments, names, and piece
identities intact. Keep the board's original topic links for card rendering and
its compact `mentionable` and narrow headless `index` projections. Preserve the
persistent short-name allocator and its never-reuse contract. Sorting cards is a
global operation; this plan introduces no incremental sort or top-K.

Backlinks must retain canonical identity semantics, including aliases and scope.
Self-mentions are excluded. Repeated mentions from one source occurrence yield
one inbound occurrence; duplicate board source occurrences require their own
cardinality tests. Inbound order follows the board's source order, whereas index
buckets use occurrence-identity order. Preserve visible ordering unless a
separate product decision explicitly changes it. Missing matches yield empty
lists. Unresolved sources must not create invalid-address rows or permanently
disappear.

For activity, retracted comments and removed links still contribute their edit
and removal timestamps. Removing them from the aggregate could move activity
backward. Preserve optional-field defaults and compatibility with stored topic
generations. Preserve linked record identity for editing handlers.

No stored hoist name on any deployed board or topic generation may resolve to a
different body. The [pattern update gates](../specs/pattern-update-testing.md)
do not establish this; T5 establishes how to check it, with evidence from their
stored data. The transformer hoists a file's `lift`, `handler`, and `pattern`
calls to module scope, numbering each kind from a counter of its own in the
order it reaches them. Any edit that adds one renumbers the later hoists of that
kind, whether what it adds is a callback operator, a handler, or an ordinary
derived expression that lowers to a lift. One operator can move both sequences:
a computed expression in its callback body lowers to a lift hoisted beside the
pattern, so a single new operator shifts the `lift` numbering as well as the
`pattern` numbering. A new operator therefore lives in a pattern in a module of
its own, which numbers its own hoists from one and leaves the board's and the
topic's unchanged, and `main.tsx` or `topic.tsx` instantiates it by a direct
call — instantiating it inside a reactive `.map` lowers to a hoisted `pattern`
in the calling file and renumbers there, as any other callback operator does.

## Execution tracker

Check off a stage only with linked implementation, tests, and measurement
evidence. Record a rejected prototype's results as a report in `docs/history/`,
with the metadata header and index entry [its README](../history/README.md)
requires; update this live plan with the resulting pending scope. A conditional
stage may close with an evidence-backed decision not to adopt it. A dependency
on T0 gates a stage's acceptance, as
[measurement and acceptance](#measurement-and-acceptance) requires;
implementation and prototypes can begin earlier.

- [x] **T0 — Establish the baseline and demonstration.** Build the two tiers
      [measurement and acceptance](#measurement-and-acceptance) defines. Exit:
      every deliverable below is checked off and the acceptance limits are set.
  - [x] The headless tier's fixture.
  - [x] The probe script and its baseline.
  - [x] The CI read-budget test, and the negative controls the command that
        derives its limits runs.
  - [x] Browser instrumentation.
  - [x] Browser workloads, extending the
        [scale](../../packages/patterns/integration/topic-board-scale.bench.ts)
        and
        [navigation](../../packages/patterns/integration/topic-board-navigation.bench.ts)
        benchmarks.
  - [x] A browser demo with board, topic, backlink, and comment actions —
        landed by #7673 as
        [`topic-board-demo.test.ts`](../../packages/patterns/integration/topic-board-demo.test.ts),
        which states which of its properties a candidate may change
        without invalidating T5's comparison.
  - [x] The baseline report in `docs/history/`, separating pivot production,
        per-topic lookup, activity, and rendering costs, and recording the
        probe's baseline and the environment and source versions. Three of
        those four costs have baseline figures; rendering has none, for the
        reason under [measurement and acceptance](#measurement-and-acceptance)
        below.
- [x] **T1 — Share individual-topic derivations.** Reuse `commentCount` for
      `hasComments`; evaluate sharing the active-link view with `hasLinks` and
      link resolution. Preserve narrow compatibility schemas and stable links.
      Exit: behavior tests pass, repeated work falls, and sharing does not
      unintentionally broaden board demand. Can proceed independently of T2;
      acceptance depends on T0. Measured in
      [sharing the Topics retraction filter](../history/development/performance/2026-09-20-topics-t1-shared-derivations.md):
      initialization proxy accesses fall by 38% to 67% across three fixture
      shapes, demand narrows at both shared hoists, and every behavior suite
      passes. `commentsView` keeps its own pass, recorded there with the reason.
      No latency conclusion was available from those runs.
- [ ] **T2 — Prototype one shared backlink-row index.** Index the existing
      cross-reference rows by topic identity once at the board level. Compare
      direct lookup with each topic scanning the table. Prove two boundaries,
      each without a cast or a duplicated producer. First, the rows reach one
      index producer through a subpattern with an explicit Cell input, the shape
      [reactive collections](../common/concepts/reactive-collections.md#choose-aggregate-semantics-deliberately)
      gives for a computed list, under a schema that carries `topic` as a Cell
      so the index keys by canonical Cell identity. The subpattern lives in a
      module of its own, and the board instantiates it by a direct call rather
      than inside a reactive `.map`. That is how a new operator leaves the
      existing hoists' numbers unchanged, which the hoist requirement under
      [compatibility requirements](#compatibility-requirements) depends on.
      `crossrefTable` is a `lift`, whose result type exposes no index operator,
      and `TopicCrossrefRow.topic` is `unknown` so that reading the table
      expands no topic. Second, the resulting handle reaches topics without
      broadening demand. Topics that `addTopic` and the board's composer create
      hold `boardCrossrefs` as a link to the board's cross-reference table;
      older topics may not, which step 1's inventory records. Decide between
      carrying the handle through that link, which changes the board's published
      `crossrefs` result, and a new topic input, which needs a one-time
      link-bind onto every existing topic that is to hold it. Classify the
      choice under step 1 of the
      [stored-state procedure](#stored-state-and-deployment-procedure), and list
      a link-bind in the step 7 manifest. Retain existing public results through
      a compatibility bridge where needed; do not assume adding a required field
      is rollout-safe. Exit: reduced lookup-stage scaling, bounded maintenance
      cost, and a written old/new board-topic compatibility matrix. Depends on
      T0.
- [ ] **T3 — Maintain the mention relation.** Prototype stable per-source edge
      production, per-source-occurrence mention deduplication, and shared
      grouping by destination. The derived edges reach `groupBy` through the
      same producer boundary T2 proves. Preserve backlink order and original
      source links. Deduplicate across board entries as well as within one
      source's mention list: a topic the board lists at two entries, whether as
      the same link twice or as an alias of it, is one source in the backlinks
      of every topic it mentions, and keeps the place of its first entry.
      Measure edge production separately from bucket lookup. Compare against the
      T2 candidate, not only the original implementation. Exit: same-count
      retargets update only the required relation work where supported,
      complete-workload costs justify adoption, or a report explains deferral.
      Depends on T0 and T2's boundary decisions; T1 need not block it.
- [ ] **T4 — Evaluate large-thread aggregates.** Compare a maintained active
      comment count and activity maxima with the T1 implementation. Use explicit
      Cell receivers and measure score/predicate production; do not rely on
      unsupported ordinary-array `.map(...).sum()` chains. A maintained count or
      activity maximum carrying a callback is a new operator, so it too lives in
      a pattern in a module of its own, instantiated the same way. Exit: adopt
      only the candidates with justified end-to-end tradeoffs. Depends on T0 and
      T1.
- [ ] **T5 — Harden accepted changes and prepare release artifacts.** Add
      regression read budgets, run all relevant authored/package/integration
      tests, preserve compatibility baselines, pass the
      [pattern update gates](../specs/pattern-update-testing.md), and update
      maintained docs. Produce matched before/after demos and reports. Establish
      and record how to check the hoist requirement under
      [compatibility requirements](#compatibility-requirements), with evidence
      from the stored data of deployed board and topic generations, among them a
      read-only copy of the primary Topics instances obtained through Gideon.
      That check depends on acquiring the snapshot
      [stored-state step 3](#stored-state-and-deployment-procedure) describes,
      which can begin before T6. Each implementation PR needs a review through
      the [`cf-review` skill](../../skills/cf-review/SKILL.md) and a clean Cubic
      review on its final head before merge. Exit: all accepted T1–T4 changes
      are merged, remaining proposals are explicitly deferred, and exact
      deployable source packages are recorded.
- [ ] **T6 — Rehearse real stored generations.** Inventory and copy the intended
      board space, verify linked-space coverage, run the two-pass upgrade
      procedure below, and write a concrete rollout/rollback manifest. Exit: two
      clean passes with semantic and authored-content evidence. Depends on T5;
      acquisition and inventory can begin earlier without blocking synthetic
      work.
- [ ] **T7 — Coordinate and execute live rollout to test instances.** Obtain the
      list of test Topics instances to upgrade and a deployment window, confirm
      runtime prerequisites, upgrade in the rehearsed order, and verify each
      stage before proceeding. This plan does not upgrade the primary Topics
      instances; any change to them is coordinated with Gideon, who runs their
      live upgrade. Exit: every target has a recorded source revision and
      acceptance result, or an explicit partial-rollout/rollback disposition.
      Depends on T6 and live authorization.
- [ ] **T8 — Publish outcomes and archive the plan.** Publish measured benefits
      with workload limits, the authoring guidance, and the final deployment
      status. Transfer genuine fast-follows to separate plans and archive this
      plan following [the documentation lifecycle](../README.md).

## Measurement and acceptance

Measure in two tiers. The headless tier exercises the pivot, lookup, and
aggregate candidates directly over synthetic Cell arrays rather than seeded
boards, as the
[index maintenance count probe](../development/BENCHMARKS.md#index-maintenance-count-probe)
does for indexes. It measures the Topics sources unmodified, the baseline's and
each candidate's alike, and reaches their non-exported derivations without
adding exports for measurement; a compiled module
[registers by name](../specs/ts-transformer/ts_transformers_current_behavior_spec.md#114-__cfreg-content-addressed-registration)
its non-exported top-level builder artifacts under its content identity. A
derivation inside a pattern body registers under a name that can differ between
the baseline and a candidate, so the tier measures it through the pattern that
holds it rather than by registered name. It runs at 32, 128, and 512 topics,
with low-degree and high-degree mention graphs, and varies E independently of N.
Exercise a single large inbound bucket as well as distributed links. Test
threads at 10, 100, and 1,000 comments, varying L separately. The headless
read-budget test runs in CI at 4 and 32 topics and at threads of up to 100
comments or 100 links; 128 and 512 topics and threads of 1,000 comments or
1,000 links run only from this tier's probe script.
T0 builds this tier's fixture; if a size cannot be built, T0 records the
measured limit and the tier runs at the largest size it builds.

The browser tier measures the whole system, rendering included, through the
scale and navigation benchmarks at the board sizes their seed builds. Its new
cases run in the scheduled
[Benchmarks workflow](../development/BENCHMARKS.md#the-pipeline). Seeding a
whole board bounds the sizes of any tier that seeds one: the
[benchmark guide](../development/BENCHMARKS.md#the-board-scaling-benchmark)
records its time, memory, and cause. Citations raise the cost further, and
seeding cost keeps the browser tier to a few citing topics (see
`DEFAULT_CITING_TOPICS` in
[the fixture](../../packages/patterns/integration/topic-board-fixture.ts)), so
only the headless tier varies E independently of N. Each tier includes a small
case to expose startup and maintenance overhead that scaling tests can hide.

Three demand workloads are distinct: the board alone, the board with one topic
open, and all backlink outputs. The browser tier runs the board-alone and
board-with-one-topic workloads and not the all-backlinks one. In a browser
measurement with client execution and stored card values, a board loaded before
any topic was opened ran none of the pivot, backlinks, comment-count, or
last-activity lifts. Opening a topic ran the pivot, that topic's backlinks, and
its comment count. Returning to the board afterward ran that topic's
last-activity lift once. The measurement is one small sample, taken with
[lazy materialization](../development/EXPERIMENTAL_OPTIONS.md#lazymaterialization)
on and with client execution.

Which tier measures a mode is settled by which tier can run it, and every run
is labeled by mode. The headless tier measures lazy materialization on and off,
under a `--mode` the probe stamps onto each sample from the flags the runtime
reports back. It cannot measure
[server execution](../development/EXPERIMENTAL_OPTIONS.md#serverexecution): the
ON posture's serving loop is an `ExecutorHost` built over a co-hosted memory
server, and the headless fixture runs over an emulated storage manager in one
process with no memory server, so the flag has nothing there to engage. Server
execution can be measured only in the browser tier, which is the tier that runs
against a toolshed. A toolshed given the ON flag was measured to construct the
loop and to serve a deployed Topics board's work, recorded in
[the engagement probe](../history/development/performance/2026-09-18-topics-lazy-materialization.md),
which is the engagement the headless tier has no way to produce. The browser
benchmark environment of a built binary, a baked shell and Chrome runs a
coherent arm: a toolshed built at either posture serves a deployment that
declares it, and the reader refuses a deployment that declares none. A browser
arm holds its two halves to one posture: the toolshed serves at it, and the
shell it serves is built at it. A run whose halves disagree is refused rather
than labeled. Server execution on and off must both be measured before the
baseline report, and
[the browser arm](../history/development/performance/2026-09-19-topics-server-execution-browser-arm.md)
measures both: the computation counters this tier records are measured under
each posture, and the headless tier can measure neither, for the reason above.
That arm's timings are not usable, and the reason is a property of the tier
rather than of one run: the browser benchmarks co-host the toolshed they
measure against, and under the ON posture that toolshed derives, so its work
competes with the browser it serves. A latency comparison between the postures
therefore needs the server off the browser's hardware, which is a requirement
on the rig rather than on when it is scheduled. The scheduled Benchmarks
workflow runs client execution only.

Of the three demand workloads above, the headless tier measures the
board-with-one-topic workload with the demand the browser measured, and the
all-backlinks workload as a scaling probe rather than normal UI behavior: it
demands the pivot and every topic's backlinks at once, which no browser workload
does. The probe records the board-alone workload as not measured, because a
board loaded before any topic is opened runs none of the pivot, backlinks,
comment-count, or last-activity lifts, so there is no work of theirs to measure
headlessly. The tier's thread cases run under a workload of their own,
`aggregates`, which demands every topic's present comment count and last
activity and nothing else. Measure cold initialization, warm updates, and reopen
or reconnect separately. T0 measured reopen in the browser tier and not
reconnect: inducing a transport reconnect needs a storage relay the Benchmarks
workflow does not run, so the browser tier's `reopen` series re-opens a topic
within one live client and a browser reconnect is unmeasured. Hold runtime,
source package, data, demand, and feature flags constant between comparison
arms; alternate repeated timing runs and report their distribution rather than
a single favorable sample.

Test mention insertion/removal, same-count destination retargeting, duplicate
and self-mentions, aliases/scoped references, topic reorder/removal, rename-only
and body-only edits, comment append/edit/retraction, link removal, and unrelated
sibling edits. Include unresolved linked inputs, cold recovery, and two-client
observation. Existing naming, rejection, render-shape, view-identity, and
multi-user tests are part of acceptance, not replaced by benchmarks.

**No tier produces a rendering baseline, and none of the candidates below can
be held to one.** A topic's rendering derivations — active comments, active
links, the presence booleans, and the link-resolution inputs — are `computed`
expressions in the topic's body or lifts neither instrument names. The headless
tier starts the four Topics lifts directly and instantiates no pattern body, so
they never run there; in the browser they run and fall into the sample's
aggregated `remaining` row, which keeps no run's identity. Closing this needs
the browser helper to retain something per source-less run and its timing rows
to be recorded, which T0 did not do. Until then a candidate's effect on
rendering cost is unmeasured rather than measured at zero, and T1, whose target
is exactly these derivations, has no rendering baseline to improve on.

The headless tier records completed body and transaction-attempt reads with
their distinct [boundaries](../features/read-accounting.md#execution-boundary),
executions, graph size in nodes and edges, elapsed time, and available storage
or memory measurements. The browser tier records body reads, graph size, and
timings; attempt reads come from the headless tier, because the runtime client's
read-stats request enables body accounting only. Count producer and consumer
work separately but decide on the complete settled operation. T0 measured the
browser tier's reopen workload to run none of the pivot, backlink,
comment-count, or last-activity lifts, so that one has no producer or consumer
work to separate. Network claims require bytes/subscription measurements in
addition to read accounting.

T0 must set numeric baseline-derived acceptance limits before tuning candidates.
Read budgets are total and per-run, with explicit output/UI demand. Read and
graph limits live in a code table beside the headless read-budget test, not as
numbers in this plan. A gated count must repeat identically across five runs
before its limit is set, and the limit is the largest observed value plus 10%.
Each gated measure has a negative control: a regression variant that grows that
measure and must exceed its limit. The command that derives the limits runs each
control against the limit it derived. Startup and latency limits are recorded in
this section, below, and are not gated in CI. An accepted candidate must
preserve semantics, improve its targeted scaling/work measure, and stay within
the read, graph, startup, and latency limits. If measurement noise prevents a
latency conclusion, say so; if a cost exceeds its limit, revise or defer the
candidate rather than silently moving the limit. A new tradeoff needs a
documented decision and rationale.

### The startup and latency limits

Four limits, derived by the same rule the gated counts use — the largest
observed value plus 10%, rounded up — from the browser tier's rounds recorded
in
[the baseline report](../history/development/performance/2026-09-20-topics-computation-cost-baseline.md),
whose `startupAndLatencyDerivation` block holds each one's observations and
arithmetic. No continuous-integration job checks them; a candidate is held to
them by whoever measures it.

**Measure a candidate against these the way they were derived.** Each comes
from the interval `timeTopicsOperation()` brackets, which turns telemetry and
read accounting off before timing. A `measureTopicsReads()` sample of the same
operation leaves both on, and its elapsed time carries their overhead: in the
rounds these limits come from, the read-accounted reopen took 153 ms where the
timed interval beside it took 122 ms, so that sample alone would breach the
135 ms reopen limit for an operation that meets it. A read-accounted elapsed
time is not comparable to these limits and must not be checked against them.

| Measure | Limit | Bench case | Board size | Largest observed |
| --- | --- | --- | --- | --- |
| Startup: board render | 1,273 ms | navigation `board` segment | 30 topics | 1,157.0 ms |
| Startup: cold board load | 4,852 ms | scale `100` | 100 topics | 4,410.1 ms |
| Latency: warm update | 140 ms | navigation `comment` segment | 30 topics | 126.8 ms |
| Latency: reopen | 135 ms | scale `reopen 100` | 100 topics | 122.0 ms |

**Every one of the four was derived under client execution**, with server
execution off. The runs that produced them record no lazy-materialization
setting; that flag defaults on. A candidate measured under any other posture is
not measured against these.

**They are loose, and deliberately so.** They were derived on a shared machine
under unrelated load — a one-minute load average with a median of 19.15 over
the navigation rounds and 21.13 over the scale rounds, against 10 logical CPUs.
Contention inflates the observations a ceiling is derived from, so these will
not catch a small regression. Treat a breach as a real signal and a pass as
weak evidence; re-derive on a quieter machine before tightening any of them.

**No server-execution latency limit exists, because no tier can produce one.**
The headless tier has nothing for that posture to engage, and the browser tier
co-hosts the toolshed it measures against, so under the ON posture that
toolshed's derivation competes with the browser it serves.
[The browser arm](../history/development/performance/2026-09-19-topics-server-execution-browser-arm.md)
records the measurement and why its timings support no posture conclusion. A
rig with the server off the browser's hardware is what would change this; the
scheduled Benchmarks workflow runs client execution, which is where candidate
latency is obtainable.

## Stored-state and deployment procedure

Repository merge does not update existing pieces. `cf piece setsrc` updates an
existing piece in place; `piece new` would create a different piece. A board and
its existing topic children are separate targets. Updating imported source in a
board's package does not upgrade those existing children.

1. Inventory target piece IDs, source revisions, stored input/result contracts,
   linked spaces, active generations, each topic's stored `topicStateVersion`,
   and which topics hold `boardCrossrefs`, `mentionable`, and the legacy
   `boardNames`, and what each links to. A topic no longer declares
   `boardNames` — it stores the number its board calls it by, which `addTopic`
   passes at create and `recordName` writes onto a topic that predates it — so
   what an inventory finds there is a stored link the current projection no
   longer reaches, on topics created before that changed. Inspect the deployed
   parent's stored demand, not just its current repository source. Record
   whether each improvement changes only derived computation, a public result,
   or persisted state.
2. Confirm the target runtime/compiler supports the operators. A change to
   derived computation alone needs no upgrade step. A change the topic pattern
   makes to its own persisted state is a new step under
   [Topic state upgrades](../../packages/patterns/topics/state-upgrades.md),
   which defines the step contract, the mutations allowed while a step is
   pending, the required tests, and the rollout and rollback limits. That
   document also describes when a topic's pending steps run and what stops them;
   rehearsal and rollout exercise any steps pending on the targets along with
   this plan's changes. The board has no stored-state version; if its persisted
   inputs must change, specify version handling, idempotency, legacy writers,
   and rollback limits explicitly rather than forcing a schema override.
3. Acquire a consistent snapshot through the owner/operator and follow the
   [space-clone rehearsal procedure](../development/space-clone-rehearsal.md).
   Identify absent cross-space inputs and obtain appropriate rehearsal coverage;
   do not treat their missing values as representative production data. A local
   copy validates stored data and runtime behavior; use the
   [staging procedure](../development/staging-space-copy.md) when deployment
   topology or shell behavior needs qualification.
4. Run every authored test and retain the exact complete source package. Run
   `setsrc --check` against the clone, then apply with every test root and data
   attachment included. Along with the check and apply, rehearse on the clone
   every link-bind the change requires (T2 decides them, and the step 7 manifest
   records them), using
   [`cf piece link`](../../packages/cli/README.md#linking-piece-inputs). Tests
   attached to deployment are packaged/type-checked, not executed there.
   Classify refusals, including missing linked data; a clean compatibility check
   is not an apply or semantic acceptance result.
5. Choose upgrade order from the old/new board-topic compatibility matrix.
   Usually children precede the board, but an old board unable to read a new
   child needs a bridge or parent-first sequence. Check old/old, old/new,
   new/old, and new/new combinations that can occur during rollout or rollback.
   Where the change requires a link-bind, the matrix also covers topics with and
   without the bind, and the bind run before and after the board's source
   update. Keep each transition serial and inspect its result before the next.
6. Verify authored content independently of `space verify --expect-migration`:
   that command detects removal, not in-place clobbering. Check board
   membership, ordering, names, backlinks, titles/bodies, attribution,
   comment/link records, handlers, settled background churn, and the hoist
   requirement under [compatibility requirements](#compatibility-requirements),
   using the check T5 records. Check that each topic's stored
   `topicStateVersion` reaches `TOPIC_STATE_VERSION`, or record the step still
   pending and why. Stop the clone server, reset, restart, and repeat from the
   pristine snapshot for a second clean pass.
7. Before live execution, record target order, link-binds, exact package hashes,
   retained source revisions, expected schema/data changes, acceptance commands,
   snapshot location, and rollback actions. The live targets are test Topics
   instances; any change to the primary Topics instances is coordinated with
   Gideon, who runs their live upgrade. Coordinate legacy writers and client
   refresh if a schema/state transition requires them. Source restoration does
   not undo stored-data migration. Whole-space snapshot restoration can discard
   later human edits; specify a recovery window and preservation procedure
   before relying on it. A local clone reset command is not a live rollback
   procedure.
8. Obtain live authorization for the concrete manifest. Start with the smallest
   rehearsed compatible target set, verify it, then continue serially. Record
   failures and successful targets durably. Stop dependent updates on
   unexplained missing data, altered content, unresolved compatibility failures,
   or failed semantic checks; do not bypass them to complete a batch. Keep
   independent investigation and remediation work moving.

## Decisions to collect without blocking implementation

T0–T5 can proceed with synthetic/local data and the conservative semantic
requirements above, except T5's hoist check, which needs the stored data of
deployed generations. Before that check and before T6, obtain the intended board
URL(s), authorized snapshot acquisition path, and coverage for linked spaces.
Before T7, agree on the test instances to upgrade, the live window, operator,
and recovery constraints. Raise a product question only if evidence suggests
changing visible ordering, duplicate behavior, or another preserved contract;
keep the existing semantics while it is pending.

Do not include handler laziness, replication changes, or a new naming allocator
solely to enlarge this performance release. Their independent plans can proceed
without blocking the compatible improvements here.
