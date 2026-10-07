# CFC conformance statement: the reactive-runtime profile

The Contextual Flow Control specification in `commonfabric/specs` under `cfc/`
says, in §18.6.4 of `18-runtime-implementation-profiles.md`, that a deployment
claiming the reactive-runtime profile MUST document eight things. This document
is this runtime's answer, one section per item. Each section names the adapter
code under `packages/runner/src/` that implements the item, by file and
symbol, and states every known non-conformance with its direction: an
_over-taint_ refuses or labels more than the specification would, which is the
fail-closed direction; an _under-taint_ admits or labels less, which is a
soundness defect. Where neither the code nor a labs document establishes an
answer, the section says "not established" and what would establish it.

The statement is written against the specification at the commit the spec
snapshot at `packages/runner/src/cfc/kernel/spec-snapshot.json` records,
`9e751d58`. It describes the runtime's shipped defaults: the dial values
`RUNTIME_CFC_DIAL_DEFAULTS` in `cfc/posture-report.ts` applies to every
`Runtime`, and `presetCfcOptions` in `runtime-presets.ts` pins for every host
preset. A host that sets a dial lower is described by
[`cfc-enforcement-matrix.md`](cfc-enforcement-matrix.md) rather than here.

The runtime holds no kernel function yet: every row of
`packages/runner/src/cfc/kernel/manifest.ts` reads `missing`, and the symbols
named below are the adapters that make each decision today. The procedure for
changing any of it is
[`../development/cfc-spec-correspondence.md`](../development/cfc-spec-correspondence.md);
this document changes in the same pull request as the behavior it describes.

## Maintaining this statement

This is a live document pinned to the specs commit
`packages/runner/src/cfc/kernel/spec-snapshot.json` records. It is re-read,
and changed in the same pull request, whenever an adapter symbol it cites is
renamed, moved or changes what it decides; whenever a dial default in
`RUNTIME_CFC_DIAL_DEFAULTS` or a preset's pin moves; whenever a §18.6.4 bullet
changes in the specification; and whenever the snapshot is regenerated, at
which point every section is checked against the specification at the new
commit and the pin above is updated. Each item marked "not established" below
is a follow-up tracked under "Conformance statement follow-ups" in
[`cfc-runner-future-work.md`](cfc-runner-future-work.md); establishing one
replaces the sentence here with what was found, in which direction.

## 1. The relevance mechanism (§18.6.1)

The specification lets a transaction skip boundary evaluation only when no
consumed read touches a labeled document, no write target carries label
entries, and no `ifc`-bearing schema governs an input or a write; relevance is
computed from the journal and the target state, callers may force it, and
nothing may suppress it.

**Where relevance is held.** `ExtendedStorageTransaction.markCfcRelevant` in
`storage/extended-storage-transaction.ts` sets the transaction's relevance
with a reason string; nothing clears it, and `getCfcState()` hands callers a
read-only view that cannot. The transaction decides whether it needs
preparation in `prepareForCommit()`, which calls `probeFlowLabelWork()`, a
memoized call of `flowLabelWorkExists` in `cfc/prepare.ts`.

**How it is computed.** There is no cached per-document flag. `flowLabelWorkExists`
reads stored label metadata through verifier-internal reads: on the read side
it counts an entry only if the read class performed consumes it
(`readConsumesEntry` in `cfc/observation-classes.ts`); on the write side it
counts any entry at a write target; it skips the transaction's own freshly
minted metadata and `cid:` documents. `storedCfcMetadataAppliesToPath` in
`cfc/metadata.ts` answers the per-path question.

**The explicit-force sites**, each marking the transaction relevant with a
reason: `schema.ts` on a read through an `ifc`-bearing schema
(`schema-ifc-read`); `cell.ts` on a write through one (`schema-ifc-write`) and
on a SQLite row label (`sqlite-row-label`); `data-updating.ts` on a link write
(`link-write`); `schema-ifc.ts` on a link crossing an `ifc`-bearing hop
(`schema-ifc-hop`); `cfc/external-ingest.ts` on external ingest; and, inside
`extended-storage-transaction.ts`, the unprivileged writes to label metadata
and its siblings, label-metadata and external-content observations, runtime
secrets, the flow-label probe, and gated sink requests.

**Non-conformances and open points.**

- The read side counts a labeled document only when the read class consumes
  one of its entries, where the specification's wording counts any read of a
  labeled document. The two agree on the join, since an entry the read does
  not consume contributes nothing to it, but no document argues that
  equivalence; its direction is not stated.
- With `cfcFlowLabels` below `persist`, the computed probe does not run and
  relevance rests on the force sites alone. Whether every write to a labeled
  document by a path other than `Cell` and `data-updating.ts` is still marked
  under flow `off` is not established; a test of a raw transaction write to a
  labeled document under `enforce-explicit` with flow labels `off`, asserting
  the refusal, would establish it. The shipped default is `persist`, where the
  probe runs.

## 2. The excluded-read mechanics (§18.6.2)

The specification excludes verifier-internal reads, label-metadata reads,
program text and schema documents unconditionally, and two classes
conditionally, wiring reads and write-destination reads, each needing a
runtime-only marker, a comment at every marking site, and, for
write-destination reads, an unobservability invariant and a recorded write-set
residual.

**The markers**, every one keyed by a module-private symbol in
`storage/reactivity-log.ts` and none exported from the package root:
`internalVerifierRead` and `stableInternalVerifierRead` (verifier-internal
reads), `schedulerDependencyRead`, `pendingWriteElisionRead`,
`linkResolutionProbe` and `dereferenceResolutionProbe`, `machineryRead` (the
wiring class), and `writeDestinationRead`, read back by
`isWriteDestinationRead`.

**Where the flow join applies them.** `forEachFlowObservation` and
`deriveFlowJoinImpl` in `cfc/prepare.ts`, exported as `deriveFlowJoin`, skip
verifier-internal and scheduler-dependency reads, reads of `cid:` documents,
reads of a document's own `cfc` and `source` members (which
`canonicalizeDocumentPath` in `cfc/canonical.ts` maps to no payload path),
link probes carrying `machineryRead`, probes a dereference trace covers other
than the probe of the followed slot, and write-destination reads.

**The write-destination marking sites:** `normalizeAndDiff` and the preserved
output attempt read in `data-updating.ts`; `CellImpl.isStream` as called from
`set()` and the append snapshot of `push` and `pushAll` in `cell.ts`;
`storedQueryState` and `storedRequestHash` in `builtins/sqlite-builtins.ts`;
`storedCellsRead` in `builtins/fetch.ts`; and the document-root read in
`storage/v2-transaction.ts`. [`cfc-write-destination-reads.md`](cfc-write-destination-reads.md)
is the design, with the unobservability argument under "Why the exclusion
carries no label out" and the residual under "What it costs".

**The wiring marking sites:** `runner.ts`, `pattern-binding.ts`, and under
`builtins/` the collection builtins `map.ts`, `filter.ts`, `flatmap.ts`,
`aggregate.ts`, `collection-index.ts`, `collection-index-membership.ts`,
`resume-republish.ts` and `scope-policy.ts`.
[`cfc-observation-classes.md`](cfc-observation-classes.md) §6 describes the
class.

**Non-conformances, with direction.**

- The conditional exclusions apply to the flow join. The egress and sink
  consumed set (`collectConsumedLabel` in `cfc/prepare.ts`) excludes only
  verifier-internal reads, so it still counts write-destination and wiring
  reads: an over-taint, stated in
  `cfc-write-destination-reads.md` under "What this does not change". The
  runtime read ceiling (`assertCfcReadCeiling` in `cfc/read-ceiling.ts`) does
  exclude write-destination reads and machinery probes; no document states
  that, and its direction follows the flow join's.
- Program and source text is not a read exclusion here: compilation-cache
  records stay stamp targets, and only the writer-fit ceiling is skipped for
  them, which `cfc-enforcement-matrix.md` §4 records as keeping a refusal
  rather than giving one up (over-taint). Whether a module load ever lands a
  source read in a handler attempt's journal is not established; a test of a
  handler transaction that loads a module, inspecting its flow join, would
  establish it.
- The write-set residual is recorded for the elision bit, the equality oracle
  on the prior value, and a parent's membership reaching a child, in
  `cfc-write-destination-reads.md` under "What it costs". It is not separated
  by observer level: what untrusted code can learn of the write set through
  versions, counts or notifications, as against what a replica or storage
  observer can, is not established.
- The runtime-private guard state for the SQLite comparison is the stored
  `requestHash` in the query's result store. The typed API omits it; whether
  pattern code can read it untyped is not established.
- The marking-site comments in `builtins/fetch.ts` and
  `storage/v2-transaction.ts` state the class and that the read joins no
  label, and do not state that no written value or address is taken from the
  result, which §18.6.2 asks every site to say. Neither site is listed in
  `cfc-write-destination-reads.md`.
- That verifier-internal reads stay freshness dependencies is a property of
  the marker (it carries no `ignoreReadForCommit`) together with the digest
  invalidation `cfc-commit-preparation.md` describes; no test naming the
  property was located.

## 3. Reference restrictions a dereference does not yet consume (§8.2.4, §18.7)

The specification requires a dereference to consume every reference
restriction along its path together with the target's labels, independent of
which probes preceded it, and lists in §18.7 the observable cases a runtime
claiming the precise reference profile must exercise at every boundary.

**What the runtime does.** In the flow join, `forEachFlowObservation` in
`cfc/prepare.ts` reads the transaction's dereference traces and treats the
probe of a followed slot as a `followRef` observation, consuming the
`followRef`-class entries at that slot, the runtime-minted wildcard membership
template among them; trace targets contribute nothing of their own, and target
content arrives through ordinary reads. For label views,
`referenceRestrictionsOf`, `cfcLabelViewForDereference` and
`cfcLabelViewForDereferenceTraces` in `cfc/label-view-state.ts` carry the
class-less confidentiality of every entry resolving at the slot, wildcard
templates included, and the render path reads them through
`cfcLabelViewForResolvedTarget` in `packages/html/src/worker/reconciler.ts`.

**This runtime does not claim the precise reference profile.** No labs
document claims it, and the following is not established:

- Whether a declared covering `ifc` entry at a reference-holding slot reaches
  the flow join of a dereferencing transaction. The flow-join probe consumes
  `followRef`-class entries (`cfc-observation-classes.md` §6.1), while §4.6.3
  counts the declared and derived-selection components at the slot as well;
  the label-view path includes them, the flow join is not shown to. If it
  does not, the omission under-taints. A test with a declared slot `ifc` over
  a link to a public target, a handler that dereferences and writes, and an
  inspection of the join would establish it.
- Whether derived-selection entries other than the runtime-minted `followRef`
  templates exist at slots, and are consumed.
- The remaining §18.7 rows at every boundary: row-set retention under
  §8.17.6, a target changing between verification and commit, deletion and
  inaccessible-target normalization, cross-space multi-hop, and rewrite or
  removal of a reference. `packages/runner/test/cfc-probe-slot-anchoring.test.ts`
  covers the "private query selects public targets" case for the flow join,
  dereferenced alone and after resolving the container.

## 4. The §8.9.3 integrity staging level

The specification stages the default transition as confidentiality join only,
then with the hereditary integrity meet, then with `TransformedBy` minting, and
requires the stage to be reported and never over-claimed.

**Stage.** The runtime is at the third stage with the deviations below:
`deriveFlowJoinImpl` in `cfc/prepare.ts` computes the confidentiality union,
the hereditary meet by propagation class (`atomPropagationClass` in
`cfc/atom-classes.ts`, under which `PolicyCertified` is hereditary), and
appends a `TransformedBy` atom from `mintTransformedBy` in
`cfc/input-witness.ts`. `followRef` observations contribute confidentiality
only. No labs document names the stage in §8.9.3's words; this section is that
statement.

**Deviations, with direction.**

- The mint is omitted when the writing identity is ambiguous or the join of
  what the transaction read is empty; a join that value-intrinsic exchange
  emptied (§5.3) is still minted, so the release is recorded. The omission is
  an under-claim of integrity, the fail-safe direction, stated in
  [`cfc-transformed-by-input-witnesses.md`](cfc-transformed-by-input-witnesses.md)
  under "What fails closed".
- The atom carries an input-witness summary in place of the pseudocode's
  `inputs` array, the conservative summary §8.9.3 permits; `SC-43` in
  [`cfc-spec-changes.md`](cfc-spec-changes.md) is the open ruling.
- The hereditary meet is empty until every input carries the certified atom,
  an under-claim stated in `cfc-observation-classes.md` §5 as the fail-safe
  direction.
- One guard matched on a consumed read releases another writer's value in
  the same document at the release gate, stated in
  `cfc-transformed-by-input-witnesses.md` under "What this does not cover" as
  a release under a witnessed guard; it is not phrased there in taint terms,
  and whether it under-taints is not established.

## 5. Position in the §18.6.3 matrix and the auxiliary dials

The specification's ladder runs `disabled`, `observe`, `enforce-explicit`,
`enforce-strict` for enforcement and `off`, `observe`, `persist` for
propagation; `enforce-strict` conforms only with `persist`; each auxiliary dial
goes through `observe` before `enforce`; and no consuming enforcement runs
ahead of its producing dial.

**Position.** Every shipped host and the bare `Runtime` sit at the end-state
cell, `enforce-strict` with `persist`, with write floor `enforce`, trigger read
gating on, policy evaluation `enforce` (with no policy records a no-op, except
under the `max-enforcement` preset, `MAX_ENFORCEMENT_CFC_OPTIONS` in
`runtime-presets.ts`, which installs the standard prompt-caveat policy and sink
ceilings), label-metadata protection `enforce`, and declared monotonicity
`observe`. `cfcPostureReport` in `cfc/posture-report.ts` reports the resolved
dials; `CFC_DIAL_LADDERS` there holds each ladder, and `resolveCfcDials`
refuses a value off its ladder. The strict rung's one additional refusal, the
writer-fit misfit, is in `prepareBoundaryCommit` in `cfc/prepare.ts`; trigger
gating is `triggerReadSources` and policy evaluation
`evaluateGatedConfidentiality` in the same file.
[`cfc-enforcement-matrix.md`](cfc-enforcement-matrix.md) §1 to §4 describe the
dials.

**Non-conformances and open points.**

- `cfc-enforcement-matrix.md` §2 states that the `observe` rung on each
  ladder is a measurement stage the order does not require, and that the
  shipped defaults sit at the strict state directly. §18.6.3 says a deployment
  MUST pass through propagation `observe`, and §18.6.3.1 requires `observe`
  before `enforce` on each auxiliary dial. This is a process deviation with
  no taint direction. Whether the write floor, policy evaluation and
  label-metadata protection each passed through `observe` in a deployed host
  is not established; the deployment history would establish it.
- Nothing refuses `enforce-strict` with `cfcFlowLabels` below `persist`, a
  cell §18.6.3 marks non-conforming; `presetCfcOptions` lowers the write floor
  to `observe` when a caller lowers flow labels, and leaves the enforcement
  mode as given. `cfc-enforcement-matrix.md` §3 asks for a deploy check; none
  exists.
- Under strict, writer-fit misfits on runtime-owned stores are admitted by a
  declared policy, an over-taint another writer can impose, stated in
  `cfc-enforcement-matrix.md` §4 under "Runtime-owned-store declaration".
  `isDeclarablePolicyStore` in `cfc/prepare.ts` exempts the raw meta seam,
  `computed:` cells, stream entry documents and compilation-cache documents
  from the writer-fit refusal at every rung; the meta seam's residual, a
  runtime write of label-derived data arriving unlabeled, is `SC-55`'s
  accepted residual, and for the others a declaration that reaches such a
  document stays a read floor and stops being a write ceiling, as the same
  section states.

## 6. Idempotent persistence (§4.6.4)

The specification requires that re-persisting unchanged label entries issue
no envelope write, version advance or replication, with equality over the
canonical form of §4.1.3.

**The equality definition.** `canonicalizeCfcMetadata` in `cfc/canonical.ts`
sorts entries by pointer path, origin and observation class, canonicalizes
each label's clauses through `canonicalizeCfcLabel`, drops `undefined`
members, fixes the envelope version and normalizes empty document entries.
The persist loop of `prepareBoundaryCommit` in `cfc/prepare.ts` skips an
envelope whose canonical form equals the stored one, before any schema
document is ensured; equality is computed after the cross-space transform of
`transformCfcLabelForCrossSpacePersist` in `cfc/label-representation.ts`.

**Deviations.**

- With `cfcContentAddressedLabels` on (off by default), a stored version-1
  envelope with unchanged labels is rewritten once in version 2;
  [`content-addressed-cfc-labels.md`](content-addressed-cfc-labels.md) under
  "Idempotence and the merge loop" and `SC-11` state this as the one
  exception. It is an extra write with no taint direction.
- The runtime drops a per-value entry whose clauses the declared component
  already carries at the path, which is broader than the parent-equality
  drop the specification names; `SC-40` is the open ruling, and records that
  label-metadata population then fails closed for the declared-only path
  (over-taint on the introspection side).
- That a skipped envelope produces no version advance and no replication is
  asserted in comments; no test naming that property was located, so it is
  not established. A test writing an unchanged label and reading the
  document's version and the replica's traffic would establish it.

## 7. Trigger reads and the PC (§8.9.2)

The specification requires that, for a dependency-scheduled rerun, the labels
of the addresses whose writes scheduled it join the conservative PC at their
current labels, or that the roughly one-bit-per-change residual be documented.

**Trigger reads are joined into the PC.** `scheduler/run.ts` hands the run's
causes to `ExtendedStorageTransaction.addCfcTriggerReads`, which drops `cid:`
and document-member paths and invalidates a prepared transaction;
`forEachFlowObservation` in `cfc/prepare.ts` consumes them as recursive value
reads, with a shape read of a `length` parent, at prepare-time metadata, which
is their current labels, whatever the gating dial says. With
`cfcTriggerReadGating` on, the shipped default, `triggerReadSources` adds them
to the egress and sink consumed set and to the `requiredIntegrity` input gate
as well. `cfc-enforcement-matrix.md` §2, item 4, records that multi-hop closure
is complete at `persist`, the shipped default.

**Residuals.**

- The SQLite and fetch destination snapshots are read under
  `ignoreReadForScheduling`, so those addresses never become trigger reads;
  `cfc-write-destination-reads.md` under "The SQLite publication comparison"
  states this as intended, so that a prior result's membership does not taint
  the pending flag. Its direction is not stated.
- Whether every non-scheduler entry point, event invocation among them,
  carries its gating reads is not established beyond the event payload being
  journaled.

## 8. Observation-class residuals (§8.12.8, §4.6.3, §4.6.4.1)

The specification asks for the existence channel where per-class entries are
not populated, the containers outside the wildcard-population scope where they
are, any deviation from re-minting on delete and re-create with its direction,
and the cross-space exposure of label metadata.

**What the runtime does.** Per-class entries are populated:
`cfc/observation-classes.ts` (`entryObservationClass`, `readConsumesEntry`)
classifies entries and reads; `cfcSchemaEntries` in `cfc/schema-label-view.ts`
is the schema walk that gives `items` and record-only `additionalProperties`
the `*` path; `deriveLabelMetadataTemplateEntries` and
`resolveLabelMetadataTemplateConfidentiality` in
`cfc/label-metadata-population.ts` mint the template entries; the persist
region of `prepareBoundaryCommit` in `cfc/prepare.ts` re-mints an existence
entry when a deleted path is re-created. Cross-space persistence commits the
source-bearing fields of atoms through `transformCfcLabelForCrossSpacePersist`
in `cfc/label-representation.ts`, classified by
`cfc/label-field-classification.ts`, under `cfcLabelMetadataProtection:
enforce`. [`cfc-template-population.md`](cfc-template-population.md),
[`cfc-observation-classes.md`](cfc-observation-classes.md) and
[`cfc-label-metadata-confidentiality.md`](cfc-label-metadata-confidentiality.md)
are the designs.

**Residuals, with direction.**

- Containers outside the wildcard scope: schemas mixing named `properties`
  with `additionalProperties` are template-inexpressible
  (`cfc-template-population.md` §4), so their record tail carries no
  existence entry. The document states that an unrestricted `*` would
  over-taint the named fields; the direction of leaving the tail unlabeled is
  not stated there, and by §18.6.4's own classification an existence channel
  left open under-taints.
- Deletion without re-creation leaves the frozen existence entry in place, an
  over-taint `cfc-observation-classes.md` §5 records as the fail-safe
  direction.
- An explicit `undefined` write at an exactly recorded deleted path reads as
  absent after the write, so the stale entry carries and the re-creating
  attempt's join is not minted into it (the comment above the presence test in
  the persist region of `prepareBoundaryCommit`). If that write counts as a
  re-creation, §18.6.4 classifies the omission as an under-taint; whether it
  counts as one under this runtime's presence semantics is not established.
- Entries written before classification existed are folded into existence
  conservatively, an over-taint the same section states.
- Cross-space label metadata: commitments are probe-able; `Space` ids,
  `Policy` and `Context` names and hashes, and authorship subjects stay
  public; declared entries and carried-forward entries persist verbatim;
  schema documents replicate; and that a path carries some entry stays
  observable (`cfc-label-metadata-confidentiality.md` §2, §4 and §5). The
  `reference` representation its design calls Stage 3 is not built. These are
  disclosure residuals of the metadata channel; the specification's own
  alternative, treating the metadata as visible to the destination's readers,
  is what the runtime does for the fields it leaves public.
