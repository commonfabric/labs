---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Browser reload checks of eager materialization and default-on controls."
---

# Lazy materialization: notebook reload evidence

These runs extend the [integration evidence](2026-09-14-lazy-off-integration.md)
for the [fast-follow plan](../../plans/lazy-materialization-fast-follow.md).
They do not establish posture equivalence or complete the retirement gate.

## Scope and method

The source revision was `b735851af53cfb4ebb2606a64c9ae6156fb8e379`. It does not
include the held synchronous lift-refusal fix. Every run used a new synthetic
identity and space, an isolated local toolshed, and a headless browser. No live
piece or copied production database was used.

`deno task integration patterns-reload` runs
`packages/patterns/integration/reload/default-app-notebook.test.ts`. Its case
creates seven notes rapidly, checks their source state, reloads the browser, and
asserts that all seven notes are present and rendered.

For the eager runs, the Runtime constructor's built-in `lazyMaterialization`
default was temporarily changed to `false`, and
`EXPERIMENTAL_LAZY_MATERIALIZATION=false` was supplied to the processes. The
constructor override covers browser and direct Runtime construction, which the
process environment alone does not switch. Explicit Runtime options still win.
`EXPERIMENTAL_SERVER_EXECUTION` selected each execution mode. The default-on
controls restored the constructor default and set both environment flags true.
All temporary source changes were restored.

The integration task owned random local ports and server cleanup. One early
served eager attempt stopped during dependency loading after files disappeared
from the shared Deno cache. That attempt is excluded from the functional
comparison. Subsequent runs used a task-specific cache populated from the frozen
lockfile, including SQLite's native library.

## Results

Durations below are the test runner's durations, not startup-inclusive
performance measurements.

| Lazy materialization                | Server execution | Result                                                                                |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| Off                                 | Off              | 1 test / 1 step passed, 0 failed; 11 seconds                                          |
| Off                                 | On               | 1 test / 1 step failed on recorded browser errors; 26 seconds                         |
| On                                  | On               | 1 test / 1 step failed on the five-minute stuck-condition guard; 5 minutes 14 seconds |
| On, with temporary test diagnostics | On               | 1 test / 1 step passed, 0 failed; 21 seconds                                          |

Each completed integration command exited with the corresponding success or
failure status after server cleanup.

The served eager run reached the stored-note and rendered-note assertions and
printed its scheduler summary. Test teardown then rejected recorded browser
errors: `Cannot read properties of undefined (reading 'split')` in
`splitDefinitions`, called by two computations in `notes/note.tsx`.
`notes/reference-block.ts` declares that function's input as a string and calls
`body.split("\n")` directly.

That symptom matches the eager unresolved-input failure recorded in the
[rollout evidence](2026-09-11-lazy-materialization-f3-rollout-evidence.md#both-postures-on-the-test-suites).
This browser run does not establish which unresolved link supplied the absent
value, so the shared symptom alone is not a complete causal diagnosis.

The first default-on control reported only that `waitForCondition` did not
resolve within 300,000 milliseconds. It did not identify the waiting predicate.
A diagnostic run added phase logging around the existing steps and a screenshot
at test-body exit. It reached every phase, including verification of seven
rendered notes, and passed. The test instrumentation was restored afterward.
That pass does not explain or invalidate the earlier stuck-condition failure.

## Limits and remaining work

The eager browser errors are an observed failure of rollback-mode acceptance.
The default-on control's inconsistent results also prevent a clean comparison.
The pending retirement decision must account for these results; neither is a
reason to mark the fast-follow complete.

Further diagnosis should identify the unresolved input in the eager run and the
waiting predicate in a failing default-on run. A decision to retain the eager
rollback path needs to address its runtime errors. Removing that path still
requires the flag owner's ruling and the other acceptance gates in the plan.

The test also records an ancillary DOM quiet-period metric using a
100-millisecond timer and a one-second cap. Those metrics were not used for
acceptance or a performance claim. A separate test-cleanup pass should review
that measurement against
[the waiting guidance](../../../development/waiting-in-tests.md).
