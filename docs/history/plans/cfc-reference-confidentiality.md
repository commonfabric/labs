---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Executed implementation plan; current behavior and support boundaries live in the CFC reference specification."
superseded-by: docs/specs/cfc-references.md
---

# CFC reference confidentiality

Implement independently labeled references according to the merged
[CFC specification at ca3b3e6](https://github.com/commontoolsinc/specs/commit/ca3b3e6cdac99a7b14951f48cec63949b39eaaa9),
especially
[§8.2, Pass-Through via References](https://github.com/commontoolsinc/specs/blob/ca3b3e6cdac99a7b14951f48cec63949b39eaaa9/cfc/08-02-pass-through-via-references.md).
This records the plan executed by the reference-confidentiality implementation.
The original checklist below records the planned acceptance scope. The current
contract and supported limits are maintained in
[CFC references](../../specs/cfc-references.md).

## Execution disposition

The implementation delivers versioned reference entries, private acquisition
provenance across Runtime and worker carriers, semantic reference observations,
subject-specific content evidence, authorization revision dependencies, and
reference-aware disclosure and persistence. Review regressions cover legacy
slot completeness, reference writer-fit, scoped aliases, same-attempt and
same-value replacement, stale content endorsements, and observable validation
outcomes.

Verification runs in the trusted Runtime before storage submission. Storage
checks the captured revisions without interpreting CFC policy. Mutable
cross-space content assertions reject because admission cannot bind their
read-only target evidence atomically. Verification also rejects unavailable
snapshot evidence and evidence whose confidentiality the attempt does not
already carry. Handle schemas remain read projections; this change does not
add a generic payload-validation gate.

Precise reads require complete reference provenance at each stored slot.
Enabling precise persistence requires compatible readers throughout the
protected deployment; this work performs no migration of live data. Shared
coordinator references retain their creation and reselection history even when
terminal computations execute per element. These are supported boundaries, not
claims that the Lean models prove every runtime channel or deployment profile.
The delivered behavior supersedes the proposed details below.

## Intended behavior

For `A.selected → B.item`, writing the reference updates A's binding and CFC
metadata. It does not write B. A records the confidentiality of acquiring,
selecting, and exposing that reference, together with A's applicable slot and
structure policies. B retains its content labels.

A public, independently acquired reference to confidential content can remain
public. A private query selecting public items produces confidential reference
identities and membership. Reading through either reference consumes the
reference restrictions and the current target restrictions. Creating a reference
grants no target-content authority.

An explicit endorsement may certify that the selected identity is an appropriate
result. Its subject and authority must be recorded. It does not automatically
certify the target's contents. Content schemas and write floors resolve current,
scoped evidence from B when required; successful validation does not transfer
B's confidentiality into A's reference label.

## Implementation decisions

1. Separate reference provenance, resolved target evidence, and scoped
   endorsements. They can share canonical addresses and label operations, but
   must not share an unqualified label view that erases their subjects.
2. Use the existing conservative observation/control join, including triggers,
   for reference creation unless a trusted structural isolation mechanism proves
   a narrower footprint. A link-covered write is not a precision proof.
3. Keep target evidence transaction-local initially. Do not add a persistent
   target-label cache. This avoids a second replicated metadata and invalidation
   mechanism; it does not remove commit-time freshness requirements.
4. Make the persisted semantic change explicit. The proposed format is a CFC
   envelope version 2, with explicit reference observation classes and scoped
   endorsement subjects. Introduce readers before enabling these writes. Keep
   legacy interpretation explicit when an upgraded document still contains
   legacy entries. Do not silently reinterpret version 1 data as precise
   reference provenance.
5. Implement wildcard content floors for concrete linked contributions using the
   existing schema/path traversal. Reject any unsupported claim in enforcing
   mode. Do not retain the wildcard skip.
6. Complete the reader, authorization, and boundary changes before enabling
   writes that omit copied target labels. Intermediate stages must preserve
   restrictions. Record enforcement prerequisites in the existing profile and
   experimental-option documentation; an off/observe configuration cannot claim
   enforcement of its disabled checks.

Envelope version 2 is an implementation proposal, not a new requirement imposed
by the spec. Stage 1 must fix its concrete representation and demonstrate that
older supported readers reject it at protected boundaries. If that cannot be
established, precise writes require a deployment compatibility barrier as well.

## Source map

Inspection used Labs `16de7e0c871d21023111729b40876497dbaf3e36`. Refreshed
`origin/main`, `c8f12c69ae0ae386652a8d6ab46935dc069a6b08`, is two commits ahead;
the inspected CFC, data-updating, and link-resolution paths have no intervening
diff. Recheck the implementation baseline before execution.

| Area                    | Implementation seam                                                                                            | Required work                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Recording writes        | `packages/runner/src/data-updating.ts`, `recordLinkWritePolicyInput`                                           | Record reference acquisition and selection even when A and B have no existing CFC metadata.                                            |
| Stored reference labels | `packages/runner/src/cfc/prepare.ts`, `derivePersistedLinkLabel` and `prepareBoundaryCommit`                   | Separate reference provenance from target evidence; remove rebased target descendants only after readers and gates are ready.          |
| Flow and writer-fit     | `prepare.ts`, `forEachFlowObservation`, `deriveFlowJoin`, and flow persistence                                 | Replace trace-covered probe suppression and link-covered write exemptions with complete semantic observations.                         |
| Resolution and views    | `link-resolution.ts`, `cell.ts`, `schema.ts`, `query-result-proxy.ts`, and `cfc/label-view*.ts`                | Preserve every hop's reference restrictions and distinguish reference-only views from resolved content views.                          |
| Floors and claims       | `prepare.ts`, `verifyWriteFloor`, exact-copy verification, and `gateRuntimeMintedIntegrity`                    | Verify by subject, retain nested-path mapping, implement wildcard coverage, and keep authorized minting separate from confidentiality. |
| Journal and prepare     | `storage/extended-storage-transaction.ts`, `storage/reactivity-log.ts`, `cfc/types.ts`, and `cfc/canonical.ts` | Bind semantic observation order, acquisition, and verification dependencies to the attempt.                                            |
| Commit admission        | `storage/v2.ts`, `storage/v2-transaction.ts`, and the Memory admission path                                    | Keep required authorization dependencies through conflict filtering and validate external changes at commit.                           |
| Boundaries              | `cfc/observation.ts`, render and sink gates, LLM builtins, HTML worker, and label introspection                | Classify the actual observation and protect reference, content, and metadata channels separately.                                      |

The
[spec decision record](https://github.com/commontoolsinc/specs/blob/ca3b3e6cdac99a7b14951f48cec63949b39eaaa9/cfc/notes/reference-confidentiality-decision.md)
provides additional implementation evidence. The merged Lean models establish
properties under their recorded-dependency and revision-coherence assumptions;
they do not prove the runtime journal, cross-space commit protocol, or metadata
channels complete.

## Stage 1: Define the representation and compatibility contract

- [ ] Define three distinct runtime records: authenticated acquisition of a
      complete reference binding; a classed reference observation; and current
      target evidence with its validation dependencies. Reuse canonical path,
      address, scope, and label helpers.
- [ ] Fix the version 2 envelope and carried-view representation. Preserve
      `origin` as the component update discipline and observation class as the
      consumption rule. A component tag alone must not decide whether a label
      applies to reference identity, structure, content, or metadata.
- [ ] Represent endorsement subjects explicitly enough to distinguish a
      relationship/binding from a target subpath at a content version. Preserve
      existing integrity authority checks; no author-controlled view or new
      record field may grant mint authority.
- [ ] Add version-aware readers and round-trip tests across storage, worker
      transport, and protected boundary consumers. Audit direct envelope
      parsers, including harness/FUSE/inspection adapters, rather than assuming
      they all use `readStoredCfcMetadata`.
- [ ] Specify legacy handling: retain clauses of mixed entries unless trusted
      re-derivation establishes their provenance. Retaining copied target
      restrictions alone does not reconstruct missing selection dependencies. A
      precise operation with unresolved acquisition or required labels must
      reject. Report conservative compatibility separately from precise
      conformance; do not bulk strip or rewrite live data.

Acceptance: v1 fixtures retain their restrictions, v2 round-trips preserve
subjects and observation classes, and unsupported versions fail closed at every
protected reader exercised. No precise reference writer is enabled yet.

## Stage 2: Record authoritative acquisition and semantic observations

- [ ] Inventory Cell conversion, query-result conversion, raw sigil handling,
      serialization, schema narrowing, aliases, opaque handles, and same-attempt
      child-document creation. Each constructor/forwarder must have an
      authenticated acquisition route. Full address normalization is necessary
      but is not evidence of authorized acquisition.
- [ ] Bind acquisition to space, identity, logical path, addressing mode, and
      capability/opaque scope. Preserve identity/path confidentiality and any
      equality, topology, existence, or membership observations used to acquire
      it. Runtime-owned provenance may follow the existing private authorization
      token pattern; handler-supplied records and carried display labels remain
      untrusted.
- [ ] Remove the existing metadata-relevance shortcut as a reason to omit a
      reference write. A confidential selector can choose between otherwise
      unlabeled documents and write into an unlabeled receiving slot.
- [ ] Record explicit reference observations separately from resolver
      bookkeeping. Associate application dereferences with their hop provenance
      and the existing journal/write-prefix clock. An explicit equality read
      must survive a later covering dereference trace.
- [ ] Retain complete per-attempt control and trigger dependencies. Preserve
      existing pointwise precision only where its isolation proof covers the
      reference identity and exposed structure. Test ordinary scalar outputs as
      well as collection operators.

Acceptance: a private selector choosing two public constants produces protected
identity, existence/membership, and resolved-content observations. The positive
control is an independently acquired public reference. Forged provenance cannot
make the private selection public.

## Stage 3: Resolve observations with every reference restriction

- [ ] Introduce an explicit purpose at the shared CFC resolution seam: reference
      identity/structure, application content, label metadata, or trusted
      assertion evidence. Map `followRef`'s current pointer-probe meaning
      explicitly; do not treat application dereference as invisible machinery.
- [ ] For application dereference, accumulate applicable reference restrictions
      at every hop and current target labels for the observation actually made.
      A target descendant override must not erase restrictions on the reference
      used to reach that descendant.
- [ ] Split reference-only carried views from resolved content views in
      `label-view-state.ts`, `label-view-core.ts`, and `label-view.ts`. Audit
      `resolveAsCell`, `key`, `asSchema`, transaction rebinding, query-result
      proxies, and schema traversal for provenance loss or unintended target
      acquisition. Bare covering entries apply according to their version and
      observation semantics, not a blanket content-only rule.
- [ ] Deduplicate accounting without erasing semantic reads. Keep topology
      traces suitable for view replay; bind ordered semantic events separately
      where needed. A memo hit and a cold resolution must produce equivalent
      labels and authorization dependencies without redundant policy work.
- [ ] Reuse the resolver's existing cycle detection and depth bound. Required
      but unreadable target evidence fails closed. Normalize missing, revoked,
      deleted, cyclic, and stale outcomes when the observer lacks authority to
      distinguish them. A reference-only operation must not inspect B merely to
      distinguish these cases.
- [ ] Preserve scoped integrity composition. Pointer confidentiality does not
      mint integrity; a content-only hereditary meet may omit pointer integrity
      only when its claim does not certify the omitted selection/routing.

Acceptance: direct and multi-hop dereferences retain selection confidentiality;
identity-only operations do not read target content; repeated memoized
resolution, descendant selection, and cross-space traversal preserve the same
applicable restrictions.

## Stage 4: Bind target verification to commit admission

- [ ] Separate handler taint from authorization dependencies. Trusted target
      verification need not taint the handler as a content read, but all
      evidence affecting authorization must remain a real commit dependency.
- [ ] Add an explicit dependency classification that survives `storage/v2.ts`'s
      internal-CFC-read and mergeable-operation filters. Preserve the existing
      ability to exclude genuinely incidental reads. Avoid turning every
      unrelated mergeable append into a whole-document conflict.
- [ ] Bind the required target value, labels, schema closure, traversed
      bindings, and policy/grant/authority state to the same coherent attempt.
      Verify principal-dependent policy at the relevant boundary. Immutable
      content identity does not imply immutable grants or policy.
- [ ] Carry these dependencies through the actual admitting storage engine.
      Exercise both ordinary commits and served/wave admission. The existing
      `sealSpaceReads` handoff records read-only-space participation; establish
      what version validation it provides before relying on it for this rule.
      `addCommitPrecondition` currently claims a write space, so blindly adding
      target preconditions is not a solution for read-only B. Do not introduce
      dummy writes into B.
- [ ] Reject stale evidence, reused revisions/ABA, or unsupported cross-space
      validation. Restart from a fresh snapshot through the normal transaction
      mechanism when supported. A matching prepared activity digest, a TTL, or
      change notifications cannot substitute for external-state validation.
- [ ] Keep binding, labels, and validated endorsement evidence atomic at A. A
      cross-space assertion whose freshness cannot be guaranteed must fail
      closed in enforcing mode; reference-only forwarding remains independently
      governed by its acquisition/transfer requirements.

Acceptance: mutate only B's labels, schema, binding, or relevant policy after
prepare while leaving the local journal unchanged. The stale write must not
commit. Demonstrate this through real admission, including a read-only target
space, with event-controlled interleavings and a no-change positive control.

## Stage 5: Separate floors, schema assertions, and endorsements

- [ ] Split `derivePersistedLinkLabel` into reference derivation and target
      evidence verification. Required content checks resolve B at the attempt's
      snapshot without depositing B's confidentiality in A's reference entries.
- [ ] Route schema, exact-copy, pass-through, and integrity requirements by
      subject. Reference exact-copy verifies the complete preserved binding and
      restrictions; materializing content is a dereference followed by a copy.
- [ ] Preserve nested floors: a content requirement at `A.selected/x` maps to
      `B.item/x`. Verify every applicable linked contribution. Expand supported
      wildcard requirements to concrete contributions, including relevant
      membership observations; reject unsupported cases instead of skipping.
- [ ] Separate destination relationship claims from exact-content evidence in
      `verifyWriteFloor`. Neither local `addIntegrity` nor `LinkReference`
      provenance may accidentally satisfy a content requirement with a different
      subject. Retain legitimate, authorized scoped endorsements.
- [ ] A creation-time content endorsement must bind an immutable target version,
      require revalidation on use, or rely on an enforced maintained invariant.
      The initial implementation should revalidate mutable targets rather than
      introduce a new maintained-invariant mechanism.
- [ ] Protect any observable validation outcome. Blind verification must return
      a correctly labeled result or an indistinguishable denial, not a public
      schema/floor oracle into confidential target contents.

Acceptance: relationship endorsement succeeds for its intended reference claim
and fails as evidence for unrelated content; current authorized target evidence
satisfies content floors; stale, missing, forged, and uncovered wildcard
evidence does not. A write without a target assertion need not read B's payload.

## Stage 6: Complete boundaries and enable precise persistence

- [ ] Audit consumers independently: input-integrity gates, exact-copy checks,
      sink ceilings, opaque serialization, rendered nodes, LLM payloads, and
      metadata introspection. `buildGatedReads` and `collectConsumedLabel` do
      not currently use exactly the flow join's observation rules; do not
      migrate them by changing one global exclusion predicate.
- [ ] Make raw identity exposure consume reference labels and materialization
      consume reference plus target labels. Follow worker HTML reconciliation,
      LLM/dialog structured serialization, and external harness/FUSE adapters to
      the bytes or metadata the recipient actually receives. Opaque transport
      must not lend the sender's authority to the recipient.
- [ ] Protect secret-dependent label presence, type/kind, counts, ordering, and
      empty introspection results. Update `label-metadata-population.ts` and
      `label-introspection.ts`; unconditional public type/kind shortcuts are not
      sufficient. Include replica audiences in metadata and reference
      writer-fit.
- [ ] Persist acquisition/carried reference restrictions and derived
      creation/selection/control restrictions at A. Apply writer-fit to the
      reference and structure being stored. Remove the exact-link flow-stamp
      exemption and the writer-fit omission it causes.
- [ ] Stop copying B's root and descendant content labels into precise A
      reference components. Keep B's metadata unchanged. Preserve
      declared-policy monotonicity, canonical no-op persistence, and
      replacement/removal of carried entries for references removed by an
      ancestor overwrite.
- [ ] Enable precise writes only after stages 1–5 and the affected boundaries
      pass. Handle legacy entries under the compatibility contract, including
      explicit unresolved-provenance failures. No automatic historical label
      relaxation or live-data migration is part of this change.

Acceptance: A's precise reference metadata depends on the reference and its
creation context, not the size or label topology of B. New dereferences observe
B's current labels without rewriting A's selection history. Public reference
forwarding and confidential content protection both work through real
boundaries.

## Regression matrix

Extend the existing focused suites when they own the behavior. Add new tests
only for new semantic seams; each negative case needs a meaningful authorized or
independent-input control.

| Scenario                                                    | Required result                                                                                      | Existing suite anchors under `packages/runner/test/`                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Public acquisition of a secret target                       | Public reference-only operation; dereference consumes target C; no B write                           | `cfc-observation-classes`, `cfc-label-view-resolved`                                   |
| Secret selector chooses public values                       | Identity comparison, scalar output, membership/order, and dereferenced value retain selector C       | `cfc-flow-labels`, `cfc-flow-pointwise`, `cfc-write-prefix-provenance`                 |
| Explicit comparison followed by dereference                 | Trace dedup does not erase comparison or hop restrictions                                            | `cfc-observation-precision`, `cfc-flow-probe-memo`                                     |
| Forwarding, chains, aliases, descendant labels              | All applicable reference restrictions survive; recipient authority is checked                        | `cfc-label-view`, `cfc-label-view-resolved`, `cfc-sink-ceiling-link-read`              |
| Reference and structure exceed receiving audience           | Writer-fit rejects, including a pure-link object or array                                            | `cfc-writer-fit`, `cfc-link-crossing-write-authority`                                  |
| Relationship endorsement versus content floor               | Scoped valid claim succeeds; unrelated/stale content certification fails                             | `cfc-link-integrity-gate`, `cfc-write-floor`                                           |
| Nested and wildcard content assertions                      | Every applicable current target contribution checked; unsupported claim rejected                     | `cfc-write-floor`, `cfc-wildcard-link-applicability`                                   |
| Raw sigil, narrowed schema, forged carried view             | No provenance weakening or unauthorized integrity mint                                               | `cfc-link-integrity-gate`, `cfc-missing-link-source-metadata`                          |
| Target labels/schema/policy change after prepare            | Real commit rejects stale evidence despite unchanged local activity                                  | `storage-commit-preconditions`, plus new reference authorization race coverage         |
| Blind schema success/failure; missing/revoked/cyclic target | No unauthorized distinguishing outcome or permissive default                                         | New reference verification coverage; existing resolver tests                           |
| Reference copy versus content snapshot                      | Binding checks and current-content checks remain distinct                                            | `cfc-exact-copy`, `cfc-exact-copy-wildcard`                                            |
| Render, opaque output, LLM content, metadata inspection     | Labels match the actual exposed observation, including metadata presence/type                        | `cfc-observation`, `cfc-llm-observation-failclosed`, `cfc-label-introspection-channel` |
| Replace ancestor, remove reference, repeat unchanged write  | Removed carried descendants cleared; siblings and declared policy preserved; no-op remains canonical | `cfc-labelmap-components`, `cfc-array-shrink-slot-labels`                              |
| Legacy and unknown formats; off/observe/enforce             | No silent reinterpretation or false conformance claim                                                | `cfc-envelope-version-guard`, existing mode-specific suites                            |

Also measure target-label read counts and persisted metadata size for a
reference to a target with many labeled descendants. Reference-only work must
not scale with that target's label map. Preserve demonstrated pointwise
map/filter precision and memo reuse; no broad performance rewrite is required.

## Delivery and validation

- [ ] Land reader/recording support first, then dereference and commit
      dependency support, then subject-specific verification, then
      boundary/persistence activation. These are dependency-ordered review
      units, not independently deployable claims of full conformance.
- [ ] Update live CFC documents with their corresponding implementation stages:
      observation classes, write-prefix provenance, commit preparation,
      render-boundary composition, template population, metadata
      confidentiality, enforcement matrix, and affected authoring/adapter
      contracts. Reconcile the local descriptions of copied target labels with
      the merged external spec. Keep historical documents unchanged.
- [ ] Before code edits, load `writing-code` and its required
      development/comment guides. Follow the unit-test and event-driven waiting
      guidance. Use `cf-review` for each reviewable changeset and the final
      combined change.
- [ ] Run the focused semantic suites, then `deno task test` in each affected
      package. Exercise browser/worker boundaries and real storage admission
      where unit mocks cannot establish the property. Run repo-wide
      `deno fmt --check`, `deno lint`, `deno task check`, and the applicable
      docs checks before preparing commits for review. Run `deno task cfcheck`
      if pattern authoring/examples change.
- [ ] Record enabled modes and supported channels alongside results. Report
      unresolved acquisition, cross-space freshness, or compatibility limits
      explicitly; do not count the merged Lean proofs as runtime test coverage.
- [ ] Archive this plan when execution is complete, following
      [the documentation lifecycle](../../README.md).

The first implementation milestone is stages 1–3 with decisive selection and
dereference regressions. The release gate for removing copied target labels is
completion of stages 4–6 as well.
