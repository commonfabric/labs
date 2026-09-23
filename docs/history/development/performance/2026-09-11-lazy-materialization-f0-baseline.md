---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "F0 baseline of the lazy-materialization fast-follow: entry-point inventory, flag posture, and the per-phase cost of one handler dispatch at three list sizes."
---

# Lazy materialization fast-follow: F0 baseline

This is the F0 record for the [lazy materialization
fast-follow](../../plans/lazy-materialization-fast-follow.md). It pins the
runtime revision the later stages compare against, lists every place the
`lazyMaterialization` flag and the transaction mark are consumed, names the
reads on the handler path that stay eager, and measures what one dispatched
handler event costs, phase by phase, over lists of 74, 296, and 1,184 rows. It
changes no runtime behavior. The one source change it carries is a phase timer
around the handler presync, so that the presync can be read back beside the
dispatch's other phases.

## Revision and posture

| Item                     | Value                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime revision         | `a44d9389c3783768cb2b3ad194751a9964dc7027`                                                                                                                                                                                                                                                                                      |
| Deno                     | 2.9.4 (aarch64-apple-darwin), Apple M5                                                                                                                                                                                                                                                                                          |
| Flag default             | `lazyMaterialization` resolves an unset value to `true` in `Runtime`'s constructor ([`runtime.ts`](../../../../packages/runner/src/runtime.ts))                                                                                                                                                                                 |
| Environment              | `EXPERIMENTAL_LAZY_MATERIALIZATION`, through `EXPERIMENTAL_ENV_VARS` in [`runtime-presets.ts`](../../../../packages/runner/src/runtime-presets.ts)                                                                                                                                                                              |
| Server and CLI processes | Toolshed and the background piece service read the variable through `experimentalOptionsFromEnv`, as do `cf check` and the pattern test runners; unset means on                                                                                                                                                                 |
| Browser shell            | Has no build-time define for this flag ([`shell/src/lib/env.ts`](../../../../packages/shell/src/lib/env.ts) declares five others), so it runs the `Runtime` default and cannot be rolled back through the environment                                                                                                           |
| Deployed clients         | `experimentalOptionsForDeployedClient`, which `cf` and the other deployed hosts call, resolves the flag by `adoptServerExperimentalOptions`: an explicit environment value wins; otherwise the posture the server publishes, when `CF_ADOPT_SERVER_FLAGS` is not `false` and the server answers; otherwise the built-in default |
| Lift arguments           | Marked lazy when the flag is on; the mark is cleared before the result is written                                                                                                                                                                                                                                               |
| Handler arguments        | Never marked; eager in both flag postures                                                                                                                                                                                                                                                                                       |

The registry entry in [Experimental
options](../../../development/EXPERIMENTAL_OPTIONS.md#lazymaterialization) names
the owner and the removal condition.

## Where the flag and the mark are consumed

The non-test sites that read the flag, the transaction mark, or the refusal
at the pinned revision, found by searching for their names:

- **The flag.** `runtime.ts` declares and defaults it; `runtime-presets.ts` maps
  the environment variable and assigns server authority; `runner.ts` reads it
  once, at the lift path's argument read, to decide whether to mark the
  transaction.
- **The mark.** `markLazyMaterialize` and `isLazyMaterialize` on
  `IExtendedStorageTransaction`
  ([`storage/interface.ts`](../../../../packages/runner/src/storage/interface.ts)),
  implemented on the transaction and on `TransactionWrapper` in
  [`extended-storage-transaction.ts`](../../../../packages/runner/src/storage/extended-storage-transaction.ts),
  with the per-layer set in
  [`reactivity-log.ts`](../../../../packages/runner/src/storage/reactivity-log.ts).
  `validateAndTransform` in
  [`schema.ts`](../../../../packages/runner/src/schema.ts) branches to the view
  on a marked transaction and keeps a marked transaction rather than swapping a
  finished one for a fresh read; `createQueryResultProxy` in
  [`query-result-proxy.ts`](../../../../packages/runner/src/query-result-proxy.ts)
  pins a schema-less proxy to its transaction when marked.
- **The refusal.** `noteSchemaRefusal` and `takeSchemaRefusal` on the same
  interface, recorded by the view in
  [`schema-view.ts`](../../../../packages/runner/src/schema-view.ts), by the
  unresolved-input arm in `schema.ts`, and by the collection index key builtin
  in
  [`builtins/collection-index-key.ts`](../../../../packages/runner/src/builtins/collection-index-key.ts).
  `clearSchemaRefusal`, on the same interface, is how the view withdraws a
  refusal it catches itself, so that only the refusals a reader saw stay
  recorded. The lift path's post-run in `runner.ts` is the one site that takes a
  recorded refusal to dispose of the run.

The tests nearest the handler question are listed under [What the existing tests
prove](#what-the-existing-tests-prove); the other files under `packages/` that
name the flag or the mark are the read-accounting tests and benchmarks
(`read-stats.test.ts`, `read-stats.bench.ts`, `collection-loop-read-counts.ts`,
`link-scan-dereference.bench.ts`), the scalar read width benchmark
`cell-schema-read-width.bench.ts`, and
`collection-index-initialization.test.ts`, which sets the flag on explicitly.
Outside `packages/`, the benchmark script `scripts/collection-index-cost.ts`
sets it on the same way.

## Entry points and eager reads

### The lift path

`#instantiateJavaScriptActionNode` in
[`runner.ts`](../../../../packages/runner/src/runner.ts) marks the action's
transaction when the flag is on, reads the argument with the transaction bound
to the schema, runs the body, and in its post-run clears the mark and takes any
recorded refusal before normalizing and writing the result. A refusal thrown out
of the body, or rejected out of an async body, is routed to the same post-run
with an undefined result — with one gap at the pinned revision. `postRun` is
assigned only after the synchronous invocation returns, so a refusal raised
synchronously anywhere between the start of the `try` and that assignment, the
argument read included, reaches the catch while `postRun` is still unassigned,
and the catch's `postRun?.(undefined)` does nothing: the mark stays set, the
refusal stays recorded, and no result is written, leaving the previous result
standing. By the time an asynchronous body rejects, the assignment has run, so
that path does dispose. A separate change, on the branch
`codex/lift-refusal-disposition`, carries the fix, which assigns `postRun`
before the body is invoked, with a test that fails at the pinned revision. That
closes the body-invocation half of the window; the argument read precedes the
assignment on that branch too, so a refusal raised there keeps the disposition
described here. The pattern vintage replay gate on that branch shows the fix
clearing a persisted derived value the defect had preserved, so it waits on that
gate's owner. Result writing and diffing in `#writeJavaScriptActionResult` run
unmarked, so they read eagerly.

### The handler path

`#instantiateJavaScriptHandlerNode` in the same file never marks its
transaction. In dispatch order, the reads it and the scheduler take are:

1. **Dependency preflight**, in
   [`preflightQueuedEventDependencies`](../../../../packages/runner/src/scheduler/events.ts).
   The handler's `populateDependencies` reads the writable inputs the argument
   binding declares, or the node's declared reads when it names none, through
   `#populateDeclaredSchedulerReads`, which calls `.get()` on each one with the
   input's own schema, and reads the event payload through
   `#populateHandlerEventSchedulerReads` with `traverseCells: true`. A handler
   with no declared reads falls back to reading the whole argument with
   `traverseCells: true`. All of it is eager, on a read-only transaction of its
   own, and its purpose is to find invalid upstream computations and in-flight
   loads the handler would read through. The measurement below shows this pass
   running twice per dispatch.
2. **Presync**, in `dispatchQueuedEvent` (same file), through the handler's
   `presyncInputs`: an eager read of the whole argument under its schema on a
   second read-only transaction, walked to depth sixteen to collect the `Cell`s
   it finds so their documents can be synced before the body runs. A property
   whose access throws is skipped, and a cell below the depth cap is not
   collected.
3. **The closed-world event gate**, `closedWorldEventRejection` in `runner.ts`:
   judges the raw event payload against a closed event schema without reading
   through a cell. It runs before the argument read.
4. **The argument read**, `#readJavaScriptArgument`: one eager `.get()` of the
   immutable inputs cell under the generated handler schema, whose root requires
   `$ctx` and leaves `$event` optional. An `undefined` result sets
   `dispatchedHandlerNotRun`, which the scheduler's finalize withdraws and
   re-runs rather than sealing.
5. **The body**, `#invokeJavaScriptImplementation`, which splits the argument
   into `$event` and `$ctx`. Everything the body reads through a handle is an
   ordinary eager `.get()`.
6. **Post-run**, `#handleJavaScriptHandlerResult`: writes the receipt cell when
   commit preconditions are on, the built-in default, and server execution is
   off, or for a served dispatch under server execution, a `set` that reads the
   cell to diff, and for a reactive result instantiates and runs a result
   pattern through the normal eager path. Its two raw reads of the receipt are
   conditional: one under server execution, one on the redelivery fast path for
   a reactive result.
7. **Trusted-write collection**, `trustedEventWriteCandidatesFromTransaction` in
   [`scheduler/reactivity.ts`](../../../../packages/runner/src/scheduler/reactivity.ts),
   after the body returns: reads the transaction's write log, not cells.
8. **Commit**, on the dispatch transaction, with the read log as its read set.

Reads 1, 2, and 4, and the post-run's write and reads in 6, are the eager
materializations the dispatch takes whatever the body reads; what the body reads
in 5 is eager too. The handler's post-run does not consult `takeSchemaRefusal`,
so a refusal recorded on a handler transaction goes unread. One site records a
refusal without consulting the mark: `resolveCollectionKey` in
[`builtins/collection-index-key.ts`](../../../../packages/runner/src/builtins/collection-index-key.ts)
notes one whenever a cell key resolves through a document the replica does not
hold. A handler reaching it through a collection index lookup, and catching the
throw, commits whatever it wrote before.

### Eager reads that unmarked callers still require

These stay whatever F2 and F4 decide:

- The dependency preflight and the presync above. Both exist to walk what
  the handler might reach before it runs, so a view that materializes on
  touch cannot serve them.
- Result writing and diffing on both paths, which compare whole values.
- Every read the scheduler takes on its own transactions.
- The standing-handle reading of the schema-less proxy, which long-lived
  consumers rely on and which only an unmarked transaction provides.

## What the existing tests prove

Three files stand nearest the handler question, and only two exercise a
dispatched handler:

- [`lazy-materialization-runner.test.ts`](../../../../packages/runner/test/lazy-materialization-runner.test.ts)
  marks a transaction by hand and reads a cell through it. It covers the view
  and the refusal on a marked read. It instantiates no lift and dispatches no
  handler, so it is not evidence about either runner path.
- [`stream-handler-unresolved-argument.test.ts`](../../../../packages/runner/test/stream-handler-unresolved-argument.test.ts)
  dispatches to a compiled handler whose argument does not resolve, and pins the
  withdraw-and-re-run disposition with the flag on its default.
- [`scheduler-event-handler-not-run.test.ts`](../../../../packages/runner/test/scheduler-event-handler-not-run.test.ts)
  pins the scheduler's handling of `dispatchedHandlerNotRun` for client
  dispatches: re-run, park on loads, backoff limit, one-shot, and the
  events-down echo.

The lift path's flag-sensitive behavior is pinned by
[`patterns-lift.test.ts`](../../../../packages/runner/test/patterns-lift.test.ts)
(a forwarding lift runs once under the view and twice eager) and the view itself
by `schema-view.test.ts`, `lazy-view-epoch.bench.ts`,
`query-result-proxy-transaction-lifetime.test.ts`,
`link-resolution-memo.test.ts`, `read-accounting.test.ts`,
`unknown-reference-materialization.test.ts`, and
`extended-storage-transaction.test.ts`. The toolshed's `runtime-options.test.ts`
and `routes/meta/meta.test.ts` and the runner's `experimental-options.test.ts`
pin how the flag is read and published.

## Measurement

### Method

[`handler-dispatch-cost.bench.ts`](../../../../packages/runner/test/handler-dispatch-cost.bench.ts)
compiles one pattern with six handlers over a `votes` list and an `out` counter,
seeds the list with 74, 296, or 1,184 inline rows of the same shape the [scalar
read width baseline](2026-09-11-lazy-scalar-read-width.md) used, and sends one
event per sample through the scheduler. The timed interval runs from the send to
the commit callback; the drains that wait for whatever the dispatch left running
come after it. Around each sample it snapshots the accumulated time of each
phase timer the runtime keeps, so a phase's figure is what it added during that
dispatch, however many times it ran, and a phase that did not run adds nothing;
the whole and the parts come from the same dispatch, and the counter is checked
against the expected value. The one workload that writes has its list re-seeded
before each sample after the first, outside the timed interval, so every sample
dispatches over a list of the stated size. The phase timers are kept once per
process, with one active start per key, so the benchmark runs its runtimes one
at a time. The runtimes take the flag's built-in default, on; no handler
argument is marked, so the posture does not reach the measured phases.

| Workload      | Bound context      | Body                                                                 |
| ------------- | ------------------ | -------------------------------------------------------------------- |
| `scalarKey`   | `Writable<Vote[]>` | Reads one element by key, as the lunch poll reaches one vote         |
| `scalarGet`   | `Writable<Vote[]>` | Reads the whole list and takes one element                           |
| `walk`        | `Writable<Vote[]>` | Reads the whole list and sums every row                              |
| `mutate`      | `Writable<Vote[]>` | Writes one element by key and pushes one row                         |
| `plainScalar` | `Vote[]`           | The argument read materializes every row; the body takes one element |
| `plainWalk`   | `Vote[]`           | The argument read materializes every row; the body sums them         |

Read counts, preflight telemetry, scheduler node counts, and a retained-heap
probe are collected in a separate pass with accounting on, before any timed
sample runs, on a fresh runtime per variant so no workload's write reaches
another's counts. That pass runs only when `HANDLER_DISPATCH_COUNTS=1` is set,
which the scheduled benchmark workflow does not; the timed samples run with
accounting off, and the ones recorded below ran after the counts pass in the
same process.

From the repository root:

```sh
HANDLER_DISPATCH_COUNTS=1 deno bench -A --v8-flags=--expose-gc packages/runner/test/handler-dispatch-cost.bench.ts
```

Each variant requested seven samples after one warmup; `deno bench` ran nine
invocations per variant, one more than requested, and the values below are the
median of the eight after the first. The storage manager is the in-memory
emulation, so commit cost is local and no network is represented. No linked rows
and no cross-space context are represented; the representative-copy limitations
recorded in the [lunch-poll
rehearsal](2026-09-12-representative-lunch-poll-rehearsal.md) carry forward
unchanged, and the live poll was not touched.

### Timing, in milliseconds per dispatch

`Populate` is the dependency-population step of the preflight, summed over the
two passes every sample ran (the timer's sample count between the snapshots was
two in every timed sample), and `Steps` the sum of the preflight's four other
timed steps (converting the transaction to a log, the dependency commit,
collecting invalid upstream nodes, scheduling them) over the same passes.
`Handler` is the scheduler's timer around the handler action, which spans
`ArgRead`, `Body`, and `PostRun`, then the trusted-write collection after the
body and the commit's preparation and synchronous steps; `Commit` sums the
transaction's three commit timers, which run inside that span. `Commit` is
recorded by a process-wide logger rather than per transaction, so its figure is
every commit in the sample window. The preflight's two commits are read-only,
and a commit with no write space returns before the three commit timers start,
so the column is the dispatch transaction's own commit plus any other commit
that landed in the window. `Rest` is what the timers this record reads do not
attribute: the elapsed time less the presync, the two preflight columns, and the
handler action. The phase snapshots bracket the dispatch from before the send to
the continuation after its commit callback; the handler action and the commit's
synchronous steps end before the callback fires, so the phase figures fall
inside the elapsed interval.

| Rows  | Workload      | Elapsed | Presync | Populate | Steps | ArgRead | Body  | PostRun | Handler | Commit | Rest  |
| ----- | ------------- | ------- | ------- | -------- | ----- | ------- | ----- | ------- | ------- | ------ | ----- |
| 74    | `scalarKey`   | 11.2    | 0.26    | 3.43     | 0.74  | 0.08    | 0.11  | 0.11    | 0.63    | 0.12   | 6.2   |
| 74    | `scalarGet`   | 15.5    | 0.31    | 3.85     | 0.68  | 0.08    | 0.74  | 0.16    | 2.07    | 0.64   | 8.6   |
| 74    | `walk`        | 21.7    | 0.27    | 3.65     | 0.62  | 0.08    | 1.27  | 0.16    | 3.41    | 1.02   | 13.7  |
| 74    | `mutate`      | 12.1    | 0.25    | 3.16     | 0.57  | 0.07    | 0.53  | 0.10    | 1.15    | 0.21   | 6.9   |
| 74    | `plainScalar` | 13.5    | 0.74    | 3.01     | 0.52  | 0.50    | 0.06  | 0.12    | 1.51    | 0.46   | 7.7   |
| 74    | `plainWalk`   | 19.2    | 1.18    | 2.95     | 0.49  | 0.93    | 0.05  | 0.12    | 2.49    | 0.79   | 12.1  |
| 296   | `scalarKey`   | 17.8    | 0.21    | 8.53     | 1.89  | 0.06    | 0.09  | 0.10    | 0.51    | 0.12   | 6.6   |
| 296   | `scalarGet`   | 25.7    | 0.22    | 8.79     | 1.22  | 0.05    | 1.74  | 0.10    | 3.99    | 1.43   | 11.5  |
| 296   | `walk`        | 47.0    | 0.26    | 9.91     | 1.31  | 0.06    | 4.01  | 0.17    | 9.00    | 2.96   | 26.5  |
| 296   | `mutate`      | 26.8    | 0.33    | 12.04    | 1.66  | 0.06    | 0.77  | 0.10    | 1.43    | 0.24   | 11.3  |
| 296   | `plainScalar` | 32.5    | 2.27    | 9.30     | 2.42  | 1.71    | 0.06  | 0.14    | 4.06    | 1.36   | 14.5  |
| 296   | `plainWalk`   | 62.5    | 6.45    | 11.57    | 1.92  | 5.18    | 0.09  | 0.20    | 10.53   | 3.26   | 32.0  |
| 1,184 | `scalarKey`   | 58.8    | 0.41    | 39.80    | 6.22  | 0.07    | 0.12  | 0.12    | 0.62    | 0.13   | 11.7  |
| 1,184 | `scalarGet`   | 86.6    | 0.31    | 35.72    | 5.41  | 0.06    | 7.85  | 0.16    | 14.15   | 4.97   | 31.0  |
| 1,184 | `walk`        | 212.3   | 0.48    | 43.26    | 7.64  | 0.08    | 20.83 | 0.23    | 39.57   | 11.99  | 121.3 |
| 1,184 | `mutate`      | 94.7    | 0.49    | 46.08    | 6.34  | 0.07    | 2.16  | 0.12    | 3.08    | 0.41   | 38.8  |
| 1,184 | `plainScalar` | 145.1   | 11.20   | 51.23    | 5.91  | 9.85    | 0.09  | 0.21    | 19.47   | 6.09   | 57.3  |
| 1,184 | `plainWalk`   | 243.0   | 21.03   | 46.00    | 6.61  | 20.05   | 0.10  | 0.22    | 40.86   | 12.18  | 128.4 |

Nine earlier runs of this benchmark on the same revision, some with a wider
timed interval, some reading each timer's last sample rather than its
accumulated time, and some while a review or a test suite shared the machine,
put `scalarKey` at 1,184 rows between 56 and 99 ms elapsed and `walk` between
161 and 380 ms. The runs agree on the ordering of the workloads and on which
phases carry the time; the absolute figures move by up to a factor of two and a
half between runs on this machine, most of that in the runs taken under shared
load, and are observations, not thresholds.

`Rest` grows with the list on the whole-list workloads: at 1,184 rows it is 12
ms for `scalarKey`, 31 for `scalarGet`, 121 for `walk`, and 128 for `plainWalk`.
It is the time outside every timer this record reads: the scheduler's ticks
between the phases, the presync transaction's setup, the commit's asynchronous
remainder after its synchronous steps, the callback's delivery, and anything
else the scheduler runs inside the window. That it grows with the read set the
commit carries makes the commit's asynchronous part the likely holder, but this
record does not attribute it. The scheduler's `execute/event` timer, which this
record does not read, spans the preflight and the dispatch through the commit's
synchronous steps, so reading it beside the elapsed time would split the
remainder at the commit boundary; a timer around the commit promise is what
would attribute the rest. Both are leads for F5's remeasurement.

### Counts, from one dispatch with accounting on

Link resolutions are the `scheduler.read-attempt` counter per attempt kind.
The preflight links column lists both passes; the preflight reads column is
the last pass's telemetry. Proxy accesses were zero in every
attempt of these workloads, whose handlers declare an argument schema and so
read eagerly; a handler without one reads its argument through the
schema-less query-result proxy and would count accesses.

| Rows  | Workload      | Preflight links | Presync links | Event links | Preflight reads / shallow | First pass skipped |
| ----- | ------------- | --------------- | ------------- | ----------- | ------------------------- | ------------------ |
| 74    | `scalarKey`   | 78, 78          | 6             | 7           | 101 / 818                 | yes                |
| 74    | `scalarGet`   | 78, 78          | 6             | 80          | 101 / 818                 | yes                |
| 74    | `walk`        | 78, 78          | 6             | 80          | 101 / 818                 | yes                |
| 74    | `mutate`      | 78, 78          | 6             | 10          | 101 / 818                 | yes                |
| 74    | `plainScalar` | 78, 78          | 80            | 80          | 101 / 818                 | yes                |
| 74    | `plainWalk`   | 78, 78          | 80            | 80          | 101 / 818                 | yes                |
| 296   | `scalarKey`   | 300, 300        | 6             | 7           | 323 / 3,260               | yes                |
| 296   | `scalarGet`   | 300, 300        | 6             | 302         | 323 / 3,260               | yes                |
| 296   | `walk`        | 300, 300        | 6             | 302         | 323 / 3,260               | yes                |
| 296   | `mutate`      | 300, 300        | 6             | 10          | 323 / 3,260               | yes                |
| 296   | `plainScalar` | 300, 300        | 302           | 302         | 323 / 3,260               | yes                |
| 296   | `plainWalk`   | 300, 300        | 302           | 302         | 323 / 3,260               | yes                |
| 1,184 | `scalarKey`   | 1,188, 1,188    | 6             | 7           | 1,211 / 13,028            | yes                |
| 1,184 | `scalarGet`   | 1,188, 1,188    | 6             | 1,190       | 1,211 / 13,028            | yes                |
| 1,184 | `walk`        | 1,188, 1,188    | 6             | 1,190       | 1,211 / 13,028            | yes                |
| 1,184 | `mutate`      | 1,188, 1,188    | 6             | 10          | 1,211 / 13,028            | yes                |
| 1,184 | `plainScalar` | 1,188, 1,188    | 1,190         | 1,190       | 1,211 / 13,028            | yes                |
| 1,184 | `plainWalk`   | 1,188, 1,188    | 1,190         | 1,190       | 1,211 / 13,028            | yes                |

The scheduler held one node before and after every dispatch: a handler with a
plain result adds nothing to the graph. The retained-heap probe, a full
collection before and after the one dispatch on each variant's fresh runtime,
gave deltas from 1.9 MB below zero to 0.1 MB above it with no relation to the
workload: a heap that shrinks across a dispatch is collecting the runtime's
own setup garbage, not measuring what the dispatch retained. This record makes
no retention claim; a retention measurement needs a runtime warmed past its
setup and more samples than this pass takes.

## Findings

1. **The dependency preflight is the largest fixed cost of a handler dispatch,
   and it does not depend on what the handler reads.** At 1,184 rows it resolves
   one link per row, twice, whatever the workload, and its two populate steps
   take 36 to 51 ms of every dispatch. For the handle-context workloads that
   read little, that is most of what the timers attribute: 40 of the 47 ms they
   attribute of `scalarKey`'s 59 elapsed. For `walk` and `plainWalk`, which sum
   every row, the handler action is comparable, and a share of the elapsed time
   remains unattributed by any timer (the `Rest` column). The first preflight
   pass is reported skipped and the second runs; both walk the full list. Which
   condition skips the first pass was not established here and is a lead for the
   scheduler's owner.
2. **The argument read is negligible for a handle context and linear for a plain
   one.** With `Writable<Vote[]>` the read mints a handle in under a quarter of
   a millisecond at every size. With `Vote[]` it materializes every row: 1.7 to
   5.2 ms at 296 rows and 10 to 20 ms at 1,184. The two plain workloads read the
   same list, and this measurement does not establish what separates their
   figures; the workloads run in a fixed order and a variant's runtime lives
   across its own samples, so position and retention within a variant are not
   ruled out. The presync pays about the same as the argument read. The lunch
   poll's handlers bind their collections as handles; the plain values they bind
   are scalars such as a name or a clock tick.
3. **A whole-list read inside the body costs what a plain context's argument
   read costs, and the commit after it grows with the read set.** The body timer
   spans the whole body, so it cannot isolate the read: at 1,184 rows
   `scalarGet`'s body, a whole-list read and one element, is 7.9 ms, and
   `walk`'s, the same read and a sum over every row, is 20.8 ms. The commit
   after either is 5.0 and 12.0 ms against 0.13 ms after `scalarKey`'s keyed
   read; each of the three writes one scalar to the same cell, so the difference
   between the keyed read and either whole-list read is the read set the commit
   carries. `scalarGet` and `walk` carry the same read set, the counts table
   gives them the same event links, and their commits still differ by about a
   factor of two at every size; this measurement does not attribute that.
4. **A handler's read log is its commit conflict set.** The lunch poll's
   `addOption` and `removeOption` read the whole vote list on purpose so a
   concurrent cast conflicts with their commit. A view registers the paths the
   body touches and nothing else, so a lazy handler context would narrow that
   set on any handler that reads a list and touches part of it. This is a
   contract difference between the lift path, where a narrower read set only
   changes when a node re-runs, and the handler path, where it changes which
   concurrent writes a commit refuses. F1 has to decide it explicitly.
5. **Nothing on the handler path consumes a refusal.** Marking the handler
   transaction without adding the disposition would leave a caught refusal
   committing whatever the body wrote before it.

## What F1 takes from here

The measured lever on the handler path is not the argument read. Making the
argument read lazy would save under a millisecond for a handle context and 10 to
20 ms at 1,184 rows for a plain one, while the two preflight passes' populate
steps spend 36 to 51 ms on every dispatch regardless. A lazy body read of a
handle could save most of the 7.9 ms a whole-list `get()` and one element cost,
and the 5.0 ms commit that follows, when the body touches little of the list, at
the price of finding 4 above. Those are the two consequences F1's contract and
prototype have to weigh, with the same benchmark extended by a posture dimension
so the comparison holds inputs fixed.