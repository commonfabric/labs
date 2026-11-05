---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Performance investigation of experimental view-scoped replication, with causal profiles, graph replay, and headless browser comparisons."
---

# View-scoped replication: planning and delivery costs

The initial implementation spent most of its active server time repeatedly
scanning execution graphs. After that was corrected, the remaining navigation
cost exposed repeated planning for detached sessions, complete document
redelivery on small subscription changes, and large producer certificates. The
fixes reduced the enabled 30-topic journey from 14.92 seconds to 3.15 seconds at
p75. They did not make every navigation segment faster than ordinary
replication.

This report follows the
[initial validation and benchmark snapshot](../../benchmarks/view-scoped-replication-2026-09-10.md).
That snapshot remains the record of the initial integration campaign and its
failures. The
[live feature description](../../../features/view-scoped-client-replication.md)
defines the current protocol; this document records the investigation only. The
[companion results file](2026-09-10-view-scoped-replication-performance.results.json)
records benchmark samples, source hashes, graph replay results, and local
evidence paths.

## Measurement conditions

- Apple M3 Max, 128 GiB RAM; Deno 2.9.4; local toolshed and Chrome.
- `HEADLESS=1` throughout. `BoardSession` also explicitly launches headless.
- `EXPERIMENTAL_SERVER_EXECUTION=true` in both arms. Only
  `EXPERIMENTAL_VIEW_SCOPED_REPLICATION` changes; the web override is unset.
- Every browser arm verifies `/api/meta` and the accepted worker initialization
  with the shell's flag integration test before timing.
- Fresh benchmark stores, identical authored workloads and UI operations,
  sequential server sets, and no tests or CPU profiles scheduled by this
  investigation during benchmark measurements. Each arm includes the
  machine-calibration suite.
- Navigation uses 30 topics. The Deno result records six samples per segment;
  tables report its p75, not a sum of independently timed segments.
- Branch `codex/view-scoped-client-replication`, HEAD
  `16de7e0c871d21023111729b40876497dbaf3e36`, with uncommitted implementation. A
  commit ID alone does not identify these stages: each browser arm records
  hashes of the working-tree files in its `source.json`.

The staged browser runs alternate controls across the investigation rather than
placing all controls before all experiments. They are small local samples, not
confidence intervals or a deployment estimate. Other work on the shared machine
was not controlled; calibration and sample ranges are retained for that reason.
The offline graph comparison alternates implementations five times per captured
graph and reports the minimum of five, following the performance skill's noise
guidance.

## 1. Repeated graph scans dominated the initial server profile

The initial three-open profile attributed approximately 81% of non-idle server
samples to `ViewPlanPublisher` and 64.5% to `readsOverlapWrites`. The publisher
performed separate scans for local execution selection, visible error ancestry,
and producer certification. Expanding an ancestor set repeatedly compared many
unrelated readers and writers; the order of a chain could make that repeat for
each layer.

A captured board snapshot had 1,108 nodes, 40,717 observed reads, and 9,154
render reads. It selected 121 eligible actions and 216 producers. The same large
view was planned three times during one topic open; complete planning took about
2.3 seconds each time. A separate capture measured the open at 9.60 seconds.

`ViewDependencyGraph` builds an entity-keyed writer index for each snapshot and
uses the scheduler's existing overlap predicate to expand each discovered node
once. It preserves scope and path semantics, shallow reads, handler boundaries,
and the difference between declared writes and observed producer writes. The
publisher uses the graph for all three ancestry questions. It does not cache an
old read set across execution changes.

All seven captured graphs replayed equivalently: eligible actions, selected
reads, pieces, error ancestors, and producer ancestors matched the original
algorithm. On the large capture, graph selection and ancestry fell from a
minimum 2,930 ms to 10.4 ms. This replay excludes rendering, fingerprinting,
publication, and wire delivery; it is not the complete planning time.

The retained chain benchmark constructs equal visible and unrelated chains. It
measures index construction plus selection and checks that only the visible
chain is selected:

| Visible nodes, plus equal hidden nodes | Original p75 | Indexed p75 |
| -------------------------------------- | -----------: | ----------: |
| 100                                    |      9.77 ms |    0.105 ms |
| 300                                    |    276.44 ms |    0.346 ms |
| 1,000                                  | 13,156.85 ms |    1.272 ms |

The exact samples are in the companion JSON. Reproduce the retained benchmark
with `deno bench -A packages/runner/test/view-replication.bench.ts`.

## 2. Detached sessions amplified repeated planning

The navigation benchmark creates and closes many browser sessions. The server
retains disconnected sessions for its reconnect window, including their view
interests. Planning every retained view therefore kept doing work for browsers
that had already closed. This is an amplifier in the benchmark and a real
lifecycle cost for clients that disconnect.

The server now exposes whether a view's session has an attached connection. The
publisher defers planning detached views while preserving their interests,
handler observations, and reconnect lifetime. Reopening a session already wakes
the serving loop, which then plans from the current graph. No retention period
or timeout changed.

The complete intermediate enabled navigation run skipped 1,372 detached-view
planning attempts and performed 210 plans. Its open-topic p75 was 2.97 seconds,
down from 5.39 seconds with indexing alone. The earlier live planning count was
sampled partway through a run and is not a comparable whole-run denominator.
Tests cover both detachment/resumption on a real Memory connection and the
publisher's retention of observations while deferring graph inspection.

## 3. Small subscription changes redelivered large unions

After those fixes, the browser worker spent 81.7% of a profiled slow-open
interval idle. The click and route change took tens of milliseconds; the wait
was for topic content. IPC and storage spans put the delay in `piece:get` and
queued watch refreshes, rather than local action execution.

A diagnostic browser frame trace exposed the source. A four-watch addition
waited 1,645 ms and received 767 document upserts in a 5,019,383-byte
uncompressed frame. About 2.39 MB was document content; the response also
carried a large view manifest. Two later view changes sent similarly complete
unions. A frame with no document upserts still occupied 2,466,392 bytes because
of its producer certificate.

In view mode, `session.watch.add` delegated to watch replacement, which used a
full sync. The correction retains replacement evaluation under the space
publication lock but diffs against the session's current delivery state for an
add. The normal full-replacement contract remains intact. Duplicate watch-ID
validation and union construction happen inside that same lock.

The client also declares its current replica holdings when replacing view
interests, using the existing holdings protocol and sampling the provider when
the request is issued. The server can then deliver missing or changed documents
and removals instead of every document the client already has. Clients without a
holdings provider retain full delivery. Tests pin unchanged-document elision,
continued support delivery and demand separation, and the outgoing holdings.

## 4. Certificates repeated checks already covered by ancestor values

A producer's certificate included a whole-object fingerprint together with
fingerprints of that object's descendants, plus repeated declared and observed
write paths. These are whole-value checks: when the ancestor's value and
reachability match, its descendants are already covered.

Certificate construction now uses the existing path compactor before hashing
reads and outputs, and compacts the producer's write surfaces. Read selection
still uses the full observed read set and its shallow-read semantics. This
changes certificate representation, not which actions become eligible or which
input documents are admitted. Tests compare compacted and original currency
checks across changed children, missing properties, unrelated siblings,
deletion, and separate scopes.

A side finding concerned redirects to output cells. Direct piece probes already
use shallow sync; the initial suspicion that every probe recursively loaded the
result was incorrect. The output-redirect branch did perform a broad pull.
Enabled clients now use the name/UI-tip schema there too. A real two-runtime
regression checks that hidden linked documents stay absent, while disabled and
unsupported controls preserve their ordinary reads.

## Results

All times are p75. The final disabled control is a separate fresh run on the
same final implementation.

| 30-topic operation     | Initial enabled | Final enabled | Final disabled |
| ---------------------- | --------------: | ------------: | -------------: |
| Board                  |          421 ms |        378 ms |       1,784 ms |
| Open topic             |       10,557 ms |      1,524 ms |         368 ms |
| Follow cross-reference |        3,058 ms |        543 ms |         297 ms |
| Complete journey       |       14,921 ms |      3,151 ms |       2,354 ms |

The complete journey is 4.73 times faster than the initial enabled result but
still 34% slower than the final disabled control. Opening a topic remains the
largest gap. The disabled board measurement was variable (1,145–2,171 ms;
previous disabled p75 controls were 972 and 1,090 ms), so the board's final
ratio should not be treated as a stable gain estimate. The enabled board's final
samples ranged from 368 to 383 ms. Full sample summaries and calibration results
remain available rather than replacing these distributions with one headline
ratio.

Indexing alone also made the 100-topic benchmark finish: enabled p75 was
1,501.75 ms, compared with the initial disabled control's 7,233.86 ms. The
initial enabled run had failed its existing 300-second last-card wait. That
passing 100-topic result was collected after indexing and before the subsequent
lifecycle and delivery fixes; it is not a final-source scale measurement. The
seed phase is outside the render measurement and still took minutes.

The final diagnostic capture confirms the delivery change. The corresponding
four-watch addition returned one absent-document entry in 413 bytes instead of
767 upserts in 5.02 MB. A view replacement returned 191 entries in 828,628
bytes; the pre-fix trace had returned 771 entries in 5,021,229 bytes. The
support/plan push shrank from 2,538,875 to 826,542 bytes. These are uncompressed
frame sizes from one diagnostic scenario, not network-throughput benchmark
totals.

The final worker profile was 95.9% idle during a 1.96-second open capture. The
click and route change took 31 ms; waiting for the title took 1,691 ms. The
server recorded three planning spans totaling 978 ms over the full 4.79-second
scenario, alongside query traversal and subscription work. These overlapping
wall spans cannot be summed into a CPU attribution. This locates the remaining
work on server planning/evaluation and delivery scheduling; client computation
is no longer a material part of that capture.

## Validation and limits

Validation on the optimized implementation completed successfully:

- Full `runner` package tests: ok | 1406 passed (8668 steps) | 0 failed | 0
  ignored (1 step) (18m37s).
- Full `memory` package tests: ok | 613 passed (565 steps) | 0 failed (29s).
- Full `runtime-client` package tests: ok | 30 passed (655 steps) | 0 failed
  (49s).
- `deno task integration runner` with server execution and view-scoped
  replication enabled via environment: ok | 16 passed | 0 failed (19s).
- `deno task integration runtime-client` with server execution and view-scoped
  replication enabled via environment: ok | 1 passed (50 steps) | 0 failed
  (3m24s).
- Full `deno task check` passed.
- `deno task check-docs` passed all 597 checked code blocks.
- Repository-wide `deno fmt --check`, `deno lint`, and `git diff --check`
  passed.
- Focused regressions cover graph equivalence, scope/shallow-read boundaries,
  detached-session resumption, delivery deltas, holdings, compacted currency
  checks, and output-redirect reads.
- Browser flag tests passed in both final benchmark arms; both navigation
  benchmarks and the final diagnostic scenario completed.

The initial root integration campaign did not end with a clean all-suite exit;
its recorded failures were corrected and focused reruns passed, as documented in
the initial snapshot. This investigation must not be read as retroactively
turning that root command green.

The 10-voter, 10-option lunch benchmark's consequence-completion failure remains
separate. It uses ordinary worker clients without renderer mounts, so enabling
the web replication mode does not activate view selection in those clients. The
prior 3-by-4 controls completed around 1.5 seconds in both modes. These
view-specific fixes neither diagnose nor establish a repair of the 10-by-10
failure.

Remaining work includes a clean complete integration campaign, large lunch-burst
completion, and further navigation measurements. The optimized mode still pays
for server evaluation and subscription changes when opening another view, while
the ordinary client has already fetched more of the graph. The protocol still
transfers complete documents and complete manifests: narrow logical reads do not
imply narrow physical documents, and unchanged manifests can still repeat.
Further work should measure per-frame evaluation and manifest deltas before
adding caches or prefetch. Transfer totals, browser heap use, and unseen
speculative-branch stability are not established by the navigation p75 table.

Producer certificates protect authoritative values while the client holds only
part of the graph. Their remaining cost is a correctness trade-off: further
reduction must preserve the proof that locally consumed computed values are
current before a speculative action can overwrite outputs. The fixes here remove
redundant checks while retaining that guard.

No default flag was enabled and no deployment or commit was made.

## Local evidence

- `/tmp/view-v6-graphs/`: seven captured execution snapshots.
- `/tmp/view-v6-replay.ts` and `.json`: original/indexed equivalence and
  timings.
- `/tmp/view-v6-chain-before.json` and `-after.json`: scaling microbenchmarks.
- `/tmp/view-replication-benchmarks/v6-*`, `v7-*`, `v8-*`: commands, source
  hashes, resolved flags, benchmark JSON, logs, and server statistics.
- `/tmp/view-v5-profile/`, `/tmp/view-v6-fixed-profile/`,
  `/tmp/view-v7-profile/`: staged server and browser-worker CPU profiles.
- `/tmp/view-v8-wire/`: pre-delivery-fix browser frame trace and paired
  profiles.
- `/tmp/view-v8-final-wire/`: final diagnostic trace and paired profiles.

Temporary frame logging was removed after each diagnostic capture. The workload
pattern and benchmark source were unchanged during the performance comparison.
