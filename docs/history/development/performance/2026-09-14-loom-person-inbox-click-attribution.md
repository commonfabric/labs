---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Worker and browser attribution for a real-data thread open after the pattern and runtime improvements."
---

# Where the improved inbox's thread-open time goes

## Finding

The remaining delay is dominated by runtime dependency reads and commit
processing. Browser style and layout are small. Pre-rendering shifts more than
DOM construction ahead of the click: it also shifts the reactive work and
information-flow verification required to produce the bubbles.

The earlier **1754.5 ms** result is an unprofiled median, so it has no exact
per-phase decomposition. This follow-up profiles the same combined revisions
(Loom `40129bb55`, Labs `820bd94a90`) on the same canonical person and thread.
The diagnostic open took **2203.0 ms**, and its shipped control **163.6 ms**.
These single profiled observations explain cost; they do not replace the
[three-repetition comparison](2026-09-14-loom-person-inbox-improvements.md).

## Observations

Both profiles capture the runtime worker, browser main-thread CPU samples, and
browser performance counters. The worker's existing timing statistics were
sampled before and after the click. All values below are milliseconds.

| Measured work                                        |     Improved lift | Shipped control |
| ---------------------------------------------------- | ----------------: | --------------: |
| Click to 50 visible bubbles and two animation frames |            2203.0 |           163.6 |
| Scheduler dependency population                      |   391.5 (2 calls) |   4.3 (4 calls) |
| Scheduler action bodies                              |   569.5 (26 runs) |   54.6 (6 runs) |
| Scheduler commit processing                          | 1146.3 (26 calls) |  21.6 (6 calls) |
| Whole scheduler execution, including the above       |            2198.6 |            99.2 |
| Runtime map execution, inside action work            |   163.9 (3 calls) |               0 |
| Browser style recalculation plus layout              |              11.6 |             8.7 |

These are cumulative elapsed logger durations and browser counters over the
profile window. Nested and asynchronous operations can overlap; the rows are not
slices of a pie and must not be added. Action runs and commit calls are
scheduler activity, not 26 user events or 26 network writes. The shipped profile
recorded two handler invocations, so these captures do not isolate every
background effect to the one click.

The browser main-thread profile also reported 5.6 ms of script execution for the
lift and 1.4 ms for shipped. Its DevTools-command durations were 142.1 and 71.8
ms respectively; those belong to instrumentation, not product rendering.
Painting and IPC were not independently bounded, so style/layout is not a
complete rendering total.

## Why a selection starts so much work

The lift pane changes the selected key, derives its index, derives the open
header and message list, maps that message list into bubble views, and exposes
the resulting detail. Each derived output participates in the reactive runtime:
reads are tracked and verified, outputs are committed, and newly demanded views
can require additional reads and subscriptions.

The authored selector is small: `openMessagesFrom` returns
`threads[index].msgs`. The declaration still supplies full message data to the
reactive pipeline, which does substantially more than an ordinary JavaScript
array lookup. In this worker CPU profile, the helper occupied 15 ms inclusive;
the header helper occupied 9 ms. Their surrounding generated wrappers occupied
27 and 21 ms inclusive. Optimizing just the helper bodies would address little
of the remaining delay.

The shipped pane already has the bubble views and DOM when the click arrives.
Its selected key primarily changes visibility. It therefore avoids most of the
new message-view computation and commit verification on the interaction path. It
carries more off-screen state and front-loads work, but this experiment does not
establish which design uses less total CPU or memory over a session. That
requires startup, message-update, switching, and retention measurements across
many threads.

## The expensive commit internals

The scheduler commit timer measures preparation and starting `tx.commit()`; it
stops when the commit promise is returned, without waiting for that promise.
Thus the 1146 ms is predominantly CPU preparation, not disk or network latency.
Only 12 native commit calls were recorded, totaling about 23 ms over the
capture.

The worker CPU samples attribute approximately **1079 ms inclusive** to
`prepareCfc`, the information-flow-policy part of commit preparation. Within
that sampled time:

- `verifyInputRequirements` accounts for **611 ms inclusive**. It builds a list
  from the transaction's recorded reads, normalizes paths, and resolves each
  source document's policy metadata. The commit boundary invokes it separately
  for each candidate write target. Building the read list is unconditional; some
  later label checks are lazy.
- `describeRefusalInputs` accounts for **104 ms**. Its caller is the writer-fit
  misfit branch. This builds the diagnostic that explains which source reads
  supplied offending confidentiality clauses. That diagnostic is constructed
  before deciding whether the mode rejects the write or persists it with a
  diagnostic. Seeing this function does not prove that the click was rejected.

Across the whole worker profile, label-view rebase accounts for **344 ms
inclusive**, containing much of the **315 ms** in merge. These overlap each
other and other rows above. They show that the first label-view improvement
reduced a cost that still exists; it did not remove the cost of constructing and
checking wide reactive values. Deep-freeze work totals roughly 97 ms inclusive
in this capture. The much larger attestation-decoding/freezing cost in the older
baseline profile did not recur here at that size.

Source anchors at the frozen runtime revision are
`packages/runner/src/cfc/prepare.ts:3963` (`verifyInputRequirements`), its
per-target call at line 6484, and the diagnostic-before-rejection branch at line
7514; `packages/runner/src/cfc/refusal-detail.ts:147` implements input
attribution.

This points to two independent opportunities: keep the click's reactive data and
outputs narrow, and reduce repeated policy work within a commit without
weakening verification. Exact action identities, write-target counts, and
per-target read counts were not captured, so the amount recoverable by either
change remains unmeasured.

The two dependency-population calls represent preflight attempts, not two
handlers or two roots. Only one handler invocation was recorded for the lift.
Each attempt walks the handler's declared read links. Waiting for pending reads
could explain a second attempt, but aggregate counters cannot establish why it
happened; no dirty-upstream rescheduling counter was recorded.

## Workload and evidence qualifications

The same read-only acceptance stores, toolshed PID 83088/start time, canonical
person, and Signal thread were used. Both captures await runtime `idle()` before
the click. That is the later readiness condition, separate from the original
median's visible-source-count condition; idle took 1.7 ms for the lift here.
Each capture starts closed and reaches exactly 50 visible bubbles in the visible
detail. Profiles are worker-local; server execution remains disabled.

The live thread's 50-message window had changed again since the earlier run. The
first lift capture failed the old digest assertion after saving its profile. An
independent read using the exact Signal SQL and fixed person/thread matched its
new digest. The shipped capture then passed that same digest. The original
failed assertion is retained; no earlier source-window latency is pooled with
these observations.

| Capture                  | Uptime before                                              | Uptime after                                               |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Improved lift, 2203.0 ms | 21:29 up 7 hrs, 14 users, load averages: 16.35 15.27 16.19 | 21:29 up 7 hrs, 14 users, load averages: 19.83 16.09 16.47 |
| Shipped, 163.6 ms        | 21:30 up 7:01, 14 users, load averages: 24.36 18.00 17.15  | 21:30 up 7:02, 14 users, load averages: 25.72 18.48 17.33  |

Private evidence is in
`/Users/berni/.codex/investigations/person-inbox-20260914/improvements/`:
`runtime-header-detail-1-*`, `runtime-cf-person-inbox-detail-1-*`,
`source-detail-epoch.json`, `source-detail-rows.json`, `measure-detail.mjs`, and
`measurements.jsonl`. Source bodies and IDs remain private. This diagnostic
added no production code change. The saved pinned browser tree was restored
after each capture; the toolshed was not restarted.
