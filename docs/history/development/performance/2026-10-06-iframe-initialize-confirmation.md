---
status: historical
created: 2026-10-06
archived: 2026-10-06
reason: "Investigation of real iframe eligibility and a standalone initialization confirmation optimization."
---

# Iframe initialization after a pending edit

The first-use boundary spike led to a smaller production opportunity: repeat the
existing stored-value probe after relevant writes are confirmed, before entering
the global default-storage barrier. This change needs neither the experimental
closed-action machinery nor compiler lowering.

## Real-path eligibility

The unchanged Shared Tape Lab, Impossible Machine, Firebreak Commons, Signal
Atlas, and Orbital Salvage Yard wrappers were compiled through the runtime
harness at spike revision `2a75a142fe`. All five retained ordinary JavaScript
and nested pattern watchers. Pinning the outer pattern left the inner
`IframeContext` watcher installed. The structured state and schema-bearing
result views also fall outside the experimental numeric reader. None qualified
as a complete closed family. Signal Atlas additionally installed a SQLite node.

That evidence argues against packaging the whole spike as a general first-use
improvement. Supporting these wrappers would require an installation and
lifetime contract for ordinary nested watchers, structured views, and ordinary
JavaScript, beyond adding another expression form.

## Confirmed stored values

The representative case here is iframe reattachment during an ordinary pending
state edit. The Shared Tape Lab wrapper is installed unchanged, its real
`$context` is read from its UI, and `handleCellFields` supplies the guest's
state reference. An ordinary producer in space B has a real native commit held
at the server. A state edit in space A is also held. Initialization begins while
both are pending.

The baseline probe sees optimistic state and enters the global barrier. When A
is confirmed, a fresh initialization can return the stored value while B is
held, but the original request remains blocked. The candidate waits for the
providers of the pending spaces actually consumed by a successful projection,
then repeats ordinary readiness and the complete transactionally recorded read
probe. It returns only an existing value whose consumed documents are free of
pending writes. Readiness can create further commits, so confirmation and
observation repeat until that criterion holds or the probe requires fallback.

An absent value, unavailable observations, a projection failure with recorded
pending reads, or failed confirmation retains the global barrier before writing
a default. Other readiness and projection failures propagate. Withdrawal to
absence takes that fallback too. Server execution and custom sealing retain
their existing optimistic-value barrier because speculative retirement is
independent of provider synchronization. The provider's optional
`hasPendingSyncWork()` capability reports whether a real synchronization wait is
available. Missing capability or a verdict-only write awaiting coverage with no
remaining synchronization work uses the global fallback. A control without this
guard performed 376 rechecks during a one-second receipt coverage wait; the
final candidate falls back rather than polling that optimistic layer. Host read
decisions and CFC rules are unchanged; this is a host waiting arrangement.

## Measurement

The standalone candidate was extracted onto labs main `9df45ddc95`, without any
spike source or test-support imports. The comparison uses that revision's exact
original `RuntimeProcessor`, copied to a temporary module with relative imports
redirected to the same checkout. Both classes use the same unchanged wrapper,
ordinary foreign producer, native loopback store, identity, and request. A/B
order alternates across five rounds. Every response is validated.

The foreign response is released 100 ms after A's transaction receipt settles.
This is a modeled service delay, not a stabilization wait. The harness reports
both the total interval from releasing A until initialization returns and the
residual interval from A's settled receipt until that same response. Initial
compilation and setup are excluded. No browser, IPC transport, paint, or cold
page bootstrap is measured. Runtime posture is client execution
(`serverExecution=false`), with ordinary watchers retained. The machine ran
Darwin 25.6.0 arm64, Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3.

| Arm            | Samples | Residual median (min–max) | Total median | B still pending at response |
| -------------- | ------: | ------------------------: | -----------: | --------------------------: |
| Exact baseline |       5 | 104.03 ms (103.35–105.21) |   1111.93 ms |                         0/5 |
| Candidate      |       5 |       3.99 ms (3.41–4.82) |   1009.31 ms |                         5/5 |

[All ten recorded samples](2026-10-06-iframe-initialize-confirmation.samples.csv)
include both timers, the warm batch mean, and the foreign-pending observation.

The roughly one-second native receipt-coverage wait remains in both arms. An
earlier experiment released B 100 ms after releasing A; B's completion helped
deliver A's coverage before its own wait finished, hiding the intended
comparison. Scheduling the modeled foreign delay after A's receipt isolates the
missed stored-value recheck. The avoided 100 ms is workload-specific; it is not
an estimate of ordinary user latency or a general runtime speedup.

Five subsequent batches of 100 confirmed-state initializations per arm gave
median per-call times of 3.15 ms baseline and 3.30 ms candidate, with batch
ranges of 2.86–3.39 ms and 3.09–3.55 ms respectively. These short runs were
collected while package validation was active. They establish no meaningful
warm-path performance claim and are not a latency gate.

Run the candidate measurement from the repository root:

```sh
deno run -A packages/runtime-client/bench/initialize-confirmation.ts
```

For an exact comparison, retrieve
`9df45ddc95:packages/runtime-client/src/backends/runtime-processor.ts` with
`git show`, rewrite its `./` and `@/` imports to absolute paths in this
checkout, and import the temporary module with the checkout's `deno.jsonc`. Pass
a factory using its `accessForTestingOnly.construct` to
`measureInitializeConfirmation`, with `serviceDelayMs=100` and
`waitForGlobalBarrier=true`. Alternate it with the default factory on matched
fresh fixtures. The different observation gates signal each handler's actual
pending phase; they forward the real wait.

## Outcome and coverage

The focused production change is ready for independent review. It covers an
existing stored state that becomes confirmed after initialization starts. It
does not narrow the default-writing barrier or enroll ordinary iframe graphs in
the closed family.

Four new event-driven tests exercise the real wrapper: confirmed state returns
before the foreign commit, optimistic state withdrawn to absence keeps the
global barrier before default storage, and a synchronization failure falls back
without reissuing the failed wait. Existing rejection and linked-child repair
tests observe either the provider wait or the global barrier, retaining their
value and no-premature-return assertions. The complete runtime-client suite
passed: 53 tests, 1,037 steps.

Further closed-family work should first establish an installation and lifetime
contract for one real nested watcher family. The five sampled wrappers provide
concrete eligibility failures to test that contract against; expanding AST
coverage alone would not make any of them eligible.
