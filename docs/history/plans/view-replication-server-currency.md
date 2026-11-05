---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Executed initial server-currency adoption and its regression, browser, and alternating startup validation; records an existing feature-off CFC control failure."
---

# Initialize view computations from settled server evidence

Status: executed. Initial server-currency adoption uses the existing global
default and client-class view-replication overrides. The
[execution report](../development/performance/2026-09-11-view-replication-server-currency.md)
records passing regression and enabled browser checks, six startup diagnostics,
and an existing feature-off CFC failure reproduced on the previous PR head.

## Result

A client opening an unchanged view can render the server's current values
without executing each eligible computation once merely to establish local
scheduler state. A subsequent input change invalidates the affected node and
uses the existing guarded speculation path.

Retaining partial graph registrations removes repeated registration and the
initial executions caused by replacing those registrations. This proposal
targets the initial execution of each retained computation. It does not change
server demand, replication selection, handlers, raw factories, fetches, LLM
calls, or durable event settlement.

## Reuse the evidence already sent

View plans contain source identities, eligible action IDs, producer write
surfaces, and settled producers' input and output fingerprints. These are
observations of actual executions, including transitive producer dependencies.
The client already validates them before consuming a producer's value.

Use that proof for initial state as well. A sequence watermark alone cannot
prove that the local value is current: inputs may have changed locally, an
overlay may cover the stored output, and a referenced producer may lack current
evidence. Both input and output values must match, and the recursive producer
proof must succeed under the current view and identity.

The conservative version needs no new Memory message or scheduler snapshot on
the wire. Missing, cyclic, or invalid proof takes the existing guarded execution
path. Unknown input still suspends execution without writing an output.

## Scheduler integration

1. Add a registration option for a view computation's proposed initial state. In
   the same synchronous registration operation, establish its read dependencies
   and writer edges, verify the current source, plan generation, eligibility,
   coverage, and recursive value basis, then mark it clean only if the proof
   succeeds. Avoid an interval in which the node is clean but has no wake
   dependencies.
2. Record that the initial state came from server evidence. Do not create a
   successful local outcome: `createProducerCheck()` can short-circuit on a
   successful local outcome, which would bypass the fingerprint proof that
   justified adopting this state. A clean node with server evidence must still
   be checked through the server-proof path when a dependent reads it.
3. Seed dependencies from the node's observed reads and outputs and from every
   producer basis visited by the proof. Output changes matter because local
   overlays can make an otherwise matching input basis insufficient. Use the
   existing scoped reactivity indexes and producer traversal.
4. Revalidate or invalidate adopted state on plan replacement and coverage
   changes as well as ordinary value changes. A server dependency may be omitted
   from the local replica; a plan update can be the only evidence that it
   changed. The current plan wake path visits unavailable nodes, so it must also
   account for clean nodes carrying adopted state.
5. On invalidation, retire adopted evidence and use ordinary local execution,
   including unavailable-read parking, registration fencing, speculation
   overlays, and commit/wave settlement. An actual successful local execution
   may then use the existing local-outcome path. Unmount, source replacement,
   and runtime retirement discard adopted state.

The first version should adopt only at registration. It should not replace
in-flight local work or overwrite local values when later plans arrive.
Continuous adoption after each server response is a separate decision with a
larger interaction surface around outstanding intents.

## Size and boundaries

This is one moderate runner change, larger and more correctness-sensitive than
retaining bindings. A reasonable review budget is roughly 250–450 production
lines and 350–650 test lines. These are planning ranges, not a change limit;
reuse of existing registration plumbing determines the lower end.

Likely production surfaces:

| Surface                                          | Responsibility                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/runner/src/runner.ts`                  | Request adoption for eligible JavaScript computations during view binding                 |
| `packages/runner/src/view-replication-client.ts` | Expose current proof and collected dependencies without duplicating validation            |
| `packages/runner/src/scheduler/facade.ts`        | Register, adopt, invalidate, and retire initial state                                     |
| Scheduler registration/node records              | Atomically seed dependencies and distinguish adopted state if an explicit field is needed |

No changes are expected in components, patterns, Memory transport, or server
execution. A need to change those boundaries is a reason to revisit the scope
before expanding implementation.

## Decisions and trade-offs

- **Reuse conservative fingerprints.** Current shallow observations have
  whole-value fingerprints. Those can create extra invalidations but avoid a
  protocol change. Recovering shallow-read precision can follow measurement.
- **Validate before saving work.** Recursive proof checking has a cost. The
  optimization is useful only if it costs less than the executions it avoids.
  Share a proof within a synchronous validation pass; do not retain a proof
  across changes without explicit invalidation.
- **Keep provenance distinct.** Server evidence can justify an initial clean
  value; it is not evidence of a successful local attempt. Collapsing those
  concepts creates a correctness shortcut through downstream currency checks.
- **Prefer fallback to broader replication.** An unprovable node should retain
  existing guarded behavior. Do not fetch more inputs merely to make adoption
  succeed, which could erase the replication benefit.
- **Start with initial state only.** This bounds the first implementation and
  its tests while capturing the startup use case. It does not promise to skip
  local recomputation after every server response.

## Implementation and evidence gates

- [x] Add failing tests for an eligible computation whose settled server inputs
      and outputs match: initial client body count is zero; first input edit
      runs it and produces the correct preview.
- [x] Reject adoption for a changed input, changed output/overlay, absent
      producer proof, cyclic proof, source mismatch, or incomplete coverage.
- [x] Prove wakeups for direct and transitive input changes, output changes,
      same-value producer settlement, coverage loss, and plan changes whose
      upstream documents are not replicated.
- [x] Fence delayed plans, source replacement, remounts, runtime replacement,
      and edits racing initial registration. Confirm that server-adopted state
      never takes the successful-local-outcome shortcut.
- [x] Implement the registration option and lifecycle changes. Preserve handler
      intent, noneligible computations, effect cut points, and unavailable-read
      poisoning.
- [x] Run runner and runtime-client tests, browser flag propagation checks,
      topic startup/navigation, and lunch-poll edits. Check both first and
      subsequent interactions and wait for durable completion.
- [x] Measure headless startup with server execution on in both arms,
      alternating adoption enabled and disabled against the same source and
      fresh fixtures. Report initial computation counts, proof cost,
      registration cost, registry readiness, total startup, and errors/pending
      requests. Include an unchanged workload as control and record machine
      load.

A smaller body count is a mechanism check. A latency claim requires unprofiled
interleaved measurements under controlled load. Retain the optimization only if
proof checking saves meaningful startup work without delaying the first edit or
weakening any currency guard.
