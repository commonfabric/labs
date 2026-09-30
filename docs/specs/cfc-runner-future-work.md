# CFC runner future work — prioritized implementation gaps

_Started 2026-07-01. Audit of the normative CFC prose spec (18 chapters + Lean
formalization) against the implementation in `packages/runner` (primarily
`packages/runner/src/cfc/`). Companion to
[`cfc-spec-changes.md`](./cfc-spec-changes.md) (which tracks edits the **spec**
needs); this file tracks work the **runner** needs._

> **Spec references.** The CFC prose spec + Lean formalization live in the separate
> [`commonfabric/specs`](https://github.com/commonfabric/specs) repo under
> `cfc/`. References below of the form `§3.1.8`, `04-label-representation.md`,
> `notes/…`, or `proposals/…` are paths within that repo — e.g.
> [`cfc/proposals/author-disjunctive-confidentiality.md`](https://github.com/commonfabric/specs/blob/main/cfc/proposals/author-disjunctive-confidentiality.md).
> References of the form `packages/…` and `docs/specs/…` are in this repo.

This list is ordered **big chunks first**: close the load-bearing structural
gaps, then fill the small holes. Dependency order matters — several small holes
and two whole epics collapse into one foundation (Epic A), so building that first
avoids throwaway work.

## Where the runner stands

The runner soundly implements the **flat "ceiling + required-integrity" fragment**
of CFC, and enforces all 8 of its own commit-gate invariants (relevant⇒prepared,
digest-invalidation, verifier-read exclusion, fail-closed on missing
schema/metadata/unsupported claim, commit-gated side effects, fresh-retry, system-
controlled metadata, coarse `classification` summary). Its remit — the reactive
commit boundary — is well covered.

**The organizing theme.** The runtime represents a label as a *flat set* —
`IFCLabel = { confidentiality?: unknown[]; integrity?: unknown[] }`
([`label-view-core.ts:5`](../../packages/runner/src/cfc/label-view-core.ts)) — with
union join and exact-`deepEqual` matching against static allow-lists
([`prepare.ts:2481`,`:2497`](../../packages/runner/src/cfc/prepare.ts)). The spec's
algebra is **CNF clauses (AND-of-ORs) + exchange-rule evaluation + pattern-matching
+ trust-closure + observation-class refinement**. Almost every big gap below is a
facet of that one representational distance. Most of the flat model's narrowness is
*fail-closed* (it over-restricts — safe), but a few edges are genuine soundness
holes, called out explicitly.

**Default posture.** The commit gate is on by default: the Runtime constructor
defaults `cfcEnforcementMode` to `enforce-strict`
([`runtime.ts:495`](../../packages/runner/src/runtime.ts)), as does lib-shell's
`createRuntimeClientOptions` — the types-level
`DEFAULT_CFC_ENFORCEMENT_MODE = "disabled"`
([`types.ts:42`](../../packages/runner/src/cfc/types.ts)) is only the
bare-transaction fallback. Flow labels persist and the render confidentiality
ceiling is built by default, so the one reject the strict rung adds — the
writer-fit misfit — is exercised in deployment rather than dormant. A host that
wants less states it.

---

# Tier 1 — Big chunks (close these first)

Listed in dependency order. **A is the keystone** — B and much of F stand on it.

## Epic A — CNF clause label representation (the shared foundation)

**Size: large. Soundness + expressiveness. The single highest-leverage item.**

Change `IFCLabel.confidentiality` from a flat `unknown[]` to `Clause[]`, where
`Clause = Atom | { anyOf: Atom[] }` — the 1:1 runtime form of the spec's
`Clause = Atom | Atom[]`. Generalize join to clause-granular concat+dedup (never
merge alternatives), and generalize the ceiling-fit check
(`cfcObservationFitsCeiling`/`atomsOutsideCeiling`,
[`observation.ts`](../../packages/runner/src/cfc/observation.ts)) from flat subset to
**clause subsumption** (`∀ clause l ∈ L. ∃ clause c ∈ ceiling. alts(c) ⊆ alts(l)`),
with a flat/flat fast-path that is byte-for-byte today's check. Then the
**flat-assumption sweep**: every `for (const atom of confidentiality)` consumer
(`uniqueCfcAtoms` call sites, `sink-inventory.ts`, `ui-contract.ts`,
`schema-sanitization.ts`, introspection projections). Ship behind a mixed-version
fail-closed test.

- **This is exactly the disjunctive-confidentiality proposal's §9 runtime outline**
  (`proposals/author-disjunctive-confidentiality.md` §9), which is Adopted
  (2026-06-09) into the normative spec (§3.1.8, §4.2.1, §8.10.3, §8.17, §18.5). The
  design + adversarial pass are already written.
- **Directly delivers:** author-written OR-clauses — "confidential to A **or** B,
  either can release alone" — which the flat model literally cannot represent (it
  flattens `[[A∨B]]` to conjunctive `{A,B}`, the *stronger* reading: safe, but the
  feature is impossible).
- **Fixes a real soundness hole (the reason this is not merely expressiveness):**
  §8.10.3 ceiling fit is *unsound* the moment a ceiling is read as a **reader
  enumeration**. A multi-party value `[User(A), User(B)]` (nobody alone may read)
  passes a flat `{A, B}` ceiling under the current `∀clause ∃reader` quantifier —
  and is then shown to A alone, violating B's clause. Clause subsumption
  (`∀reader ∀clause`) closes it. Deployed conjunctive ceilings must keep their
  meaning (a list = conjunctive; an `anyOf` entry = reader enumeration).
- **Depends on:** nothing. **Unblocks:** Epic B (entirely), Epic F (aggregates,
  read-time clearance), several Tier-2 items.
- Ref: `cfc-spec-changes.md` SC-1 (components), and the proposal §5.3 (the
  quantification hole), §9 (runtime outline).

## Epic B — Exchange-rule + policy evaluator (built on Epic A)

**Size: large (a second evaluation engine). Unblocks 5 safety invariants.**

The runner has **no** exchange-rule or policy machinery of any kind — confirmed by
whole-repo grep (zero hits for `exchangeRule`, `PolicyRecord`, `lookupPolicy`,
`canAccess`, `trustClosure`, `matchAtomPattern`, `fixpoint`, `fuel`, `HasRole`,
`declassif`, `EndorsedIntent`). Exchange rules are the guarded, policy-authored
rewrites that *add an alternative to a clause* — the single mechanism through which
disjunction, caveat discharge, declassification, and role/space grants all arise.
Its absence means the runtime **can never release or declassify anything** — it can
only accumulate taint conjunctively and fail closed.

Decomposes into (dependency order — 1/2/3 can parallelize once A lands):

- **B1 — Atom pattern-matching + variable binding.** `AtomPattern`/`AtomVariable`
  unification, `substituteVars`/`instantiate`, multi-binding (§4.4.5). Register the
  ~10 missing atom families (`Space`, `HasRole`, `User`/principal, `Policy`/
  `Context`, `Concept`, `Role`, `CaveatScreened`, `BoundaryContext`, `Expires`) in
  [`packages/api/cfc.ts`](../../packages/api/cfc.ts) + spec ch.15. Biggest self-
  contained algorithmic piece. **This is the "rich matcher" that also fixes the
  requiredIntegrity soundness edge** — see below.
- **B2 — Policy-record store + content-addressed lookup.** `PolicyRecord`/
  `ExchangeRule` types, `lookupPolicy` (fail-closed on hash mismatch),
  `collectPolicyPrincipals` over the clause-structured label, trusted discovery
  roots (§4.4.1–4.4.3).
- **B3 — Trust closure over the acting principal.** The `I ≥_actingUser Concept(C)`
  resolver under a `trustContext` (§4.4.5, §4.8.9) — feeds concept-valued integrity
  matches; mints per-user `HasRole` facts. Delivers invariant 11.
- **B4 — Guarded rewrite + fueled fixpoint.** `applyExchangeRule` (add-alternative
  + empty-postcondition drop) + `evaluateExchangeRules` fixpoint with bounded fuel
  and **hard fail-closed on exhaustion** (§4.4.5); then post-rewrite `canAccess`.
- **B5 — Boundary hook.** Wire the evaluator into `prepareBoundaryCommit`
  ([`prepare.ts:3095`](../../packages/runner/src/cfc/prepare.ts)) and the sink/
  observation path; mint `BoundaryContext` atoms (sink, sinkClass, fieldRole,
  purpose, intentId); replace the flat `deepEqual` ceiling check with
  evaluate-to-fixpoint → `canAccess`.
- **B6 — Prompt-caveat tier profile as data.** Express unscreened→ingress→
  value-screened tier upgrades and material-risk/influence discharge as ordinary
  exchange rules (§10.1, §8.10.5), then **retire the hard-coded special-case**: today
  [`schema-sanitization.ts`](../../packages/runner/src/cfc/schema-sanitization.ts)
  bulk-strips the four tier kind-strings identically (no transition, no evidence
  binding, no clause locality) — exactly the "prompt-specific runtime branch"
  §10.1 says MUST be replaced by exchange rules.

**Delivers safety invariants 3, 5, 6, 10, 11**, all declassification/endorsement
release paths, and the disjunctive-release semantics ("any alternative releases its
clause"). **Also fixes a soundness edge inside B1:** the current `requiredIntegrity`
gate is exact `deepEqual` and lacks §8.10.3's **object-level shared-witness-key
coherence** — heterogeneous per-leaf integrity can satisfy an object-level
requirement the spec would reject. That is the one requiredIntegrity narrowing that
is *not* fail-safe.

- Ref: `cfc-spec-changes.md` SC-15 (class-aware meet), SC-22 (impl identity);
  invariants §10; §10.1 prompt-caveat profile.

## Epic C — Observation classes / `PathLabelTemplate`

**Size: large. Closes two documented information channels. Independent of A/B.**

Today one label per path is consumed identically by every read *shape*. Implement
the §4.6.3 observation-class model (`shape` / `value` / `enumerate` / `count` /
`followRef`) so a read consumes only the label of the observation it actually made.

- **Closes SC-4 existence channel** — overwriting a derived label today also shrinks
  the *existence* label, leaking "this path was once written" as a public bit
  (acknowledged in-code at [`prepare.ts:1191`](../../packages/runner/src/cfc/prepare.ts)).
- **Closes SC-8 pointer-identity-at-a-slot** — which element sits at a slot,
  observed without dereferencing, is not separately labeled. The `structure`
  labelMap component is only a partial container-shape mitigation.
- **Also enables** public reads of low-labeled child fields under a secret parent
  (today the flat model must take the max), and fixes the sqlite null-origin/
  computed-column over-labeling.
- **Depends on:** nothing structurally, but interacts with A (labels become
  clause-structured per observation class). Ref: SC-4, SC-8; §4.5.2, §4.6.3.

## Epic D — Write-side & agent integrity enforcement (the live soundness cluster)

**Size: medium-large. This is where a flow can actually escape control today.**

Four coupled gaps; the coupling is the point (you cannot fix the last two without
the middle one):

- **D1 — `requiredIntegrity` write-target floor (§8.12.4.1).** `requiredIntegrity`
  exists only as a *consume-side* gate; there is no check of the *written value's*
  integrity against a declared floor. A store path declaring "must be GPS-measured"
  gets no write-side rejection of untrusted writes. (SC-18 integrity direction,
  decided but unhomed in §8.10.)
- **D2 — Per-write data-flow provenance.** Gate each protected write on the reads
  that *actually fed it*, not the transaction-global consumed set. The enabling
  machinery for D3, and the reason D3 can't be fixed in isolation (see the in-code
  TODO at [`prepare.ts:2383`](../../packages/runner/src/cfc/prepare.ts): tightening
  the vacuous pass without per-write provenance would over-reject). "Potential and
  Final Write Sets."
- **D3 — Trusted-agent tool-input `requiredIntegrity` enforced, not decorative.**
  Today tool-invoke never checks model-supplied input against
  `inputSchema.ifc.requiredIntegrity`; the only gate is write-target-scoped; and it
  is **vacuous when the consumed-read set is empty** — a plain model-output literal
  skips it entirely, so an injected `sendMail` recipient is sent under `enforce`.
  (`docs/history/specs/cfc-trusted-agent-tool-integrity.md`.)
- **D4 — `LlmDerived` / untrust stamping.** Untrust is represented only as
  *absence* of an integrity atom, so a `requiredIntegrity` gate can fail only on
  absence — which, combined with D3's vacuous pass, lets model bytes pass silently.
  Stamp `LlmDerived`/`DerivedFromAdmitted` at `createToolResultMessages` / message
  append. (§14.2.2 — note this is a "Proposed" spec surface.)
- **Depends on:** Epic B's matcher for concept-level floors (D1); otherwise
  standalone. Ref: SC-18; `docs/history/specs/cfc-trusted-agent-tool-integrity.md`.

## Epic E — Row-set reads, per-row labels & sqlite Phase 3.b/3.c

**Size: medium-large. Mostly unblocked by Epic A.**

The sqlite per-row work surfaced a cluster of general row-set semantics (§8.17) that
are partly built (skip/fail modes, aggregate integrity meet — verified present in
`builtins/sqlite/row-label-read.ts`) but blocked on OR-clauses for the rest:

- **Aggregates on rule-bearing tables** (`COUNT`/`SUM`/…) — refused today; sound
  once the OR-clause **common-alternative property** (§8.17.4) lets `dbOwner()` as an
  unconditional alternative make `COUNT(*)` readable by the owner with no fallback.
  **Needs Epic A.**
- **Read-time clearance / per-user filtered views** (Phase 3.b) — filter rows by
  who's asking, not by a declared output ceiling. Impractical today. **Needs Epic A.**
- **Non-attributable writes** — `INSERT…SELECT`, upserts, columnless INSERT, named
  params, unparseable SQL all fail closed because the runner gate can't verify which
  columns receive labeled inputs. **Needs Phase 3.c server-side commit-time label
  re-derivation.**
- **Cross-table joins over rule-bearing tables** — deferred; rule-input provenance is
  ambiguous across table boundaries.
- **Content-derived integrity is forgeable** — `when(matches(auth, /dmarc=pass/)) →
  authoredBy(sender)` lets any row writer mint provenance unless the `auth` column
  carries trusted-ingestion integrity. Ties to D2 (per-column input integrity);
  interim fix is a self-describing `ClaimedAuthoredBy` family.
- Ref: `docs/specs/sqlite-builtin/06-cfc.md`, `plans/cfc-phase3-per-row.md`,
  `08-open-questions.md`; §8.17.

## Epic F — Range-scoped integrity for collaborative documents (§14.4.8)

**Size: large but most speculative — least blocking; schedule after the others.**

The flat model carries one label per value; collaborative materialization (OT)
needs **per-range labels on a single field** — "range [0:100] authored by Alice,
[100:200] by Bob" — plus witness-bearing materialization and anchors/partial reads.
Related: `IntegritySummary(semantics="covered-by")` — the runtime can't encode the
semantic quantifier ("every surviving part is covered by ≥1 signer"), only a flat
atom set. Expressiveness (over-restricts, safe), and the spec itself marks the full
collaborative-doc model as a downgraded/future area. Ref: §14.4.8, §3.1.6.

## Epic H — Enforcement & flow activation (smaller than the engines, high leverage)

**Size: medium. Mostly flipping defaults onto conforming states — do early.**

Not new machinery so much as turning the system on:

- **Flow-labels `off` outside the presets → inv-9 partial.** The router-attack
  flow-taint (§10's own worked example) is stamped where the shell runs
  ([`lib-shell/src/runtime.ts`](../../packages/lib-shell/src/runtime.ts) defaults
  `cfcFlowLabels` to `persist`) and on toolshed, whose `productionServer`
  preset pins it to `persist`. The bare `Runtime` default is `off`, so a host
  that builds a `Runtime` without a preset runs without it. Move that default
  through `observe` to `persist`. `cfcTriggerReadGating` is `false` in every host on the
  same footing — turning it on joins the §8.9.2 trigger reads to both
  enforcement gates, the sink-request ceiling and the
  `requiredIntegrity` input gate
  ([`prepare.ts`](../../packages/runner/src/cfc/prepare.ts) `triggerReadSources`),
  which closes the direct trigger channel; multi-hop closure follows once flow
  persists (SC-3).
- **`enforce-strict` default deployment states.** The effective deployment
  default is `enforce-strict` (Runtime + lib-shell; the types-level `disabled`
  is the bare-transaction fallback). The strict rung carries one differentiated
  reject: the SC-18b writer-fit misfit. The per-transaction flow join landing on
  a written document must fit that document's declared store policy; under
  strict a misfit rejects the commit, and under every mode below it persists the
  measurement and flags a diagnostic. One seam answers a misfit by declaring
  rather than rejecting: a document the runtime is setting a piece up in
  takes the §8.12.5 route-2 upgrade, declaring a policy that covers the join
  in the same transaction that writes it. Implemented in
  `prepareBoundaryCommit`
  ([`prepare.ts`](../../packages/runner/src/cfc/prepare.ts)), contract in
  [`cfc-enforcement-matrix.md`](./cfc-enforcement-matrix.md) §4, asserted under
  both modes in
  [`cfc-writer-fit.test.ts`](../../packages/runner/test/cfc-writer-fit.test.ts).
  What remains is picking the conforming default deployment states from that
  matrix's §3 progression and moving the shipped hosts onto them. A piece's
  RUNNING graph is not on that seam: a lift or handler writing in a later
  transaction records no setup marker, so its target — commonly a `computed:`
  document — measures against its own ceiling, and strict refuses those
  writes until they have a route of their own. Strict
  presupposes `cfcFlowLabels: persist`: §18.6.3's conformance matrix marks
  `enforce-strict` without `persist` non-conforming, and the writer-fit
  measurement exists only where the flow join is stamped. §18.6.3 also puts the
  standard-profile display ceiling (§8.10.6) on the strict rung, where the
  runner has it as a host-passed option the enforcement ladder does not reach —
  so a deployment that moves to strict does not thereby get it.
- **Display-ceiling "shell flip."** The render ceiling is built, fail-closed and
  §15.2-shaped: `User` and `PersonalSpace` fit the acting user by exact match,
  and a `Space(...)` clause resolves through a verified `HasRole` reader fact
  under the standard display exchange rule
  ([`render-ceiling.ts`](../../packages/runner/src/cfc/render-ceiling.ts)), which
  the worker backend threads into the reconciler whenever a ceiling is in force
  ([`runtime-processor.ts`](../../packages/runtime-client/backends/runtime-processor.ts)).
  What remains is the flip: the shell builds that ceiling only behind its
  `cfcRenderCeiling` flag, which defaults off, so nothing renders under a ceiling
  today. (SC-16; §8.10.6.) Render-boundary *composition + text integrity* itself
  is owned by `packages/html` (see Out of scope).

---

# Tier 2 — Smaller holes (fill after the big chunks)

Each is bounded and mostly independent. Several are fail-safe today.

- **`addIntegrity` vs spec `addedIntegrity` — naming trap.** The runner honors its
  own `addIntegrity` spelling; the spec's `addedIntegrity` is in the *unsupported-
  keys reject list*, so a spec-conformant author is **rejected**, not honored.
  Reconcile the spelling and honor §8.7.3 boundary-verified transformer-minted
  semantics. (audit 3.6.)
- **`propagationClass` registry drift.** Working hand-maintained 12-atom map with a
  fail-safe `value-bound` default, but it diverges from §15 (`PromptSlotBound`
  classed value-bound vs spec provenance; `IntegritySummary` absent). Code-generate
  the map from a shared registry, or add a parity test that fails when §15 gains a
  hereditary family absent from `CLASS_BY_TYPE`. (SC-10/15/17.)
- **`classification: string[]` shorthand not lowered.** No `classificationToAtoms`
  anywhere in the runner — a silent no-op if it reaches the runner. Confirm the
  schema-generator lowers it first, or add the lowering. (§4.2.1, §4.7.1.)
- **`Caveat.source` redaction is display-only.** The carried-label (cross-space)
  path is not redacted, so `Caveat.source`, `Origin` URIs, and policy names remain
  observable to a destination space. Extend redaction to the carried-label path;
  the `inspectConfLabel` first-layer introspection API (§4.6.4.1) is also unbuilt.
  (inv-12; SC-14.)
- **Idempotency ledger / `X-Idempotency-Key`.** Only per-tx `outboxIdempotencyKeys`
  dedup exists; cross-retry no-double-send is delegated to per-builtin mutex +
  content-addressed keys. No runtime-level idempotency-key ledger, no HTTP header.
  (WS10; §6.5.)
- **`sinkClass` / `BoundaryContext` atom substrate on egress.** The runner owns the
  sink builtins, but caveat discharge keyed on `sinkClass`/`fieldRole`/`purpose` has
  no atom substrate on the egress path. (Overlaps Epic B5.)
- **Destination / audience-release binding at send sinks.** Bind the visible
  destination context (conversation/channel/public target) into the audience-release
  evidence. (§8.10.5.2; FUTURE-SPEC destination-binding follow-up.)
- **§6.5 intent-consumption / attempt-cell contract.** Commit-point single-use
  intent consumption + bounded-retry attempt-cell ledger (`attemptCellId`/
  `consumedCellId`). This is runner-remit even though the rest of the Ch.6 refiner
  chain is not.
- **Projection binding-scoped atom survival (§8.3).** A value-bound atom should
  survive a projection only if the runtime verifies the projected value still
  matches its scope digest. No per-atom conditional survival today (safe: drops or
  over-keeps). Setup-projection carve-out (audit 3.3) sits here.
- **Trust-snapshot determinism audit.** `trustSnapshot` is correctly in the prepared
  digest (invalidates on change), but the *provider* is not audited to be free of
  ambient mutable state (the anti-TOCTOU property behind inv-7). Verify or harden.
- **Multi-match integrity subject** (sqlite) — a global regex match over `from` may
  yield multiple senders; fail closed on >1 for integrity-bearing positions
  (already the posture) but document.
- **Stale derived labels (SC-2).** Confirm the "no retroactive relabeling of cold
  copies" model is documented as intended (policy-layer sweep, not a runtime
  invariant) — likely a doc note, not code.

---

# Tier 3 — Spec promotion, not runner code

Shipped, security-conscious runner mechanisms with **no normative home**. These are
`commonfabric/specs` edits (they belong in `cfc/notes/FUTURE-SPEC-WORK.md`), not
runner work — but they are load-bearing and an implementer could weaken them with no
spec test failing.

- **`ownerPrincipal` / `__ctCurrentPrincipal` write-authority chain** — a fully-built
  owner-binding-to-acting-principal mechanism with `represents-principal` evidence,
  zero spec text. (audit 3.5, "confirmed open".)
- **Schema-merge per-key conflict-direction table** — a monotonicity-defining
  mechanism (grow confidentiality/requiredIntegrity, narrow maxConfidentiality/
  integrity ceilings, freeze structural claims) with no §4.2.2.1 counterpart; it even
  runs *opposite* to §8.15.2 for `writeAuthorizedBy`. (audit 3.10.)
- **Post-commit sink-release re-verification** — the runner re-checks the frozen
  request snapshot after commit; §8.10 defines only pre-commit verification. Define
  the contract (what it re-verifies, whether it re-runs the ceiling). (audit 3.11.)
- **`ExternalIngest` provenance mark** — split-mint, module-private trigger,
  and bypasses `gateRuntimeMintedIntegrity`. Its vouched-channel variant
  records an audience without enforcing it; its weaker fetch variant records
  only a pinned source and makes no audience claim. Defined only in feature
  documents.
- **Atom registry parity (`ExternalIngest` / `UserSurfaceInput`).** Both are
  *already* registered in the runtime — `CFC_ATOM_TYPE`
  ([`packages/api/cfc.ts:35`,`:49`](../../packages/api/cfc.ts)) and the propagation
  map ([`atom-classes.ts:30`,`:34`](../../packages/runner/src/cfc/atom-classes.ts),
  both `provenance`) — so no runner code is needed. The residual is spec-side:
  promote them from spec example-only into the §15 atom registry, and reconcile the
  `structure`/`external-ingest` `LabelComponent` values that extend the spec's
  3-value enum. (SC-10/20.)

---

# Out of scope for the runner (owned elsewhere — not runner debt)

Large spec surfaces a different component owns; the runner consumes the *results* of
policy (store labels + write-authority claims), not these mechanisms.

| Spec surface | Ref | Owner |
|---|---|---|
| Render-boundary discharge, text-integrity meet, `sinkClass=display` gating | §8.10.5–6, inv-8/10/13 | `packages/html` reconciler (+ Epic B for atom-shaped ceilings) |
| Sandbox structured-result contract, caveat clearing, runsc/gVisor mediation, tool-invoke | §14.2.2, §18.2 | `@commonfabric/cf-harness` (runner provides the validator seam only) |
| Labeled filesystem, subagents, command/CLI exec, `node=CodeHash` identity | §14.2 | cf-harness + sibling gVisor repo |
| Tool-registry snapshot, agent plan trace, NL-refinement, measured contract | §14.1.3.5, §14.2.2.1 | cf-harness (overlaps the Reactive-Interpreter meta-node effort) |
| Direct content-addressed storage (label-bearing CAS, miss-indistinguishability) | §17.2–6 | Deferred behind causal-path rollout (WS12) |
| **Recombination attack** (overlapping declassifiers leak more than either alone) | §14.3.2 | **Explicitly OPEN research problem** in the spec — no owner; note as a known residual |
| Recursive label-metadata introspection (labels-of-labels) | §14.3.3 | Intentionally out of scope — first-layer `inspectConfLabel` only |

---

# Appendix — suggested critical path

```
Epic A (CNF clauses)  ──┬──►  Epic B (exchange-rule evaluator)  ──►  B6 retire prompt special-case
                        │
                        └──►  Epic E (row-set / sqlite 3.b)   [3.c is a separate server-side track]

Epic C (observation classes)   — independent, start any time
Epic D (write/agent integrity) — independent (D1 wants B's matcher); highest security urgency
Epic H activation (flip defaults onto conforming states) — cheap, high leverage
Epic F (range-scoped integrity) — last of the big epics; most speculative
```

Rule of thumb: **A unlocks the most** (B, most of E, and 3–4 Tier-2 items).
**D is the most urgent for security** (live soundness holes) and is largely
independent. **H is the cheapest leverage** — it depends on nothing above it,
and the hosts below the shell enforce little by default today. Everything in
Tier 3 is spec-writing, not runner code.

## Provenance

Findings from an 8-domain adversarial audit (74 raw → 44 verified gaps), a §10
safety-invariant completeness cross-check, and three focused sweeps
(docs/specs expressiveness gaps, CFC-spec algebra gaps, exchange-rule epic sizing),
2026-07-01. Load-bearing claims (vacuous requiredIntegrity gate, flow/enforcement
defaults, ceiling-fit reader-enumeration hole) were spot-verified against the code.
Cross-references: [`cfc-spec-changes.md`](./cfc-spec-changes.md) (SC-1..22 + audit
queue), and in [`commonfabric/specs`](https://github.com/commonfabric/specs):
`cfc/notes/RUNNER_IMPLEMENTATION_PLAN.md` (12 workstreams),
`cfc/notes/FUTURE-SPEC-WORK.md`, and
`cfc/proposals/author-disjunctive-confidentiality.md` (Adopted; §9 is Epic A's
runtime outline).
```
