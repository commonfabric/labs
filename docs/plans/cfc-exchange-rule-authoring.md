# CFC Exchange-Rule Authoring — Implementation Plan

Status: Direct shipping program (Stages 0–4) implemented. All change-owned
checks pass; the exact schema-generator package task remains blocked by the
pre-existing shared-utils type error recorded in WP4.3. Stages 5–7 remain
blocked on the owner decisions named below and are not authorized by completion
of the direct slice.

This plan turns the direction in
[CFC Exchange Rules — Pattern Authoring Surface](../specs/cfc-exchange-rules-authoring.md)
into dependency-ordered implementation work. The companion
[extensions](../specs/cfc-exchange-rules-authoring-extensions.md) are triaged
near the end of this plan; they are not part of the first shipping slice.

The normative CFC specification lives in the paired `specs` repository at
`~/src/specs/cfc`. It is the source of truth. The `SC-29..SC-37` entries in
[the labs change list](../specs/cfc-spec-changes.md) are still open, so runtime
work must not silently turn the labs proposal into de facto normative behavior.

## Critical-review result

The proposal is directionally sound about four things:

- a pattern may define release paths only for confidentiality clauses it
  creates;
- referenced policies must retain home-clause locality;
- imported policy artifacts should use the defining module's content identity;
- concept defaults should be stable policy kernels backed by mutable grants,
  rather than mutable policy records that strand old labels.

It is not yet a safe implementation contract. In particular:

1. `{ identity, symbol }` content-addresses the defining authored-module export,
   but cross-space evaluation should not have to copy or recompile that export's
   whole source closure. This plan therefore chooses a canonical `policyDigest`
   that lets a destination directly address and byte-verify the smaller,
   subject-independent lowered policy manifest. The pair remains source
   provenance; the digest is the portable evaluation artifact.
2. Pattern deployment has no path that safely adds records to the boot-time,
   attested, frozen `Runtime.cfcPolicySnapshot`. Referenced pattern policies
   need a separate immutable, content-verified, cold-capable resolver. Pattern
   code must never mutate the ambient snapshot.
3. `SELF` is already the public pattern-output self-reference symbol in
   `commonfabric`. Although a transformer could distinguish the two syntactic
   positions, the policy placeholder has different policy-export-level
   semantics. The authoring spelling is `THIS_POLICY`.
4. The direct-rule example does not define how the subject matched by
   `THIS_POLICY` correlates with intent evidence. A hidden convention such as
   variable name `"O"` is not acceptable. The policy-self token needs an
   explicit subject placeholder that authors can reuse. Across spaces, the
   resolver must seed that reserved binding from the label's represented value
   before matching, so a committed subject can unify commitment-aware with
   independently supplied plaintext evidence without being disclosed.
5. The proposal's `pre` surface must lower to the shipped `preCondition`
   representation, and every rule needs a deterministic id. Neither translation
   is currently specified.
6. `cfcAtom.user(v("A"))` does not type-check: `cfcAtom` builds concrete atoms
   and accepts a string subject, while `v()` is an atom-pattern placeholder.
   Pattern constructors must remain distinct from concrete atom constructors.
7. `ConceptOf` is not API sugar over shipped grants. The current resolver
   requires a bound `{ owner, resource }`; the proposed `ConceptGrant` has no
   `resource`, no shipped `requiredIntent` field, and no trusted intent-backed
   writer.
8. Cross-space metadata protection commits `Policy`/`Context.subject`, and a
   fresh variable cannot bind from a commitment. The proposed concept kernel
   relies on exactly that fresh owner binding for owner-space grant lookup.
9. `ConsumerIntent` proves only that code declared a string. It is not release
   authority unless the grant also binds an exact reviewed consumer artifact or
   a verifier-backed consumer concept.

Consequently, the first shipping slice is direct, digest-bound
`PolicyOf<typeof rules>`. `ConceptOf`, consumer defaults, and every extension
remain gated until their substrate and normative decisions are explicit.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent complete only after its child checks and completion gate pass.
Keep this live plan accurate as implementation proceeds. When the final stage
lands, archive it under `docs/history/plans/` following `docs/README.md`.

## How to execute this plan

- Work in red/green/refactor loops. Start every behavioral change with the
  smallest failing test that demonstrates the missing invariant.
- Treat examples as acceptance tests, not screenshots or illustrative prose.
  A reader should be able to copy the example's authoring idiom, while the test
  proves the underlying security property.
- Commit by numbered work package or smaller coherent subtask. Do not combine a
  normative wire-format decision, transformer lowering, runtime resolution,
  and example migration in one commit.
- Preserve the existing `{ name, subject, hash }` policy-reference path and
  ambient deployment records throughout the rollout.
- Do not change the default `cfcPolicyEvaluation` mode or first-party runtime
  presets as part of the authoring work. Observe/enforce rollout is a separate
  gate at the end.
- For transformer work, inspect emitted output with
  `deno task cf check <fixture>.tsx --show-transformed --no-run`.
- Reuse the canonical hashing, cloning, and serialization modules. Policy
  digests use the same canonical value-hash machinery as current
  `PolicyRecord.digest`; do not add another JSON stringifier or SHA-256 path.
- Never make a missing artifact, unknown field, unbound variable, unresolved
  owner, digest mismatch, cold-load failure, or unsupported compiler version
  degrade to an unguarded rule. Every such case fails closed.

## Fixed safety invariants

These are implementation gates, not aspirations.

1. A module-authored rule can rewrite only a home clause carrying the exact
   `{ identity, symbol, policyDigest, subject }` reference that selected it.
2. Input-derived and sibling clauses remain conjunctive and untouched.
3. The pair identifies the defining authored-module export, the digest identifies
   its canonical portable manifest, and the subject is bound by the invoking
   piece at label creation. None of these roles is implicit in another.
4. General rules require integrity or durable policy-state evidence. A
   boundary-only rule is not admitted by the general authoring surface.
5. A policy subject is explicit and consistently bound. The resolver seeds
   `THIS_POLICY.subject` from the selecting label alternative before rule
   matching; plaintext and committed representations use the existing
   commitment-aware equality. No magic variable name, commitment opening, or
   ambient acting-user substitution is inferred from prose.
6. Old labels remain bound to old policy digests. Upgrades create a new policy
   version; old artifacts remain resolvable until an explicit migration or
   documented retirement gate.
7. Pattern-authored policies never enter the ambient operator-policy set and
   cannot gain cross-clause authority by being loaded or imported.
8. Authored policy declarations are static, deterministic, module-level, and
   export-addressable. Runtime-computed rule content is rejected at compile
   time and revalidated at trusted ingestion.
9. The same source imported through `cf:` resolves to the defining module's
   identity, never the importer's identity or a re-exporting module by accident.
10. Missing cold/federated policy state closes access; it never widens a label.

## Dependency map

| Stage | Delivers | Depends on |
| --- | --- | --- |
| 0 | Normative reference/template/resolution contract | Current specs + labs design |
| 1 | Canonical policy-template and module-reference substrate | Stage 0 |
| 2 | Static declarations and compiler-emitted manifests | Stage 1 |
| 3 | `PolicyOf` schema lowering and label-time binding | Stages 1–2 |
| 4 | Direct-policy end-to-end examples and rollout proof | Stages 1–3 |
| 5 | Concept/default-policy normative and storage design | Stage 4 |
| 6 | Concept kernel, grants, and trusted consumer authority | Stage 5 |
| 7 | `ConceptOf`, composition, and concept examples | Stage 6 |
| 8 | Documentation, compatibility, and rollout completion | All shipping stages |

Stages 1–4 are the first implementation program. Stages 5–7 are deliberately
separate: completing Stage 4 must not be held hostage by unresolved concept
defaults, and completing Stage 4 does not authorize starting Stage 5 without
its owner decisions.

## Stage 0 — Normative and architecture gate

No runtime/API implementation begins before this stage closes.

### WP0.1 — Apply the direct-policy contract in `~/src/specs/cfc`

- [x] Apply the SC-29 direction to the normative atom and policy-reference
  sections without deleting the existing named form.
- [x] Define a discriminated module-policy reference carrying, at minimum:
  defining module identity, defining export symbol, exact canonical policy
  digest, and concrete policy subject.
- [x] Define `{ identity, symbol }` as the content-addressed defining module
  export, `policyDigest` as the content address of its canonical portable
  manifest, and `subject` as the invocation-relative principal binding.
- [x] Define the policy record as a subject-independent template. Keep
  `THIS_POLICY` symbolic in the digestible template; bind its subject from the
  selecting label alternative during evaluation.
- [x] Amend §4.4.2/§4.4.3 explicitly: the module-policy variant hashes a
  subject-independent manifest body while the label's complete
  `{ identity, symbol, policyDigest, subject }` tuple selects and instantiates
  it. This is not the current named-policy record shape.
- [x] Define old-version retention and explicit migration. An ordinary module
  upgrade creates a new pair and/or digest but does not rewrite existing labels.
  A space retains every locally referenced manifest for at least as long as the
  labels that reference it.
- [x] Define the failure posture for missing source, unsupported manifest
  version, missing symbol, malformed record, wrong subject, and digest mismatch.
- [x] Extend the home-clause and policy-lookup formal surface for the new
  reference variant, or explicitly record which proof obligation blocks
  implementation.
- [x] Update the normative safety text so general rules require integrity or
  policy-state evidence. If owner-self is intended as an exception, specify it
  as a narrow standard-profile rule, not a generic "guard" category.

Expected spec files include:

- `~/src/specs/cfc/04-label-representation.md`
- `~/src/specs/cfc/05-policy-architecture.md`
- `~/src/specs/cfc/10-safety-invariants.md`
- `~/src/specs/cfc/15-atom-registry.md`
- `~/src/specs/cfc/formal/Cfc/PolicyLookup.lean`
- `~/src/specs/cfc/formal/Cfc/HomeClauses.lean`
- the corresponding files under `formal/Cfc/Proofs/`

Verification:

- [x] `cd ~/src/specs/cfc/formal && lake build`

### WP0.2 — Freeze the policy-artifact transport

The current phrase "deployment registers the record" is insufficient. The
transport must let a destination evaluate without retaining or recompiling the
defining module's full source closure.

Working architecture: no space may commit a persisted policy reference unless
that same transaction already has, or atomically creates, a verified,
create-only local copy of the small policy manifest keyed by `policyDigest`.
Cross-space writes are the replication case. The label carries
`{ identity, symbol, policyDigest, subject }`, not the whole source or manifest.
An initial fetch may use the defining module pair, but subsequent cold
evaluation resolves the local digest directly.

The current implicit design—session-local registration or mutation of the
boot-time snapshot—is rejected.

- [x] Define `PolicyArtifactManifestBodyV1` exactly as `{ formatVersion,
  moduleIdentity, symbol, template }`, where `template` is canonical and
  subject-independent.
- [x] Define `policyDigest` as canonical `hashStringOf` over `{ domain:
  "cfc/policy-manifest/v1", manifest: manifestBody }`. An envelope may repeat
  `policyDigest` for transport, but the digest field is not part of its own hash
  projection.
- [x] Define the persistence/replication lifecycle for immutable manifest bodies
  keyed by `policyDigest`.
- [x] Make every persisted-label write durably create or confirm the local
  manifest in the same destination transaction; cross-space writes copy it as
  part of that rule.
- [x] Tie local manifest retention to the lifetime of the destination space and
  its referencing labels; source retention in the defining space is not a
  prerequisite for later local evaluation.
- [x] Define the source-to-manifest proof chain. A digest check proves manifest
  byte integrity, not correct lowering from `{ moduleIdentity, symbol }`; a
  trusted compiler/verifier must check the source closure, exported symbol, and
  lowering before issuing a binding that a destination can trust without
  retaining the source.
- [x] Define cold lookup after runtime restart and lookup in a federated
  evaluator that never executed the producer module.
- [x] Define how a transaction records every consulted manifest (present or
  absent) in its prepared digest, mirroring consulted grants.
- [x] Define whether manifests are public published artifacts or carry their
  own access policy. If a legitimate recipient cannot fetch a private manifest,
  the intended behavior must be documented as fail-closed rather than left
  accidental.
- [x] Define garbage-collection/retention rules for manifests referenced by old
  labels.

Recommended architecture: keep ambient operator records in the existing
attested `PolicySnapshot`, and add a separate immutable resolver for exact
label-referenced module manifests. Do not merge dynamic artifacts into
`Runtime.cfcPolicySnapshot`.

### WP0.3 — Freeze the direct authoring grammar

- [x] Name the policy-export-level placeholder `THIS_POLICY`; `SELF` remains the
  pattern-output self-reference symbol.
- [x] Define `THIS_POLICY` relative to each containing exported `exchangeRules`
  artifact, not to the module as a singleton. If one rule is reused by multiple
  rule sets, either bind it contextually in each manifest or reject that reuse
  explicitly in v1.
- [x] Give the token an explicit reusable subject pattern, for example
  `THIS_POLICY.subject`, so intent/evidence can correlate to the policy subject
  without a magic variable name.
- [x] Specify match ordering: seed the reserved `THIS_POLICY.subject` binding
  from the selecting label field as represented—plaintext locally or
  `{ digestOf }` after crossing—before matching `appliesTo`. Later plaintext
  evidence unifies through `commitmentAwareEquals`; a committed subject is
  never opened or freshly bound.
- [x] Keep concrete atoms and atom patterns separate. Add a typed pattern
  constructor namespace (working name `cfcPattern`) rather than weakening
  `cfcAtom` to accept placeholders everywhere.
- [x] Specify `pre` as authoring sugar that lowers exactly to
  `preCondition`; specify every accepted/rejected field.
- [x] Derive each rule id from its defining export symbol. Reject non-exported
  rules and duplicate symbols in v1; do not use source-order ordinals.
- [x] Specify re-export semantics: references use the defining module's pair,
  not the re-exporter's pair.
- [x] Specify all variable-binding rules and reject every postcondition
  placeholder not bound by `THIS_POLICY` or a precondition.
- [x] Replace the proposal's over-broad compile-time egress claim with the
  conservative guarantee the compiler can prove: local declaration/reference
  coherence. Runtime evidence, concept grants, and input labels remain runtime
  concerns.

### Stage 0 completion gate

- [x] The normative spec changes are merged or pinned to an accepted commit.
- [x] One canonical lowered direct-policy manifest and label reference are
  written down byte-for-byte.
- [x] The canonical rule passes the existing runtime record validator after
  only the explicitly planned representation adapter.
- [x] A hostile variant with wrong subject evidence is shown not to fire.
- [x] The same subject-correlated rule fires locally and after cross-space
  commitment with correct evidence, and remains closed for wrong evidence.
- [x] The artifact transport has warm, cold, restart, federated, old-version,
  and missing-artifact acceptance cases.
- [x] The labs design documents are corrected to match these decisions before
  the first API symbol ships.

## Stage 1 — Canonical direct-policy substrate

### WP1.1 — Model legacy and module references explicitly

- [x] Add a discriminated policy-reference union in `base/api/cfc.ts` and
  runner CFC types. Preserve the legacy `{ name, subject, hash }` variant.
- [x] Add the exact module variant fixed in Stage 0. Keep the canonical record
  digest present even though the module is content-addressed.
- [x] Extend label-field classification for the new public lookup fields and
  subject representation decided in Stage 0.
- [x] Add encode/decode and cross-space representation tests for both variants.
- [x] Reject ambiguous records that mix legacy and module addressing fields.

Likely files:

- `base/api/cfc.ts`
- `base/api/cfc-atoms.ts`
- `runtime/runner/src/cfc/types.ts`
- `runtime/runner/src/cfc/label-field-classification.ts`
- `runtime/runner/src/cfc/label-representation.ts`

Focused tests:

- `base/api/test/cfc-surface.test.ts`
- `base/api/test/cfc-atom-mints.test.ts`
- `runtime/runner/test/cfc-label-representation.test.ts`
- `runtime/runner/test/cfc-commitment-matching.test.ts`

### WP1.2 — Extract canonical policy-template validation and digesting

- [x] Refactor `runtime/runner/src/cfc/policy.ts` so legacy deployment records
  and compiler-produced templates share one canonical validator and digest
  projection.
- [x] Version the template projection independently from module identity.
- [x] Validate unknown keys, duplicate rule ids, malformed patterns, exactly one
  post effect, guard presence, and no unbound post variables.
- [x] Represent `THIS_POLICY` only in the template form and substitute it only
  in the trusted resolver/evaluator path.
- [x] Deep-freeze every admitted template and manifest.
- [x] Keep current deployment-record bytes/digests unchanged unless Stage 0
  explicitly requires a versioned migration.

Focused tests:

- `runtime/runner/test/cfc-policy.test.ts`
- `runtime/runner/test/cfc-atom-pattern.test.ts`
- new `runtime/runner/test/cfc-policy-template.test.ts`

### WP1.3 — Add the per-evaluation referenced-policy resolver

- [x] Add a pure resolver interface keyed by the exact module reference.
- [x] Keep lookup I/O in a runner-owned closure, as grants do; the exchange
  evaluator remains pure.
- [x] Resolve only records actually selected by label alternatives.
- [x] Verify manifest version, pair, subject/template compatibility, and digest
  before exposing rules.
- [x] Seed `THIS_POLICY.subject` from the selected label alternative's represented
  field into the starting match environment before target matching, and require
  all repeated uses to unify commitment-aware.
- [x] Compose exact referenced records with the ambient snapshot without giving
  either authority over the other's home clauses.
- [x] Record consulted present/absent manifest digests in transaction CFC state
  and the prepared digest.
- [x] Preserve the original label and report exhaustion/failure on resolver
  errors; never partially rewrite.

Likely files:

- `runtime/runner/src/cfc/policy.ts`
- `runtime/runner/src/cfc/exchange-eval.ts`
- `runtime/runner/src/cfc/canonical.ts`
- `runtime/runner/src/cfc/types.ts`
- `runtime/runner/src/cfc/prepare.ts`
- `runtime/runner/src/storage/extended-storage-transaction.ts`

Focused tests:

- `runtime/runner/test/cfc-exchange-eval.test.ts`
- `runtime/runner/test/cfc-policy-boundary.test.ts`
- new `runtime/runner/test/cfc-referenced-policy-resolver.test.ts`
- one prepare/commit invalidation test for absent→present/deleted manifest
  state or reference-digest substitution; same-digest body mutation must be
  impossible

### Stage 1 completion gate

- [x] All legacy policy tests pass without expectation weakening.
- [x] Module refs rewrite only their home clauses.
- [x] Wrong pair, wrong subject, wrong digest, missing manifest, and malformed
  manifest all fail closed.
- [x] A sibling clause is byte-for-byte unchanged after a direct rule fires.
- [x] Absent→present/deleted manifest state or reference-digest substitution
  between prepare and commit invalidates the prepared decision; a body
  substitution under the same digest is rejected as an integrity failure.

## Stage 2 — Static declarations and compiler manifests

### WP2.1 — Add typed authoring values without granting execution trust

- [x] Add public types/functions for `v`, `cfcPattern`, `exchangeRule`, and
  `exchangeRules` under the canonical `commonfabric` exports.
- [x] Keep policy artifacts inert, deeply frozen data. They are not patterns,
  lifts, handlers, executable modules, or implementation-integrity evidence.
- [x] Introduce a separate runner-private addressable-policy-artifact brand if
  live export indexing needs one. Do not broaden
  `isTrustedBuilderArtifact` or `resolvePolicyFacingImplementationIdentity` to
  treat policy data as executable/trusted code.
- [x] Require module-level exported bindings in v1. Imported aliases retain the
  defining artifact identity.

Likely files:

- `base/api/cfc.ts`
- `base/api/cfc-authoring.ts`
- `base/api/index.ts`
- a dependency-light runner authoring module for the private brand

### WP2.2 — Statically validate and lower declarations

- [x] Add a dedicated transformer pass for policy declarations.
- [x] Thread the compiler's per-source module identity map into transformation;
  do not derive identities again inside the transformer.
- [x] Accept only the literal/static expression subset fixed in Stage 0.
- [x] Resolve local exports, direct imports, pinned `cf:` imports, and permitted
  aliases to the defining module identity and symbol.
- [x] Translate `pre` to `preCondition`, stamp deterministic rule ids, preserve
  `preConfScope`, and lower `THIS_POLICY` to the symbolic template form.
- [x] Emit a deterministic `PolicyArtifactManifestV1` per defining module.
- [x] Hard-error on computed content, runtime conditionals, non-exported rules,
  unsupported re-exports, duplicate rule ids, unguarded rules, unknown fields,
  unbound post variables, or a policy token used outside its allowed position.

Likely files:

- `base/ts-transformers/src/core/transformers.ts`
- a new `base/ts-transformers/src/transformers/cfc-policy-authoring.ts`
- `base/ts-transformers/src/mod.ts`
- `runtime/runner/src/harness/engine.ts`

Focused tests:

- extend `base/ts-transformers/test/cfc-authoring.test.ts`
- add focused fixtures under `base/ts-transformers/test/fixtures/`
- inspect one local and one `cf:`-imported fixture with `--show-transformed`

### WP2.3 — Persist and cold-load manifests

- [x] Carry emitted manifests through the compiler/harness result without
  mixing them into JavaScript module exports.
- [x] Persist them through the Stage 0 transport alongside the existing
  source/compiled artifact lifecycle.
- [x] Verify create-only/content-addressed write semantics and byte equality on
  idempotent recompilation.
- [x] Cold-load and verify a manifest without evaluating the producer module.
- [x] Replicate the verified manifest to every destination space that persists a
  referencing label; do not require those spaces to copy the defining source.
- [x] Do not use PatternManager's session-local artifact index as the durable
  source of truth.

Likely files depend on the Stage 0 transport, but will include the compiler
result types and relevant compilation-cache/deploy path.

Focused tests:

- compiler cache write/read/restart tests
- `runtime/runner/test/fabric-imports-engine.test.ts`
- `runtime/runner/test/fabric-imports-pattern-manager.test.ts`
- a tampered-manifest rejection test

### Stage 2 completion gate

- [x] Identical source + compiler profile emits byte-identical manifests.
- [x] A lowering-profile change cannot reuse an old `policyDigest` silently.
- [x] Warm and cold resolution return the same verified template.
- [x] A pinned `cf:` import emits the dependency's defining pair.
- [x] No policy-data object gains builder execution trust or verified
  implementation provenance.

## Stage 3 — `PolicyOf` schema lowering and label-time binding

### WP3.1 — Add `PolicyOf<typeof rules>` to the authoring contract

- [x] Add the public type alias and canonical-alias registry entries.
- [x] Require a direct `typeof` query of an exported `exchangeRules` artifact.
- [x] Preserve binding identity through schema generation for local and imported
  artifacts, following the narrow `WriteAuthorizedBy` marker precedent without
  conflating the two claim types.
- [x] Lower inferred pattern schemas, explicit output schemas, and
  `toSchema<T>()` identically.
- [x] Emit a hard diagnostic for a plain object, computed expression,
  non-exported binding, wrong artifact kind, or unresolved import.

Likely files:

- `base/api/cfc.ts`
- `base/schema-generator/src/formatters/common-fabric-formatter.ts`
- `base/ts-transformers/src/transformers/schema-generator.ts`
- `docs/specs/ts-transformer/cfc_authoring_contract.md`

Focused tests:

- `base/schema-generator/test/schema/cfc-authoring.test.ts`
- `base/ts-transformers/test/cfc-authoring.test.ts`
- `base/ts-transformers/test/schema-generator-coverage.test.ts`

### WP3.2 — Bind the concrete subject at label creation

- [x] Add the Stage 0 subject/owning-space placeholder to schema metadata.
- [x] Thread the target address/space through every schema-derived label mint
  path that can encounter `PolicyOf`; do not substitute the acting principal
  where the contract says storage space, or vice versa.
- [x] At label creation, resolve the referenced manifest, attach the concrete
  pair + `policyDigest` + subject, and fail the write closed if resolution is
  unavailable or inconsistent.
- [x] Preserve schema merge stability for identical references and reject
  conflicting pair/digest/subject markers.
- [x] Ensure cross-space representation leaves every lookup-critical field in
  the Stage 0-approved form.

Likely files:

- `runtime/runner/src/cfc/prepare.ts`
- `runtime/runner/src/cfc/schema-merge.ts`
- `runtime/runner/src/cfc/metadata.ts`
- schema/label minting helpers in `runtime/runner/src/cfc.ts`

Focused tests:

- new authored-schema-to-persisted-label test
- `runtime/runner/test/cfc-schema-merge.test.ts`
- `runtime/runner/test/cfc-boundary.test.ts`
- `runtime/runner/test/cfc-cross-space-integrity.test.ts`

### WP3.3 — Add authored OR only after direct references work

- [x] Add `AnyOf` type-level lowering to the already-shipped
  `{ anyOf: [...] }` clause wire form.
- [x] Reuse the existing forbidden-alternative validation; do not add a second
  principal-family table.
- [x] Warn that `AnyOf<[PolicyOf<A>, PolicyOf<B>]>` weakens one clause and
  unions both alternatives' release paths.
- [x] Keep conjunctive `Confidential<T, [PolicyOf<A>, PolicyOf<B>]>` the
  default and demonstrate the difference in transformed schemas.

### Stage 3 completion gate

- [x] The canonical direct example compiles without casts or raw `ifc` JSON.
- [x] Inferred/explicit/`toSchema` paths produce the same reference.
- [x] The stored label contains the exact verified reference and concrete
  subject.
- [x] Input labels join as independent clauses.
- [x] Direct refs survive persist/reload and cross-space representation under
  the Stage 0 contract.

## Stage 4 — Direct-policy examples and end-to-end proof

The examples are part of the feature, not cleanup after it.

### WP4.1 — Add a small canonical example suite

Create `patterns/examples/cfc-exchange-rules/` as a demo-quality, copyable
authoring example rather than adding more cases to the already broad CFC spec
gallery.

- [x] `direct-release.tsx`: an exported, subject-correlated, integrity-guarded
  rule set and an output annotated with `PolicyOf<typeof rules>`.
- [x] `direct-release.test.tsx`: pattern-native construction/happy paths;
  lower-level runner tests cover absent and wrong-subject evidence because a
  pattern test cannot introspect or forge trusted boundary evidence.
- [x] `imported-policy.tsx`: the same policy imported locally, plus a pinned
  `cf:` compiler acceptance test proving defining-module identity.
- [x] `README.md`: explain the one-clause authority bound, the difference
  between concrete atoms and atom patterns, and why an unresolved policy fails
  closed.
- [x] Add the directory to `patterns/index.md` as a `demo`; do not
  present it as an application-style exemplar.

Use an integrity family that actually ships for the first runnable example.
Do not make the first acceptance test depend on unimplemented
`EndorsedIntent`/`ConsumerIntent` atoms.

### WP4.2 — Prove the security properties below the pattern layer

- [x] Matching evidence releases the direct home clause.
- [x] Missing evidence leaves the original label unchanged.
- [x] Evidence for a different policy subject does not fire the rule.
- [x] Two pieces using the same `{ identity, symbol, policyDigest }` bind
  different subjects; evidence for one invocation cannot release the other.
- [x] An unrelated input/sibling clause remains closed.
- [x] A forged policy object in schema metadata is rejected.
- [x] A wrong module, symbol, digest, or manifest body fails closed.
- [x] Warm load, cold load, runtime restart, and cross-space destination load
  agree, including a cold evaluator that touches only the destination space.
- [x] A destination evaluates from its local manifest after the defining source
  space becomes unavailable; a persisted-label commit without an atomic local
  manifest copy fails closed.
- [x] Upgrading the producer creates a new reference while an old label still
  resolves its old immutable artifact or follows the explicit migration
  posture fixed in Stage 0; the cold old/new-version case is pinned in
  `cfc-policy-of-label.test.ts`.
- [x] Imported direct rules retain the exporting module's identity.
- [x] `AnyOf` demonstrates weakening only when explicitly authored.

Place pure calculus cases in runner unit tests, compiler cases in transformer
tests, and one complete compile→persist→reload→evaluate scenario in a runner or
pattern integration test. The compiler-backed cold path is pinned in
`cfc-policy-of-label.test.ts`. Do not force every invariant through a slow
browser test.

### WP4.3 — Verification gates

- [x] `deno task cf test patterns/examples/cfc-exchange-rules/`
- [x] `deno task check`
- [x] `deno task --cwd base/api test`
- [ ] `deno task --cwd base/schema-generator test` — blocked before test
  execution by the pre-existing `base/js-values/src/arrays.ts:91`
  `string | undefined` type error. The focused CFC schema suite passes.
- [x] `deno task --cwd base/ts-transformers test`
- [x] `deno task --cwd runtime/runner test`
- [x] `deno task check-docs specs plans common`
- [x] Run the focused cross-space/federation-equivalent integration case
  required by the Stage 0 transport: copy source→destination, restart without
  the producer module, touch only the destination, resolve the local manifest,
  and evaluate the rule (`cfc-policy-of-label.test.ts`).

### Stage 4 completion gate

- [x] Direct `PolicyOf` is usable from ordinary pattern TypeScript.
- [x] The canonical examples are green and reviewed as author-facing material.
- [x] Legacy policies and patterns with no exchange-rule authoring are
  unchanged.
- [x] The direct path has observe-mode diagnostics for resolution and firing.
- [x] Enforce mode is enabled only in explicit test/demo runtimes; production
  defaults remain unchanged pending separate rollout approval.

## Stage 5 — Concept/default-policy design gate

This stage starts only after direct policies ship. It applies SC-30/31/32/33/35
normatively and corrects the concept examples before runtime work.

### WP5.1 — Define stable concept and owner identities

- [ ] Define one canonical `ConceptId` wire type across confidentiality Context
  atoms, integrity Concept guards, caveat kinds, grants, and trust statements.
- [ ] Decide whether module-relative concepts are versioned identities or
  stable coordination identities. A whole-module hash that changes on unrelated
  edits must not silently orphan grants and trust statements.
- [ ] Define owner as an acting principal, storage space, or explicit value
  provenance. Do not use the phrase "owning space" for multiple meanings.
- [ ] Define an owner/grant discovery carrier that remains usable after
  cross-space label-metadata protection.
- [ ] Specify personal-space, shared-space, imported, and federated cases.

### WP5.2 — Map concept defaults onto the canonical grant store

- [ ] Express `ConceptGrant` as a profile/wrapper over `CfcGrant`, not a parallel
  storage engine.
- [ ] Put `{ concept, requiredIntent, consumer/surface constraints }` in the
  canonical `resource` scope or normatively change the generic grant address.
- [ ] Reconcile the current one-record-per-scope mutable audience with SC-35's
  assumption of multiple independent grants per concept.
- [ ] Match audience as the complete principal atom, or destructure it with an
  atom pattern. Never wrap an already-complete audience atom as
  `User{subject: <atom>}`.
- [ ] Define revocation, expiry, single-use, enumeration, and recombination
  behavior using the existing grant lifecycle.

### WP5.3 — Make consumer intent real authority or remove it from the gate

- [ ] Choose one authority model: exact reviewed consumer artifact
  `{ identity, symbol }`, or verifier-backed concept satisfaction for the
  consumer implementation.
- [ ] Bind the grant to that consumer authority plus purpose/surface. A
  self-declared string alone cannot release data.
- [ ] Define atom shape, propagation class, runtime mint gate, forged-schema
  stripping, and prepared-digest inputs.
- [ ] Implement the trusted review/policy-writer evidence chain before exposing
  a public `ConceptGrant` acceptance surface.
- [ ] Add the adversarial acceptance case: malicious code declares the same
  intent string and remains denied.

### Stage 5 completion gate

- [ ] The corrected kernel record passes the real policy validator and evaluator
  without hand-translating example fields.
- [ ] Owner-only bootstrap, standing grant, revocation, and one-shot grant are
  defined byte-for-byte.
- [ ] The kernel works after cross-space persistence; fresh owner binding does
  not rely on opening a commitment.
- [ ] `lake build` passes for the updated normative/formal spec.

## Stage 6 — Concept kernel, grants, and trusted authority

### WP6.1 — Ship the standard concept kernel as trusted substrate

- [ ] Add one versioned, hash-stable kernel template using the canonical concept
  and grant shapes from Stage 5.
- [ ] Implement owner access through the exact narrow standard-profile rule
  approved by the spec; do not introduce a generic acting-user literal.
- [ ] Bootstrap an unconfigured concept with zero grants and prove it is
  owner-only.
- [ ] Keep kernel replacement rare and explicit; retain old kernels for old
  labels.

### WP6.2 — Add typed concept-grant operations through the trusted writer

- [ ] Add create/update/revoke helpers that delegate to the existing
  `writeCfcGrant` path and reserved namespace.
- [ ] Source audience, purpose, required consumer authority, expiry, and
  single-use from trusted review evidence, never proposing-pattern data.
- [ ] Reuse consulted-grant digesting and consumption receipts.
- [ ] Add active-grant enumeration for the owner-facing review surface without
  changing the evaluator's point-query discipline.

### WP6.3 — Add consumer-authority minting and evaluation

- [ ] Mint evidence only from verified module identity plus the Stage 5
  authority model.
- [ ] Bind it into the exact boundary evaluation that consumes the data.
- [ ] Fail closed across cold load, missing trust config, revoked verifier
  delegation, wrong surface/purpose, and cross-space resolution failure.

### Stage 6 completion gate

- [ ] Owner-only/no-grant, standing grant, revoke, expire, wrong consumer,
  wrong purpose, and single-use cases pass end to end.
- [ ] The generic grant tests remain unchanged and green.
- [ ] No concept policy performs grant enumeration during rule evaluation.

## Stage 7 — `ConceptOf`, composition, and examples

### WP7.1 — Add concept artifacts and `ConceptOf`

- [ ] Add well-known URI concepts first.
- [ ] Add module-relative concepts only if Stage 5 settled stable identity and
  migration; otherwise keep that spelling unavailable.
- [ ] Lower `ConceptOf<typeof concept>` to the exact kernel-bound Context shape.
- [ ] Bind the concrete owner/discovery fields at label creation.
- [ ] Add local/imported diagnostics and inferred/explicit schema parity tests.

### WP7.2 — Prove composition

- [ ] `Confidential<T, [ConceptOf<C>, PolicyOf<P>]>` creates two conjunctive
  clauses and requires a release path through both.
- [ ] Input-derived clauses remain additional conjuncts.
- [ ] `AnyOf<[ConceptOf<C>, PolicyOf<P>]>` creates one explicit weakening and
  is diagnosed as such.
- [ ] A rule selected by one alternative cannot rewrite a sibling clause.

### WP7.3 — Add concept examples as executable tests

Extend `patterns/examples/cfc-exchange-rules/` with small examples:

- [ ] owner-only bootstrap with no grant;
- [ ] standing grant accepted through a trusted review surface;
- [ ] revocation closes access on the next evaluation;
- [ ] consumer authority mismatch remains closed;
- [ ] direct + concept conjunction;
- [ ] one-shot grant consumed only at a consuming boundary;
- [ ] cross-space persist/reload; and
- [ ] explicit `AnyOf` weakening beside the safer conjunctive default.

Every example gets a pattern-native test where practical and a lower-level
runner test for the security property that cannot be observed safely through
pattern UI alone.

### Stage 7 completion gate

- [ ] All concept examples are green, copyable, and use no raw policy JSON.
- [ ] Personal/shared/cross-space cases match the Stage 5 owner contract.
- [ ] Malicious self-declared consumer intent remains denied.
- [ ] Active grants are visible to the owner-facing review surface.

## Extensions disposition — not scheduled by this plan

The extensions document is exploratory. Each item needs its own normative gate
and implementation plan after the core direct path is proven.

| Surface | Why it is not in the core plan | Entry gate |
| --- | --- | --- |
| Sink `paths` + `AuthorityOnly` | The runner currently joins a transaction-wide consumed label and does not provide request-field path attribution to policy evaluation. A path-scoped `dropClause` could release a token that also leaked into the body. | Per-path boundary evaluation and authority-only flow semantics |
| Error exchange rules | The current evaluator rewrites labels only; it does not sanitize values, relabel descendant paths, or mint `SanitizedError`. | Separate trusted transformation/sanitizer design |
| Generic caveat discharge helper | The sketch does not bind evidence to the same source, value, and release site, violating invariant 10. | Source/value/sink-correlated rule shape and tests |
| Multi-party consent | The sketch omits purpose and SC-37 makes it optional, while the normative spec requires scope, audience, and purpose. | Correct reserved evidence shape, replay/expiry, and trusted minting |
| `PolicyCertified` execution envelope | Exchange policy references do not define execution constraints or an attesting enforcement environment. | Separate execution-policy schema, composition, enforcement, and attestation plan |
| `claimsConcept` | Claims have no authority and need registry/review tooling, not evaluator changes. | Tooling product contract and verifier workflow |
| TTL sugar | `ttl(86_400)` in a type argument is invalid TypeScript, and TTL-to-Expires label-time binding is separate work. | Valid type syntax plus runtime TTL binding |
| Row-set `skip` | The normative spec still requests a noninterference attempt and a threat model for self-declared ceilings. | Formal/security review and collection-read implementation plan |

Do not expose helpers for these surfaces merely because a type can be made to
compile. The runner must enforce the semantics in the same landing sequence.

## Stage 8 — Compatibility, documentation, and rollout

### Final completion gate

- [x] Existing named/hash-bound policies and deployment snapshots still work.
- [x] Patterns with no new authoring symbols compile to byte-identical or
  semantically identical output, with an explicit test guarding the boundary.
- [x] Old module-policy manifests remain resolvable for old labels.
- [x] Live CFC authoring docs, API reference, component/examples docs, and
  `patterns/index.md` match shipped behavior.
- [x] Change-owned focused checks, the API/transformer/runner package tasks,
  docs, and root `deno task check` pass. The schema-generator package-task
  baseline is recorded in WP4.3.
- [x] `cfcPolicyEvaluation: observe` has useful diagnostics for policy lookup,
  digest mismatch, rule firing, and exhaustion.
- [x] Any proposal to change first-party presets or defaults is reviewed as a
  separate rollout change with rollback criteria.
- [ ] Archive this plan only after the last scheduled shipping stage is complete.
