---
status: historical
created: 2026-09-10
archived: 2026-09-12
reason: "Executed #7155 scope; B3a deferred and D1/D2 transferred to a separate fast-follow."
---

# Pattern computation cost: implementation sequence

Status: instrumentation, read budgets, named aggregates, reactive row repairs,
collection indexes, tagged key enumeration, and left lookup joins are delivered.
[PR #7323](https://github.com/commontoolsinc/labs/pull/7323) publishes the index
producers and join acceptance;
[PR #7362](https://github.com/commontoolsinc/labs/pull/7362) publishes the
separate maintenance-phase measurements. Both passed CI and review before merge.
[PR #7372](https://github.com/commontoolsinc/labs/pull/7372) bounds index member
setup reads, and [PR #7385](https://github.com/commontoolsinc/labs/pull/7385)
bounds shared downstream traversal in scheduler wake checks. The repository
lunch poll uses maintained per-option groups and tighter updated-render budgets
in [PR #7336](https://github.com/commontoolsinc/labs/pull/7336). The execution
dashboard records validation and publication status.

A5/B6 acceptance is recorded in the
[representative-copy report](../development/performance/2026-09-12-representative-lunch-poll-rehearsal.md).
Two migration passes preserved authored data and matched rendered content. The
report separates reduced update reads from graph growth and mixed timings;
production latency and the historical deployment ratio remain unconfirmed. Q9
transfers D1/D2 execution to the
[lazy-materialization fast-follow](lazy-materialization-fast-follow.md).
The live poll is untouched.

This tracker executes the design in
[PR #7155](https://github.com/commontoolsinc/labs/pull/7155), reviewed at commit
`147e7518c9d03bc9808c56e1488d2ae0965ea655`. The design owns the rationale and
scope; this document owns dependencies, implementation slices, acceptance
checks, and the next task. Keep the A–E identifiers aligned with the design. Its
reported durations and access estimates are hypotheses until reproduced here.

The [execution dashboard](../../../tools/implementation-progress/README.md)
shows delivery state, review gates, outstanding questions, and observable demos.
Checked items below mean implemented and validated; the dashboard separately
records whether they have landed. Keep both current at implementation
milestones.

## Tracking rules

An unchecked item is pending. Check an item only after its acceptance checks
pass, and attach the implementation PR and validation evidence. A parent is
complete only when its children are complete. An unavailable rig is a named
dependency, never a passing measurement. Keep completed measurement reports
under `docs/history/` with metadata and an index entry; link them here.

Do not expand this work into a TypeScript execution planner, contention repair,
inverse-based aggregates, or a general incremental `reduce`. B3a is explicitly
deferred and does not block completion of the active work.

## Implementation order

| Slice | Design stages        | Prerequisite                                | Reviewable result                                      |
| ----- | -------------------- | ------------------------------------------- | ------------------------------------------------------ |
| 0     | Preparation          | None                                        | This tracker and source reconciliation                 |
| 1     | A0a, A1              | 0                                           | Baseline fixture, counter contract, runtime accounting |
| 2     | A2, A0b              | 1                                           | Attributed per-step counts and regenerated baseline    |
| 3     | A3                   | 2                                           | Opt-in per-run and whole-step budgets                  |
| 4     | A4, A5               | 2                                           | On-screen read benchmark and rig comparison            |
| 5     | C1                   | 0; use 2 for cost evidence                  | Two multi-replica reproductions                        |
| 6     | B1/B2 contracts      | 2; incorporate C1 findings                  | Written index, lookup, and join contracts              |
| 7     | B1, B4               | 6                                           | Incremental grouping and unique-key indexing           |
| 8     | B2, B4               | 7                                           | Keyed lookup and incremental join                      |
| 9     | B3 contracts, B3, B4 | 2                                           | Deterministic named aggregates                         |
| 10    | C2, C3, C4           | 5; use 2 for cost evidence                  | Remote updates work through reactive rows              |
| 11    | B5, B6               | 3, 4, 8, 9; coordinate with 10              | Measured lunch-poll migration                          |
| 12    | E1, E2, E3           | 2 for measurements; 7–9 for operator advice | Measured guidance and warning diagnostic               |
| 13    | D1, D2, D3           | Track throughout; use 2 for comparisons     | Dependency verification and measurements               |
| 14    | Closeout             | Active stages verified                      | Live docs updated and tracker archived                 |

This is a dependency order, not a requirement to wait for every earlier row. C1
and contract research can start early; operator implementations require settled
contracts and working counters. A5 gates the performance claim in B6, not
implementation of an operator. E1's recommendation requires measurement; E3's
replacement advice requires a shipped replacement.

## 0. Prepare the implementation

- [x] Read the design and identify its existing runtime and CLI extension
      points.
- [x] Create the full implementation sequence with explicit acceptance gates.
- [x] Reconcile D3 with the current implementation: `getSnapshotMemo()` in
      [extended-storage-transaction.ts](../../../packages/runner/src/storage/extended-storage-transaction.ts)
      selects separate memos by epoch and ambient metadata. D3 must verify
      isolation and measure reuse, rather than assume scoped memoization is
      absent.

## 1–2. Establish measurement: A0, A1, A2

- [x] **A0a — Establish a repeatable workload before instrumentation.**
  - [x] Run
        `deno task cf test packages/patterns/lunch-poll/main.test.tsx
        --verbose --stats-threshold 0`;
        inspect which tally and row reads it actually demands.
  - [x] Specify the options, votes, voters, source revision, demanded output,
        CFC posture, lazy-materialization setting, and execution location. Add a
        controlled fixture if the existing test cannot reproduce the design's
        workload.
  - [x] Separate initialization from one steady-state vote update. Record
        available run counts; leave unavailable access counts unmeasured.
        Disable idempotency verification before using test durations as
        performance evidence, following the performance-investigation skill.
- [x] **A1a — Define the initial accounting contract.** See
      [read accounting](../../features/read-accounting.md). Reactive action
      bodies are the initial boundary; event dispatch and commit work must be
      added before claiming whole-step budget coverage.
  - [x] Define proxy access events, actual link crossings, distinct documents
        identified by replica document object, and registered dependencies.
        Specify repeated reads, missing values, enumeration, shallow reads, and
        memo hits. A read activity is not interchangeable with a proxy access.
  - [x] Define per-run ownership, cumulative totals, and per-step aggregation.
        Distinguish a union of documents across a step from a sum of per-run
        cardinalities. Define failure, restart, idempotency verification, nested
        execution, and async completion accounting.
  - [x] Define opt-in configuration and the disabled path. Register any new
        experimental option in the central registry if one is needed.
- [x] **A1b — Implement reactive-action accounting at the operations it
      measures.**
  - [x] Extend `ActionStats` and scheduler recording in
        [telemetry.ts](../../../packages/runner/src/telemetry.ts) and
        [timing.ts](../../../packages/runner/src/scheduler/timing.ts).
  - [x] Trace both query-result and schema-backed lazy reads before placing
        proxy counters. Count link crossings in the actual resolution and schema
        traversal paths, without counting the same crossing twice.
  - [x] Derive document/dependency accounting from actual transaction reads and
        registration. Preserve read metadata and subscription behavior.
  - [x] Test repeated reads versus distinct documents, cross-space reads, link
        chains, memo hits, shallow dependencies, failures, and isolation between
        actions/runtimes. Verify builtins are counted.
  - [x] Verify disabled accounting allocates no per-read counter state and
        performs no document-set maintenance; measure its overhead against an
        uninstrumented control. See the
        [disabled-probe measurement](../development/performance/2026-09-10-read-accounting-probes.md);
        the result is limited to that workload and does not claim zero overhead.
- [x] **A2 — Expose attributed reactive-action counts.**
  - [x] Extend per-step output in
        [test-runner.ts](../../../packages/cli/lib/test-runner.ts), sorting by
        access deltas and retaining run counts and authored `src`.
  - [x] Keep builtin/coordinator work visible when no authored site exists. The
        CLI aggregates completed-run events, including removed actions. Avoid
        double-counting shared action IDs and parent/child totals.
  - [x] Test interval resets, multiple runs, zero-work steps, missing source
        locations, and completed runs without consulting graph snapshots.
- [x] **A0b — Regenerate the durable baseline using A1/A2.**
  - [x] Provide one command and checked fixture that regenerate all four
        counters, by action and step, with initialization separate.
  - [x] Record measured evidence and explain differences from the design's
        estimates. A0 is complete only after this pass.

See the
[controlled baseline](../development/performance/2026-09-10-lunch-poll-read-baseline.md)
for the fixture, command, execution posture, and counts. No pattern-test
durations are used as performance evidence.

## 3–4. Defend and calibrate measurements: A3–A5

- [x] **A3 — Add opt-in pattern-test budgets.** The
      [budget contract](../../features/read-accounting.md#pattern-test-budgets)
      defines the surface, execution coverage, and pass/fail demo.
  - [x] Define the test declaration and diagnostics for per-action-run and
        per-step-through-settle limits, with separate initialization limits.
  - [x] Include every execution in a step, including builtins, coordinators,
        failed attempts, and short-lived actions according to A1a's contract. Do
        not depend solely on retained graph snapshots for enforcement.
  - [x] Test exact-boundary pass, one-over failure, one expensive run, and many
        individually cheap runs exceeding the step budget. Verify unbudgeted
        tests preserve their behavior.
- [x] **A4 — Add the read-side benchmark.**
  - [x] Follow [BENCHMARKS.md](../../development/BENCHMARKS.md); measure one
        vote settling with its tally on screen across declared collection sizes.
  - [x] Preserve the existing write-burst benchmark as a separate workload.
        Record reads, runs, commits, and timing in
        [PR #7261](https://github.com/commontoolsinc/labs/pull/7261).
  - [x] Add read-count regression limits in
        [PR #7282](https://github.com/commontoolsinc/labs/pull/7282): all six
        functional assertions and render limits pass at 74, 296, and 1,184
        votes. Benchmark timing remains a reported trend.
- [x] **A5 — Compare probe/product boundaries within accepted copy scope.**
  - [x] Compare matched inputs in the headless probe and browser, varying worker
        boundary and single-space/cross-space voter links separately.
  - [x] Record client/server execution posture, demanded surfaces, counters, and
        timings from the process that performs the work.
  - [x] Validate the comparison against an isolated snapshot copy of the
        representative poll. Record the snapshot, source revision, and linked
        profile coverage. Keep production hosting, network conditions, and
        concurrent live-user behavior outside the resulting performance claim.

The representative-poll comparison uses the
[local clone rehearsal procedure](../../development/space-clone-rehearsal.md).
Acquire a consistent snapshot, inventory cross-space profile dependencies,
record a pristine baseline and the current-day vote filter, and compare the
candidate on the clone. Verify preserved authored inputs and correct rendered
behavior separately from generated results. The copy has its own local server
and writable database; test votes and edits stay there. Live poll updates
require separate coordination.

### Validation evidence for the A3 slice

[PR #7257](https://github.com/commontoolsinc/labs/pull/7257) implements the
checked A3 acceptance items.
[Read-accounting tests](../../../packages/runner/test/read-accounting.test.ts)
cover transaction ownership, aborted attempts, queued preflight setup failures,
fan-out, and asynchronous writebacks. The
[budget collector tests](../../../packages/cli/test/read-budgets.test.ts) cover
exact boundaries, total/per-run separation, and action/attempt attribution. The
[CLI budget fixtures](../../../packages/cli/test/test-runner-read-budgets.test.ts)
exercise declarations, functional-failure preservation, rejected initialization
settlement without restarting it, render enforcement, many cheap runs, and one
expensive run.

Compiler acceptance also covers stored fields named after Cell methods, optional
Cell handles, and whole-value reads passed to helpers. The generated call-center
integration and pinned default-app vintage replay pass with complete stored
shapes preserved. Full affected-package validation and all 69 CI gates passed
before merge, with clean Cubic and antagonistic reviews.

## 5, 10. Repair incremental correctness: C1–C4

- [x] **C1 — Reproduce both documented failures.**
  - [x] Add a multi-replica nested-filter case whose reader has not locally
        materialized every vote.
  - [x] Add a remote element-update case asserting rendered per-row content.
        Start beside the existing lunch-poll keyed-votes integration tests.
  - [x] Establish failure before repair, or demonstrate that the current system
        already passes the faithful reproduction. Record the cause or evidence
        before deciding what C2/C3 need to change.
  - [x] Exercise two reader transport outages with nested and mapped rows;
        verify catch-up and subsequent updates through headless result reads.
  - [x] Verify rendered rows after reconnect.

  The
  [independent-replica probes](../../../packages/patterns/integration/reactive-vote-rows.test.ts)
  assert nested-filter membership and derived tally updates. The
  [browser tests](../../../packages/patterns/integration/reactive-vote-rows-browser.test.ts)
  cover same-space and cross-space profiles, remote colors, profile-only edits,
  membership additions, removal/restoration, ranking changes, and nested mapped
  swatches. Removal checks pin the empty row, absence of nested swatches,
  reordering, and exactly one swatch after restoring the same keyed vote. A
  fresh browser reader first materializes a vote and renamed profile after both
  were changed remotely, then observes further edits while subscribed.
  Cross-space profiles are created in a separate transaction and edited directly
  in their own space. Headless result reads explicitly pull data, so browser
  rendering owns the passive-update check. The optional browser reconnect mode
  closes live reader sockets around color, profile, and removal writes; all four
  nested/mapped and same/cross-space cases pass. The
  [repeatable relay procedure](../../development/TESTING.md#browser-row-reconnect-acceptance)
  keeps the writer connected and asserts that each outage closes live sockets.
  The
  [reconnect probe](../../../packages/patterns/integration/reactive-vote-rows-reconnect.test.ts)
  closes the reader's storage sockets while the writer changes membership and
  profiles. Ordinary memory queries wait for session restoration before
  constructing their requests. This guards the handshake-to-session interval; a
  subsequent disconnect during request issue remains a separate boundary. These
  synthetic probes cover repository behavior. Live poll changes require
  coordination with Mike.

  C3 records the mutable inline element used when resolving a nested array to a
  content-addressed snapshot. The
  [cell callback regression](../../../packages/runner/test/cell-callbacks.test.ts)
  verifies updates after initial demand settles and confirms that changing a
  neighboring inline element causes no rerun. The fix and its validation are
  recorded in [PR #7265](https://github.com/commontoolsinc/labs/pull/7265). C3's
  complete acceptance also includes the client and serving cases below.

  To record synthetic browser evidence with a local test server, set `API_URL`
  and `FRONTEND_URL`, then run:

  ```sh
  CF_ROW_REPRO_ARTIFACT_DIR=/tmp/reactive-row-artifacts deno test -A packages/patterns/integration/reactive-vote-rows-browser.test.ts
  ```

  The artifact directory receives screenshots and assertion metadata for all
  four cases. Live poll access requires coordination with Mike.

- [x] **C2 — Repair partial materialization.** Complete inputs are covered by
      C1's cold-browser, remote insertion/removal, and reconnect acceptance. The
      session-restoration query repair is merged in #7308; rendered reconnect
      acceptance is merged in #7312. The same-space and cross-space fixtures
      verify complete vote and profile inputs on first demand, after membership
      changes, and after two reader outages. No additional materialization
      change is required for these reproductions. Disconnects during request
      issue remain the separate boundary stated above; C3's producer-identity
      and rerun checks are tracked independently.
- [x] **C3 — Repair remote row invalidation.** Client and serving-host
      acceptance verify correct derived values, stable normalized output links
      and producer identities, and no execution of the untouched row producer
      after edits to each of two linked rows. The
      [client case](../../../packages/patterns/integration/reactive-vote-rows.test.ts)
      uses independent worker replicas and merged in #7329. The
      [serving-loop case](../../../packages/runner/test/executor-serving-loop.test.ts)
      observes the actual serving runtime and waits for the authored input
      watermark; a client diagnostic graph does not contain those actions.
      Serving acceptance is published in
      [PR #7331](https://github.com/commontoolsinc/labs/pull/7331).
- [x] **C4 — Restore reactive lunch-poll rows.** Direct reactive option and
      voter maps use the scoped callback-child repair. Repository acceptance
      includes 93 assertions, unchanged A4 budgets at all three sizes, and
      concurrent two-browser voting. The
      [acceptance record](../development/performance/2026-09-11-reactive-lunch-rows.md)
      states measurement limits. B5's operator migration remains separate;
      deployed poll updates require coordination with Mike.

## 6–9. Complete the collection algebra: B1–B4

- [x] **B1 contract — Specify `groupBy` and `keyBy` separately.** The
      [executed index contract](collection-index-contract.md) records semantic
      decisions and acceptance tests, agreed in
      [PR #7294](https://github.com/commontoolsinc/labs/pull/7294). Typed lookup
      landed in [PR #7304](https://github.com/commontoolsinc/labs/pull/7304);
      producers landed in
      [PR #7323](https://github.com/commontoolsinc/labs/pull/7323);
      initialization and maintenance counts are validated separately in
      [PR #7362](https://github.com/commontoolsinc/labs/pull/7362), with 12
      cases and 96 phases. Source-size and affected-bucket costs remain
      explicit.
  - [x] Key domain and equality, including resolved link identity and
        retargeting a key link without editing its containing element.
  - [x] Duplicate-key handling that remains deterministic for unordered input;
        missing extracted keys and absent lookups.
  - [x] Group membership order, homogeneous-key enumeration order, lookup
        surface, and identity across removal/reinsertion.
  - [x] Mixed primitive/Cell enumeration API decision (Q7): explicit tagged
        entries, preserving homogeneous `keys()` usage. The
        [decision record](../features/2026-09-11-index-key-enumeration-decision.md)
        records consequences and alternatives.
  - [x] Implement tagged enumeration and verify authored output acceptance,
        lookup round trips, cross-space identities, and durable resume. The
        [authored consumer tests](../../../packages/runner/test/collection-index-key-entries.test.ts)
        exercise both producer modes with equal-valued primitive and Cell keys;
        stored-descriptor recovery preserves lookup-only demand behavior.
  - [x] Bound invalidation to affected keys; state initialization, update,
        lookup, and storage complexity.
- [x] **B2 contract — Specify lookup and join.** The index contract defines a
      left lookup join, unmatched rows, deterministic duplicate matches, left
      occurrence ordering, link retargeting, and owned cleanup.
- [x] **B1 implementation — Build grouping and unique-key indexing.** PR #7323
      carries the implementation and runner acceptance; PR #7362 supplies the
      separate phase-count probe. Both PRs passed delivery gates.
  - [x] Reuse collection element-identity/reconciliation rules from existing
        builtins; cover primitives, linked elements, and inline values.
  - [x] Wire builtin registration, replayability, `Cell` methods and reactive
        operation list, author-facing types, and transformer lowering.
  - [x] Test inserts, edits, moves between keys, removals, reorder, duplicate
        keys, link retargeting, replay, and teardown. Assert unaffected-key
        consumers do not rerun and measure maintenance work as size grows.
- [x] **B2 implementation — Build keyed lookup, then join.** Lookup and join
      contracts, both-side updates, unmatched rows, and affected-row-only
      invalidation pass the local/cross-space and restart acceptance tests in
      [PR #7323](https://github.com/commontoolsinc/labs/pull/7323), merged after
      clean CI and reviews.
- [x] **B3 contract — Specify deterministic aggregates.**
  - [x] Define combine order from the current collection, independent of edit
        history; define floating-point behavior explicitly.
  - [x] Define ties, empty collections, NaN, infinities, and signed zero for
        `sum`, `min`, `max`, `minBy`, and `maxBy`; define predicate counting.
- [x] **B3 implementation — Add `count`, `sum`, `min`/`max`, `minBy`/`maxBy`.**
  - [x] Maintain partial aggregates using existing element identities and
        deterministic combination; avoid inverse subtraction.
  - [x] Reach identical results through different insertion, deletion, reorder,
        and edit histories. Test count bounds on single-element updates and
        initialization separately.
  - [x] Keep ordinary `reduce` as the full-rerun order-dependent operation.
- [x] **B4 — Document contracts and complexity with each operator.** Update
      public doc comments, pattern-author documentation, and executable examples
      in the same slice that ships the API. The aggregate portion is documented
      in [collection aggregates](../../features/collection-aggregates.md); index
      semantics and current costs are documented in
      [collection indexes](../../features/collection-indexes.md). Measured scale
      acceptance is recorded in PR #7362; join documentation and acceptance
      tests are in PR #7323. Both PRs passed CI and review before merge.

**Deferred B3a:** Reconsider restricted append folds only after B1–B3 ship and a
remaining use case justifies them. Requires a separate contract excluding
whole-array access and mutable accumulator aliasing; no active checkbox here.

## 11. Validate the motivating pattern: B5–B6

- [x] **B5 — Rewrite `tallyOptions` using the shipped operators.**
      [PR #7336](https://github.com/commontoolsinc/labs/pull/7336) uses
      maintained per-option vote groups. Authored pattern tests and two-browser
      acceptance cover ranking, profile identity, and viewer-specific behavior
      with client and server execution. The 1,184-vote coverage case keeps its
      existing action limit and default heap.
- [x] Add measured per-run and steady-state step budgets for the hot path. PR
      #7336 limits the 74-vote fixture to 6,000 initial-render accesses, 1,100
      updated-render accesses, and 300 accesses per reactive body. The local
      combined run measured 4,857 / 958 / 224. The scan control passes
      functional assertions and the initial-render limit at 3,176 accesses. It
      fails the 300-access per-body limit in both render windows (360 each) and
      the 1,100-access updated-render limit (1,240). Maintained groups use more
      initial-render accesses (4,857 versus 3,176) and fewer updated-render
      accesses (958 versus 1,240); this is an update-work bound, not a
      total-cost or latency claim.
- [x] **B6 — Measure savings and maintenance together.** Compare the same
      operation before/after on both probe and browser rigs, then validate with
      the representative poll copy after A5. Report accesses, runs, nodes,
      commits, durations, and any omitted cross-space dependencies. Do not call
      fewer reads alone a win or describe local-copy results as production
      performance.

## 12–13. Guidance and related runtime work: D, E

- [x] **E1 — Measure identical `computed` and `lift` collection loops** under
      current defaults and compare declared read width and access counts. The
      [reproducible comparison](../development/performance/2026-09-11-computed-lift-collection-loops.md)
      validates three forms at 32, 128, and 512 linked rows, including
      unread-field edits. The dashboard tracks publication and review status.
- [x] **E2 — Publish the measured advice** where pattern authors encounter
      collections, `computed`, and `lift`. Explain nested-scan cost and use only
      available operators in replacement examples. The
      [computed/lift guide](../../common/concepts/computed/computed.md#collection-loop-cost)
      and
      [collection guide](../../features/collection-aggregates.md#choosing-a-collection-computation)
      explain lazy read width, repeated scans, explicit cell receivers, numeric
      contract differences, and measurement limits. The author index links both;
      dashboard publication status remains separate.
- [x] **E3 — Add a transformer warning** through the existing diagnostic
      collector. Test recognizable nested reactive scans and negative cases
      involving plain arrays and unrelated scopes; inspect warning volume across
      authored patterns before shipping. Escalation to error requires separate
      evidence about false positives. The
      [diagnostic acceptance report](../development/performance/2026-09-11-nested-collection-scan-diagnostic.md)
      records the focused cases, full transformer suite, and all five distinct
      findings across 413 pattern entries. Publication and review remain visible
      in the dashboard.
- [x] **D1 — Transfer remaining lazy-materialization execution** to the
      [separate fast-follow plan](lazy-materialization-fast-follow.md),
      as approved in Q9. F1/F2 own handlers; F3/F4 own rollout and flag
      retirement. These behaviors are not implemented by this handoff.
- [x] **D2 — Transfer conditional remeasurement** to F0/F5 of that plan. Repeat
      the A baseline when its dependency changes, separating access count from
      per-access cost. This checks off the approved handoff, not a future
      measurement that has already run.
- [x] **D3 — Verify scoped snapshot memoization and measure its effect.** The
      snapshot-memo suite passes 41 steps, including combined epoch/metadata
      label-view isolation. The benchmark verifies one metadata read across 74,
      296, and 1,184 requests in each scope. The
      [verification report](../development/performance/2026-09-10-scoped-snapshot-memo.md)
      records the control and measurement limits.

## 14. Validation and closeout

- [x] Each code slice runs relevant focused tests plus the touched packages'
      test tasks, repo-wide `deno fmt --check`, `deno lint`, and
      `deno task
      check`. Pattern changes also run authoritative
      `deno task cfcheck`.
- [x] Browser-launching checks on macOS run outside the sandbox. Follow
      [TESTING.md](../../development/TESTING.md) and event-driven waiting rules.
- [x] Run applicable independent gates: documentation examples, history index,
      conflict markers, package cycles, and any changed CLI surface,
      experimental options, skills, or transformer fixtures.
- [x] Review every implementation slice through the `cf-review` skill; attach
      the exact validation scope and unresolved limitations.
- [x] Confirm every active stage has evidence, keep deferred work explicit,
      update live feature/author docs, and archive the completed tracker
      following [the documentation lifecycle](../../README.md).

## Accounting measurement record

The
[probe comparison](../development/performance/2026-09-10-read-accounting-probes.md)
records the measurement method and its limits. The current accounting contract
and regression surfaces are documented in
[read accounting](../../features/read-accounting.md).

## Follow-up

The
[lazy-materialization fast-follow](lazy-materialization-fast-follow.md)
owns remaining execution and conditional remeasurement. B3a remains deferred.
Any live poll update requires separate operator coordination.
