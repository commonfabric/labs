# CFC llm-sink admission

Status: decision-gated. Nothing is built; stage 2 is mechanical once the
stage-1 decisions are made. This plan exists so the mechanism the
max-enforcement posture describes as pending is tracked work rather than a
standing note.

## The gap

The max-enforcement posture declares public-only confidentiality ceilings for
every network-fetch sink and an explicit ungated release for the llm sinks
(`llm`, `llmDialog`, `generateText`, `generateObject`). It leaves
`sqliteQuery` ungated as well, for a reason of its own that this plan does not
carry: the bound a storage read wants is the database's space rather than a
clause list, and the sqlite builtin applies it. A sink with no
ceiling gets no gate, so llm-sink release is ungoverned under the posture:
any confidentiality — a secret as much as a risk caveat — reaches the llm
sinks without a policy evaluation running for them. The sink registry records
that gap as a published deviation with a reason, an owner, and a retirement
condition (`SINK_UNGATED_RATIONALES` in
`packages/runner/src/cfc/sink-inventory.ts`), and the retirement condition is
this plan's subject: a public-only ceiling paired with an exchange rule that
admits the material-risk family at llm-class boundaries.

The gap is load-bearing once the runtime-owned-store change (#6740) is in:
before it, a pattern calling `llm(...)` over labeled content was refused by
accident — the builtin's undeclared result store failed the strict writer-fit
check in the same transaction that staged the request — and with the store
declaring what flows into it, nothing refuses llm egress under the posture on
any path.

## What already exists

Everything below is in the tree today; the mechanism is a composition of
built parts plus policy decisions.

- **The egress gate runs exchange rules.** `verifySinkRequestCeilings`
  (`packages/runner/src/cfc/prepare.ts`) gates every recorded `sink-request`
  input whose sink declares a ceiling: it mints boundary atoms
  (`BoundaryContext{key:"sink"}` with the sink name, and
  `BoundaryContext{key:"sinkClass", value:"network"}`), runs the full
  exchange-rule evaluation over the consumed label — trust closure,
  policy-state grants, module policies, consuming semantics for single-use
  grants under the enforce dial — and only then tests the rewritten label
  against the ceiling with `atomsOutsideCeiling`. So "an exact-match ceiling
  cannot admit a source-varying caveat" is true of the ceiling alone and is
  answered by the rules: a rule can rewrite the caveat clause at the boundary,
  access-time only (spec §8.12.7 route 1 — nothing persists), before the
  membership test.
- **Public-only-plus-evidence already admits at a fetch-class sink.**
  `packages/runner/test/max-enforcement-posture.test.ts` pins "admits a
  screened value: the §10.1 discharge is what fits the public-only ceiling"
  and its negative. The composition works end to end today where a ceiling is
  declared.
- **The rule vocabulary.** `STANDARD_PROMPT_CAVEAT_POLICY`
  (`packages/runner/src/cfc/standard-profile.ts`), shipped as the posture's
  `cfcPolicyRecords`, carries the §10.1 machinery: material-risk discharge on
  `InjectionSafe` integrity (sanitizer-only, path-local — the module doc says
  why those must not run at a transaction-wide boundary), tier upgrades
  unscreened → ingress-screened → value-screened on stage-matched
  `CaveatScreened{verdict:"pass"}` evidence, value-screened discharge, and the
  influence discharges scoped by `sinkClass` and `fieldRole` boundary guards.
- **The class-scoped precedent.** The display-sink release ceiling (spec
  §8.10.6; `packages/runner/src/cfc/render-ceiling.ts`) mints
  `sinkClass:"display"` boundary atoms and the profile's display rules match
  them — the same shape this mechanism needs at an llm class.
- **A total governance registry.** `MAX_ENFORCEMENT_SINK_GOVERNANCE`
  (`packages/runner/src/runtime-presets.ts`) decides every sink `KNOWN_SINKS`
  names — a ceiling, or an explicit ungated release carrying its rationale —
  and a sink added without a decision is a compile error. The posture record
  every surface publishes carries the ungated set as a deviation, and the CFC
  audit names every sink releasing with no ceiling. So the mechanism has a
  declared landing site: flipping the four llm rows from ungated to a ceiling
  is what retires the published deviation.
- **Landing checkpoints.** `max-enforcement-posture.test.ts` pins the ungated
  hand-staged path ("lets a secret-labeled value reach the llm sink with no
  gate at all") and the registry's totality; #6740 adds a builtin-path pin in
  `builtin-abandoned-request.test.ts`. The two ungated-path pins are written
  to flip to asserting the refusal when this mechanism lands.

## Stage 1 — decisions

Blocked on an owner. The naive rule is ruled out by the spec: safety
invariant 3 (spec `10-safety-invariants.md`) requires exchange rules to carry
authority — non-empty integrity evidence or durable policy-state evidence —
and says boundary context alone is not authority, so "at an llm boundary,
drop the material-risk clause" with no other guard is not a conforming rule.
Invariant 10 (caveat discharge discipline) and §8.10.5.2 (audience expansion
and sink classes) govern the shapes below.

- [ ] **Which authority admits material risk to a model.** Candidates:
  - *Screening evidence (integrity).* Admit the screened tiers at llm
    boundaries, leaving unscreened refused. The evidence shapes exist
    (`CaveatScreened`, §10.1 tier transitions), and the posture test already
    proves screened admission at a fetch sink. The cost: unscreened ingested
    content cannot reach a model under the posture until an ingress screen
    runs — arguably the point of a maximum posture, but the presets note reads
    processing risk-caveated content as what the sink is for.
  - *A durable policy-state grant (spec §8.12.7 route 2a, §4.3.5).* A
    deployment-scoped grant record — this deployment admits unscreened
    material risk to its configured model endpoints — consulted at access
    time by a policyState-guarded rule. Durable policy-state evidence
    satisfies invariant 3, is revocable, and makes the admission an auditable
    deployment decision. The grant-resolver seam already runs at the sink
    gate.
  - *A spec change.* Define model input as a boundary class where
    material-risk caveats are non-blocking by definition, on the argument that
    the caveat's job is to survive into the model's output, where influence
    gating bites. That is normative work; spec §14.1.3.1–.2 (screening and
    material-risk clearance) is the open-problems home for it, and nothing
    lands here ahead of the spec.
- [ ] **What the admitted family covers across turns.** A dialog's later
  turns re-send what earlier turns accumulated, so whatever confidentiality
  the conversation's values carry — the propagated material-risk caveats, and
  `PROMPT_INFLUENCE` where a profile mints it on model-influenced values —
  comes back as model input. A family that admits the risk caveats but not
  the clauses a dialog's own loop reproduces refuses on a later turn instead
  of the first; the rule set has to be checked against a multi-turn
  conversation, not one call.
- [ ] **Whether plain secrets are refused, and the remedy story.** A
  public-only ceiling refuses ordinary confidentiality — a `User` clause, a
  secret — at the llm sinks. That is a real tightening: those flows are
  ungoverned today. Plausibly yes for the maximum posture (the current pin of
  a secret reaching the sink reads as a documented gap, not a feature), but
  it needs saying, together with what a legitimate secret-over-llm deployment
  does instead: a per-deployment ceiling override exists already
  (`cfcSinkMaxConfidentiality` is a constructor option); anything
  finer-grained is out of scope here.

## Stage 2 — mechanical

- [ ] Flip the four llm rows in `MAX_ENFORCEMENT_SINK_GOVERNANCE` from
  `ungatedSink(...)` to a ceiling (public-only baseline, `[]`), retiring
  their `SINK_UNGATED_RATIONALES` rows.
- [ ] An llm sink class. The gate reads each sink's class off the
  `SINK_CLASSES` table beside the inventory
  (`packages/runner/src/cfc/sink-inventory.ts`, `sinkClassOf`), which the
  `agent` sink minted its own class through; the four llm sinks still class
  `network`, so a rule scoped there would fire at the fetch sinks too. Give
  them a class of their own in that table; fetch and stream stay `network`.
- [ ] Admission rules in the standard profile scoped to that class, carrying
  the stage-1 authority, shaped for transaction-wide boundary evaluation the
  way the display rules are (source-bound and kind-bound; the
  `InjectionSafe` sanitizer rules are not the template).
- [ ] Flip the pinned tests: the two named under landing checkpoints, and the
  abandoned-request cases that declare local `llm: []` ceilings once the
  bundle carries real ones.
- [ ] Update the places that describe the gap: the `LLM_SINK_UNGATED`
  rationale and its JSDoc in the sink inventory, the
  `MAX_ENFORCEMENT_SINK_GOVERNANCE` comment,
  `docs/development/EXPERIMENTAL_OPTIONS.md`, the posture-record and audit
  goldens that assert the ungated set, and — once #6740 is in —
  `docs/specs/cfc-enforcement-matrix.md` §4 and `packages/cf-harness/README.md`.

## Spec references

Normative spec in the paired `specs` repository, `cfc/`:

- §10.1 (`10-safety-invariants.md`) — the prompt-caveat standard profile:
  caveat kinds, the screening gradient, tier transitions as ordinary
  clause-local exchange rules, blocking semantics.
- Safety invariants 3 and 10 (same file) — authority-bearing guards; caveat
  discharge discipline (evidence binds the same caveat source and release
  site; boundaries fail closed on a remaining blocking caveat).
- §8.10.5.2 (`08-10-validation-at-boundaries.md`) — audience expansion and
  sink classes: sending a request to a provider is an audience expansion, and
  sink classes are how release scopes there.
- §8.10.6 (same file) — the display-sink release ceiling, the shipped
  precedent for a class-scoped ceiling-plus-rules boundary.
- §8.12.7 (`08-12-store-label-monotonicity.md`) routes 1 and 2a, with §4.3.5
  (`04-label-representation.md`) — access-time exchange (nothing persists)
  and durable policy-state grants, the two conforming homes for the admission
  authority.
- §14.1.3.1–.5 (`14-open-problems-and-proposals.md`) — the open problems this
  mechanism sits inside: material risk versus influence, screening and
  clearance, and the proposed frontiers.
