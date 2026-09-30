# Debugging Settle Waves

Use this guide when the shell or a pattern feels busy after a change, reload,
or user interaction, especially when the page looks responsive but the worker
keeps running for much longer than expected.

The goal is to answer four questions quickly:

1. Is the expensive work on the main thread or in the worker?
2. Is the worker spending time on rendering, storage, traversal, or scheduler
   convergence?
3. Which interaction or write kicked off the fan-out wave?
4. What should be instrumented next if the existing logs are not enough?

A worked example with concrete measurements from one investigation is archived
in [settle-wave-2026-03-findings](../../history/development/debugging/settle-wave-2026-03-findings.md).
Console API details for every command used below live in
[console-commands](console-commands.md).

## When To Suspect a Settle Wave

Start here if you see any of the following:

- reload looks visually fine but the worker stays busy
- creating or editing content triggers long waves of background work
- `scheduler` or `traverse` counts jump rapidly after a single write
- UI updates land, but the runtime keeps settling for several more passes
- Chrome traces show long tasks on a dedicated worker thread instead of
  `CrRendererMain`

This guide is worker-first: in practice the most important work often happens
off the main thread. First rule out a true non-idempotent loop with
`await commonfabric.detectNonIdempotent()` — see
[non-idempotent-detection](non-idempotent-detection.md). If `busyTime` is high
but `nonIdempotent` and `cycles` are empty, you are looking at broad fan-out or
slow convergence: continue here.

The escalation order: trace (main thread or worker?) → logger baselines →
settle stats → trigger trace ("which write scheduled this?") → action-run
trace ("which actions actually ran?") → write stack trace ("which callsite
wrote the hot cell?") → focused debug loggers.

## Reproduction Workflow

Use a simple, repeatable shell flow and keep it fixed across runs:

1. Open a local space at `http://localhost:8000/<space-id>`.
2. Perform the interaction you care about (e.g. create a note), return to the
   starting view, and confirm the result persisted.
3. Repeat the same interaction several times in the **same space** — for
   scaling questions, fan-out grows with existing content, so a fresh space
   per run hides the problem. In the integration harness, prefer
   `SPACE_NAME=...` over a random space.

For integration-test FAILURES, start with the self-diagnosing failure
output (fill phase ledger, pending-IPC table, worker request ledger) before
reaching for traces — see
[Browser Integration Test Diagnostics](integration-test-diagnostics.md).

For a scripted browser reproduction instead of manual console work, the
default-app integration flow supports trace capture:

```sh
HEADLESS=true API_URL=http://localhost:8000 FRONTEND_URL=http://localhost:5173 \
CF_CAPTURE_TRIGGER_TRACE=1 \
deno test -A packages/patterns/integration/default-app.test.ts
```

Use `:5173` when you need the shell to serve the worktree's current code, and
keep `API_URL` pointed at Toolshed on `:8000`.

## Trace Workflow

Capture two Chrome performance traces when possible: one for a reload (does
startup or persisted hydration cause a wave?) and one around the interaction
(does a specific write or navigation fan out?). For large spaces, repeat the
same reload 3–5 times and compare medians; individual worker timings vary a
lot from run to run even when the shape is stable.

For each trace, compare total `RunTask` time on `CrRendererMain` versus the
dedicated worker, count worker tasks at or above `50 ms`, inspect large
`RunTask` slices for long microtask drains, and map the hottest worker bundle
locations back to source files.

Rough rule of thumb:

- If main-thread time dominates, start with rendering and DOM work.
- If worker `RunTask` time dominates, treat the trace as a scheduler/runtime
  problem first.
- If `worker-reconciler` is quiet but `scheduler/execute/settle` is large, the
  bottleneck is convergence before rendering.
- If `traverse` is high count but low average latency, it is often a symptom of
  broad fan-out rather than the sole root cause.

## Console Workflow

After the trace, keep the session live and inspect the worker through
`commonfabric.rt` in the page console.

### Baseline, Replay, Compare

```js
// Shown inside a pattern body.
await commonfabric.rt.getLoggerCounts()       // see what counters exist
await commonfabric.rt.resetLoggerBaselines()  // just before the interaction
// ... replay one interaction, let it settle ...
await commonfabric.rt.getLoggerCounts()       // inspect the deltas
```

The most useful worker timing groups to compare first:

- `scheduler/execute`, `scheduler/execute/settle`, `scheduler/execute/event`
- `scheduler/run`, `scheduler/run/action`, `scheduler/run/commit`
- `traverse`
- `storage.cache`
- `worker-reconciler`

How to interpret the deltas:

- Large `scheduler/execute/settle` with multiple `execute()` passes usually
  means repeated convergence work after the initial event.
- A large trigger-trace fan-out plus repeated `schedule-resubscribe` usually
  means a write is matching many existing subscriptions and rebuilding too
  much scheduling state.
- Large `schedule-run-start` relative to one user interaction means one write
  is fanning out into many action runs.
- High `storage.cache` volume matters only if its timing dominates too.
- Small `worker-reconciler` deltas mean the UI flush is downstream, not the
  primary bottleneck.

### Settle Stats

When logger timing is not enough, capture per-`execute()` settle-loop stats:

```js
// Shown inside a pattern body.
await commonfabric.rt.setSettleStatsEnabled(true)
// ... replay the interaction ...
await commonfabric.rt.getSettleStatsHistory()
```

Prefer `getSettleStatsHistory()` — `getSettleStats()` returns only the **last**
`execute()` call, so a trailing empty settle pass can overwrite the
interesting wave. See [console-commands](console-commands.md#worker-settle-stats)
for the payload shape and a live-polling snippet.

### Trigger Trace: Which Write Scheduled This Action?

Use trigger trace when the question is no longer "is there churn?" and becomes
"which exact write scheduled this action again?"

```js
// Shown inside a pattern body.
await commonfabric.rt.setTriggerTraceEnabled(false)  // reset the ring buffer
await commonfabric.rt.setTriggerTraceEnabled(true)
// ... replay the interaction, let it settle ...
await commonfabric.explainTriggerTrace({ rootOnly: true, limit: 8 })
```

`explainTriggerTrace` groups exact `space/entity/path` changes, counts direct
schedules and downstream effects, reads the changed cells back, and adds shape
hints such as `ui-result` and `index-state`. For raw entries and manual
grouping, see [console-commands](console-commands.md#worker-trigger-trace).

### Action-Run Trace: Which Actions Actually Ran?

Use exact action-run tracing when the question becomes "which actions really
ran?" rather than "which were merely scheduled?" — especially when trigger
trace is noisy because one root write schedules many sinks, or when comparing
run N against run N+1 in the same space.

```js
// Shown inside a pattern body.
await commonfabric.rt.setActionRunTraceEnabled(false)  // reset
await commonfabric.rt.setActionRunTraceEnabled(true)
// ... replay the interaction ...
await commonfabric.rt.idle()
const trace = await commonfabric.rt.getActionRunTrace()
```

Group entries by `actionId` and sort by count and total duration (grouping
snippet in [console-commands](console-commands.md#worker-action-run-trace)).
The first run in a space often includes navigation, mount, and
reader-materialization noise — compare later runs against each other.

### Write Stack Trace: Which Callsite Wrote the Hot Cell?

Once trigger trace has told you which cell is noisy, arm the transaction-level
write watcher to capture the exact write callsite:

```js
// Shown inside a pattern body.
await commonfabric.watchWrites({
  space: "did:key:z6Mkm...",
  id: "of:baedrei...",
  path: [],
  match: "exact",
  label: "watched hot cell",
})
// ... replay the interaction ...
const trace = await commonfabric.getWriteStackTrace()
```

Interpreting the captured stacks:

- `#setupInternal` / `#instantiatePatternNode` frames mean piece
  instantiation/setup writes — usually noise, not churn
- `diffAndUpdate`, `applyChangeSet`, or pattern handler frames point to runtime
  state updates after setup — usually the more interesting targets
- a generic `raw:async ...worker-runtime.js` frame is not evidence of one
  specific builtin; keep the next 1–3 frames underneath it to find the actual
  pattern or runtime helper

Disable with `await commonfabric.watchWrites([])`.

## Selective Debug Logging

Prefer the structured traces above. When you need log output, use the focused
loggers before raising the whole `scheduler` module:

- `runner.trigger-flow` — which source action id re-enters `Runner.run()`,
  `#setupInternal()`, `#instantiatePatternNode()`
- `runner.wish-flow` — is `wish()` launching suggestion patterns or just
  reading hot indexes?
- `scheduler` — settle-loop internals (broad — last resort)

```js
// Shown inside a pattern body.
await commonfabric.rt.setLoggerEnabled(true, "runner.trigger-flow")
await commonfabric.rt.setLoggerLevel("debug", "runner.trigger-flow")
```

In scheduler debug logs, the fan-out shape to look for is: one commit matching
dozens of registered actions; the same action ids recurring across trigger
entries; repeated `schedule-resubscribe` bursts after each run; alternating
change → trigger → run → commit → resubscribe waves. If you see that shape,
the problem is usually not one slow action body — it is the number of affected
actions and the number of times they are revisited.

## Broad Async Readers

Sometimes the hottest action is not the root cause, especially an async reader
over a broad index or collection. Signs: run count stays low but total time is
large or highly variable; one action spends its time in awaited `sync()` or
lookup work; downstream index/grid/summary actions are hot in the same wave.
When that happens, measure both run count and total time (do not optimize only
by count), check whether the hot action is loading a large result set, inspect
the producer side as well as the reader side (index builders that scan all
pieces, views that materialize many previews, broad root-state cells rewritten
wholesale), and compare small versus large spaces before blaming the action
body itself.

## Equivalence Checks

The scheduler maintains two structures incrementally rather than recomputing
them, and each one can fall out of step with the definition it implements. A
structure that has drifted does not report anything: the trigger index stops
waking a subscriber, or a node never becomes live, and the interface shows a
stale value. Each structure therefore has a switch that turns on an assertion
comparing it against that definition on every mutation, so drift throws at the
mutation that caused it.

The trigger index checks itself, under `ENV=test`, which the runner's own test
task sets. On every registration and removal it asserts that the path trie in
`packages/runner/src/scheduler/entity-triggers.ts` holds what the per-action
record beside it holds, under `arraysOverlap()`, and throws naming the write
path and the paths the two disagree on. Nothing needs turning on to get that,
and nothing turns it off: a lane that does not set `ENV=test`, which is every
lane outside the runner, `cf-harness`, `llm`, and `toolshed` suites, does not
carry the check. The profile scripts run through `deno run` and so measure
without it.

Liveness is checked on request rather than always. With
`SCHEDULER_LIVENESS_EQUIVALENCE=1`, every exit from the four liveness mutators
in `packages/runner/src/scheduler/dependency-graph.ts` asserts that the
incrementally maintained refcounts equal a full rebuild from the demand roots,
throwing with the mutation site and the drifted nodes. It is off by default
because it rebuilds the whole graph per mutation. Run the runner suite under it
after changing liveness maintenance, registration ordering, or edge derivation:

```bash
cd packages/runner && ENV=test SCHEDULER_LIVENESS_EQUIVALENCE=1 deno task test
```

## Source Paths Worth Checking First

Start with these locations when traces or logs point to worker churn:

- `packages/runner/src/scheduler/facade.ts` — execute orchestration, queueing,
  and the public diagnosis API; `packages/runner/src/scheduler/` holds the
  settle loop (`settle.ts`, `execution.ts`, `work-oracle.ts`), event dispatch
  (`events.ts`), action execution/resubscribe timing (`run.ts`), and trigger
  matching (`invalidation.ts`, `trigger-index.ts`, `entity-triggers.ts`,
  `scheduling-writes.ts`, `dependency-graph.ts`)
- `packages/runtime-client/src/backends/web-worker/index.ts` — worker message
  entrypoint — and `runtime-processor.ts` — console-facing scheduler IPC
- `packages/runner/src/storage/cache.ts` — socket event dispatch
- `packages/html/src/worker/reconciler.ts` — worker flush scheduling

## Next Steps

If the existing traces and logs still leave ambiguity, add or expose more
instrumentation rather than guessing. For what one full investigation
measured, concluded, and recommended next, see the archived
[March 2026 findings](../../history/development/debugging/settle-wave-2026-03-findings.md). The full
`commonfabric.*` API reference is in [console-commands](console-commands.md),
and [non-idempotent-detection](non-idempotent-detection.md) covers ruling out
true loops.
