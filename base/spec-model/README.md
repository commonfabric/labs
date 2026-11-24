# @commonfabric/spec-model

Executable mini-models of in-progress specs, checked by property tests over
explored schedules. NON-NORMATIVE: the spec documents govern; a disagreement
between a model and its spec is a finding against one of them, resolved in the
spec's ruling process — never silently in the model.

## server-execution

Models the **identity/commit machinery** of `docs/specs/server-side-execution/`
(the v2 spec, PR #5269) as ruled through 2026-08-03: commit classes and
envelopes, `firedAt` stamping and actor inheritance (uniform across run kinds —
LT6), same-space cascade carriage (LT1), delegated cross-space carriage and
stamping, the wave with commit splits, `eventWatermark` idempotency, the
crash-lossy process-local outbox, navigateTo's session-connection requirement
(LT3), the effect channel's enact/ack window (LT8), the lease fence (DR1:
per-process holder + the in-process abort-before-reacquire discipline, with the
discipline-off residue characterized), the mid-wave conflict machinery (staged
compute/commit waves with per-doc CAS per write class: superseded pure writes
DROP, raced consequences REQUEUE — never lost, never doubled — unrunnable events
DROP with a notice, and budget-exhausted waves commit with W pinned), and
`scope_key` push filtering.

Why it exists: the scenario-trace and field-provenance instruments (see those
docs' §1 protocols) check hand-enumerated journeys and per-field chains; neither
explores SCHEDULES. The model does — small configurations, exhaustive
interleaving with fault injection — and it runs unattended (`deno task test`),
so every future ruling batch can be re-verified mechanically.

One test began as a **characterization of ledger item FP1** (the lost-append
crash trace, asserted reachable). FP1 RULED 2026-08-03 — durable append rows in
the wave's own transaction, deleted on delivery-ack — and the test now asserts
CLOSURE: no schedule loses an append, delivery stays exactly-once across
crashes, and recovery re-sends pending rows.

Scope narrowing and fan-out ARE modeled, as a bounded self-contained sub-model
(Phase 2's OW3 pre-gate; `FanoutState`/`applyFanout` in
`server-execution/model.ts`): one scoped node downstream of one shared
space-scoped input, pinning the three bound rules — clean-product instance sets
(never ragged), `action × instance` as the run unit, and ONE unforked W waiting
on demanded siblings only. Steps naming a principal outside the configured set
are rejected (no-op), so the explored space stays inside the clean product by
construction.

Deliberately NOT modeled (extend when a question needs them):
scheduler/dirtiness internals, the basis index, CFC label ladders, speculation
values (only the enacted-nonce overlay record), offline queues, quotas,
`.inSpace` provisioning. Values are counters; docs are key-value rows; one
memory server hosts all spaces (the spec's co-hosted assumption).

This package is the seed of `testing.md` §5's `sx2` conformance surface: as
Phase 1 stages land, their semantics (lease, seal, watermark) should be checked
against these properties before the real implementation exists, then the
properties become the implementation's oracle.
