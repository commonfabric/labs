---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measured Loom policy-preparation optimizations, node attribution, and rejected alternatives."
---

# Loom thread opening: policy preparation below 200 ms

## Outcome

The retained candidate combines the selected-bubbles pattern (`4b7723a4`) with
read-only renderer subscriptions (`ae7bfd91`). Full policy preparation was below
200 ms in all nine observations across three consecutive three-repetition
blocks. The first block compared the same pattern on R4 and the new runtime:

| Runtime            | Full policy preparation, raw ms | Median ms | Thread open, raw ms | Median ms |
| ------------------ | ------------------------------- | --------: | ------------------- | --------: |
| R4                 | 263.9, 249.2, 219.4             |     249.2 | 860.7, 811.0, 683.0 |     811.0 |
| Read-only renderer | 172.2, 120.2, 89.5              |     120.2 | 668.9, 474.2, 355.3 |     474.2 |

The enclosing `prepareForCommit` medians were 262.0 and 122.7 ms. The shipped
control's thread-open medians were 351.9 and 129.6 ms. Those controls also
moved, so machine contention contributes uncertainty to the size of the latency
gain. The mechanism is directly observed: full policy preparations fell from
1,206–1,212 per click to 10–16, without removing subscription dependency
journals.

In the following pattern-comparison block, the retained candidate's full-policy
observations were 175.6, 102.6, and 185.0 ms. These blocks remain separate;
their medians are not pooled. Post-suite verification is recorded below.

### Post-suite verification

After the full runner and HTML suites exited, a final interleaved block measured
both panes on R4 and the retained runtime, with the same source window:

| Runtime and pane                     | Full policy preparation, raw ms | Median ms | Thread open, raw ms | Median ms |
| ------------------------------------ | ------------------------------- | --------: | ------------------- | --------: |
| R4, selected bubbles                 | 297.6, 190.7, 195.1             |     195.1 | 825.4, 623.3, 621.7 |     623.3 |
| Read-only renderer, selected bubbles | 161.2, 125.0, 174.6             |     161.2 | 622.3, 504.2, 687.2 |     622.3 |
| R4, shipped pane                     | 16.5, 9.0, 12.3                 |      12.3 | 342.0, 129.2, 141.8 |     141.8 |
| Read-only renderer, shipped pane     | 10.4, 9.6, 16.9                 |      10.4 | 119.8, 129.9, 220.5 |     129.9 |

The retained candidate met the policy budget in all three observations and beat
its paired R4 policy time three times. Its enclosing preparation times were
163.6, 126.6, and 176.9 ms, median 163.6 ms, against R4's 203.5 ms median. Full
preparations fell from 1,206 to 10 per selected-thread click. Total opening
improved in two pairs and regressed in the third; the medians were essentially
equal. This block does not establish a total-open median improvement.

One-minute load fell from 11.92 to 8.26 before rising to 35.55 near the end. The
retained candidate's last observation spanned a rise from 8.26 to 23.08, and the
subsequent shipped control also slowed. The raw before/after uptime strings are
beside every number in the CSV. All 12 observations passed the same zero-to-50
visible-bubble and content-hash gate and had no page exceptions. The third R4
selected-pattern observation recorded one aborted background `/_health` request;
the successful visible-result measurement is retained with that network
annotation, without claiming its cause.

The candidate remains a local change. No default pane was switched, no PR was
pushed or merged, and no vendored release was adopted. The initial pin/main
comparison and the preceding four rounds are in
[the pin/main report](2026-09-14-loom-person-inbox-thread-open.md) and
[the preceding runtime campaign](2026-09-14-loom-person-inbox-policy-rounds.md).

## Where one retained-candidate open spends its time

This is one named-span and CPU diagnostic, not a decomposition of a separate
median. It opened in **473.9 ms**, with **115.5 ms** in full `prepareCfc` and
117.1 ms in the enclosing `prepareForCommit`. CPU sampling is diagnostic; the
repeated timing comparisons did not enable sampling or timeline emission.

| Overall phase                                        | Measured ms |
| ---------------------------------------------------- | ----------: |
| Running pattern nodes and view subscriptions         |       203.3 |
| Committing their results                             |       136.9 |
| Input/dependency preparation and handler execution   |       107.3 |
| Remaining scheduling and browser display/capture gap |        26.4 |
| Total click to visible bubbles                       |       473.9 |

The input/handler phase includes 80.0 ms finding dependencies, 13.2 ms
synchronizing handler inputs, and 11.7 ms executing the handler. The whole
scheduler window was 455.0 ms.

The **203.3 ms in nodes** breaks down as follows. Each named computation ran
once in this diagnostic. Subscription rows may include nested subscription
setup, so their inclusive rows are grouped without adding child spans again.

| Pattern node or subscription                            | Inclusive ms |
| ------------------------------------------------------- | -----------: |
| Selected message-view subscription, 50 bubbles          |         92.1 |
| `openBubbleViews`: constructs the selected bubble views |         56.2 |
| `shownThreads`                                          |         21.4 |
| `openHeadOf`                                            |         12.3 |
| Conversation-list map                                   |          6.7 |
| `rowClassOf`                                            |          4.0 |
| Other view subscriptions                                |          8.4 |
| `openIndex` and conditionals                            |          2.2 |
| Total                                                   |        203.3 |

The graph connects the list map to `shownThreads`; the largest subscription owns
50 children under the selected detail. Named action times include runtime input
reads, view construction, and output handling, not only authored function
bodies. The timeline emitted 2,713 spans under its 200,000-span cap.

**Policy preparation overlaps the overall phases above:** 107.2 ms was inside
commits and 8.3 ms inside the handler. None was inside the named pattern-node
spans in this capture. Do not add 115.5 ms to the total. The largest two full
preparations were 74.0 and 26.9 ms. CPU sampling attributed approximately 72.2
ms to boundary-commit preparation and 24.1 ms to reactivity-log inspection, with
further nested hashing, canonicalization, and input-verification work.

## Why renderer subscriptions were preparing write policy

The worker reconciler initializes subscriptions recursively for props, children,
and cells embedded in views. Each ordinary value subscription creates an initial
query transaction; reads through callback child cells use a separate transaction
so they do not enlarge the parent's reactive dependency set. Both were writable
transactions and therefore eligible for policy stamping and digest preparation.
Ordinary `Cell.get()` fallback reads already use read-only transactions; they
were not the source of these full preparations.

An earlier prepared-cell diagnostic had 1,153 tiny policy preparations inside
its dominant message-view subscription, totaling 117.6 ms, plus 7.2 ms in
another subscription. Its 351.1 ms full-policy total also included 211.8 ms in
scheduler commits and 14.5 ms elsewhere. That diagnostic opened in 1,111 ms:
618.5 ms in nodes, 272.6 ms committing, 137.2 ms finding dependencies, 38.0 ms
in handler synchronization/execution, and about 44.7 ms elsewhere. Its principal
node costs were the message-view subscription (402.3 ms, including 117.6 ms
policy), bubble construction (99.4 ms), `shownThreads` (37.1 ms), another
subscription (24.4 ms, including 7.2 ms policy), and `openHeadOf` (23.9 ms).
Different machine load and pattern variants prevent treating these diagnostics
as an isolated speed ratio.

The retained runtime adds an internal read-only option and opts in at the worker
reconciler's ten subscription call sites. Initial deliveries and scheduler
reruns retain separate journals and declare their query and child-read
transactions read-only before traversal or callbacks. `sinkMeta` honors the same
option; stream listeners create no subscription transaction. Writes through
delivered cells fail. Ordinary subscriptions retain writable child cells.

This uses the existing read-only commit contract: transactions that admit no
writes have no writes to stamp. It changes no render confidentiality, integrity,
redaction, or admission checks. Label reads remain reactive dependencies. Event
handlers and bindings obtain their writable transactions independently; a real
runtime regression test dispatches an event after rendering and verifies a
committed value change from 0 to 1.

The retained pattern constructs only the selected thread's bubbles in one lift,
using an ordinary loop and a readonly cell read of the selected message path. It
avoids a reactive map subpattern for each message. Only the selected detail DOM
mounts. This is distinct from the shipped pane, which constructs all thread DOM
beforehand and selects with CSS.

## Other experiments and why they were not retained

R4 is `4b2b207e41347f70f7f4620e1277903b145364a6`: owned label-view reuse plus a
conservative candidate-read journal that excludes immutable runtime-owned
verifier records while preserving the full journal and mutable metadata
behavior. Its full runner suite had already passed 1,405 tests and 9,915 steps.
The new renderer change is directly on R4; none of the experiments below is
included implicitly.

| Experiment                                                                   | Evidence and decision                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6, lazy input descriptors and prepare-local refusal attribution, `8e60339c` | Policy median 397.4 to 364.6 ms; thread open 810.0 to 824.5 ms. No demonstrated open improvement; kept separate.                                                                                          |
| Prepare-local document-key reuse, `517c931`                                  | Selected-pattern policy median 292.4 to 294.2 ms. No demonstrated gain.                                                                                                                                   |
| Native reactivity-path construction simplification, `d092685d`               | Selected-pattern policy median 207.6 to 241.7 ms; open 676.8 to 847.8 ms. Header results moved the other way under changing load. No selected-path gain established.                                      |
| Prepared-cell pattern, `215fbc18`                                            | Earlier demand-driven bubble-array candidate; policy median 230.2 ms in its block. A separate lift did not guarantee preconstruction before opening.                                                      |
| Merge-carried views inside each thread, `83bb3371`                           | Actual merge preconstruction verified, but policy raw 8180.9, 5254.8, 6635.1 ms; open raw 10153.5, 6434.4, 8162.5 ms. Rejected.                                                                           |
| Split merge output `{threads, bubbleViews}`, `13eb9f94`                      | On the read-only renderer, policy raw 894.6, 809.2, 982.5 ms; open raw 1286.8, 1217.1, 1479.7 ms. Selected-bubbles controls were 175.6, 102.6, 185.0 ms policy and 697.4, 417.4, 715.9 ms open. Rejected. |

A write-only reactivity projection prototype was rejected without committing it.
Original digest preparation builds and caches the complete reactivity log. The
prototype skipped that call, moving the snapshot boundary: a retained read's
metadata could change without transaction activity and alter a subsequent log.
Preserving only an already-existing cache did not preserve this behavior. The
review finding superseded an initial no-findings review. No executable
counterexample or performance result is claimed for that prototype.

### What the preconstruction experiments exposed

The emitted program and focused counts prove that both merge variants construct
views in the same merge demanded by the closed conversation list; opening does
not run a bubble builder. They front-load views for every queried thread on
startup and merge updates, while mounting only the selected DOM. The real
fixture contains one thread, so it does not quantify many-thread startup
amplification.

Putting views inside a thread enlarges that inline array element's raw identity.
A narrower input schema does not prevent `schema-view` from reading the full raw
element and computing its data URI before applying the child schema. Splitting
the output paths removes the views from the raw thread element but does not
separate their parent output document or label view.

The split-output CPU diagnostic opened in 1,331.5 ms with 874.4 ms full policy
preparation. Approximately **703.1 ms sampled** was in `authoritativeCoverFor`,
including 585.6 ms in its `isPrefix` predicate. For each carried label entry,
that function scans all authoritative entries to find the longest covering path,
joining equal-length covers. This is quadratic when both collections grow with
the view size. It explains the dominant policy cost in the split-output capture.
An indexed longest-prefix lookup preserving wildcard and equal-depth join
semantics is a separate remaining optimization; the retained candidate meets the
requested budget without that change.

## Measurement method and evidence

Every observation pins the same person and Signal thread by identity. A
read-only SQL snapshot independently captures its 50-message display window,
including attachment placeholders; the browser must change from zero visible
bubbles to exactly 50 in the single visible selected detail and match the
expected text hash. WhatsApp and Gmail counts are zero. Neither hidden bubbles
nor merely nonzero DOM counts qualify. The source window is snapshotted per
block, and raw failures remain in the ledger.

All runtime arms use identical private build instrumentation around the complete
synchronous `prepareCfc` and enclosing `prepareForCommit`. The first includes
verification, label processing, digest-input construction, and hashing. Timing
statistics are differenced around the click-to-visible capture. Clock or source
work that occurs within that interval remains included. Sampling and named
logger spans are separate diagnostic runs; they are not pooled into medians.

Arms and panes are interleaved for at least three repetitions. Each observation
uses a fresh browser and waits for the actual source counts and runtime idle.
The config-capture protocol fetches and hashes the real configuration before
mount, replays those bytes only during mount, and removes the route before the
click. Both arms follow the same protocol. Uptime is captured before and after
every observation. External benchmark and validation jobs caused substantial
load; none was stopped. Owned tests and builds are outside valid timing blocks.
Process isolation is checked through coordinator observations and supervisor
ledgers; the legacy concurrent-runner field in browser records tracks an earlier
test PID and is not sufficient by itself.

Only prebuilt browser trees are swapped. Toolshed PID 83088, started September
14 at 15:22:33, retains pin `be73306e5` and the same stores throughout; server
execution is disabled. Each new pane is registered with the acceptance daemon
and measured only after all three store links appear in its log. No source store
was copied or modified. The split-output pane waited for a slow serial injection
pass; no receipt, queue, or service was modified to bypass that gate.

The ordinary vendor/browser pin is restored after every build and block. Vendor
sync's known unavailable sandbox artifact reflects the stopped Docker service;
browser builds succeeded, but this is not a completed vendored adoption ritual.

The accompanying [CSV](2026-09-15-loom-person-inbox-policy-budget.csv) records
every attempt from this continuation, including raw timings, source/content and
bundle hashes, readiness, config protocol, errors, and uptime before/after. A
rejected inline-merge CPU diagnostic failed during mount with a `piece:start`
timeout and produced no click profile; it also overlapped owned validation and
is not latency evidence. Private profiles, transformed programs, frozen source
closures, manifests, full logs, and validation ledgers are under
`.codex/investigations/person-inbox-20260914/`.

## Validation and retained revisions

- Loom selected-bubbles: `4b7723a4dc605ae2b3d22acdec4af092dec71622`; frozen
  source SHA-256
  `84b6620f56b062407fe958e1428e75adf3b1bf1708ba031287c552f926440df6`.
  Compilation, 245 correctness assertions on R4, scoped formatting/lint, and
  review passed. The assertions cover updates, switching, removal, and layout.
- Labs renderer read-only: `ae7bfd91f75351a50960855b20faf66655c8856a`; focused
  runner 7 tests/75 steps, renderer 11 tests/135 steps, strengthened real-event
  module 2 tests/25 steps, ambient-aware type checking, repository formatting
  (6,371 files), lint (6,044 files), and independent review passed.
- Full renderer package: 29 tests/288 steps, zero failures, clean exact head,
  process exit zero and no remaining process-group members.
- Full runner package: 1,406 tests/9,919 steps, zero failures, one ignored step,
  23 minutes 59 seconds. Both full suites ran at the clean retained head, exited
  zero, and had no remaining process-group members before the final measurement
  block.
- Rejected runtime candidates passed their focused gates and independent review;
  no full-suite result is claimed for them. Both merge pattern variants passed
  245 assertions and compilation; those correctness results did not predict
  their real-data performance.
- Initial invalid test-fixture and omitted-ambient type-check attempts remain in
  the validation ledger. Corrected checks passed. Loom's existing
  repository-wide formatting/lint failures were preserved; no unrelated files
  were reformatted.
- Final restoration verified vendor head
  `be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`, served worker SHA-256
  `8710b6e1bb5c581196e382c0537f2d0dcb38321f097967d82805cd32e1d23827`, and
  unchanged toolshed PID 83088/start time. Retained pattern and runtime
  worktrees are clean at the revisions above. The vendor's untracked generated
  `deno.json` is preserved; no vendor-cleanliness claim is made.
