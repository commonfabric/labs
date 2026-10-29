---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Recommendation 6 verification and decision at the recorded main head."
---

# Demand grace and the consequence-flush deadline

Recommendation #6's disposition is to retain both the 100 ms flush deadline
and the 300 ms demand grace. Source inspection and a controlled serving-loop
probe do not support a universal 300 ms cold-session floor. They do establish
that demand notifications coalesce into a callback and that input-driven
cycles can reconcile demand before that callback fires. No constant was
changed. The comments and normative measurement guidance were corrected to
match these boundaries.

The current capture uses main
`3aee034aff7672391bf037a4eba44d9d279cb986`, Deno 2.9.4, with the exact
comment/documentation patch in the evidence directory. This main includes the
identity/no-op admission and nested-snapshot changes that landed during the
campaign. The earlier capture at
`d66493076b00ad62533436dcbfb91163e63354b9` is retained separately. Shared
verification is tracked in PR #7229; recommendation #6 is independent of the
unmerged runtime recommendations.

## Controlled observations

The probe uses a fresh emulated memory store, a real serving runtime with ON
posture asserted, and three durable plain roots. A facade controls demanded
roots. It intercepts only the grace callback, and waits on actual loop-idle
registration rather than elapsed sleeps. Input-backstop and deadline callbacks
remain observable. Every snapshot requires zero firings of either and zero
exhausted cycles, including the deadline's direct clock-check path.

| Phase | Grace arms / fires | Demand passes | Wave closures | Engine sequence | Watermark |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial terminal root | 0 / 0 | 1 | 1 | 4 | 3 |
| Twenty notifications, one callback fired | 1 / 1 | 3 | 1 | 4 | 3 |
| Input processed while next callback held | 2 / 1 | 4 | 2 | 6 | 5 |
| Departure and rearrival confirmed | 4 / 4 | 10 | 2 | 6 | 5 |

These are cumulative counters from one controlled schedule. Twenty
notifications add one callback and two passes, with no additional wave closure
or engine commit. The next input adds its own durable commit and a coverage
commit; its demand pass runs before the held callback fires. The departure and
rearrival phase performs a fresh confirmation of the returned root.

The actual serving session tracks one, then two, then three entities. Excluding
the serving principal yields zero client-demand entities throughout. This
separates the serving graph from the report's client-demand maximum. It is not a
measurement of a Topics board's production graph.

## Deadline and accounting contract

The active wave's flush deadline and the idle demand grace govern different
work. Under sustained multi-user input, the deadline allows already sealed
handler consequences to become durable before all demanded recomputations
quiesce. Event IDs and per-stream consequence coverage still accompany the
flush. The space watermark remains bounded by actual input completion; an
exhausted flush does not prove quiescence. Removing the deadline would change
that consequence-visibility policy, which these observations do not justify.

`wavesBudgetExhausted` increments for exhausted zero-delta cycles that close
no wave. `waves` increments after wave closure, including vacuous or aborted
outcomes. Their ratio cannot be described as the fraction of committed waves
that exhausted. Additional cycles also do not necessarily add durable commits.
The existing cooperative-yield, event-deadline, no-op-wave, and serving-loop
regressions are the correctness controls for these distinctions.

`demandPassMs` includes awaited structure loading and terminal confirmation;
adding nested durations or assigning the entire demand-pass reduction to
confirmation would double-count work. The settle series' `graceMs` is a growth
notification-to-attributed-landing interval, including scheduling and work. Its
name does not make it a measurement of the timer alone. Growth attribution is
an adjacency heuristic, not proof that one notification caused one commit.

## Evidence and limits

[Captured scripts, manifests, compact raw results, and replay instructions](../../../../scripts/server-execution-topics/evidence/2026-09-10-demand-grace/README.md)
bind each run to its head, helper, exact patch, runtime, command, and load. The
runtime emission comparison verifies that the two source-file edits only
change comments. Full outputs have durable retrieval paths and hashes; no
binary or real user payload is part of this record.

The measured machine was far above the protocol's quiet threshold. These
captures establish mechanism, not an end-to-end latency benefit, a demand-grace
optimum, or multi-user fairness under all schedules. The timer hook deliberately
controls the schedule; its counts must not be generalized to arbitrary machine
load. There is no grace-constant ablation because the proposed universal floor
is already contradicted by the unchanged implementation. A future tuning
proposal would need paired quiet runs, matched fixture and completion
conditions, burst/liveness and creation-race controls, and multi-user
consequence-visibility evidence. The campaign's final aligned cumulative and
quiet-latency comparisons remain separate outstanding gates at this snapshot.
