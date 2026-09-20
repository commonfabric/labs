---
status: historical
created: 2026-09-11
archived: 2026-09-19
reason: "Completed default-on evidence and measurement work; handler integration remains explicitly deferred and flag retirement remains outside the arc."
---

# Lazy materialization fast-follow

Status: completed to the documented handler-deferral boundary. F0, F2, F3, and
F5 are complete; F1's three unverified bullets remain explicitly deferred. F4 is
optional owner-led work outside this arc. The
[closeout record](../development/performance/2026-09-19-lazy-fast-follow-closeout.md)
collects the evidence, measurement limits, and conditions for future work.

This follow-up to the [computation-cost](pattern-computation-cost.md) arc owns
the handler investigation, default-on behavior evidence, and the D1/D2
measurements transferred by its
[implementation record](pattern-computation-cost-implementation.md). It does not
authorize a live lunch-poll update.

The [lazy materialization design](../../plans/lazy-cell-materialization.md)
defines the schema-observing view and snapshot contracts. Lift arguments use
that view under the default-on `lazyMaterialization` flag. The handler path in
[`runner.ts`](../../../packages/runner/src/runner.ts) still reads its argument
without marking the transaction for lazy materialization. Its closed-world event
validation, cold-input handling, receipts, and effects make it a separate
integration problem.

## Scope and decision

Complete measurements and guidance for the current default-on lift behavior. The
runtime's flag owner, Bernhard Seefeld, decides whether and when to retire its
rollout switch. Retirement is optional owner-led work, not a prerequisite to
completing this arc or its measurement matrix. The prepared retirement PR is a
proposal the owner may adopt, revise, or decline.

Keep the eager-mode limitation visible: disabling the flag is not a qualified
rollback. A retirement proposal must separately settle its rollback route; that
operational decision does not block measuring the supported default. Lazy
handler contexts remain explicitly deferred under F1/F2.

## Execution tracker

Mark a step complete only with its linked evidence. Capture decisions and
completed investigations in `docs/history/`; update the live contract documents
in the same PR as behavior changes.

| Step | Depends on                  | Deliverable                                                                  | State                                                                                                                                                                                                                           |
| ---- | --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0   | Computation-cost acceptance | Fixed baseline and remaining-call-site inventory                             | Done: [F0 baseline](../development/performance/2026-09-11-lazy-materialization-f0-baseline.md)                                                                                                                                  |
| F1   | F0                          | Handler materialization contract and measured prototype                      | Done as far as the deferral needed, three bullets carried forward: [F1 record](../development/performance/2026-09-11-lazy-handler-context-prototype.md)                                                                         |
| F2   | F1                          | Reviewed handler integration, or an explicit evidence-backed deferral        | Done: deferred, with the blocker and the conditions for revisiting in the [F1 record](../development/performance/2026-09-11-lazy-handler-context-prototype.md)                                                                  |
| F3   | F0                          | Default-on evidence and documented fallback limitations                      | Done: [rollout evidence](../development/performance/2026-09-11-lazy-materialization-f3-rollout-evidence.md) and [reload diagnosis](../development/performance/2026-09-15-lazy-reload-diagnosis.md); eager mode is not qualified |
| F4   | Owner decision              | Optional removal of the lift rollout switch                                  | Outside this arc; owner-led proposal, not a completion gate                                                                                                                                                                     |
| F5   | F2, F3                      | Repeat default-on measurement matrix, update guidance, and archive this plan | Done with explicit measurement limits: [closeout](../development/performance/2026-09-19-lazy-fast-follow-closeout.md)                                                                                                           |

F1/F2 and F3 can proceed independently. F4 does not depend on making handlers
lazy: F1 identified no shared contract that would require that order. The
deferral's blocker is what a narrower read set does to a handler's commit — it
changes which concurrent writes the commit refuses — where on the lift path it
changes only when a node re-runs. Do not delete eager materialization that
unmarked transactions still require.

### F0 — Establish the baseline

- [x] Inventory flag consumers, lift and handler argument entry points, and
      eager reads required for result writing, diffing, or unmarked callers.
- [x] Pin a runtime revision and record flag posture for each process. Preserve
      the controlled 74-, 296-, and 1,184-vote fixtures and the representative
      copy's current-day filter and linked-profile limitations.
- [x] Record completed-attempt reads, reactive-body reads, handler and commit
      work, graph size, allocation/retention, and disabled-accounting durations
      in separate windows. Preserve their different accounting boundaries.

The
[F0 baseline](../development/performance/2026-09-11-lazy-materialization-f0-baseline.md)
holds the inventory, the posture table, and the per-phase handler dispatch
measurement from `packages/runner/test/handler-dispatch-cost.bench.ts`; the
completed-attempt and reactive-body reads the step names are in the
[representative lunch poll rehearsal](../development/performance/2026-09-12-representative-lunch-poll-rehearsal.md).
Its retention probe was inconclusive and is recorded as such; the representative
copy was not re-run and its limitations carry forward. Two of its findings shape
F1: the dependency preflight, not the argument read, is the largest fixed cost
of a handler dispatch, and a handler's read log is its commit conflict set,
which a view would narrow.

### F1/F2 — Decide and integrate handler materialization

- [x] Specify which bound context paths can be lazy and which event-payload
      checks must complete before the body runs. Start from the existing
      `$event` / `$ctx` split and closed-world event gate; do not weaken payload
      validation as a side effect of narrower context reads.
- [ ] Define touched required-field refusal, optional mismatch, missing linked
      data, and caught refusal. Distinguish cold input withdrawal from permanent
      invalidity; do not consume an event that never ran or commit partial
      handler writes as a successful handling. Defined for all four; the touched
      required-field, optional-mismatch, and caught-refusal arms are pinned for
      client dispatches by the deferred prototype's tests, which are not in the
      tree, and for served dispatches only as far as the existing not-run tests
      reach, and a cold linked document parked on its load is defined but not
      pinned; a client dispatch under server execution with no served carriage
      seals its skip rather than withdrawing it, and a refusal after a write on
      that arm is left open.
- [ ] Pin receipt identity, duplicate delivery, retry, and effect behavior in
      both client and server execution. Test that a refusal after a write does
      not publish that write or an external effect. Retry, the receipt on the
      committing run, and the withdrawn write are pinned by the deferred
      prototype's tests, which are not in the tree; receipt identity across a
      duplicate delivery, external effects, and the served execution path are
      not pinned anywhere, and the deferral leaves them open.
- [ ] Test read/write snapshots, defaults and absent-path dependencies,
      cross-space context, labels read before and after policy preparation,
      escaped views, and asynchronous handler continuations where supported.
      Asynchronous continuations, a result built from values read through the
      view, and an absent optional field are pinned by the deferred prototype's
      tests, which are not in the tree; a view itself escaping into result
      handling, snapshots, a default followed by the value's arrival,
      cross-space context, and labels around policy preparation are not pinned
      anywhere, and the deferral leaves them open.
- [x] Compare a scalar read from a large bound context with a full walk and with
      mutation-heavy handlers. Measure argument setup separately from the body
      and commit preparation so work is not merely moved out of a counter.
- [x] Review the proposed contract and measured prototype. Implement the lazy
      context path if it preserves the event contract with a useful measured
      consequence; otherwise record the specific blocker, alternatives, and
      condition for revisiting it. A deferral must be explicit, not an unchecked
      handler exception hidden in a completed lift rollout.

The
[F1 record](../development/performance/2026-09-11-lazy-handler-context-prototype.md)
holds the contract, the prototype, its tests, and the measurements. The outcome
is a deferral: the prototype preserves the event contract, but its measured
consequence is a win only for a handler that reads a whole list and touches
little of it, a shape the collection guidance already steers authors away from,
and a cost in the body for the full walks the lunch poll's handlers rely on; and
a view narrows the read log a handler's commit is checked against to the paths
the body touched, so a concurrent write to a field of a row the body never read
stops conflicting with its commit. The record names the conditions under which
the prototype is worth taking up again. Three bullets above stay open because
the deferred prototype was not verified against everything they name; the record
lists what its tests pinned and what they did not, and whoever takes the
prototype up finishes them. One design question is open for the handler path's
owner: whether touched-path conflict sets are the intended handler contract, or
whether a handler should be able to declare a conflict set independently of what
it materializes. An owner ruling that they are the contract reopens the
deferral; ruling the other way leaves it closed until a handler can declare that
set.

Use the existing transaction mark, schema-refusal state, snapshot view and
event-finalization paths. Keep the mark's lifetime bounded to the argument/body
contract; result serialization, policy preparation and scheduler bookkeeping
must not accidentally inherit it.

### F3 — Default-on evidence and fallback limits

The
[rollout evidence](../development/performance/2026-09-11-lazy-materialization-f3-rollout-evidence.md)
records revisions, execution postures, observed failures, and coverage limits.
The
[integration evidence](../development/performance/2026-09-14-lazy-off-integration.md)
records passing eager-posture suites without qualifying rollback. The
[reload diagnosis](../development/performance/2026-09-15-lazy-reload-diagnosis.md)
shows that eager execution can deliver an unavailable nullable input and fail
with browser errors. Rendering the notes alone does not qualify that fallback.
The
[navigation-policy diagnosis](../development/performance/2026-09-15-notebook-reload-navigation-policy.md)
explains the corrected notebook selection; the default-on scenario passes.

The
[derived-state correction decision](../development/2026-09-14-derived-state-correction.md)
permits two exact stale fetch-status transitions during vintage replay. Other
state-loss findings must be investigated rather than covered by that exception.

### F4 — Optional owner-led retirement

The flag owner decides whether to retain the default-on switch, repair and
qualify eager execution, or retire the switch with a separately reviewed
rollback route. The prepared retirement proposal supplies implementation and
evidence for that decision; this arc does not drive its approval or merge. Any
retirement change still needs applicable tests, CI, antagonistic review, and
Cubic review. Live deployment remains separately coordinated.

### F5 — Measure and close

- [x] Repeat the handler and collection count matrix on a pinned default-on
      revision; all 18 handler cases and nine collection cases matched the
      earlier default-on baseline's count fields. Record graph size and the
      inconclusive cold-heap probe separately from timing.
- [x] Repeat headless fixtures and mounted browser measurements at three sizes
      and both browser profile locations, with accounting disabled for timing.
      Preserve their different demand boundaries instead of treating headless
      render/rematerialization windows as equivalent to mounted browser updates.
- [x] Publish the evidence and its remaining limits, clarify benchmark reporting
      guidance, and archive this plan under the documentation lifecycle.

The
[closeout record](../development/performance/2026-09-19-lazy-fast-follow-closeout.md)
links the browser, fresh-store, handler-timing, and final count records. Timings
varied even with matching reactive read counts; no general speedup, allocation,
or retention improvement was qualified. Comparative latency and warmed-memory
measurements remain prerequisites to those claims, not claims made by completing
this evidence collection. No live-space update was performed.

## Out of scope

Sync-selector narrowing and network transfer reduction remain with
[shaped reads and verb results](../../plans/shaped-reads-and-verb-results.md).
This plan does not infer production latency from local-copy timings, change
unrelated event semantics, or authorize writes to the live lunch poll.
