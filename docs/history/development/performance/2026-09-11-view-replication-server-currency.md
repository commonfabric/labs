---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Executed initial server-currency adoption and its regression, browser, and alternating startup validation; records an existing feature-off CFC control failure."
---

# Initial view currency from settled server evidence

Eligible client view computations can initialize clean from matching settled
server input/output evidence. Registration installs their observed writer
surfaces and complete wake dependencies before establishing that state. The
first invalidation retires adoption and uses the ordinary guarded execution
path; subsequent server plans do not re-adopt a computation that has run.

The source identity, plan generation, admitted inputs, local coverage, and
recursive producer fingerprints all remain required. Omitted ancestors use the
existing conservative proof. Server-adopted state does not create a successful
local outcome, so downstream reads still validate the server basis. There is no
new public flag, transport message, or scheduler snapshot. The existing global
and web-class view-replication settings govern the optimization.

## Validation

The full runner package passes 1,456 tests and 9,254 steps, with zero failures
and one ignored step. The runtime-client package passes all 32 groups and 668
steps. Repository lint, type checking, documentation, package-cycle, and
formatting checks pass after the recorded test-stub and formatting corrections.

The uninstrumented shell flag test passes with the public feature enabled and
disabled, including actual browser worker initialization. The enabled lunch run
passes concurrent two-user voting and later edits. The disabled lunch run
completes its functional assertions but fails its console-error gate on a CFC
refusal: `ownerPrincipal requires writeAuthorizedBy at /`. The same console
refusal reproduces with the runner production sources restored to the previous
PR head, `f59231ee3d9a1cf85b37076639067b648b7fa64b`, without this optimization.
Its control also completes the voting assertions before failing the
console-error gate. The enabled command took 104 seconds overall, with 21
seconds reported for the test step; the disabled command took 105 seconds
overall, with 53 seconds reported for its failed step. Timing rows are retained
for the failed arm too, and neither is treated as a controlled latency sample.

The initial instrumented flag prelude passed its assertion but needed assisted
Chrome termination during teardown. It is excluded as clean flag-validation
evidence. The later uninstrumented flag runs and all six topic drivers exited
without that intervention. An externally terminated first runner-suite process
is likewise recorded as incomplete, with a separate full run used for
validation.

The real stored-graph regression failed without adoption: the visible body ran a
second time on the client after the server had already settled it. With the
change, initial client executions are zero and the first edit recomputes once.
Seventeen focused tests cover matching proof, changed inputs/outputs/ancestors,
missing and cyclic evidence, source and runtime fencing, coverage changes,
omitted-ancestor plan changes, downstream proof provenance, ordinary/effect
registration, and shared producers whose local recomputation keeps the same
value. No new polling, timeout, or retry mechanism was added.

## Controlled change and measurement boundaries

Six fresh 30-topic fixtures alternate adoption on/off/on/off/on/off. Both server
execution and view-scoped replication are enabled in all six arms. An
artifact-only literal bypasses the adoption helper for the control; this is not
the public feature flag comparison. The source base is
`f59231ee3d9a1cf85b37076639067b648b7fa64b` plus this change. Source hashes and
instrumentation patches identify each arm.

Chrome runs with `HEADLESS=1`. Startup includes login, rendering, mount
acknowledgment, registry and runtime readiness, and an explicit local graph
registration event. The driver verifies the board and all 30 topic identities
before capturing counters, then opens a topic and checks its title and linked
content. Captures retain every phase, browser errors, IPC failures and pending
requests, command exit status, and server/main/worker sampling profiles.

| Arm   | Authored executions | Proof ms | Entered authored attempt ms | Binding ms | Startup ms | One-minute load |
| ----- | ------------------: | -------: | --------------------------: | ---------: | ---------: | --------------: |
| on-1  |                   0 |     61.0 |                         0.0 |     1183.0 |      17517 |           194.7 |
| off-1 |                 121 |      0.3 |                      1414.4 |     1069.8 |      14941 |           335.2 |
| on-2  |                   0 |     72.1 |                         0.0 |     1401.7 |       7955 |           126.2 |
| off-2 |                 121 |      0.3 |                      1273.9 |     1035.4 |       9564 |            53.7 |
| on-3  |                   0 |    111.3 |                         0.0 |     1360.5 |       6455 |            48.7 |
| off-3 |                 121 |      0.2 |                       822.2 |      656.9 |       4870 |            33.9 |

Every arm registered 61 graphs and 1,033 bindings. The unchanged internal action
count was 33 in every arm. All six drivers exited zero, with no browser errors,
failed IPC requests, pending requests, or failed sampling captures. Initial
adoption eliminated 121 authored executions in every enabled arm. The control
spent 822–1,414 ms in those entered attempts; the initial adoption checks took
61–72 ms. The third enabled arm additionally revalidated adopted evidence before
the startup snapshot. These sums describe work, not elapsed startup improvement.

The authored action time is the sum of entered scheduler-attempt spans, not an
isolated measurement of pattern-body CPU. Spans and proof checks include the
costs of their instrumentation. Non-idle profile time is sampled time, not a
controlled CPU benchmark. This campaign establishes saved work; extreme,
variable shared-machine load prevents a latency claim.

Initial adoption checks include ineligible registrations and stop early when
proof is unavailable. Revalidation also runs on plan and coverage changes.
Coverage currently scans adopted nodes in the space; it does not maintain a
separate reverse index solely for adopted evidence. The third enabled trial
received a generation-one empty plan for a secondary view after the 61 graphs
had installed. That accepted plan caused 121 successful rechecks (48.2 ms) and
126 extra guarded attempts that parked before entering a body. It added no
bindings and ran no authored bodies. The first two enabled trials captured
startup before this extra plan pass. More selective plan wakes remain a possible
follow-up if they matter under controlled load.

## Delivery limits

The PR has separate preexisting lifecycle and plan-delivery review findings, and
its previous head has failing CI jobs. This change does not claim to resolve
those findings or make the complete feature ready to merge. No deployment or
merge was performed.

## Evidence

The [results](2026-09-11-view-replication-server-currency.results.json) record
source hashes, exact commands, every trial, phase timings, profile hashes,
validation outcomes, and interventions. The diagnostic checkout and
successful-trial stores were removed after checking that owned servers and store
handles had closed. The two failed CFC control stores are preserved with the
artifacts for investigation. Raw logs, source snapshots, instrumentation,
browser profiles, and review triage are retained at
`/Users/berni/.codex/artifacts/view-server-currency-2026-09-11/`.
