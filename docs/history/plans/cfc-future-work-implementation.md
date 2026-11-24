---
status: historical
created: 2026-07-02
archived: 2026-07-09
reason: "Executed plan; all scheduled stages (Epics A–E, H, F-doc) merged by 2026-07-07. Residual designs live in docs/specs/cfc-{value-level-provenance,label-metadata-confidentiality,persisted-declassification}.md; the deferred tail (B2b, E5, SC-18b, rewrite event) is tracked in docs/specs/cfc-spec-changes.md."
---

# CFC future-work implementation plan

_Started 2026-07-02. The detailed "how" companion to
[`docs/specs/cfc-runner-future-work.md`](../../specs/cfc-runner-future-work.md)
(the prioritized "what/why" gap inventory). Sibling to
[`runner_cfc_implementation.md`](../../plans/runner_cfc_implementation.md), the phase-1
commit-boundary plan this builds on. Spec references (`§…`, `04-…md`,
`proposals/…`) are paths in the
[`commontoolsinc/specs`](https://github.com/commontoolsinc/specs) repo under
`cfc/`; `packages/…` paths are this repo._

This plan covers the Tier-1 epics (A, B, C, D, E, H; F is deliberately
design-doc-only). Every stage is a mergeable vertical slice with its own tests;
every soundness fix starts red (failing test first, then the fix). File:line
anchors were verified against the tree at the time of writing — re-verify before
coding; `prepare.ts` line numbers in particular will drift.

---

## 0. Ground rules (apply to every stage)

- **Red-green.** A stage that fixes a soundness gap lands the failing test
  first, in the same PR, with the red→green transition visible in the PR
  description. Test files follow `packages/runner/test/cfc-<topic>.test.ts`.
- **Dials, not flag-days.** New behavior lands behind a mode dial defaulting to
  today's behavior; rollout = flip the dial in hosts, not merge the PR. Existing
  dials: `cfcEnforcementMode` (Runtime default `enforce-explicit`,
  [runtime.ts:495](../../../runtime/runner/src/runtime.ts)), `cfcFlowLabels`
  (default `off`), `cfcSinkMaxConfidentiality` (default none). New dials this
  plan adds: `cfcPolicyEvaluation` (B5), `cfcWriteFloor` (D3).
- **Fail-closed on the new path, byte-identical on the old.** Every
  generalization (clause fit, matcher, evaluator) must have a fast path that is
  behaviorally identical for today's flat inputs, guarded by existing tests
  running unmodified.
- **Mixed-version discipline.** Any new persisted form (OR-clauses, observation
  classes) needs an explicit test that a clause/class-*unaware* reader treats
  the new form as **more** restrictive, never less (the `{anyOf:…}` wrapper and
  additive-entry designs below are chosen precisely for this).
- **Digest coverage.** Anything that can change a boundary decision must be in
  `PreparedDigestInput` ([types.ts:299](../../../runtime/runner/src/cfc/types.ts))
  so post-prepare changes invalidate: this plan adds `policySnapshot` (B5) and
  the write-attempt log (D4).
- **Perf gates.** Label-path changes run
  `packages/runner/test/cfc-label-sync-strategy.bench.ts` and
  `cfc-canonicalize.bench.ts` before/after; dial flips in hosts watch the
  note-create perf guard. Rerun only the flagged perf job on CI noise;
  `NEW_PERF_BASELINE` only for proven noise.
- **Land sequentially.** CI only runs for PRs based on `main` — do not stack
  these PRs; each stage merges before the next starts.

---

## 1. Milestone map

Three independent tracks can start immediately; everything else chains.

```
Track 1 (foundation):   A1 → A2 → A3 → A4 → A5
                                           ├─→ B1 ─┬─→ B4 → B5 → B6
                                           │  B2 ──┤
                                           │  B3 ──┘         └─→ H3b (atom-shaped render ceiling)
                                           └─→ E1 → E2 → E3          E4 (server-side; independent of E2/E3)
Track 2 (soundness):    D1 → D2 → D3 → D4        (D5 needs B1+B3)
Track 3 (activation):   H1 → H2;  H3a;  H4;  H5   (mostly independent of each other)

Epic C: C0 (design doc) any time; C1–C5 after C0, independent of A/B.
Epic F: design doc only, unscheduled.
```

Rough sizing (PR count, each PR ≲ a few hundred lines + tests):

| Epic | Stages | PRs | Blocked on |
|---|---|---|---|
| A — CNF clauses | A1–A5 | 4–5 | — |
| B — evaluator | B1–B6 | 7–9 | A |
| C — observation classes | C0–C5 | 1 doc + 4–5 | C0 |
| D — write/agent integrity | D1–D5 | 4–5 (+1 after B) | — (D5: B1, B3) |
| E — sqlite/row-set | E1–E5 | 4–6 | A (E1–E3); — (E4) |
| H — activation | H1–H5 | 4–5 small | — (H3b: B) |

---

## 2. Epic A — CNF clause label representation

**Goal.** `IFCLabel.confidentiality` entries become CNF **clauses** — a bare
atom (singleton clause, today's form) or `{ anyOf: [atom, …] }` (an authored
OR-clause) — and the ceiling-fit check becomes **clause subsumption**. This is
the shared foundation for the disjunctive-confidentiality feature (adopted
spec §3.1.8/§4.2.1/§8.17/§18.5), the exchange-rule evaluator (Epic B), and the
sqlite `any()` combinator (E1). Design + adversarial pass:
`proposals/author-disjunctive-confidentiality.md` (its §9 is this epic's
outline).

**Current state.** Flat sets everywhere:
`IFCLabel = { confidentiality?: unknown[]; integrity?: unknown[] }`
([label-view-core.ts:5](../../../runtime/runner/src/cfc/label-view-core.ts));
join = concat + structural dedup (`mergeLabel`,
[label-view-core.ts:123](../../../runtime/runner/src/cfc/label-view-core.ts));
fit = flat membership (`atomsOutsideCeiling` / `cfcObservationFitsCeiling`,
[observation.ts:81-138](../../../runtime/runner/src/cfc/observation.ts)).
Integrity stays flat forever (no OR-integrity — spec §3.1.6; mixed integrity is
`IntegritySummary`, out of scope here).

**Design decisions (settled here, revisit in PR review):**

1. **Wire form.** A clause is `Atom | { anyOf: Atom[] }`. The `anyOf` key is
   the discriminator; a clause-unaware reader deepEquals the whole object and
   finds it outside every ceiling → strictly more restrictive (fail-closed by
   construction — this is the mixed-version story, verified by test in A4).
2. **`IFCLabel` type stays `unknown[]`.** TS can't help here (`unknown` admits
   the clause object), so the flat-assumption sweep (A5) is enumeration + tests,
   not compiler-driven. Add `CfcConfClause` alias + helpers and migrate
   consumers to them so future greps find stragglers.
3. **Subsumption fit.** `fits(L, C) ⇐ ∀ clause l ∈ L. ∃ clause c ∈ C.
   alts(c) ⊆ alts(l)` (atom comparison = deepEqual now; per-family entailment
   hook arrives with B1). A **flat list ceiling keeps its conjunctive
   meaning** (list entries = singleton clauses; for flat labels this reduces
   byte-for-byte to today's subset check). An `anyOf` **ceiling entry is a
   reader enumeration** — the sound `∀reader ∀clause` quantification the flat
   check cannot express (the §8.10.3 hole).
4. **Normalization prohibitions (tested invariants).** Dedup is
   clause-granular deepEqual only. Never merge distinct clauses, never union
   alternative sets, never dedup an atom across a singleton and an OR-clause
   containing it (`[A]` and `[A ∨ B]` are different constraints). No absorption
   initially (labels grow; measure before optimizing — spec §14.5.6).
5. **Authoring restriction.** Alternatives in an authored OR-clause must be
   principal-like; `Expires`/`Caveat` as alternatives are rejected fail-closed
   (spec §3.1.8 rationale: OR-Expires inverts most-restrictive-wins; OR-Caveat
   makes risk dischargeable by identity).
6. **Ceiling meet.** `meetCfcObservationCeilings`
   ([observation.ts:188](../../../runtime/runner/src/cfc/observation.ts)).
   _Corrected 2026-07-02 — the original decision here ("pairwise
   alternative-set intersection, sound: the intersection clause subsumes via
   both parents") was **unsound**._ Ceiling clauses sit on the demanding side
   of subsumption (`alts(c) ⊆ alts(l)`): fewer alternatives = a weaker demand
   = admits **more** labels, so intersecting alternative sets *loosens*.
   Counterexample: `meet([{A,B}], [{B,C}]) = [{B}]` admits label `[[B]]`,
   which ceiling `[{A,B}]` alone rejects. The sound **and complete** clause
   meet is the **pairwise alternative-set UNION**: `alts(c1) ∪ alts(c2) ⊆
   alts(l)` holds iff both parents subsume `l`, and any label fitting both
   ceilings has a witness pair whose union it fits. The union meet is also
   the true meet on flat/flat inputs — `meet([A],[B]) = [{anyOf:[A,B]}]`,
   decision-equivalent to today's atom intersection for flat *labels* but
   additionally admitting OR-labels the intersection wrongly rejects.
   Implementations may keep the flat-pair intersection fast path (equal-atom
   pairs collapse to the atom — that *is* their union) and, if
   `O(|C1|·|C2|)` ceiling growth ever bites, may drop cross pairs — a sound
   over-restriction, but one that forfeits completeness (a pruned meet is
   strictly tighter than the true meet: `[{anyOf:[A,B]}]` fits `[A]` and
   `[B]` individually but not a meet whose cross pair was dropped). The
   intersection of alternative sets is never sound. Status: **LANDED
   (#4485)** — the full pairwise-union meet (no cross-pair pruning; equal
   pairs collapse via the `normalizeClause` singleton unwrap; result clauses
   dedup via `clausesEqual`) with the **both-direction** property test
   `fits(L, meet(C1,C2)) ⟺ fits(L,C1) ∧ fits(L,C2)` exhaustive over
   flat+clause ceilings/labels in
   `packages/runner/test/cfc-clause-meet.test.ts`. The seam is ready for B5
   (`BoundaryContext`/sink ceilings) and H3b (render ceiling). If a future
   large-ceiling consumer ever needs cross-pair pruning, it forfeits
   completeness and must downgrade the property test to the soundness
   direction (`⟹`), stated as such — prefer the full meet; the biconditional
   is the guard worth having.

### Stages

**A1 — clause core (pure helpers, no behavior change).**
New `packages/runner/src/cfc/clause.ts`: `isOrClause`, `clauseAlternatives`
(singleton → `[atom]`), `normalizeClause` (dedup alternatives; unwrap
`{anyOf:[a]}` → `a`), `clauseSubsumes(c, l)`, `clausesEqual`. Canonical
ordering of alternatives in `canonical.ts` (`canonicalizeCfcMetadata` must sort
`anyOf` members so prepared digests are stable across insertion order). Tests:
`cfc-clause.test.ts` (algebra + canonicalization goldens).

**A2 — subsumption fit + the reader-enumeration soundness test.**
Rewrite `atomsOutsideCeiling` → clause-subsumption membership (return offending
label *clauses*); `cfcObservationFitsCeiling` signature unchanged; the
ungrantable `CFC_LABEL_READ_FAILED_ATOM` handling unchanged (it can never be
subsumed-in). `meetCfcObservationCeilings` per decision 6 (#4470 landed the
conservative deepEqual meet; the general union clause-meet + both-direction
property test landed in #4485 — see decision 6).
**Red first:** the multi-party counterexample — label `[[User(A)],[User(B)]]`
(nobody alone may read) vs ceiling `[{anyOf:[User(A),User(B)]}]` (readers A or
B) must **fail** fit. Also: OR-clause label `[{anyOf:[A,B]}]` vs flat ceiling
`[A]` **fits** (some alternative allowed — the weaker-clause direction).
Existing flat/flat tests (`cfc-ceiling-empty`, `cfc-sink-ceiling*`,
`cfc-tool-ceiling-empty`) run unmodified — that is the golden gate.

**A3 — join invariants.** `mergeLabel`/`mergeCfcLabelViews` already
concat+deepEqual-dedup, which is clause-correct; this stage adds the
prohibition tests of decision 4 (no cross-clause dedup, no alternative-set
union, join of `[[A∨B]]` and `[C]` = both clauses) and a
`normalizeClause`-on-ingest pass.

**A4 — authoring + persistence + mixed-version test.**
Accept `{anyOf:[…]}` entries in schema `ifc.confidentiality`: validation at the
schema write-policy path (reject non-principal-like alternatives with an
`unsupportedTrustSensitiveReason`-style fail-closed reason,
[prepare.ts:1623](../../../runtime/runner/src/cfc/prepare.ts)); schema-merge
direction rule (growing = adding clauses; merging alternative sets is never a
merge result — extend `schema-merge.ts` conflict table + tests). Persistence:
clause objects ride `LabelMapEntry.label` unchanged (shape already `unknown[]`);
canonical order per A1. Mixed-version test: a persisted clause label read by
the *flat* fit logic (simulate pre-A2 semantics) is outside every ceiling —
fail-closed confirmed end-to-end.

**A5 — flat-assumption consumer sweep.** The full non-test inventory of
`.confidentiality` consumers (verified by grep):

| File | Disposition |
|---|---|
| `cfc/prepare.ts` (21 sites) | gates go through A2 helpers; `isProvenanceOnlyConsumedLabel` counts clauses (correct); flow join concatenates clauses (correct join) |
| `cfc/schema-sanitization.ts` | material-risk scan must look **inside** `anyOf` alternatives (banned at authoring, but scan anyway — exchange rules add alternatives later) |
| `cfc/observation.ts` | rewritten in A2 |
| `cfc.ts` (legacy classification walker) | clause = opaque atom (coarse summary only); test documents it |
| `packages/html/src/worker/reconciler.ts` | clause = opaque → over-restrict (fail-safe); clause-aware render fit is H3b |
| `builtins/sqlite/row-label-{read,write}.ts`, `write-ceiling.ts`, `sqlite-builtins.ts` | producers/checkers; inherit A2 via `cfcObservationFitsCeiling`; `any()` stays reserved until E1 |
| `builtins/llm.ts`, `data-updating.ts`, `builder/node-utils.ts` | audit each; expected pass-through/merge — add opaque-clause tests |

Deliverable: `cfc-clause-consumers.test.ts` asserting the restrictive-or-correct
behavior per consumer.

**Acceptance for the epic.** Authored OR-clause flows end-to-end (schema →
persisted labelMap → read label view → ceiling fit) with: any-alternative
admits at a flat ceiling naming it; reader-enumeration ceilings enforce
`∀reader ∀clause`; all pre-existing flat tests untouched; mixed-version
fail-closed test green.

---

## 3. Epic B — exchange-rule + policy evaluator

**Goal.** The guarded-rewrite calculus (spec §4.3–§4.4.5, §5): policy records
carrying exchange rules; atom pattern-matching with variable binding; a fuelled
fixpoint evaluator that **adds alternatives to clauses** (never anything else);
trust-closure concept satisfaction; wired into `prepareBoundaryCommit` behind a
dial. Delivers safety invariants 3, 5, 6, 10, 11; retires the hard-coded
prompt-caveat strip; enables declassification/discharge for the first time.

**Current state (verified absent).** Zero exchange/policy machinery repo-wide.
What exists to build on: `trustSnapshotProvider` (Runtime option,
[runtime.ts:248,485,748](../../../runtime/runner/src/runtime.ts) — injected
per-tx via `setCfcTrustSnapshot`); `WritePolicyInput` recording
([extended-storage-transaction.ts:464](../../../runtime/runner/src/storage/extended-storage-transaction.ts));
the runtime-minted-integrity gate (`gateRuntimeMintedIntegrity`,
[prepare.ts:2680](../../../runtime/runner/src/cfc/prepare.ts), builtins bypass);
the per-space system-doc pattern (`ACLManager`,
[acl-manager.ts:10-61](../../../runtime/runner/src/acl-manager.ts)); the
content-addressed + identity-memoized resolution pattern
(`resolveCfcSchemaRefs`,
[schema-refs.ts:213](../../../runtime/runner/src/cfc/schema-refs.ts)); the
evidence-matching precedent (`ui-contract.ts` trusted-event verification).
The only "discharge" today is `schema-sanitization.ts`'s bulk strip of the four
prompt-risk kind strings — exactly the "prompt-specific runtime branch" spec
§10.1 says must become ordinary rules (B6 retires it).

**Design decisions:**

1. **Evaluation-time only.** Rewritten labels are never persisted (spec
   §8.12: disjunctions arise at access time; store-label rewrite as a
   declassification *event* is out of scope for this epic).
2. **Policy sources, phased.** B2a: a deployment-configured, frozen policy set
   on `RuntimeOptions` (`cfcPolicyRecords`), mirroring how
   `cfcSinkMaxConfidentiality` ships — enough for B6's standard prompt-caveat
   profile and the display profile. B2b (later): space-hosted policy docs at a
   reserved space-root path (ACLManager storage discipline), content-addressed
   records verified on read (schema-refs pattern), read under
   `internalVerifierRead` metadata so policy lookups never taint.
3. **Determinism + digest binding.** The evaluator is a pure function of
   `(label, policySnapshot, trustSnapshot, boundaryContext, evidence)`. Add
   `policySnapshot: { digest: string }` to `PreparedDigestInput` and
   canonicalization — a policy change between prepare and commit invalidates
   (same discipline as `trustSnapshot`).
4. **Fuel.** Fixed constant (start 64 firings/label); exhaustion → fail-closed
   prepare reason + diagnostic counter, never a partial result (spec §4.4.5;
   invariant 6's "no silent downgrade" becomes a real code path here).
5. **Rule authority.** Which rules may fire on a clause = the union over the
   clause's alternatives of each alternative's governing policy's rules (spec
   §4.4.5 "the confidentiality principal chooses the admissible rule set").
   For B2a's deployment records, scope rules by an explicit
   `appliesTo` atom pattern; document that this is the degenerate
   single-policy-root case.

### Stages

**B1 — atom pattern matching + new atom families.**
New `packages/runner/src/cfc/atom-pattern.ts`:
`AtomPattern` (concrete atom | `{ var: "$x" }` | typed pattern
`{ type, <field>: pattern|value… }`), `matchAtomPattern(pattern, atom,
bindings) → bindings | null`, multi-binding enumeration over a label
(§4.4.5: a variable matching multiple atoms yields the disjunction of all
valid bindings), post-match equality constraints between variables, and the
`atomEntails(a, b)` hook (deepEqual default; `Expires`: timestamp ordering;
everything else fails closed). Register the missing atom families in
[packages/api/cfc.ts](../../../base/api/cfc.ts) `CFC_ATOM_TYPE` with mint
helpers + `atom-classes.ts` propagation classes (SC-10 parity): `Expires`,
`BoundaryContext`, `CaveatScreened`, `DisclosureRendered`,
`DisclosureAcknowledged`, `DisclaimerAttached`, `CaveatAssessment`, `User`,
`Space`, `HasRole`. Add the missing `CFC_CONCEPT_KIND` tier kinds
(`…-ingress-screened`, `…-value-screened`). Extend
`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`
([prepare.ts:2644](../../../runtime/runner/src/cfc/prepare.ts)) for the new
evidence families so pattern code cannot self-mint them.
Tests: `cfc-atom-pattern.test.ts` — binding, multi-binding disjunction,
constraint correlation, entailment, fail-closed unknown families.

**B2 — policy records + lookup (B2a runtime-configured).**
New `packages/runner/src/cfc/policy.ts`: `ExchangeRule` (id, `appliesTo`
clause-alternative pattern, `preCondition: { confidentiality?: AtomPattern[];
integrity?: AtomPattern[]; boundary?: AtomPattern[] }`, `preConfScope:
"targetClause" | "anywhere"` (default `targetClause`), `post: { addAlternatives?:
AtomPattern[]; dropClause?: boolean }`), `PolicyRecord` (id, digest, rules),
`PolicySnapshot` (frozen record set + digest). `RuntimeOptions.cfcPolicyRecords`
→ frozen snapshot at construction (deep-freeze like the sink ceilings,
[runtime.ts:499-507](../../../runtime/runner/src/runtime.ts)); snapshot injected
into tx CFC state alongside the trust snapshot. Tests: canonicalization/digest
stability, freeze, malformed-record fail-closed.

**B3 — trust closure.**
`packages/runner/src/cfc/trust.ts`: a `TrustResolver` built from frozen
deployment config + the tx `TrustSnapshot`
([types.ts:246](../../../runtime/runner/src/cfc/types.ts)) — `conceptSatisfied
(concept, integrityAtoms, actingPrincipal) → boolean` via declared
concept-delegate edges (transitive, bounded depth). Determinism contract: the
resolver is a pure function of snapshot + config; `TrustSnapshot.revision`
covers the config version (audit the provider for ambient state — this is the
"trust-snapshot determinism" Tier-2 item, folded in here). Consumed by B4
guards and D5 floors. Tests: closure transitivity, per-user scoping (inv-11:
concrete integrity portable, concept satisfaction acting-principal-scoped).

**B4 — guarded rewrite + fuelled fixpoint.**
`packages/runner/src/cfc/exchange-eval.ts`:
`evaluateExchangeRules(label, snapshot, ctx, fuel) → { label, firings:
RuleFiring[], exhausted: boolean }`. `applyExchangeRule` adds instantiated
alternatives to the matched clause (or drops the clause on an empty
instantiated postcondition); iterate to fixpoint; structural-change detection
for termination; canonical rule/clause ordering for determinism.
Property tests (`cfc-exchange-eval.test.ts`): (i) every output clause is an
input clause with a superset alternative set, or dropped by a firing —
**nothing else ever changes**; (ii) no clause merging/creation; (iii)
deterministic across input orderings; (iv) fuel exhaustion → `exhausted`,
label unchanged; (v) a rule whose integrity guard is unsatisfied never fires
(invariant 3); (vi) firing on clause `c` never touches clause `c'` (inv-11
clause locality).

**B5 — boundary integration (dial: `cfcPolicyEvaluation: "off" | "observe" |
"enforce"`, default `off`).**
In `prepareBoundaryCommit` ([prepare.ts:3095](../../../runtime/runner/src/cfc/prepare.ts)):
- Mint `BoundaryContext` atoms per sink-request input (sink name; `sinkClass`
  starts with `"network"` for fetch/LLM — the display class arrives with H3b)
  — this is the Tier-2 "`sinkClass`/`BoundaryContext` substrate" item, landed
  here.
- For each gated label (sink-request payloads in `verifySinkRequestCeilings`,
  [prepare.ts:3058](../../../runtime/runner/src/cfc/prepare.ts); consumed-read
  labels in `verifyInputRequirements`, [prepare.ts:2386](../../../runtime/runner/src/cfc/prepare.ts)):
  evaluate to fixpoint, then subsumption-fit the **rewritten** label.
  `observe` = evaluate + diagnostics, decide on the un-rewritten label;
  `enforce` = decide on the rewritten label; exhaustion/lookup failure =
  fail-closed reason in both enforcing modes.
- **`requiredIntegrity` matcher upgrade** (the §8.10.3 soundness edge): replace
  exact `deepEqual` membership with `matchAtomPattern` + `atomEntails`, and add
  **object-level witness-key coherence** — when one `requiredIntegrity`
  requirement spans multiple consumed descendant leaves, all must satisfy it
  via one shared witness atom (`witnessKeyForRequiredMatch`). **Red first:**
  heterogeneous per-leaf integrity satisfying the object-level requirement
  passes today → must fail.
- Digest: `policySnapshot.digest` into `PreparedDigestInput` + `canonical.ts`.
Tests: `cfc-policy-boundary.test.ts` (observe vs enforce, invalidation on
policy swap, exhaustion fail-closed) + `cfc-required-integrity-coherence.test.ts`.

**B6 — standard prompt-caveat profile as data; retire the special-case.**
Ship the §10.1 profile as `PolicyRecord`s in the default deployment config:
tier upgrades (`unscreened → ingress-screened` guarded by
`CaveatScreened{kind, source, stage:"ingress", verdict:"pass"}` with structural
kind/source match; `→ value-screened` guarded by stage `"value"` +
`valueRef` binding) as **add-alternative** rules; discharge rules for display
(`DisclosureRendered`/`DisclosureAcknowledged`/`DisclaimerAttached` per sink
class/field role); material-risk discharge requiring positive `InjectionSafe`;
`PROMPT_INFLUENCE` never cleared by `InjectionSafe` alone (test). Value-stage
staleness: discharge re-verifies `valueRef` still binds the current value —
a value-screened alternative on a transformed value must not fire (test; this
is the §10.1 re-binding blind spot from the audit).
Then **rewire `schema-sanitization.ts`**: keep only the trusted-schema
`InjectionSafe` *minting* (`schemaWithInjectionSafeAnnotations` — §10.1
sanctions it); delete `filterMaterialRiskAtoms`' wholesale strip — stripping
becomes an ordinary discharge-rule firing. Guard: every existing
`cfc-schema-sanitization` scenario reproduced through the rule path before the
strip is deleted (goldens).

**Acceptance for the epic.** With `cfcPolicyEvaluation: "enforce"` and the
standard profile: a screening-pass caveat admits at a display-class boundary
whose rule set discharges it, and is refused at one that doesn't; releasing one
clause never releases a sibling; policy swap between prepare and commit
invalidates; fuel exhaustion rejects; all with `off` remaining byte-identical
to today.

---

## 4. Epic C — observation classes (`PathLabelTemplate`)

**Goal.** A read consumes only the label of the observation it actually made
(spec §4.6.3: `shape` / `value` / `enumerate` / `count` / `followRef`),
closing the two documented residual channels: SC-4 (existence — "this path was
once written" leaks publicly after a derived-label overwrite) and SC-8
(pointer-identity-at-a-slot — which element sits at a slot, observed without
dereferencing, is unlabeled).

**Current substrate (better than the audit implied).** The persisted entry
already has a provenance axis (`LabelMapEntry.origin`:
declared/link/derived/structure/external-ingest,
[types.ts:171-182](../../../runtime/runner/src/cfc/types.ts)); reads already
distinguish shape-only observations (`nonRecursive` on `IReadActivity`,
[storage/interface.ts:1469](../../../runtime/runner/src/storage/interface.ts))
and link-topology probes (`linkResolutionProbe` marker,
[reactivity-log.ts:58](../../../runtime/runner/src/storage/reactivity-log.ts) —
currently **excluded** from flow taint, which *is* the SC-8 residual);
read-side resolution already threads `nonRecursive`
(`effectiveReadLabel(metadata, logicalPath, nonRecursive, { excludeLinkOrigin:
true })` inside `deriveFlowJoin`,
[prepare.ts:1321](../../../runtime/runner/src/cfc/prepare.ts)); and the
`structure` origin already labels container shape at exact paths
([prepare.ts:3517-3583](../../../runtime/runner/src/cfc/prepare.ts)).

**C0 — design doc first (`docs/specs/cfc-observation-classes.md`).** This epic
has real open semantics; write them down before code:
- **Persisted form.** Recommend an additive, orthogonal axis:
  `LabelMapEntry.observes?: "value" | "shape" | "enumerate" | "followRef"`
  (absent = covers all classes — every legacy entry is a covering entry, so
  clause/class-unaware readers over-taint, fail-safe). `origin` stays the
  update-discipline axis; `observes` is the consumption axis. Justify against
  the alternative (a `PathLabelTemplate`-shaped entry with per-class label
  fields) — additive entries win on wire compat and on reusing the existing
  longest-prefix resolution.
- **Read-classification table (the SC-8 normative mapping).** Concretely:
  recursive value read = `value + shape + enumerate` at the path;
  `nonRecursive` read = `shape + enumerate` only; `linkResolutionProbe` /
  slot-pointer read without dereference = `followRef` (and **stops being
  excluded** from flow taint — it consumes the link-origin entry's `followRef`
  class); dereference = the trace pair it already is.
- **SC-4 semantics.** On value overwrite, replace only `observes:"value"`
  derived entries; the existence/shape entry **grows** (join of old and new
  J) — existence reveals every historical writer, so it must not shrink.
  State the interaction with §8.12.8's replace-on-overwrite explicitly.
- **What `deriveFlowJoin` consumes per read shape**, and how the observation
  ceiling (LLM path) consumes classes.

**C1 — read-shape plumbing.** Classify each flow observation (value /
shape-only via `nonRecursive` / followRef via `linkResolutionProbe`) in
`forEachFlowObservation` ([prepare.ts:1215](../../../runtime/runner/src/cfc/prepare.ts));
`effectiveReadLabel` selects entries by class-compatibility instead of the
boolean; `excludeLinkOrigin` becomes class selection (link-origin entries
consumed by `followRef` reads). Flow-taint parity test, scoped per C0 §6:
with only legacy covering entries, derived joins are byte-identical to today
for `value`/`shape`/`enumerate` reads; the `followRef` path intentionally
widens (that widening *is* the SC-8 fix) and is asserted as the new wider
join, not claimed as parity.

**C2 — persist split.** The persist region writes `observes:"value"` derived
entries plus a `shape` entry per written path; the existing `structure` stamps
become `origin:"structure", observes:"shape"` (compat: absent `observes` on old
structure entries = covering, unchanged). Idempotence (SC-11) must hold per
class.

**C3 — the two channel fixes (red first).**
SC-4: test — write secret → derived label present; overwrite with public value
→ **existence/shape entry still carries the old J** (today it vanishes; the
in-code acknowledgment sits near [prepare.ts:1150](../../../runtime/runner/src/cfc/prepare.ts)).
SC-8: test — read WHICH link sits at a slot (no dereference) → flow join now
carries the link entry's `followRef` label (today: clean).

**C4 — consumer precision.** Observation ceiling (llm.ts) and render label
views consume per-class; a public `value` read under a secret container
`shape` no longer inherits the shape label (the precision win that pays for
the epic).

**C5 — sqlite precision.** Null-origin/computed-column conservative merge
(`deriveNullOriginIfc`,
[sqlite-builtins.ts:205](../../../runtime/runner/src/builtins/sqlite-builtins.ts))
narrows to the classes actually consumed.

**Rollout.** _Corrected by C0 (#4476) — two regimes, not one._
`value`/`shape`/`enumerate` entries are additive and legacy readers treat
them as covering (over-taint, fail-safe — no dial needed). The **followRef
slice is NOT fail-safe writer-first**: a legacy reader *drops*
`origin:"link"` entries via `excludeLinkOrigin`, so a new writer + old
reader **under-taints**. Deploy the class-aware reader before the writer, or
gate followRef persistence behind a dial flipped only after readers
understand it — a hard prerequisite for the SC-8 slice
(`docs/specs/cfc-observation-classes.md` §9). Perf: labelMap grows ~2×
entries per written path — bench before/after (canonicalize + label-sync).

---

## 5. Epic D — write-side & agent integrity (the live soundness cluster)

**Goal.** Close the three composing holes that let an injected `sendMail`
recipient send under `enforce` (scoping doc:
[docs/history/specs/cfc-trusted-agent-tool-integrity.md](../specs/cfc-trusted-agent-tool-integrity.md)),
and build the write-side `requiredIntegrity` floor (§8.12.4.1 / SC-18). Track
runs independently of A/B (D5 excepted) — **start immediately; this is the
security-urgent track.**

**Current state.** (1) tool-invoke never consults `inputSchema.ifc.
requiredIntegrity` (`llm-dialog.ts` `handleInvoke`/`executeToolCalls`); (2) the
enforced gate is write-target-scoped (`verifyInputRequirements`,
[prepare.ts:2386](../../../runtime/runner/src/cfc/prepare.ts)) and the demo's
targets carry no floor; (3) vacuous pass — empty consumed set satisfies the
gate, acknowledged in-code with the coupling warning
([prepare.ts:2372-2380](../../../runtime/runner/src/cfc/prepare.ts): tightening
without per-write provenance would over-reject); model output carries no label
at all. The red test already exists and is `it.ignore`'d:
`packages/runner/test/cfc-agent-tool-input-integrity.test.ts`.

### Stages

**D1 — `LlmDerived` stamping (scoping doc piece B; the enabler).**
Add `CFC_ATOM_TYPE.LlmDerived` + mint helper (subject: model id; valueDigest
optional) + `atom-classes.ts` class `provenance` + membership in
`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES` (pattern code cannot self-mint or strip
it). Stamp at the two entry points where model bytes become store values:
`createToolResultMessages` and the assistant-message append in
`llm-dialog.ts`. Gate behind `cfcEnforcementMode !== "disabled"`. Guard: the
llm-dialog tests that assert tool results flow back unchanged must still pass
(the stamp rides the label, not the value).

**D2 — invoke-time tool-input gate (pieces A + C; un-ignore the red test).**
In `handleInvoke` (llm-dialog.ts) and the `llm.ts` tool path, where
`toolCall.input` is cellified: for each input field whose `inputSchema`
declares `ifc.requiredIntegrity`, resolve the supplied value's integrity —
a by-reference cell carries its label view; a model-supplied scalar carries
(at most) `LlmDerived` from D1 — and check the floor with the **same
membership helper** `verifyInputRequirements` uses (export it from
`prepare.ts`; no parallel implementation). A bare scalar on a floor-declaring
field fails closed (piece C, no per-write provenance needed at this surface).
Refusal surface: error tool-result — the loop continues, the model is told the
call was refused (mirrors `toolAllowsObservedConfidentiality`) — with the
commit gate as defense in depth. Tests: un-ignore
`cfc-agent-tool-input-integrity.test.ts` (injected recipient refused); add the
legitimate path (by-reference recipient carrying the required integrity is
**allowed**); end-to-end demo drive via the mock (unsafe agent refused, safe
agent's direct-command send succeeds).
Open decision to settle in this PR: the by-reference contract for
direct-command values (how a legit recipient reaches the tool with integrity
intact — opaque handle / `{"@link": …}` binding affordance).

**D3 — write-side `requiredIntegrity` floor (§8.12.4.1; dial
`cfcWriteFloor: "off" | "observe" | "enforce"`, default `off`).**
New check beside `verifyInputRequirements`: for each attempted write covered by
a schema `ifc.requiredIntegrity` entry, the **written value's** integrity — the
derived output integrity at that path (flow hereditary meet + `addIntegrity`
mints + carried link-view integrity), *not* the consumed-read set — must
satisfy the floor. SC-18 semantics, tested one by one: floor is a minimum
(above-floor writes always pass); overwrite is checked against the **declared
floor only**, never the prior value's integrity (sibling replacement B≱A, both
≥ floor, conforms); **no meet across successive writes**; empty integrity on a
floor-declaring path fails (this closes the write-side half of the vacuous
pass — a stamped-`LlmDerived`-only value fails any floor by construction).
Exact-match membership first; D5 upgrades to pattern/concept. **Red first:**
floor-declaring schema + integrity-less write commits today under
`enforce-explicit` → must reject under the dial.

**D4 — per-write read-prefix provenance (the deferred end-state of
`runner_cfc_implementation.md` "Potential and Final Write Sets").**
_Design superseded by the soundness review
[`docs/specs/cfc-write-prefix-provenance.md`](../../specs/cfc-write-prefix-provenance.md):
the bound below ("first attempt") is unsound under write re-attempts — the
sound bound is the **last write overlapping the protected path** (both prefix
directions), and consumed-read journal positions must join the digest
alongside the write-attempt log. The review's §7 constraints are the contract
for the code PR; the paragraph below is kept as the original sketch._
Record a write-attempt log in `CfcTxState`: `{ target: CfcAddress,
journalIndex: number }` per attempted write (the journal already orders
activity). Gate scoping: `requiredIntegrity`/floor checks quantify over reads
with `journalIndex <` the write's first attempt — the prefix approximation
(strictly tighter than transaction-global; not value-level dataflow, stated
honestly). Two payoffs, both tested red-first: (i) the general audit-#14
tightening — a floor-declaring write with an **empty read prefix** fails
instead of vacuously passing; (ii) the S7-style false-reject scaffolding
(`isProvenanceOnlyConsumedLabel`,
[prepare.ts:2381](../../../runtime/runner/src/cfc/prepare.ts)) can narrow — the
admin-grant lookup no longer gates an unrelated later write (port the
group-chat regression scenario from the comment into a test). Digest: the
write-attempt log joins `PreparedDigestInput` + `canonical.ts`.

**D5 — concept-level floors (needs B1 + B3).** Swap exact-match floor
membership for `matchAtomPattern` + `TrustResolver.conceptSatisfied` so a floor
like "minted by a valid GPS measurement" accepts any concrete atom above the
concept in the acting user's trust closure. (The consume-side twin lands in
B5.)

---

## 6. Epic E — row-set reads, per-row labels, sqlite 3.b/3.c

**Goal.** Un-reserve `any()` (authored OR-clauses in row-label rules), make
aggregates work via the common-alternative property, land read-time clearance
(Phase 3.b) and server-side commit-time re-derivation (Phase 3.c).

**Current state.** Phase 3.a is done and well-factored: rule AST + shared
evaluator in [packages/memory/v2/sqlite/row-label.ts](../../../runtime/memory/v2/sqlite/row-label.ts)
(memory-side — conveniently already where 3.c needs it); `any()` serializes but
is rejected at `table()` time with the clause-profile error
(row-label.ts:246-249, enforced at 311/343/582); read side
([row-label-read.ts](../../../runtime/runner/src/builtins/sqlite/row-label-read.ts)):
true-origin attribution, `onExceed: fail|skip` with the aggregate-skip
refusal, ceiling placeholder resolution (`__ctCurrentPrincipal`/`__ctDbOwner`);
write side ([row-label-write.ts](../../../runtime/runner/src/builtins/sqlite/row-label-write.ts)):
no-laundering fit + fail-closed rejects for every non-attributable shape, each
error naming 3.c as the lift; `authoredBy`/`endorsedBy` already mint
self-describing `claimed-*` atoms (the forgeability mitigation is **already
option (b)**; only the trusted-upgrade path remains). Server hook exists:
`applySqliteOperation` inside the commit transaction
(packages/memory/v2/engine.ts:3292-3321), rows already split into entity docs
server-side.

### Stages

**E1 — un-reserve `any()` (needs A4).**
Delete the `ANY_REJECTION` validations + the `evalConf` throw; the evaluator
emits one `{anyOf:[…]}` clause per `any(...)`; carried-in value labels and
per-column `ifc` join **conjunctively around** the rule's clause (the
proposal's single most load-bearing rule — the rule's OR never absorbs
input-derived clauses; the no-laundering check at row-label-write.ts:229-248
already enforces exactly this via `cfcObservationFitsCeiling`, which A2 made
clause-aware). Tests: the worked-example email rule
(`any(principal("mailto", match(f.from,…)), …recipients…, dbOwner())`) — row
readable at a ceiling naming any one participant; laundering attempt (labeled
value bound into a row whose clause doesn't capture it) still refused;
`whenMatches`-gated alternative absent from non-matching rows.

**E2 — aggregates via the static common-alternative property.**
Key insight (per §8.17.4): if atom `m` appears as an alternative in **every**
clause of **every possible** row label, `m` satisfies the join of all rows —
statically decidable from the rule AST, no row access needed. Implement
`ruleCommonAlternatives(spec): atom[]` in row-label.ts: atoms present
unconditionally (in the top-level `any()`/`all()` of every branch, **not**
under `whenMatches`, not data-dependent — `dbOwner()` qualifies; extracted
principals don't). Then relax the aggregate refusal
(row-label-read.ts:118-124): allow a null-origin/aggregate projection on a
rule-bearing table iff the declared output ceiling is subsumption-satisfied by
the common alternatives (+ static per-column atoms). `COUNT(*)` for the db
owner works with an unconditional `dbOwner()` alternative and **no fallback
machinery**. Exact per-query join of actual contributor rows stays server-side
(E4+, if ever needed). Tests: owner count allowed; ceiling naming a
conditional alternative refused; `onExceed:"skip"` still never applies to
aggregates.

**E3 — Phase 3.b read-time clearance (needs E1).**
Filtering by *who is asking*: a declared query mode (not a silent fallback)
where the keep-mask tests each row's label against the **reader** — reader
satisfies a clause iff some alternative is reader-satisfiable
(`User(reader)` / db owner / space atoms; reuse+extend
`resolveCeilingPlaceholders`,
row-label-read.ts:229-258). Per §8.17/inv-14 this is a declared existence
release: require (a) declared in the query contract, (b) the table's governing
policy permits it (a `rowLabel`-adjacent schema flag), (c) auditable (count of
withheld rows in diagnostics). Never for aggregates. Tests: per-user mailbox
view (each participant sees their rows only); the withheld-count is not
observable in the result shape beyond the declared release. Status: **LANDED
(#4478/#4484)** — keep-mask/withheld semantics in
`packages/runner/test/sqlite-row-label-read.test.ts`, per-user view +
reader-isolated result cells in
`packages/patterns/integration/sqlite-read-clearance-multi-runtime.test.ts`;
the same file's result-shape test pins the raw cleared result doc to exactly
the declared surface (kept rows + `withheld` + pending/error + request
bookkeeping — no placeholders, gaps, or ids of withheld rows).

**E4 — Phase 3.c server-side commit-time re-derivation (independent of
E1–E3).**
In `applySqliteOperation` (engine.ts:3292): when the target table declares a
`rowLabel` rule, after the mutation applies read back affected rows by rowid,
run the **shared evaluator** (already memory-side) against the true committed
row, and throw (rolling back the whole commit) on rule-evaluation failure.
Then relax the runner-side rejects for the shapes 3.c covers (INSERT…SELECT,
upsert, columnless INSERT, UPDATE-of-rule-input-columns —
row-label-write.ts:151-180) **gated on a server-capability handshake** (old
server + new runner keeps failing closed). No-laundering stays runner-side
(the server has no input-value labels; document the split). Integration tests
in `packages/runner/integration/sqlite-cfc-*`: INSERT…SELECT whose committed
rows violate the rule rolls back atomically; upsert re-derives from the
post-image. Status: **implemented (#4552)** —
`memory/v2/sqlite/commit-eval.ts` (evaluation runs unconditionally
server-side; RETURNING-rowid + read-back-by-rowid; row cap), the
`sqliteCommitRowLabelEval` hello-flag, the gate relaxation (labeled inputs
still fail closed on every relaxed shape), spec updated in
sqlite-builtin/06-cfc.md ("Server commit" section); e2e
`sqlite-cfc-commit-eval.test.ts`.

**E5 — trusted `authoredBy` upgrade path (later; wants per-column ingest
provenance).** When the matched column itself carries trusted-ingestion
integrity, mint the real `AuthoredBy`; otherwise keep `claimed-authored-by`.
Depends on ingest stamping reaching sqlite columns; park until a consumer
needs it.

---

## 7. Epic H — enforcement & flow activation

**Goal.** Turn on what is built. Corrected picture from the seam mapping: the
Runtime constructor **already defaults `enforce-explicit`**
([runtime.ts:495](../../../runtime/runner/src/runtime.ts)), as does lib-shell
([lib-shell/src/runtime.ts:113-149](../../../runtime/lib-shell/src/runtime.ts));
`InitializationData` already carries `renderDeclassificationPolicy` and
`renderConfidentialityCeiling` across the worker IPC
([runtime-client/protocol/types.ts:130-187](../../../packages/runtime-client/protocol/types.ts)).
The dormant pieces are: the flow dial (`off` everywhere), the render ceiling
(plumbed, never populated), `enforce-strict` (rankable, no distinct behavior),
and trigger-read labels on the enforcement side.

### Stages

**H1 — flow dial to `observe` in shipped hosts.**
Add `cfcFlowLabels` to `InitializationData` + `createRuntimeClientOptions` (it
is **not** currently in the protocol — only the enforcement mode is) and set
`observe` in shell/toolshed. Collect `deriveFlowJoin` diagnostics + the
`flowLabelWorkExists` relevance rate; watch benches. Exit criteria: diagnostic
volume sane, no perf regression on note-create.

**H2 — flow dial to `persist`.**
Prereq checks, each a test: SC-11 idempotence (re-deriving an unchanged label
= no envelope write, no version bump — assert via storage write counts using
`cfcLabelViewsEqual` semantics); derived-component replace-on-overwrite +
ancestor-clear behavior matches §8.12.8 (tests exist from S16 — extend);
cross-space derived-label exposure is a known accepted residual (SC-14,
re-affirm in PR description). Flip shell/toolshed to `persist`; perf-gate.
This activates inv-9 (flow-path confidentiality) in real deployments — state
that in the PR as the point.

**H3a — populate the render ceiling (no new machinery).**
lib-shell passes `renderConfidentialityCeiling` (and
`renderDeclassificationPolicy: "deny"`) into `InitializationData`. Initial
profile per §8.10.6 owner direction: `atoms: [<acting-user DID string>, …]`
(exact-match forms the reconciler can check today) +
`caveatKinds: [<influence-class kinds>]` allow-list. Dogfood behind a shell
flag; the reconciler's fail-closed narrowing
([reconciler.ts childRenderPolicyForNode](../../../runtime/html/src/worker/reconciler.ts))
does the rest. Expect over-blocking (no exchange resolution yet) — that is the
point of the dogfood stage; H3b fixes precision.

**H3b — atom-shaped ceiling with exchange resolution (needs B).**
Render gate admits via §15.2 shapes: `User(actingUser)`,
`PersonalSpace`/`Space`-via-`HasRole` resolved by exchange rules in the
worker's evaluator context (the reconciler consumes a resolved ceiling —
resolution happens runner-side, not in the reconciler). This is the "shell
ceiling flip" end state; `sinkClass: "display"` `BoundaryContext` minting joins
here (completing B5's substrate).

**H4 — differentiate `enforce-strict` (SC-13 / §18.6.3).**
Define the mode matrix in a short doc section first (which combinations of
enforcement × flow dial are conforming deployment states; rollout ordering:
propagation-observe → persist → strict). Implement strict-only rejects at the
ladder ([extended-storage-transaction.ts:1016-1033](../../../runtime/runner/src/storage/extended-storage-transaction.ts)).
Missing-policy is **not** part of the strict delta: `enforce-explicit` already
fail-closes it (prepare records `missing schema write-policy input`, the
ladder rejects any reasoned tx under both enforcing modes, asserted in
explicit mode by `cfc-boundary.test.ts`) — do not move that check behind the
strict gate. The strict-only reject is the writer-fit variant (SC-18b:
`canWrite` confidentiality misfit rejects under strict instead of
persist-and-flag; not yet in code), plus any new fail-closed cases that want
an explicit-mode grace, each with its error contract (SC-18c: stable reason
strings naming rule id + path).

**H5 — trigger reads on the enforcement side (SC-3 completion).**
`CfcTxState.triggerReads` ([types.ts:339-345](../../../runtime/runner/src/cfc/types.ts))
currently joins only the flow derivation. Add their `effectiveReadLabel`s to
the consumed set for the sink-request ceiling and input-requirement gates,
behind a flag folded into the H4 matrix (cost: extra metadata reads per
prepare — measure). Red test: a handler whose *scheduling* was caused by a
secret write egressing to a ceiling'd sink without re-reading the secret
passes today → rejected with the flag on.

---

## 8. Epic F — range-scoped integrity (design-doc only)

Deliberately unscheduled. When prioritized, start with
`docs/specs/cfc-range-scoped-integrity.md` covering: per-range labels on one
field (§14.4.8.2), `IntegritySummary` semantics (`covered-by` vs
`contributors`, `basis`), witness-bearing materialization (§14.4.8.4), and
anchors/partial reads (§14.4.8.5) — plus which parts land memory-side vs
runner-side. No runner code before that doc exists; nothing in Epics A–E
depends on it.

---

## 9. Cross-cutting register

**Dials after this plan (deployment matrix lives in H4's doc section):**

| Dial | Values | Default | Introduced |
|---|---|---|---|
| `cfcEnforcementMode` | disabled/observe/enforce-explicit/enforce-strict | enforce-explicit (Runtime) | exists |
| `cfcFlowLabels` | off/observe/persist | off → observe (H1) → persist (H2) | exists |
| `cfcSinkMaxConfidentiality` | per-sink ceilings | none | exists |
| `cfcPolicyEvaluation` | off/observe/enforce | off | B5 |
| `cfcWriteFloor` | off/observe/enforce | off | D3 |
| `cfcTriggerReadGating` | false/true | false | H5 |
| `renderConfidentialityCeiling` | atoms + caveatKinds | unset → §8.10.6 profile | exists; populated in H3a |
| sqlite 3.c server capability | handshake | absent | E4 |

**PreparedDigestInput additions:** `policySnapshot.digest` (B5), write-attempt
log (D4). Each lands with canonicalization tests in `cfc-canonicalize` and an
invalidation test (post-prepare change → reject at commit).

**Spec/impl sync points.** B6 retires audit item "prompt-specific runtime
branch"; D3 gives SC-18's write-floor a code home (spec home in §8.10 still
owed — `cfc-spec-changes.md` tracks it); C0 and H4 each produce a small spec
PR to `commontoolsinc/specs` (observation-class read mapping per SC-8; the
enforcement×propagation matrix per SC-13). File those against the specs repo
when the design docs settle, keeping `cfc-spec-changes.md` the single tracking
list.

**Known-inaccuracy fix (applied alongside this plan).**
`docs/specs/cfc-runner-future-work.md` §"Default posture" said enforcement
"defaults to `disabled`", citing the types-level constant; the effective
Runtime/shell default is `enforce-explicit` (the types constant is the
bare-transaction fallback). That doc's "Default posture" paragraph and Epic H
bullet were corrected in the same change that landed this plan.

**Test infrastructure reused.** Multi-runtime worker harness for cross-runtime
label-flow tests (reader isolation matters for E3/H5); `cf test` console-error
enforcement means new diagnostics must be structured, not `console.warn`;
integration tests live in `packages/runner/integration/` for sqlite stages.

## Provenance

Grounded in the 2026-07-01 audit (`docs/specs/cfc-runner-future-work.md`) plus
a seam-mapping pass over: `cfc/types.ts`, `label-view-core.ts`,
`observation.ts`, `atom-classes.ts`, `metadata.ts`, the `prepare.ts` gate and
persist regions, `runtime.ts` options, `lib-shell/src/runtime.ts`,
`runtime-client` protocol types, the html reconciler render policy,
`memory/v2/sqlite/row-label.ts` and the runner sqlite builtins,
`memory/v2/engine.ts` (`applySqliteOperation`), `acl-manager.ts`,
`schema-refs.ts`, `ui-contract.ts`, and the scoping docs
(`docs/history/specs/cfc-trusted-agent-tool-integrity.md`,
`runner_cfc_implementation.md`,
`docs/history/specs/cfc-s16-default-transition-design.md`,
`docs/specs/sqlite-builtin/06-cfc.md`).
