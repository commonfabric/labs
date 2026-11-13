# CFC conformance statement: the reactive-runtime profile

The Contextual Flow Control specification in `commonfabric/specs` under `cfc/`
says, in §18.6.4 of `18-runtime-implementation-profiles.md`, that a deployment
claiming the reactive-runtime profile MUST document nine things. This document
is this runtime's answer, one section per item. Each section names the adapter
code under `runtime/runner/src/` that implements the item, by file and
symbol, and states every known non-conformance with its direction: an
_over-taint_ refuses or labels more than the specification would, which is the
fail-closed direction; an _under-taint_ admits or labels less, which is a
soundness defect. Where neither the code nor a labs document establishes an
answer, the section says "not established" and what would establish it.

The statement is written against the specification at the commit the spec
snapshot at `runtime/runner/src/cfc/kernel/spec-snapshot.json` records,
`239fc839`. That commit is the head of
[specs#88](https://github.com/commonfabric/specs/pull/88), which adds §8.9.1.3
and has not merged; the rest of the specification there is `9c9e96d0` on specs
`main`. It describes the runtime's shipped defaults: the dial values
`RUNTIME_CFC_DIAL_DEFAULTS` in `cfc/posture-report.ts` applies to every
`Runtime`, and `presetCfcOptions` in `runtime-presets.ts` pins for every host
preset. A host that sets a dial lower is described by
[`cfc-enforcement-matrix.md`](cfc-enforcement-matrix.md) rather than here.

The runtime holds no kernel function yet: every row of
`runtime/runner/src/cfc/kernel/manifest.ts` reads `missing`, and the symbols
named below are the adapters that make each decision today. The procedure for
changing any of it is
[`../development/cfc-spec-correspondence.md`](../development/cfc-spec-correspondence.md);
this document changes in the same pull request as the behavior it describes.

## Maintaining this statement

This is a live document pinned to the specs commit
`runtime/runner/src/cfc/kernel/spec-snapshot.json` records. It is re-read,
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
whose link schema declares policy, whose handle carries a restriction, or
whose slot carries stored or arriving policy (`link-write`; a bare pointer is
recorded as a policy input without forcing relevance, and the flow-label probe
marks the transaction when the attempt read labeled data); `schema-ifc.ts` on
a link crossing an `ifc`-bearing hop
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
than the probe of the followed slot, and write-destination reads. The
per-write input gate in `verifyInputRequirements` in `cfc/prepare.ts`
(through `buildGatedInputReads`),
which checks a protected entry's `requiredIntegrity` and `maxConfidentiality`
over its read prefix, skips write-destination reads too.

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

- The conditional exclusions apply to the flow join, and write-destination
  reads are excluded from the per-write input gate as well; that gate still
  counts wiring reads, which over-gates. The egress and sink
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
`cfcLabelViewForResolvedTarget` in `runtime/html/src/worker/reconciler.ts`.

**What a link write persists.** `linkSlotLabel` in `cfc/prepare.ts` persists
at the receiving slot the reference's own label as §8.2.3 and §8.12.8 state
it: the link schema's declarations, the restriction the written handle
carries at its root, and, where flow labels persist, the creating attempt's
flow join, stamped at the slot as a pointer-class `structure` entry beside
the link entry, or carried to the slot by the `*` template of a container the
transaction stamps as a whole. No evidence atom is minted for the reference:
§15.4 retires `LinkReference`. The atom stays non-authorable, and one in a
label stored before the retirement stays what it was, provenance that
endorses nothing. A writer's stamp at a slot describes the reference the
committed document holds there in an envelope that says so, with
`stampPlacement: "committed"`: the runtime re-derives an attempt's labels
against the committed placement (§8.10.2.2,
`SpaceReplica.#commitReadActivities`), and writes the member when the
envelope's stamps at reference slots were all placed that way. A stamp at a
reference slot of an envelope that does not say it is not an input witness
(§18.7, `slotStampPlacementUnknown`). The member is beside the ones the
envelope's version defines, so a reader that predates it reads the envelope
all the same. Nothing of the source's labels is copied to the slot,
and the write takes no dependency on the source's envelope. A write floor on
the slot, including a floor declared under a wildcard on every element of a
list, resolves the source's current evidence through `linkedSourceEvidence`,
as §8.2.6 requires, and persists none of it. A stamp the writer's schema mints
at the slot's path credits no reference written there, since the store keeps
no stamp at a position holding a reference; a stamp at a container the write
persists covers the references beneath it. In that evidence the source's
stored integrity stands as stored, and only the link schema's integrity and
a schema the transaction writes the source under are gated against
runtime-minted atoms. A refusal the floor reaches from documents the
transaction holds is terminal, and the refused run then depends on what the
floor read there, the source's envelope among it, so a writer runs again when
that evidence changes. A handle's carried view is the reference restrictions
of the slots its resolution left (`cfcAcquisitionViewForDereferenceTraces`
in `cfc/label-view-state.ts`, `referenceRestrictionsOf` for the schema
traversal's crossings), confidentiality alone, and nothing of the document
it names, whose labels are read from that document when the handle is
followed; the resolution reads those labels all the same, so that a
subscription depends on them. The reading attempt's own join reaches a
written reference through the slot stamp of the writing transaction rather
than through the handle.

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
  removal of a reference. `runtime/runner/test/cfc-probe-slot-anchoring.test.ts`
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

- The mint is omitted when the writing identity is ambiguous or the join is
  empty: an under-claim of integrity, the fail-safe direction, stated in
  [`cfc-transformed-by-input-witnesses.md`](cfc-transformed-by-input-witnesses.md)
  under "What fails closed".
- A schema declaration carrying `TransformedBy` is admitted as declared,
  where §15.4 requires the runtime to refuse or strip the atom at admission.
  The input-witness reader takes no witness from it (§8.10.2.2); whether any
  other integrity consumer reads it as a claim is not established, and if
  one does, the declaration over-claims integrity, an under-taint.
- The atom carries an input-witness summary in place of the pseudocode's
  `inputs` array, the conservative summary §8.9.3 permits; `SC-43` in
  [`cfc-spec-changes.md`](cfc-spec-changes.md) is the open ruling.
- The hereditary meet is empty until every input carries the certified atom,
  an under-claim stated in `cfc-observation-classes.md` §5 as the fail-safe
  direction.
- `atomPropagationClass` classes `ExternalIngest` as provenance where §15.4
  registers it value-bound, so a verified projection does not carry a scoped
  form of it: an under-claim of integrity, which §15.1.1 holds sound.
- The release gates (`verifyInputRequirements` and
  `verifySinkRequestCeilings` in `cfc/prepare.ts`, `readRefusal` in
  `runtime/html/src/worker/display-fit.ts`) evaluate the value-intrinsic
  rules at each location an access consumed and the other rules over the
  join (`evaluateAccessExchange`, and `exchangeEachObservation` in
  `cfc/access-integrity.ts`), per §5.3, §4.6.3 and §8.10.1.1. An observation
  that consumed no label, a document with no CFC metadata or a location no
  entry labels, never enters the join, so a hereditary atom every labeled
  location carries survives where §3.1.6.2 would empty the join: an
  over-claim of integrity, an under-taint. A cell's stored label at the
  display, which `cellLabelRefusal` fits on its root's integrity, is not
  resolved location by location: a root stamp's evidence can release a clause
  a child entry carries, an under-taint.
- Within one location, `labelForEntriesAtPath` in `cfc/consumed-label.ts` unions
  integrity across the label components resolving there, where §8.12.8 asks
  for the class-aware join of §3.1.6.2. Where two components carry integrity
  that over-claims, an under-taint. Read with every applicable component an
  input of the join, §8.12.8 drops each per-value claim wherever a component
  carries none, and against that reading the runtime over-claims wherever any
  does. Which reading holds is open in
  [commonfabric/specs#60](https://github.com/commonfabric/specs/pull/60).

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
- A space-scoped store's residency ceiling includes its own space as both
  `Space(S)` and `PersonalSpace(S)`, alongside the declared policy. This
  implements the own-space proposal in
  [specs#71](https://github.com/commonfabric/specs/pull/71), which is open and
  unruled; no ruling on it is incorporated in the pin. The
  pinned §8.12.4 has no residency term, and the proposed base rule in
  [specs#68](https://github.com/commonfabric/specs/pull/68) admits only the
  `Space(S)` form on an unbound store. The own-space addition admits writes
  those texts refuse and runs at strict without a default-off dial or a
  separate `SPEC-PENDING` marker; the three slots are occupied and the
  residency marker names #68. This is a nonconforming semantic gap and does
  not satisfy the correspondence procedure's step 4. @danfuzz's authorization
  to proceed ahead of unresolved specs dependencies does not supply a ruling;
  the gap still needs one and a reconciled pin. This entry and
  `cfc-enforcement-matrix.md` §4 record the additional gap.
  The new clause is absent on `user` and `session` stores, even when their
  scoped principal is unavailable. No foreign-space clause or unbound
  `User` clause is added. Full derived labels still persist and taint readers;
  no declaration or frozen existence label is released.
- Under strict, an authorized runtime-owned store with a live enrollment or
  an authenticated piece-setup claim admits eligible writer-fit misfits and
  records them only in the derived component.
  This is a slice of the proposed §8.12.5 change in
  [specs#78](https://github.com/commonfabric/specs/pull/78), not the pinned
  rule: the pin requires declaring those misfits, so a later clean overwrite can
  carry less taint here than under the pin. The strict default implements the
  proposal ahead of its ruling; the specification dependency remains open until
  the ruling and pin are reconciled. Against the proposal, the
  authored-declaration, read-failed and foreign-container refusals remain
  fail-closed residuals. Piece setup supplies a separate transaction-local
  claim for its argument, result and internal stores, so
  `PiecesController.setupPersistent()` can commit their setup with derived-only
  persistence before starting the piece. This claim establishes no lifetime
  enrollment and grants no authority to a later transaction. A generic
  transaction-local ownership marker alone still takes the pinned declaration
  route: one-shot handoffs and marker-only anchored children retain that
  ratchet. Lazy scoped-default seeding on a later transaction before enrollment
  also retains the generic marker and declaration route. Existing declarations
  and frozen existence stamps remain. Clean
  creation records no empty existence entry, so even a path created clean keeps
  the first labeled write's existence label after a clean overwrite. No
  automatic data repair is performed. See
  `cfc-enforcement-matrix.md` §4, "Runtime-owned-store derived admission".
  `isDeclarablePolicyStore` in `cfc/prepare.ts` exempts the raw meta seam,
  `computed:` cells, stream entry documents and compilation-cache documents
  from the writer-fit refusal at every rung; the meta seam's residual, a
  runtime write of label-derived data arriving unlabeled, is `SC-55`'s
  accepted residual, and for the others a declaration that reaches such a
  document stays a read floor and stops being a write ceiling, as the same
  section states. A served run's cross-holder misfit, below, is measured on
  those documents all the same.
- Under strict, a served run, any wave run context
  (`isServedRunUnderHolderRule` in `cfc/prepare.ts`), admits a
  clause it read from a store whose holders don't include every holder of the
  target only by the target's residency. This implements §8.12.5.1 as proposed
  in [specs#95](https://github.com/commonfabric/specs/pull/95), which the pin
  does not hold, ahead of its ruling and under a `SPEC-PENDING` marker naming
  it; `check-cfc-correspondence` exempts the citation. It refuses writes the
  pinned §8.12.5 admits, by an authored, upgraded or minted declaration or by
  the runtime-owned routes above, and persists nothing new: an over-taint
  against the pin. Against the proposal it differs three ways. It holds every
  served run to the rule, a derivation and bookkeeping as well as an event
  handling, since a derivation the serving posture runs copies another
  space's private data into a runtime-owned store otherwise: an over-taint
  the ruling would need to adopt. Residency's owner case admits a cross-holder `PersonalSpace(P)` clause
  into a store bound to `P`, which the proposal leaves out pending specs#68
  and specs#71: an under-taint against the proposal's text, whose holders,
  `P` alone, are inside that clause's audience. And it inherits the
  reference-write gap below: a served run that carries a cross-holder clause
  into a store by reference, rather than by value, is not refused, although
  the clause is in the slot stamp it persists. A read declared onward, whose
  membership lands as a stamp the measurement does not reach, is the same.
- Writer-fit does not measure a reference or structure write. §8.2.6
  requires "writer-fit for the reference and structure actually persisted,
  including replica audiences", and §8.12.8 that writer-fit and upgrade
  rules "govern the declared component, including reference
  identity/structure writes". The measurement in `prepareBoundaryCommit`
  takes only a target's value-write paths: a recorded link write, and a
  value made entirely of references, are skipped
  (`cfc-enforcement-matrix.md` §4, the writer-fit entry's scope note). What
  such a write persists is the reference's own label, §3 above: the link
  schema's declarations, the handle's carried restriction, and the creating
  attempt's flow join as a pointer-class stamp at the slot. None of it is
  measured against the target's ceiling: an under-taint. A served run's
  cross-holder clause (§8.12.5.1, above) is in that stamp, so a measurement
  of reference writes would bring those writes under the holder rule.

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
is their current labels, whatever the gating dial says. A trigger at the
sub-path where a link exposes its recognizable form is the invalidation of a
link probe, and is read as a shallow read of the slot the probe asked about,
since that sub-path's segments are not child segments (§4.6.3)
(`triggerReadAt`). With
`cfcTriggerReadGating` on, the shipped default, `triggerReadSources` adds them
to the egress and sink consumed set and to the `requiredIntegrity` input gate
as well. `cfc-enforcement-matrix.md` §2, item 4, records that multi-hop closure
is complete at `persist`, the shipped default.

**A run deferred into a transaction of its own carries what decided it.** The
runner sets up or starts some runs in a fresh transaction rather than the one
that asked for them: a piece whose execution family has to be named first
(`#runAfterNamedFamilyLands` in `runner.ts`), a start held until the asking
transaction commits (`#startAfterSuccessfulCommit`), and a handler's
navigate-bearing result pattern (`#runPatternAfterSuccessfulCommit`). When the
run is deferred, `flowJoinObservationsOf` in `cfc/prepare.ts` takes the
addresses of what the asking transaction has observed so far that its flow
join weighs, its own trigger reads among them, and the fresh transaction
receives them as trigger reads, with the asking transaction's label-metadata
observations. So what decided that the run happens joins the PC of everything
the run writes, at its labels when the run commits, and under
`cfcTriggerReadGating` it enters the run's consumed sets and input gate too.
A piece already running here takes the pattern a setup staged by swapping to
it, in transactions of the pattern watcher's own (`swapToPattern`): a setup
transaction, unless the setup that moved the pointer staged the pattern
already, and an instantiation transaction. Those carry the same observations
of the transaction that ran the setup, a source update's setup for resume
included (`#runDecisions`, recorded when the setup stages), and the
instantiation carries the swap setup's own along with them. This is how the
pattern a lift returns reaches a result that is running already, and how a
source update reaches the patterns the updated piece nests.
`runInTransaction` defers by throwing `RetryImmediately`, and the scheduler
then reruns the asking action, which reads again.

**Residuals.**

- A read the asking transaction took shallowly is carried as a recursive
  trigger read of its address: an over-taint. So is a read it declared
  onward, whose membership the asking transaction's own join leaves to the
  declared target.
- External content the asking transaction observed is not carried, since its
  receipt binds it to that transaction. An action that both records external
  content and defers a run leaves that content off the run, an under-taint;
  whether any action does both is not established.
- A swap to a pattern that no setup in this runtime staged, such as one whose
  pointer another runtime moved, receives no carried observations: its
  transactions weigh only what they read themselves. The pointer is one of
  the document's own members, which carries no payload label (§4.6.5), so a
  trigger read of it would join nothing either.
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
`runtime/memory/v2/cfc-label-fields.ts`, under `cfcLabelMetadataProtection:
enforce`. [`cfc-template-population.md`](cfc-template-population.md),
[`cfc-observation-classes.md`](cfc-observation-classes.md) and
[`cfc-label-metadata-confidentiality.md`](cfc-label-metadata-confidentiality.md)
are the designs.

The two owner releases of §8.12.7, routes 2c and 2d, are the operations that
lower a still-existing path's existence entry. For route 2c,
`releaseCellConfidentiality` in
`cfc/confidentiality-release.ts` is the host operation, the transaction's
`releaseCfcConfidentiality` in `storage/extended-storage-transaction.ts` the
privileged write, and `planConfidentialityRelease` in
`cfc/confidentiality-release-plan.ts` the decision. It implements the route as
stated, its recommended refusal of a request the path would still show an
unkept clause after included; the request is an authenticated host command
and the record a create-only receipt
([`cfc-persisted-declassification.md`](cfc-persisted-declassification.md)
§3.3). A release at a link slot lowers the link-carried component stored
there, and its refusal reads the path without the link's target, whose content
labels §8.12.8 excludes from that component.

Whether a release at a path holding a write redirect conforms is an open
question pending a ruling. By default the release follows the redirect, as a
write follows it, and lowers the document it leads to; it addresses the link
slot itself only when the request asks for that. Route 2c requires the
document and path to come from the request "and from nothing a computation
derived", and a write redirect stored at the path is data a computation wrote,
so the default lets that data choose the document a release lowers. This
statement does not claim the default conforms.

A release path holding a `*` segment reaches every stored position the segment
matches at its depth, the wildcard entry there and each concrete position's
entries, in one release whose receipt names each position. The pinned route
removes clauses "from exactly the one path", and does not say whether a
wildcard entry's path is one a request may name. This implements the proposal
in [specs#86](https://github.com/commonfabric/specs/pull/86), which the pin
does not incorporate.
Against the pin it errs toward under-taint: it lowers clauses at positions no
release under the pin reaches, since the route's recommended refusal reads a
wildcard entry and the concrete positions it matches as labeling each other,
so a release of either alone refuses while the other holds the clause. Every
clause removed still passes the route's home-space and
`canReleaseStoredClause` gates. It runs at strict without a default-off dial
or a separate `SPEC-PENDING` marker; the three slots are occupied. This is a
nonconforming semantic gap and does not satisfy the correspondence procedure's
step 4. @danfuzz's authorization to proceed ahead of unresolved specs
dependencies does not supply a ruling; the gap still needs one and a
reconciled pin.

An owner release by intent (§8.12.7 route 2d) removes the clauses a request
the space's owner signed names, whoever they stand for, from every component
and observation class at one stored path of one document, the existence and
membership entries included. `releaseConfidentialityByIntent` in
`cfc/confidentiality-release.ts` is the host operation, the transaction's
`releaseCfcConfidentialityByIntent` in
`storage/extended-storage-transaction.ts` the privileged write, under its own
builtin identity, and `planConfidentialityReleaseByIntent` in
`cfc/confidentiality-release-plan.ts` the removal, which shares route 2c's
core. What the store and the runtime share is
`runtime/memory/v2/cfc-owner-release-by-intent.ts`: the purpose
`cfc.owner-release-by-intent/1`, the request, the DAG-CBOR bytes signed, the
record and its identity, derived from the document's id and the request's
digest, and the digest of the envelope, taken over the `cfc` member as the
store holds it. The canonical clause digest both sides name a clause by is
`cfcCanonicalClauseDigest` in `runtime/memory/v2/cfc-clause-identity.ts`. The
specification's `ownerReleaseByIntentAt` is decided twice: by the transaction
operation before it writes, and by `judgeOwnerReleaseByIntent` in that memory
module, which `applyCommitTransaction` in `runtime/memory/v2/engine.ts` calls
for every record a commit creates, against the space's access list at the
commit (`ownerReleaseByIntentSpaceOwner`, the list's `aclOwner`, or the
space's own DID where it stores none). The store refuses the commit whole on
any of the refusals the route lists, on a record whose content does not match
its request, on any other write under the record id scheme, and on two
releases of one document in one commit; and the interim admission rule of
[specs#89](https://github.com/commonfabric/specs/pull/89) admits a dropped
declared path that a verified release names (`admitsDroppedDeclaredPaths` in
`runtime/memory/v2/envelope-admission.ts`). At the request's path the store
compares the confidentiality clauses of every entry, component and class by
component and class, so the commit removes exactly the clauses named there.
What the commit does to the rest of the envelope, at other paths, to
integrity, and in the components the store does not judge elsewhere, is the
runtime's to get right, as it is for every write. An identity commit, a stale
retry whose every operation leaves the store as it is, records nothing and
releases nothing, so its record is not judged again. The intent is
obtained by `cf cell release-by-intent` in `runtime/cli`, which signs only
after the owner, at a terminal, is shown the request's target and its clauses
and types a confirmation; nothing else in this repository signs under the
purpose, and that obligation rests on the host holding the owner's key, as the
route says. The request names its document directly, so no link is followed
to choose it, and one stored path, matched literally against the stored
entries' paths: a `*` segment names the wildcard position itself, such as a
container's class templates, and none of the concrete positions it covers, so
one request reaches one stored position. A membership stamp sits at the
container's path and at its `*` position, so its full removal is a request for
each, and the CLI names the other positions holding a clause it releases.
Whether a request may name a wildcard position is not stated by the pending
route, which says "exactly the one path"; this runtime reads a wildcard
position as a path of its own.
A clause is identified by its canonical clause digest throughout, in the
runtime's plan and listing as in the request and the store, so two spellings
of one clause, a field in plaintext and committed, are named and released
apart. What may be named is what the label map holds at the path, which is
what the store reads: a clause only the stored schema declares there, with no
label-map entry, is not stored and is refused on both sides. The store also
refuses a record whose stored label holds no declared `User(owner)` clause at
its root. The runtime reads the space's access list only once it has loaded
the list document from the store, so an owner other than the space's own DID
is read as the list names it. Both owner releases re-derive the envelope's
label-metadata templates from the payload entries they leave, as every
persist does.

Route 2d is pending ruling in
[specs#90](https://github.com/commonfabric/specs/pull/90), which the pin does
not incorporate, and the snapshot defines no `ownerReleaseByIntentAt` for the
kernel manifest to carry a row for; the next regeneration after the ruling adds
one. It lowers clauses at strict, with no default-off dial, which @danfuzz
directed, so it does not satisfy the correspondence procedure's step 4; the
deciding sites, in the store and in the runtime, carry its `SPEC-PENDING`
marker. Against the pin it errs toward under-taint, in the way the route itself
describes: a release removes a clause that stands for someone other than the
owner, which no route under the pin removes, and every such removal is signed
by the owner and recorded.

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

## 9. Result-wiring membership (§8.9.1.3)

The specification asks whether the runtime mints a pattern setup's
result-wiring membership from the wiring's own stamp, and if so where it marks
the wiring scope and how each marking site establishes that the wiring is
build-decided; and that a restated wiring re-mints its membership when its
value write is elided.

**What the runtime does.** It mints from the wiring's own stamp. Setup's
`#updateResultProjection` in `runner.ts` is the one marking site: it records a
`result-wiring` write-policy input, under the runtime's authorization, for
every setup, naming the result document, whether the wiring is
build-decided, and the journal position the setup began at. It is
build-decided unless the setup carries the stored result's name over, since
that name is a reference the stored document chose. The
wiring's references come from `unwrapOneLevelAndBindToDoc` over the pattern's
result and the piece's identity, which reads no application content.
`resultWiringsByTarget` in `cfc/prepare.ts` reads the records, and the persist
region of `prepareBoundaryCommit` stamps a build-decided document's membership
(its `enumerate` entries and `*`-child templates) from `deriveFlowJoin` with
`journalBefore` at that position: what the transaction read before the setup
began, the trigger reads among it. Those reads decided which pattern, and so
which build, the setup sets up, which is what the specification's triggers
stand for; a caller that reads data and sets up a pattern chosen by it, in
the same transaction, carries that data onto the membership. A run the runtime
defers is the exception, below. The specification's wiring scope adds nothing
to it, since wiring, write-destination and runtime-internal reads contribute
nothing to a join. The stamp carries no
`TransformedBy`. Every other entry of the document, its frozen existence entry
among them, keeps the attempt's join.

`withRestatedResultWirings` takes every recorded wiring whose document holds
nothing but references as written at the root of that document, whatever the
setup wrote, so the root's membership is re-minted at each setup: when setup
finds the wiring unchanged and writes nothing, and when it writes only the
slots that changed.
`ownRestampContainerPaths` includes the build-decided ones, so a setup's
reads of its own stored membership do not feed the join it re-mints from. A
wiring that carries the stored name over is left out of it: the name is a
reference the stored document's membership guards, so the setup's read of it
joins the stamp it re-mints. A container reached only through the restatement
mints no existence entry.

This implements [specs#88](https://github.com/commonfabric/specs/pull/88)
ahead of its ruling, at strict and with no dial, at @danfuzz's direction. It
narrows what is stored and so does not satisfy the correspondence procedure's
step 4, which asks for a default-off dial; the two deciding sites carry its
`SPEC-PENDING` marker.

**Residuals.**

- A wiring whose stored name is carried over is stamped from the attempt's
  join, an over-taint where the name was itself build-decided.
- Only a setup in the transaction it was asked in restates an unchanged
  wiring (`#askingSetupTransactions` in `runner.ts`: the transaction a caller
  hands `run`, `setup`, `runSynced` or `runInTransaction`, or the one `setup`
  or `runSynced` makes for that call; a setup nested in another, such as a
  pattern node its parent instantiates, takes that transaction's standing).
  A `run` given no transaction is not one. A transaction the runner makes
  later for a deferred start or a swap takes the standing of the transaction
  whose reads it carries (§7) while that transaction is committing or has
  committed, and not while it is open or once it is aborted or refused, so a
  source update that leaves a result's wiring unchanged restates it in the
  start that follows the update. The standing is read when the deferred
  setup runs, so a refusal that arrives after that does not take it back.
  Every setup in such a transaction begins at the transaction's start: what
  decided it is the reads the transaction carries, and the transaction's own
  earlier reads, such as an instantiation reading the result of a piece it
  set up beside the nested one, chose nothing, so they join none of its
  stamps. In a transaction a setup was asked in, a setup nested in it begins
  where it does, so what the instantiation read before it, of the pieces set
  up beside it, joins its stamp: an over-taint. Where the nested piece
  carries its stored name over, that restatement keeps the
  stored membership, as the carried-name rule above has any setup do, so
  such an update leaves an earlier attempt's stamp in place. A setup repair,
  and a swap to a pattern no setup in this runtime staged, carry no such
  reads, and leave an unchanged wiring's stored membership as a setup that
  wrote nothing would. One of them that changes the wiring writes it, and is
  stamped from its own transaction.
- A `run` given no transaction carries no earlier transaction's reads.
  `wish.ts`'s suggestion fetch sets up the pattern an earlier transaction
  chose this way, once the suggestion surface opens, so what that setup
  writes, a changed wiring's membership stamp included, carries none of the
  reads that chose the pattern: an under-taint.
- The pre-setup bound applies to journaled reads with a position. A read
  without one, and every label-metadata or external-content observation,
  which carry none, joins the narrowed stamp whenever it happened: an
  over-taint, which on a transaction with no activity clock leaves the stamp
  the attempt's whole join.
- A result wiring at a path below its document's root is restated and
  narrowed only at the root.
- A result document holding data beside its references is not restated, so
  a setup that leaves it unchanged re-mints none of its membership: an
  over-taint where an earlier attempt's stamp is wider than the setup's own.
  Restating it would take a value stamp from what the setup read onto data no
  write of the setup made.
