# Reactive action read accounting

`runtime.scheduler.setReadStatsEnabled(true)` enables counters for
subsequent reactive action bodies, including builtins and scheduler effects. It
defaults off. A run retains the setting it started with, even if the setting
changes while an asynchronous body is suspended.

`cf test --verbose --stats-threshold 0` enables accounting and prints every
step's measured work, with a separate initialization report. Rows are sorted by
proxy accesses. Authored rows name the verified source location; builtins and
host actions use their module name or action ID. `--stats-action-limit` limits
displayed rows without truncating totals. The usual stats threshold controls
which step reports print; initialization always prints in verbose mode.

## Counter contract

| Counter             | Definition                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `proxyAccesses`     | Property or element value requests through schema-backed or query-result views, including repeats, missing properties, array length, and descriptor values. Array iteration and methods count the elements they materialize even when they bypass a JavaScript proxy trap.     |
| `linkResolutions` | Stored-link traversal attempts on cache misses, including eager handle conversion and repeated fast-path/fallback reads. Missing-target reads count; a cycle rejected before a target read contributes no attempt. Memoized replay contributes no attempts. |
| `distinctDocuments` | Distinct replica document objects selected by storage reads. Repeated paths in one replica document contribute one document; separate scope replicas can contribute separately. Machinery reads and reads ignored for scheduling count. Inline data URI values that produce no read activity do not.       |
| `registeredDependencies`      | Recursive and shallow scheduling read paths at body completion, compacted separately with the scheduler's own compaction rules. Ignored scheduling reads do not count. This is the body's dependency footprint, not the eventual union of all served instances' subscriptions. |

Property reads performed by runtime helpers count as well as reads directly
written in the pattern. Fetching a method or symbol, and enumerating keys
without requesting descriptor values, contributes no proxy access. A method that
materializes an entire array counts that materialization even if its callback
stops early. Plain eager values produce no proxy accesses; the work to
materialize them remains visible through link and document counts.

The counters intentionally differ. A repeated property read can add an access
while adding neither a link hop nor a document. A single property can cross
several links. Dependency compaction can turn many reads into one subscription
path.

## Execution boundary

Body accounting starts immediately before invoking the scheduler action and ends when
its body resolves or throws, at the same boundary as its execution-time sample.
It covers argument materialization and result construction performed by that
invocation. Failed and retried runs each contribute their work.

Accounting belongs to the underlying storage transaction. Read-only and
nonreactive wrappers share its counters; unrelated transactions and other
runtimes do not. Asynchronous code retains its transaction's ownership.

`ActionStats.reads` and `scheduler.run.complete` describe this body boundary.
Commit preparation, commit processing, event-handler dispatch, and diagnostic
idempotency reruns are outside their samples.

Pattern-test budgets also collect the separate `scheduler.read-attempt` stream.
Its transaction samples extend through commit or abort and include event
preflight, handler presync and dispatch, initialization, and asynchronous
writeback attempts. Each retry contributes its own attempt. The
[pattern-test budget contract](#pattern-test-budgets) defines the covered paths
and settlement boundaries; diagnostic idempotency reruns remain excluded.

Read sites check `readStatsActive` before looking up a transaction's collector.
Disabled accounting allocates no collector or document set. Enabled runs retain
two integer counters and a set of replica document objects; completion derives
dependencies from the existing reactivity log. Probes never write read metadata
or add subscriptions. Measure instrumentation overhead on the workload before
making timing claims.

## Results and aggregation

`ActionStats.reads` contains cumulative counts over measured runs, and
`ActionStats.lastRunReads` contains the latest run's sample. An unmeasured run
increments the ordinary run count and clears the latest sample while retaining
the cumulative counts. Document and dependency totals sum per-run cardinalities;
they are not unions across runs. CLI output labels them as per-run sums.

Each `scheduler.run.complete` telemetry marker carries the run's measurements
when enabled. The CLI aggregates these events, so actions removed from the graph
or evicted from the bounded statistics map still contribute to the step's
report. It adds each run once rather than combining parent-inclusive totals with
their children's totals.

The implementation is in `runtime/runner/src/read-stats.ts`, the scheduler
completion path, and `runtime/cli/lib/action-read-report.ts`.

## Pattern-test budgets

A single-user test module can export `readBudgets` with `initialization` and
`steps` objects. Each accepts optional `total` and `perRun` nonnegative safe
integer limits on proxy accesses. Equality passes, zero is valid, and omitted
limits impose no constraint. An executable test step's `readBudget` object
replaces its default step limits completely; an empty override clears them.
Step overrides require the module export, including an empty export object.
Invalid declarations fail explicitly. Multi-user module budgets are rejected.

`perRun` limits the largest completed reactive-body sample. `total` sums separate
`scheduler.read-attempt` markers after full runtime settlement. It never adds
body samples to attempt totals. Budget failures include the interval, actual
count, limit, and largest contributors, and fail the test even when functional
assertions pass. Verbose output reports each budgeted interval's total and body
maximum. Budget declarations do not demand UI; use render steps or continuous
UI demand to measure rendering work.

Attempt accounting is enabled with
`runtime.scheduler.setReadStatsEnabled(true, { attempts: true })`. It
covers reactive transactions through settlement, event dependency preflights,
handler input presync materialization, event handlers, the harness's
pattern-instantiation transaction, and each
`runtime.editWithRetry` attempt, including asynchronous builtin writebacks.
Commit and abort callbacks emit each attempt once. Aborting inside a reactive
body preserves its per-run sample. Probes stop at settlement; diagnostic
idempotency reruns remain excluded.

Attempt markers retain proxy-access and link-hop counts, independently of the
transaction read logs that commit can clear. Document cardinality and dependency
diagnostics remain body-only; no full-attempt document count is claimed.

Initialization excludes compilation and default environment setup, and includes
pattern instantiation, initial settlement, and continuous UI mounting when
enabled. Steps settle scheduler, storage, pending commits, and asynchronous
builtin work with uncapped `runtime.settled(Infinity)` before evaluating limits.
A settlement failure ends budget measurement and preserves the original error;
the harness does not restart settlement over already-failed work.
Skipped steps omit their operation and budget enforcement but still validate
their declarations and report any measured work in verbose mode. Unbudgeted tests retain their existing
settlement behavior. These totals cover the named local transaction paths;
unrelated transactions, standalone harness reads, storage-server work, and
network traffic are outside the measure. Plain eager values and primitive Cell
reads are not proxy accesses. A zero count does not mean zero CPU work or zero
storage reads.

## Compiler hints for nested scans

The non-fatal `collection:nested-scan` warning identifies an inline reactive
array callback that scans another captured reactive collection. For example,
filtering the same captured entries separately for each group can make work
grow with both collection sizes. The warning asks for a measurement of the
demanded output; it does not assert that every update performs that work.

The check covers `map`, `filter`, `flatMap`, `count`, `minBy`, and `maxBy` with
inline callbacks and receivers that resolve to captured root bindings. Plain
local arrays, each row's own child arrays, callback-local derived lists,
sequential scans, and unrelated function scopes are excluded. It does not trace
arbitrary helper calls, complex receivers, or other loop forms. Absence of this
warning is not a complexity guarantee.

Move shared work outside the callback when possible. A
[named aggregate](collection-aggregates.md) can fit some workloads; check its
cardinality, numeric, ordering, and update contract before changing the pattern.
Use the counters and budgets above to validate the resulting behavior.
