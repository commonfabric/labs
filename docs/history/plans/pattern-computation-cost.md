---
status: historical
created: 2026-09-09
archived: 2026-09-12
reason: "Executed #7155 scope; B3a deferred and D1/D2 transferred to a separate fast-follow."
---

Execution closed with the
[implementation record](pattern-computation-cost-implementation.md) and
[representative-copy report](../development/performance/2026-09-12-representative-lunch-poll-rehearsal.md).
B3a remains explicitly deferred. Q9 transfers remaining D1/D2 execution to the
[lazy-materialization fast-follow](lazy-materialization-fast-follow.md).
The proposal below records the original design, not a claim that deferred stages
shipped or historical deployment timings were reproduced.

# Making pattern computation cost declarable and visible

A pattern author can write a derivation that reads a thousand documents. The
single-runtime pattern test runner exposes that work through per-action read
counts. Named aggregates maintain linked single-row updates incrementally; keyed
collection operations and opt-in test budgets remain the next steps. This plan
gives expensive collection operations an incremental form and makes their cost
visible before they ship.

It is deliberately not a proposal to hand execution planning to the compiler.
The reasoning for that boundary is under
[What this plan does not do](#what-this-plan-does-not-do).

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all of its child checks pass.

## Implementation priority

A1 and A2 provide read accounting and generic `reduce` baselines. B3 provides
named aggregates on explicit Cell/Writable array inputs, with contracts in
[collection aggregates](../../features/collection-aggregates.md). The
[aggregate comparison](../development/performance/2026-09-incremental-aggregates.md)
covers initialization, single-row updates, scheduler runs, and total read work
at 10, 100, and 1,000 elements. Timings include maintenance and commits and
record the startup cost and machine-load limitations alongside update savings.
B1's `groupBy`/`keyBy` indexes and B2's keyed lookup are the next
collection-algebra priority.

A0's specified headless command is measured, but it does not reproduce the
reported 74-vote deployed workload. Keep the deployed figures unconfirmed until
the representative workload and probe/deployed comparison in A4/A5 are ready.
The
[first-batch measurement record](../development/performance/2026-09-pattern-read-accounting.md)
contains the observed headless counts and the aggregate baseline matrix.

## Problem

The vote path in
[`packages/patterns/lunch-poll/main.tsx`](../../../packages/patterns/lunch-poll/main.tsx)
is the worked example. `tallyOptions` is a group-by over votes joined against a
roster, hand-written as nested scans: for each of the options it filters the
whole vote list, then filters that result three more times by vote color, then
resolves each voter through a linear `find` over the roster. Every one of those
element and property reads goes through a reactive query proxy, so each is a
link resolution rather than a property load.

Figures reported from the current investigation, reconstructed by hand from a V8
profile and a reading of the code, pending reconfirmation under Stage A0:

| Quantity                                     | Reported             |
| -------------------------------------------- | -------------------- |
| Wall clock per vote                          | ~1.15 s              |
| Tally derivation, single run                 | ~550 ms              |
| Tally proxy accesses, single run at 74 votes | ~2,600               |
| Per-option card derivation, per run          | ~30 ms, over 14 runs |
| Per-proxy-access cost                        | ~0.2 to 0.8 ms       |

The tally figure decomposes as 14 options times 74 votes for the per-option
filter, three more color filters over each option's votes, then up to 8 roster
comparisons per vote plus a self check. Each card scans the full list again.

An earlier estimate of ~1,100 document accesses across the whole click is
superseded by the per-run figure above; record counts rather than the estimate.

The spread in per-access cost is itself informative. An access costs ~0.2 ms
bare and closer to ~0.8 ms when it derives a label view, which is why A1 counts
proxy accesses and link resolutions separately rather than reporting one number.

Three properties of the system produce that, and each needs a different repair.

**The algebra has no middle.** `map`, `filter`, and `flatMap` have incremental
builtins under
[`packages/runner/src/builtins/`](../../../packages/runner/src/builtins) that
key elements by normalized link address and reuse per-element runs across
changes. `reduce` has none — its doc comment on
[`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts) records
that it re-runs the whole reduction when any element changes — and there is no
`groupBy`, no `keyBy`, no join, and no read-side index. A tally is a group-by
and a join. Neither has a declarative spelling, so it is written as scans.

The write side already solved the same problem. `elementById` derives the entity
for a keyed element without reading the array at all, which is what lets a vote
be cast without touching the vote list. The read side has no counterpart.

**Authors leave the incremental path for correctness reasons.** The comment at
`packages/patterns/lunch-poll/main.tsx:1712` states why that pattern builds
every row in one coarse `computed` rather than a reactive map: a nested
`votes.filter` sees only the votes a replica has materialized locally, and a
reactive map re-renders per-item content unreliably when a remote vote updates a
row. While those hold, adding operators to the algebra will not move authors
onto it.

**Cost needs an enforceable contract.** Scheduler action statistics carry
per-run and cumulative read counts alongside timing, and the single-runtime
pattern test runner reports them by authored source. Opt-in per-run and
whole-step budgets remain to be implemented. Counts expose scaling work;
milliseconds additionally reflect machine speed, storage, and scheduling.

## What already exists

Read these before proposing anything adjacent, so this work extends them rather
than competing with them.

- **Incremental collection builtins.** `map`, `filter`, `flatMap` and their
  `WithPattern` forms, registered in
  [`packages/runner/src/builtins/index.ts`](../../../packages/runner/src/builtins/index.ts).
  `map.ts` documents the element-identity rules every new operator must follow.
- **A declarative query surface.** The SQLite builtin ships;
  [`docs/specs/sqlite-builtin/`](../../specs/sqlite-builtin/README.md) is
  as-built, with its remaining phases and open questions recorded there. Any
  proposal for a new declarative layer should first say why that one is not the
  vehicle.
- **Per-access cost work.**
  [Lazy cell materialization](../../plans/lazy-cell-materialization.md) is the
  plan that owns the constant this plan multiplies against. It is on by default
  behind `lazyMaterialization`; its remaining stages include the handler path
  and flag removal. This plan adds no work there and depends on it.
- **Per-step counters.**
  `deno task cf test <file> --verbose --stats-threshold 0` prints per-step
  timing and per-action run deltas from
  [`packages/cli/lib/test-runner.ts`](../../../packages/cli/lib/test-runner.ts).
- **Read-width feedback.** `deno task cf check <file> --show-transformed` shows
  the emitted input schema, whose size is a usable proxy for how much a
  derivation declared it would read.
- **A write-side benchmark.**
  [`packages/patterns/integration/lunch-poll-vote-burst.bench.ts`](../../../packages/patterns/integration/lunch-poll-vote-burst.bench.ts)
  measures a hundred-vote burst to settle. It exercises the write path; the read
  path this plan targets needs its own.

## What this plan does not do

It does not build a cost-based optimizer that chooses an execution strategy for
arbitrary authored TypeScript.

Planners work where there is a closed algebra and statistics to plan against.
Authored pattern bodies are neither. More importantly, an optimizer answers the
complaint that motivates this work — an author cannot predict what their code
costs — by removing the author's choice rather than informing it, which
relocates the surprise into a plan the author can neither see nor override. The
tracks below keep the choice with the author and make it a choice they can see.

Track B adds operators whose cost is a documented property of the operator. The
author says what the result is and the runtime owns how it is maintained, with
the complexity stated up front rather than inferred by a planner.

It also does not cover the optimistic-write cycle under contention. With several
people voting at once, each client recomputes and writes the same derived
documents, so commits are applied locally, refused on a stale basis, reverted,
and retried — reported at around 46 conflicts per vote with five concurrent
voters. That is a multi-client recomputation problem rather than a read-width
one. Cheaper settles shrink its window without addressing it, and it needs its
own plan.

## Track A — Make cost visible

The cheapest track, the one every other track needs to prove itself, and the
only one that helps patterns nobody rewrites. Do it first.

- [ ] **A0. Reconfirm the baseline.** Reproduce the table above with
      `deno task cf test packages/patterns/lunch-poll/main.test.tsx --verbose
      --stats-threshold 0 --no-idempotency-check`,
      disabling verification before quoting any duration, per the instrument
      notes in
      [`skills/perf-investigation/SKILL.md`](../../../skills/perf-investigation/SKILL.md).
      Record counts, not milliseconds, as the durable baseline.
- [x] **A1. Count accesses per action run.** Add read accounting to
      `ActionStats` in `packages/runner/src/telemetry.ts`, accumulated the way
      `runCount` and `totalTime` already are.

      Four quantities, kept separate, because they answer different questions
      and only the first scales with the shape this plan targets:

      | Counter | What it answers |
      | --- | --- |
      | proxy accesses | how many element and property reads the body performed |
      | link resolutions | how much stored-link traversal work the run performed |
      | distinct documents | how much of the space the run touched |
      | registered dependencies | how much will re-trigger it |

      Instrument the read path itself, not the classification helpers.
      `packages/runner/src/storage/reactivity-log.ts` holds transaction markers
      and `isXRead(meta)` predicates; it is not where a read is recorded. The V2
      transaction records reads into `#readActivities` in
      `packages/runner/src/storage/v2-transaction.ts`, which `getReactivityLog()`
      builds from, and `V2TransactionJournal.activity()` throws by construction.
      Take link resolutions at `resolveLink` and the schema traversal in
      `packages/runner/src/schema.ts` rather than inferring them from read
      records.
- [x] **A2. Attribute it to an authored site.** The node already carries `src`
      pointing at the `computed` or `lift` that produced it. Print accesses
      alongside run count in the per-step deltas, sorted by accesses, so a step
      report names the file and line responsible for the largest read count.
      Reports cover assertion, render, and settle steps as well as actions;
      initialization is separate. Totals collect completion events, including
      actions absent from the final graph snapshot. The
      [CLI reference](../../../packages/cli/README.md#pattern-test-read-costs)
      defines each counter and its boundary.
- [ ] **A3. Give a pattern test a budget.** Opt-in per pattern, not a
      repository-wide gate, so a pattern can defend its own hot path the way a
      benchmark defends a duration. Two budgets, because one alone is
      defeatable:

      - [ ] **Per action run.** Catches a single derivation that reads too much.
      - [ ] **Per step, through settling.** Catches the fan-out this plan
            exists for: fourteen card derivations at a fiftieth of the tally's
            cost each pass any per-run budget and still dominate the
            interaction. Count every run in the step, including builtin and
            coordinator work, not only authored derivations.

      Report a step's initialization and its steady-state update separately. A
      first render legitimately reads what a subsequent update must not, and one
      number covering both can only be set loose enough to catch neither.
- [ ] **A4. Add the read-side benchmark.** A lunch-poll benchmark for the cost
      of one vote settling with the tally on screen, sibling to the existing
      write-side burst benchmark, so Track B and Track C changes have something
      to move. Follow
      [`docs/development/BENCHMARKS.md`](../../development/BENCHMARKS.md) for
      the shape rather than copying the burst file.
- [ ] **A5. Settle the probe-versus-deployed discrepancy.** The headless probe
      `packages/patterns/tools/lunch-poll-diagnose.ts` runs at the same
      `enforce-explicit` posture as the deployed board, and its tally at 70
      votes is reported at ~45 ms against the board's ~550 ms. That is an order
      of magnitude in per-access cost at the same posture, and it is currently
      unattributed. The candidates are the worker boundary and the fact that the
      board's voter links reach into eight separate home spaces where the probe
      has synthetic voters in one. Once A1 lands, this is a comparison of two
      counter readings rather than a profiling exercise.

      It matters beyond curiosity: if the probe understates per-access cost by
      that factor, then every A/B run on the probe is measuring a different
      system from the one people use, and Track B's operators would be tuned
      against the wrong ratio.

The success test for this track is that the numbers in the Problem table can be
regenerated by any team member with one command, without a profiler.

## Track B — Close the collection algebra

Each operator here is the same construction: an incremental builtin under
`packages/runner/src/builtins/`, a registration in that directory's `index.ts`,
a matching record in `packages/runner/src/builder/builtin-replayability.ts` as
that file's note requires, a `Cell` method plus its entry in the reactive-op
list in `packages/runner/src/cell.ts`, and transformer lowering so authored code
reaches it. `map.ts` and `filter.ts` are the templates for element identity and
reconciliation; follow their keying rules rather than inventing new ones.

- [ ] **B1. `groupBy` and `keyBy` are two operators, not one.** They differ in
      arity and therefore in every edge case, so settle both contracts before
      either is built. `groupBy` maps a key to a collection of elements and is
      what the tally needs; `keyBy` maps a key to at most one element and is
      what the roster lookup needs. Both maintain the index incrementally: an
      element changing its key moves, and consumers of untouched keys do not
      re-run. Together they are the read-side counterpart to `elementById`.

      Decide and write down, before implementation:

      - [ ] **Key equality.** The motivating roster key is a profile cell
            compared with `equals`, which follows links to the end. So an index
            keys on resolved link identity, not on a value hash, and the index
            has to be maintained when a link's target changes rather than only
            when the element does. A key extractor returning a non-cell value
            is the easier case and must not be allowed to define the harder one.
      - [ ] **Duplicate keys under `keyBy`.** Two elements claiming one key is
            reachable in live data. First wins, last wins, or a diagnostic, and
            whichever it is must not depend on element order when the collection
            is unordered.
      - [ ] **Missing keys.** What a lookup for an absent key yields, and whether
            that reads as an empty group or as undefined, differs between the two
            operators.
      - [ ] **Group ordering under `groupBy`.** Whether a group preserves source
            order, and whether the set of groups has an order at all. Preserving
            order costs the positional index that B3's aggregates avoid, so this
            decision has a price attached.
- [ ] **B2. Keyed lookup and join.** Given a `keyBy` index, resolve one key
      without scanning, and join two collections on a key so that a change to
      one row invalidates only the joined rows it participates in. The roster
      lookup in `tallyOptions` is the motivating case, and it is the most common
      shape in the tree: the authored patterns hold roughly 250 sites spelling a
      keyed lookup or a membership test as a linear scan, in the forms
      `find((x) => x.id === k)`, `find((u) => equals(u.profile, p))`, and
      `some((x) => x.id === k)`. The nested form
      `filter((a) => !current.some((b) => b === a))` is a set difference written
      as a quadratic scan, and appears several times. Keep this stage as the
      next collection-algebra priority after the initial aggregate comparison.
- [x] **B3. Named aggregates, not a general incremental `reduce`.** A survey of
      the authored patterns finds 33 `reduce` call sites, of which the large
      majority are a sum, and the rest an average (a sum over a count), an
      argmax, or a group-into-counts. Ship those directly rather than a general
      incremental fold:

      - [x] `count`, with an optional predicate. The color tallies in
            `tallyOptions` are counts written as a filter followed by a length.
      - [x] `sum`.
      - [x] `min` and `max`, with `minBy` and `maxBy` returning the element.

      Each is a commutative monoid over its idealized domain, so each is
      maintained as a bag of partial aggregates keyed by the element identity
      `map` and `filter` already use, with no positional index. A single element
      change costs one path through the tree.

      Idealized is load-bearing there, and the gap between it and the machine is
      where this stage can go wrong. Floating-point addition is neither associative nor
      commutative, so recombining from leaves removes the subtraction drift an
      inverse-based form would have and still leaves the result dependent on the
      shape of the tree, which depends on the edit history that produced the
      collection. Two users who reach the same set of votes by different routes
      would then see different totals. Settle a determinism contract before
      implementation:

      - [x] **Combine order.** Fix an order that depends only on the current
            collection, not on how it was reached. Element identity already
            gives a stable sort key. Alternatively adopt a summation that is
            order-independent to the precision reported, and say which.
      - [x] **Ties in `minBy` and `maxBy`.** Two elements comparing equal need a
            rule that is not "whichever the tree reached first".
      - [x] **Empty input.** What each aggregate yields over no elements, and
            whether `minBy` over nothing is undefined or an error.
      - [x] **Non-finite values.** NaN and the infinities, in both the summing
            and the comparing aggregates.

      The test that proves it is a history test, not a value test: build the same
      final collection through several different sequences of inserts, removes,
      and edits, and require identical results from all of them.

      Do not add an inverse-based form. It buys a logarithmic factor on the
      aggregates that are already cheapest, has no definition for min or max,
      and makes a float sum diverge silently under repeated subtraction.

      Do not add a general `reduceMonoid(combine, identity)` escape hatch in
      this stage. The survey does not justify one, and it invites an author to
      declare an associativity they have not checked. Add it when a real case
      appears that the four aggregates above cannot express.

      Leave today's `reduce` in place, unchanged, as the full-rerun path for
      order-dependent folds that have no algebra — a rolling hash is the shape.
      Say so in its documentation, so an author knows which of the two they are
      choosing. A fold that looks complicated is usually a `map` followed by one
      of the aggregates above; the scoring folds in the word game are that
      shape.

- [ ] **B3a. Deferred: cheap append for a restricted fold.** The idea is to
      cache the accumulator after each element so a change at index k re-runs
      only the suffix from k, making an append cost one step instead of N.

      It does not apply to "any fold", and the plan should not claim it does.
      Today's `reduce` hands its callback `(accumulator, element, index, array)`.
      A body that reads `array` — `(acc, x, _i, all) => acc + x / all.length` is
      the compact example — has every prefix change when a single element is
      appended, so every cached accumulator is invalid. A body that mutates and
      returns its accumulator invalidates them a second way, since the cached
      prefixes would alias one object rather than being independent snapshots.

      So this stage is deferred behind a decision it does not get to make alone:
      either a restricted fold API that withholds the `array` parameter and
      requires the accumulator be treated as immutable, with those semantics
      stated rather than assumed, or nothing. Do not start it before B1 through
      B3 land, by which point the aggregates may have absorbed the cases that
      motivated it.
- [ ] **B4. State each operator's cost in its documentation.** An operator whose
      complexity is not written down is one an author has to measure. The
      per-change cost belongs in the doc comment and in
      [`docs/common/concepts/`](../../common/README.md).
- [ ] **B5. Rewrite `tallyOptions` on the new operators** and record the
      before-and-after access counts from Track A in this plan.
- [ ] **B6. Measure maintenance cost against savings, on the deployed board and
      not only on the probe.** An incremental index is not free: it adds nodes,
      and nodes add commits per settle. A hand-written version of this
      restructuring — a single-pass tally with a per-option votes cell that each
      card binds to — cut reads roughly fivefold and added 14 small derivations
      and their commits, which made the probe's vote rounds about 24% slower
      because reads are cheap there. On the deployed board the reads should
      dominate and the trade should invert.

      That inversion is the whole question for this track, and it is a ratio
      rather than a fact: an incremental `groupBy` pays off exactly when its
      maintenance cost sits below what it saves, which differs per deployment.
      Report both numbers, from both rigs, before declaring any operator a win.
      A5 has to be settled first, or the probe's reading cannot be trusted as
      the cheap-reads end of the comparison.

Sketch of the authoring surface, for orientation only:

```ts
// Shown for illustration only.
// Many votes share an option, so that is `groupBy`.
const votesByOption = todaysVotes.groupBy((v) => v.optionId);
// One user per profile, so that is `keyBy`.
const rosterByProfile = users.keyBy((u) => u.profile);
const tally = options.map((option) => ({
  option,
  green: votesByOption.get(option.id).count((v) => v.voteType === "green"),
}));
```

The shape to hold to is that no expression there scans a collection whose length
grows with the space.

## Track C — Make the incremental path trustworthy

This is the track that decides whether Track B gets used. It is also the one
with the most unknown in it, so it starts with reproduction rather than design.

- [ ] **C1. Reproduce both failures as tests.** From the comment at
      `packages/patterns/lunch-poll/main.tsx:1712`: a nested reactive `filter`
      that sees only locally materialized elements, and a reactive map whose
      per-item content does not re-render when a remote update changes an
      element. Both are multi-replica properties, so they belong beside
      `packages/patterns/integration/lunch-poll-keyed-votes.test.ts` rather than
      in a single-runtime pattern test.
- [ ] **C2. Fix partial materialization under nested collection operators.** A
      collection operator's view of its input must not depend on which elements
      the local replica happens to hold.
- [ ] **C3. Fix per-element re-render on remote element update.** An element run
      keyed by normalized link address should re-run when the entity behind that
      link changes, wherever the change originated.
- [ ] **C4. Remove the workaround.** With C2 and C3 landed, move the lunch-poll
      row rendering back onto the reactive path and delete the comment that
      explains why it is not there. The comment going away is the acceptance
      criterion for this track.

## Track D — The per-access constant

D1 and D2 propose no new work; D3 proposes a decision rather than a change. The
constant is what every other track multiplies against, and operators layered
over a sub-millisecond access are still one large collection away from a slow
interaction.

- [ ] **D1. Track
      [lazy cell materialization](../../plans/lazy-cell-materialization.md)
      through flag removal**, including the handler path it lists as
      deliberately deferred.
- [ ] **D2. Re-run the Track A baseline after each stage of it lands**, so the
      per-access improvement is attributed rather than assumed.
- [ ] **D3. Audit and measure the scoped snapshot memo.** `getSnapshotMemo()` in
      [`packages/runner/src/storage/extended-storage-transaction.ts`](../../../packages/runner/src/storage/extended-storage-transaction.ts)
      maintains separate memos by read epoch and ambient metadata identity.
      Child-view label derivation in `deriveDereferenceLabelView` uses an
      ambient-read-meta scope. Measure reuse within these scopes with Track A's
      counters and establish whether repeated label-view derivation remains a
      significant per-access cost. Entries must stay within the epoch and
      metadata boundaries whose journaled reads they represent.

## Track E — Fix the guidance

Independent of every other track, cheap, and worth doing this week.

- [ ] **E1. Give the `computed` and `lift` recommendation a cost dimension, once
      it is measured.**
      [`docs/common/concepts/computed/computed.md`](../../common/concepts/computed/computed.md)
      recommends `computed()` as almost always better and treats `lift()` purely
      as a reuse mechanism. Cost appears nowhere in that recommendation, which
      is the defect regardless of which way the answer falls.

      Do not assume the answer is "prefer `lift` for a loop over a collection".
      Lazy materialization defaults on, and `packages/runner/src/runner.ts`
      marks a lift's transaction lazy for both the argument read and the reads
      the body performs while running, so a lift body also works through a proxy
      that resolves paths on access. The remaining difference is declared read
      width, not proxy versus plain values: a lift's parameter type bounds its
      schema, while a derivation whose body the transformer cannot see through
      declares everything. Neither form removes a nested scan.

      - [ ] Measure both spellings of the same collection loop under current
            defaults, using the Track A counters.
      - [ ] Write the guidance the measurement supports, in terms of declared
            read width, and say what it does not fix.
- [ ] **E2. Name the trap where authors will hit it.** The
      scan-over-a-reactive-array cost is currently written down in
      [`skills/perf-investigation/SKILL.md`](../../../skills/perf-investigation/SKILL.md),
      which an author reads after something is slow. It belongs in the
      pattern-authoring documentation, which they read before.
- [ ] **E3. Add a transformer diagnostic for the recognizable shape.** A nested
      scan over a reactive collection inside a `computed` body is detectable
      statically. Emit a diagnostic naming the shape and the cheaper spelling,
      through the `TransformationDiagnostic` collector in
      [`packages/ts-transformers/src/cf-pipeline.ts`](../../../packages/ts-transformers/src/cf-pipeline.ts).
      Ship it as a warning first; the false-positive rate decides whether it
      ever becomes an error.

## Sequencing

Track A gates everything, because no other track can show it worked without it.
Track E is independent and can run in parallel with anything. Track C should
start its reproduction step early even if the fixes land late, because what C1
finds may change what B1 has to guarantee.

**Track B does not start until its contracts are settled.** The decision lists
in B1 and B3 are not implementation detail deferred to the implementer. Key
equality against a link-valued key, duplicate and missing keys, group ordering,
combine order, ties, and the empty and non-finite cases are the places where the
tally and the roster lookup can turn out to want incompatible semantics, and
that is cheap to discover on paper and expensive to discover in two landed
operators. Write them down, then build.

After the aggregate comparison prioritized above, rank B2 ahead of further
aggregate extensions by expected value: the tree holds roughly 250 linear-scan
lookups against a handful of aggregates worth incrementalizing. B1 still
precedes B2, since keyed lookup and join depend on its index contracts.

Suggested split for three parallel efforts: one on Track A plus E, one on Track
C's reproduction and fixes, one settling the Track B contracts and then building
B1.

## Testing

- Pattern tests for each new operator's semantics, per
  [`docs/development/unit-test-coding-style.md`](../../development/unit-test-coding-style.md).
- Incrementality is a count property, not a duration property: assert on
  scheduler run counts and the Track A access counts, not on milliseconds.
- Multi-replica integration tests for Track C, since the failures do not
  reproduce in a single runtime.
- Benchmarks for the read path (A4) and the existing write path, read as trends
  across windows rather than one window against the last.

## Risks

- **Track C's cause is not yet known.** Its stages are written as outcomes
  because the design cannot be written before C1. If C1 shows the cause is
  structural to how replicas materialize collection elements, this track is
  larger than the others combined, and Track B should not wait on it.
- **A new operator is a new identity contract.** `map` and `filter` key elements
  by normalized link address, with positional identity for inline values. A
  grouping operator adds a second key, and the interaction between the two is
  the most likely source of correctness bugs.
- **An incremental index can cost more than it saves.** It trades reads for
  nodes, and nodes for commits per settle. B6 exists because a hand-written
  version of this trade came out negative on the rig it was measured on. Whether
  it comes out positive on the deployed board is a measurement nobody has made
  yet, and Track B should not be declared successful before it is.
- **An access counter has its own cost.** Track A1 instruments the hottest path
  in the runtime. It needs to be free when off, and the check that it is belongs
  in the same change.
- **A diagnostic with a high false-positive rate gets ignored or disabled.** E3
  ships as a warning for that reason, and its false-positive rate decides
  whether it ever becomes an error.
