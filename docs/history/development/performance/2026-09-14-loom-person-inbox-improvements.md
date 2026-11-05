---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Real-data measurements and local pattern/runtime improvement candidates, with incomplete follow-up experiments recorded separately."
---

# Loom person-inbox pattern and runtime improvements

## Result and decision

The conservative pattern change reduced median thread-open time **42%** on its
frozen Labs main baseline. The runtime change reduced that changed pattern's
median a further **17%**. Together the changes reduced the median from **3.66 s
to 1.75 s**, a **52%** improvement. The shipped pane's median on the same
runtime candidate was **0.20 s**: the changed lift pane remained **8.9 times
slower**. This evidence does not justify making the lift pane the default.

These are three interleaved repetitions per combination on a loaded machine, not
quiet-machine latency guarantees. All 18 completed runs used the same canonical
person, thread, 50 visible messages, content digest, and unchanged toolshed. The
full runner suite was concurrently active; its process status and load are
recorded for every run. Load averages ranged from 19.56 to 45.75.

The user authorized separate pattern and runtime improvement agents after taking
over the pattern. Both produced local commits and passing relevant tests. No
commit was pushed or merged, no vendor pin was adopted, and the default pane was
not changed. A further candidate that selects prepared bubble cells passed
pattern tests, but its comparative browser measurements remain incomplete.

## Upstream remeasurement

The preceding
[pin-versus-main report](2026-09-14-loom-person-inbox-thread-open.md) contains
five repetitions per pane/version, raw values, load records, and profiles. It
measured these thread-open medians:

| Browser                 |  Shipped | Original lift |
| ----------------------- | -------: | ------------: |
| Pinned Labs `be73306e5` | 162.6 ms |     4303.1 ms |
| Labs main `51f8c1105`   | 121.3 ms |     2545.3 ms |

The upstream bundle improved the lift median 41%, winning four of five paired
runs. It contains #7412, #7425, #7453, and other changes: this comparison cannot
attribute the improvement individually to #7412 or #7425. The profile shows the
consumed-source deduplication addressed by #7453 removing a large cost. The
upstream improvements helped but did not eliminate the thread-open blocker.

**Correction to the preceding report:** `openThreads` was consumed by
`bodyClassOf(open.length)`. Its full message reconstruction was unnecessary for
deciding whether the detail layout was open; it was not an unused computation.
The new pattern replaces that layout dependency with `openHead.isOpen`.

## Frozen candidates and method

| Component                     | Revision and scope                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Original panes                | Loom `5f00c7eff026a76e38a425999769ee2461981456`                                                      |
| Conservative pattern          | Loom `40129bb55ae24b7e5f0ae32c334b26a193436567`, branch `codex/person-inbox-lift-open`               |
| Pattern prerequisite          | `b391bf9f5`, preserves/formats the unmerged lift rewrite on Loom main `85f18fa27`                    |
| Browser baseline (`base`)     | Labs `16fb4be51bea37c7af34ef5b0f2efaa0ab72f971`                                                      |
| Browser candidate (`runtime`) | Labs `820bd94a9079633fbbbd27b42e7fc311238edb52`, branch `codex/inbox-label-perf`                     |
| Serving toolshed              | Labs `be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`, PID 83088, started September 14 at 15:22:33 Pacific |

The improvement experiment uses a later frozen main than the first report. Its
intervening runner change is #7403, concerning synchronous lift refusal output.
Comparing the two reports' absolute times would confound versions and load; the
improvement claims use only the 18-run comparison below.

The acceptance instance links the three real source stores read-only. Each
candidate was deployed as a separate local piece. All three daemon injection
links had to be present before measurement. The fixed person was selected by
canonical entity ID, confirmed through the resolver and the piece's `picked`
input. The thread key came from its source conversation ID. For this person the
source counts were Signal 50, WhatsApp 0, and personal Gmail 0, with one thread
row. This is not a many-thread or multi-store startup benchmark.

Each run opened a fresh Chromium context at 1200 × 900. It waited for the fixed
row and numeric source counts, verified zero visible bubbles, timestamped the
DOM click, then required one visible detail with the fixed thread key, one
visible `.pi-msgs`, and exactly 50 visible `.pi-bub` elements. Completion
included two animation frames. The identical content digest was asserted, so
hidden pre-rendered bubbles could not satisfy the shipped arm. All 18 runs
passed these gates and had zero page errors; console favicon CSP diagnostics
were retained.

Whole prebuilt browser trees were swapped between arms; served worker bytes were
verified. The toolshed process and backing store were unchanged. This measures
client execution with `experimental.serverExecution=false`, not a server
upgrade. `uptime` and the concurrent runner process status were captured before
and after every run. No CPU profile is included in the comparison medians.

## Completed comparison

All values are milliseconds, with three repetitions in their numbered order. The
changed lift is the conservative `40129bb55` source, called `header` in the
private harness and CSV.

| Browser | Pane          |  Rep 1 |  Rep 2 |  Rep 3 | Median |
| ------- | ------------- | -----: | -----: | -----: | -----: |
| base    | Original lift | 2198.6 | 3657.7 | 5388.6 | 3657.7 |
| base    | Changed lift  | 1146.5 | 2111.8 | 2182.4 | 2111.8 |
| base    | Shipped       |  106.8 |  169.0 |  145.9 |  145.9 |
| runtime | Original lift | 1679.5 | 3653.2 | 2537.8 | 2537.8 |
| runtime | Changed lift  |  949.0 | 1911.5 | 1754.5 | 1754.5 |
| runtime | Shipped       |  154.9 |  262.0 |  198.2 |  198.2 |

The pattern improvement wins all three corresponding repetitions on each
browser. The runtime candidate wins all three changed-lift repetitions and all
three original-lift repetitions, one of the latter almost tying. The shipped
control's median is higher on the runtime candidate. These noisy samples support
workload-specific gains, not a universal runtime speedup or a controlled shipped
regression claim.

### Run order and load beside each observation

All rows are September 14 Pacific, approximately 17:50–17:56. The accompanying
CSV preserves complete timestamps and `uptime` strings. The runtime agent's full
suite ran throughout this comparison; short generic-pattern correctness tests
also overlapped its final portion (00:52:59–00:55:45 UTC).

| Order | Browser | Pane          | Rep | Open ms | Load before (1/5/15 min) | Load after (1/5/15 min) |
| ----: | ------- | ------------- | --: | ------: | ------------------------ | ----------------------- |
|     1 | base    | Original lift |   1 |  2198.6 | 19.56 20.90 25.54        | 20.96 21.16 25.61       |
|     2 | base    | Changed lift  |   1 |  1146.5 | 20.96 21.16 25.61        | 27.02 22.43 26.01       |
|     3 | base    | Shipped       |   1 |   106.8 | 27.02 22.43 26.01        | 33.58 23.87 26.49       |
|     4 | runtime | Original lift |   1 |  1679.5 | 33.58 23.87 26.49        | 36.82 24.70 26.77       |
|     5 | runtime | Changed lift  |   1 |   949.0 | 36.82 24.70 26.77        | 41.31 26.06 27.23       |
|     6 | runtime | Shipped       |   1 |   154.9 | 41.31 26.06 27.23        | 43.93 26.86 27.50       |
|     7 | runtime | Shipped       |   2 |   262.0 | 43.93 26.86 27.50        | 45.54 27.47 27.72       |
|     8 | runtime | Changed lift  |   2 |  1911.5 | 44.61 27.58 27.75        | 45.75 28.38 28.04       |
|     9 | runtime | Original lift |   2 |  3653.2 | 45.75 28.38 28.04        | 42.92 28.61 28.12       |
|    10 | base    | Shipped       |   2 |   169.0 | 42.92 28.61 28.12        | 40.77 28.40 28.05       |
|    11 | base    | Changed lift  |   2 |  2111.8 | 40.77 28.40 28.05        | 34.67 27.65 27.79       |
|    12 | base    | Original lift |   2 |  3657.7 | 34.67 27.65 27.79        | 35.62 28.10 27.95       |
|    13 | base    | Changed lift  |   3 |  2182.4 | 35.62 28.10 27.95        | 30.82 27.41 27.70       |
|    14 | base    | Original lift |   3 |  5388.6 | 30.82 27.41 27.70        | 29.33 27.27 27.65       |
|    15 | base    | Shipped       |   3 |   145.9 | 29.33 27.27 27.65        | 28.66 27.16 27.61       |
|    16 | runtime | Changed lift  |   3 |  1754.5 | 28.66 27.16 27.61        | 26.00 26.66 27.42       |
|    17 | runtime | Original lift |   3 |  2537.8 | 26.00 26.66 27.42        | 27.08 26.84 27.48       |
|    18 | runtime | Shipped       |   3 |   198.2 | 27.08 26.84 27.48        | 26.24 26.67 27.40       |

### Startup limitation

Median mount plus selection time for the already-selected person was 8988.6 ms
for original/base, 9412.5 ms for changed/base, 5919.9 ms for shipped/base,
7903.4 ms for original/runtime, 9974.5 ms for changed/runtime, and 5888.3 ms for
shipped/runtime. This comparison does not show a startup improvement. It
measures loading a selected person, not the empty-picker boot reported in
earlier work.

## What the changes do

### Pattern: reduce message reconstruction and header reads

The conservative change removes layout-only message reconstruction, forwards
`threads[index].msgs` directly instead of rebuilding each message's fields, and
narrows the header lift to `key`, `title`, `accent`, and `serviceLabel`. The
header no longer requests full message bodies just to describe the open thread.

The pattern suite passed **245 assertions**. Coverage includes a 50-message
SQLite window, edits, arrivals and eviction, removal, switching and closing,
threads beyond the 40-thread cap, mobile layout, and invalid selection. The
corresponding baseline passed 242 assertions. Both test files are registered in
Loom's pattern task. Compiler checks verified the transformed schemas and all
six downstream message fields. Scoped formatting and lint passed, and review
found no actionable issue.

Loom's repository-wide checks remain red on existing issues: 2096 unformatted
files and 2945 lint issues, plus a missing vendored pattern-factory path. The
changed inbox files were absent from those diagnostics. Passing pattern tests
also emitted `storage.v2 sync-load-failure` / `memory client closed` during
teardown: runtime disposal closes the client to cancel pulls after test console
capture ends. This diagnostic was retained and traced, not suppressed or
retried.

### Runtime: reduce CFC label-view allocation and sorting work

The runtime change computes sort keys once per sort, encodes paths without
intermediate logical-path arrays, and avoids redundant label-array copying in
rebase before merge creates owned output arrays. It adds no cross-call cache and
changes no transaction or lifecycle boundary.

Repository-wide formatting and lint passed. Focused CFC/schema/propagation tests
passed 158 steps; the new test and benchmark type checks passed. The complete
runner suite passed **1404 tests / 9901 steps**, zero failures and one ignored
step, in 20 minutes 4 seconds. Review found no actionable issue.

A separate interleaved synthetic benchmark measured these per-run p75 values in
microseconds for 300 carried entries:

| Operation    | Baseline raw p75     | Candidate raw p75   | Reduction in median p75 |
| ------------ | -------------------- | ------------------- | ----------------------: |
| Clone        | 376.1, 243.6, 196.2  | 100.5, 116.8, 104.5 |                     57% |
| Merge        | 1176.7, 548.5, 991.3 | 442.2, 501.3, 501.9 |                     49% |
| Root rebase  | 606.3, 286.5, 558.8  | 222.2, 250.1, 262.0 |                     55% |
| Child rebase | 28.1, 12.5, 20.4     | 9.3, 9.7, 10.2      |                     52% |

This fixture includes OR clauses and escaped path segments; it is not calibrated
to Loom's label distribution. Child rebase still scans all carried entries on
every call, so the change reduces constant work rather than eliminating the
width-dependent cost.

### Remaining click cost

A separate base/changed-lift CPU profile under concurrent test load showed cheap
authored helpers (`openMessages` 15 ms and `openHead` 9.9 ms inclusive), but
substantial scheduler dependency population and commit work. Event
`pullPopulateDependencies` accounted for 980.8 ms over two calls; commits
totaled 684 ms, action bodies 443.9 ms, map runs 94.4 ms, and JS invocations
69.6 ms. Storage watch refresh accounted for 250.9 ms over four calls. Deep
freezing through attestation decoding and label-view merge/rebase remained
visible. These overlapping timings are diagnostic attribution, not additive
phases or another latency sample.

## Additional experiments and unresolved failures

A sequence of narrower selectors and prepared bubble views was explored in
separate snapshots. A generic indexed-access return type failed compilation;
that failure is retained. A compiling key-only generic selector passed 245
assertions and a browser content check, but did not complete a three-repetition
comparison establishing a gain.

The final optional candidate, Loom
**`215fbc18296177675bc1a41564caf824cd3f4e2e`** on
`codex/person-inbox-prepared-cell`, prepares bubble VNode arrays when merged
data changes and selects a `ReadonlyCell` using `.key(index)`, without `.get()`.
It renders the selected cell directly. It does not pre-render every thread into
hidden DOM. All 245 assertions, emitted readonly-cell schemas, scoped format and
lint, and review passed. Preparing all merged threads adds startup/update work;
the tests do not establish mixed-label read-ceiling isolation.

Its real-data performance comparison is **incomplete**. A base-browser smoke
passed the 50-message content gate at 1421.5 ms and a subsequent formal base run
at 1787.5 ms. The runtime-browser counterpart failed before mounting, so neither
number supports choosing this candidate over the conservative branch.

Three distinct issues prevent combining the later samples with the completed
comparison:

1. **Dropped interaction.** A later base/changed-lift run logged
   `Event dropped:
   no handler registered` after its owning piece was started.
   The detail remained closed with zero bubbles. It was interrupted and retained
   as a failed action, not assigned a latency. An earlier shipped interruption
   has no established cause. Graph installation is not proof that the exact DOM
   stream has a registered handler. The runtime optimization does not fix this
   bug.
2. **Readiness changed.** Subsequent experiments explicitly awaited the public
   runtime `idle()` operation before clicking. Loom's mounting sequence waits
   for start and storage synchronization, which do not establish worker
   quiescence. `idle()` waits for quiescence and commit durability, but still
   does not prove exact handler registration. These samples are a separate
   readiness condition; no fixed delay or automatic retry was introduced.
3. **The source window changed.** A new real message at 2026-09-15T00:59:49.372Z
   shifted the same thread's 50-message window. A strict browser digest check
   caught it. An independent read using the exact source SQL produced the new
   digest, and a shipped control matched it. Epoch A and epoch B stay separate
   even though the person and thread are unchanged.

The epoch-B, idle-gated comparison completed only five observations:
base/original 5687.0 ms, runtime/original 4793.1 ms, runtime/changed 2724.6 ms,
base/changed 2558.8 ms, and base/prepared-cell 1787.5 ms. The next
runtime/prepared-cell run failed before mounting with
`signal is aborted without
reason`, while load averages exceeded 70. The failed
request was not traced well enough to name its endpoint. Comparison stopped; no
three-repetition claim is made from these values. The harness now records
dropped-event arguments and fails immediately on a reported mount failure.

The session's full runner test had already exited. Other machine workloads
remained, with observed load briefly above 94; they were not stopped. A useful
follow-up needs a less loaded host and a reproduction that captures the exact
DOM stream address, owning root, and registered handler set for the dropped
interaction. Repeatedly rerunning until a click succeeds would hide the defect.

## Evidence and final state

The [sanitized raw CSV](2026-09-14-loom-person-inbox-attempts.csv) contains 75
records across the initial upstream measurement and subsequent experiments,
including failed/interrupted and diagnostic attempts. It preserves raw timings,
readiness, source epoch, load before/after, and concurrent test status. Only the
18 `factor-*` records support the improvement table; profiles and partial
experiments are excluded. Person IDs, thread IDs, and message text are omitted.

Private reproducibility evidence is retained at
`/Users/berni/.codex/investigations/person-inbox-20260914/`, with improvement
harnesses, frozen pattern snapshots, full browser trees and SHA-256 manifests,
deployment/link evidence, raw console diagnostics, profiles, and the durable
`improvements/WORK.md` ledger. Runtime microbenchmarks and full-suite logs are
at `/Users/berni/.codex/investigations/inbox-label-perf/`.

The conservative pattern worktree is
`/Users/berni/looms/person-inbox-lift-open`; the runtime worktree is
`/Users/berni/.codex/worktrees/inbox-label-perf/labs`. The optional
prepared-cell worktree is `/Users/berni/looms/person-inbox-prepared-cell` and
remains a separate candidate. Primary Loom and unrelated probe files/processes
were preserved.

The acceptance browser tree and vendored Labs checkout were restored to the
original pin. The same toolshed PID remained running throughout. Vendor sync's
unrelated sandbox-artifact stage returned an error because Docker was stopped;
the requested browser builds completed and their bytes were verified. No new
pin-keyed toolshed store was created, and no store pruning was needed. Local
acceptance candidate pieces remain available for follow-up.
