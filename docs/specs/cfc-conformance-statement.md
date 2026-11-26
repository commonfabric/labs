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
`set()`, the append snapshot of `push` and `pushAll`, and the add-unique
snapshot of `addUnique` in `cell.ts`;
`storedQueryState` and `storedRequestHash` in `builtins/sqlite-builtins.ts`;
`storedCellsRead` in `builtins/fetch.ts`; the setup's comparison of the
projection it builds with the stored result (`#nextResultProjection` in
`runner.ts`); and the document-root read in `storage/v2-transaction.ts`. [`cfc-write-destination-reads.md`](cfc-write-destination-reads.md)
is the design, with the unobservability argument under "Why the exclusion
carries no label out" and the residual under "What it costs".

**The scheduler-dependency marking sites:** dependency seeding
(`#populateDeclaredSchedulerReads` in `runner.ts`), and the resolution of a
new JavaScript action node's declared inputs that certifies its static read
set for the scheduler (`#collectStaticReadTargetsWithCompleteness` in
`runner.ts`, under `STATIC_READ_TARGET_READ` in
`cfc/static-read-target-read.ts`, which carries `machineryRead` as well; the
scheduler marker decides what both consume). Both read an action's
declared inputs through their links for the scheduler, the first so the
reactivity log covers them, the second to name the cells they reach in the
certificate of the action's reads. Either record decides only whether and
when the action runs, and nothing the transaction resolving it writes is
taken from it. The action's own run reads the same links as ordinary reads,
where their labels and the runtime read ceiling are weighed. §8.10.1 excludes
dependency discovery only in a transaction used for nothing else, and §18.6.2
names no class for these reads inside a transaction that also commits, so the
second site is a nonconforming semantic gap, as the first is wherever it runs
in a transaction that commits; `cfc-spec-correspondence.md` records it. The
class [specs#100](https://github.com/commonfabric/specs/pull/100) proposes is
narrower than §8.10.1's exclusion: these reads leave the flow join and read
ceilings only, and stay in the consumed set the input gate, egress and sinks
check, and in conflict detection.

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
- The flow join (`deriveFlowJoin` in `cfc/prepare.ts`) evaluates the
  value-intrinsic rules where a value is observed into a computation, at each
  location the observation consumed and on the evidence there about the value
  currently at it, and joins what they leave, so that what the computation
  writes carries the exchanged confidentiality (§5.3). The other rules are
  not evaluated there, since their result is never carried. Where an
  evaluation runs out of fuel, each clause that location consumed is held
  split into its alternatives, never looser than as read and stricter than
  any outcome that keeps an original alternative (§5.3.2; the flow join has
  callers outside prepare, so it refuses through the label rather than by
  failing the transaction). It is not a bound on an outcome where an added
  alternative enables a rule that drops an original one. A policy that cannot be resolved
  fires none of its rules at that location, so its clause stays as read for
  the next gate to decide, which is looser than intended where the policy
  holds a rule that would tighten it. A read's container length is one of
  its locations: a shallow read's, and the node a recursive read declares
  onward. It departs from §5.3 in the over-taint direction in four
  places. It evaluates only while `cfcPolicyEvaluation` is `enforce`. A
  label-metadata
  observation and the flow of external content join as read. The integrity
  that satisfied a rule is recorded on the derived value's `TransformedBy`
  only where the input-witness summary retains it
  ([`cfc-transformed-by-input-witnesses.md`](cfc-transformed-by-input-witnesses.md)),
  an under-claim of integrity. And a refusal names no read for a clause a
  rule rewrote, since the sources are matched on the clause as stored.
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
  section states.
- A served run is measured as any run is: its whole join fits a target by
  §8.12.4 and the options of §8.12.5, whichever store a clause was read from.
  A serving host reads what its acting principal's own runtime could not
  (`docs/specs/server-side-execution/protocol.md` §2b, "read a foreign doc"),
  so a served run can carry a clause its acting principal does not satisfy
  into a store that principal reads, where it lands labeled. Two boundaries
  then let it out, and both are open: an under-taint each. The memory server
  delivers a document to every reader of its space whatever its label admits
  (Topics top/3173), and a served effect's request is checked against its
  sink only where the host declares a sink ceiling (Topics top/3174;
  `served-effect-cross-holder.test.ts` pins a served fetch over another
  space's private URL going out). An event's payload is delivered unlabeled,
  so a send drops its sender's clauses (Topics top/3175). The holder rule of
  [specs#95](https://github.com/commonfabric/specs/pull/95)'s first proposal,
  which refused such writes by where a clause was read, ran here ahead of its
  ruling and was removed when the proposal was withdrawn.
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
  measured against the target's ceiling: an under-taint.

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

- With `cfcContentAddressedLabels` on, its default, a stored version-1
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
(`triggerReadAt`). A node the serving loop runs once for each viewer is one
node with one subscription, the union of its instances' reads, so the
addresses whose writes scheduled a run are decided for each instance:
`causesForInstance` in `scheduler/run.ts` hands a run the changes that name an
instance on its own chain, and of the changes that name no instance those
that arrived for a document a run of the instance is recorded to have read
(`dirtyFanOutForCause` in `scheduler/fan-out.ts`), whether they arrived before
the pass the run is in began or during it. A pass starts a run of an instance
only where the instance never ran, one of those changes or an invalidation
that names no cause reached it, a retry of its own run is due, or demand for
it arrived (`fanOutInstancesToRun`), so a change to a document only another
viewer's run read starts no run of this instance, and is not joined. Two
things such a change can still do to this instance are not trigger reads
under this reading. Where it also reaches an instance that read the
document, it re-arms the node's debounce, which is the node's and not an
instance's, and a run this instance was already owed starts later. And the
match is by document, not by path: an instance that read one path of a
document takes a change at another path of it, at the read path the cause
names. With
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

An array the value diff rewrites is persisted index by index:
`normalizeAndDiff` in `data-updating.ts` writes each index whose value changed,
and the persist region clears the `derived` and `structure` entries beneath
those paths and stamps them with the attempt's join. An element whose value at
its index did not change is not written, and keeps the entries stored beneath
it. An element the write moves to another index keeps them too:
`elementEntryPlacements` in `cfc/prepare.ts` aligns the old and new arrays by
a shortest edit script and moves each such entry, existence entries excepted,
to the element's new index. An element the script removes is paired, in
order, with an equal element it adds, which is how an element that changes
places with others is carried, and the entries beneath an element left
unpaired are dropped, except where the new element at its index is unpaired
too: that element is the old one edited in place, and keeps its entries
beneath the paths the diff did not write. Where no script within 64 edits
aligns the arrays between their common prefix and suffix, the elements between
are paired by value, in order, and the same exception covers the rest. Without
the move, an element moved onto an index holding an equal value would take the
entries of the element that stood there, and its own would be lost. Declared
entries stay with their position, and link entries follow the reference their
slot holds. This is §8.10.2.3, which specs `main` adopted at `f549c796`
([specs#106](https://github.com/commonfabric/specs/pull/106)), later than the
pin. The runtime conforms to it: the pairing joins equal values only, the
attempt's join is stamped at the length and the indices the diff writes and
nowhere else, and existence entries stay at their paths.

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
- The alignment matches elements by value, so a write that sets an element
  equal to one stored elsewhere in the array, without reading it, carries that
  element's entries to it, an over-taint §8.10.2.3 accepts.
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

A recorded wiring whose document holds data beside its references is taken
too, at its root, from a setup the runtime did not start on its own,
but its root is not treated as written: only an asking setup restates a wiring
it finds unchanged, and the persist region's `restatedDataRoot` replaces the
derived value entries at and below the root with one at the root re-derived
from the transaction's whole flow join, the entry a write of the root would
leave, or with none where the join is empty. The existence entries at and
below the root and the membership entries below it stay as stored, as the
existence entries do under a write of the root, and no existence entry is
minted at the root. This
implements
[specs#98](https://github.com/commonfabric/specs/pull/98) ahead of its ruling,
at strict and with no dial, at @danfuzz's direction; it lowers a stale value
stamp and can raise one from the restating setup's decision reads, so it does
not satisfy step 4 either, and its four deciding sites carry that pull
request's `SPEC-PENDING` marker.

**Residuals.**

- A wiring whose stored name is carried over is stamped from the attempt's
  join, an over-taint where the name was itself build-decided.
- Only a setup in the transaction it was asked in restates an unchanged
  wiring (`#askingSetupTransactions` in `runner.ts`: the transaction a caller
  hands `run`, `setup`, `runSynced` or `runInTransaction`, or the one `setup`
  or `runSynced` makes for that call; a setup nested in another, such as a
  pattern node its parent instantiates, takes that transaction's standing).
  A `run` given no transaction is not one. A setup the runtime starts on its
  own but hands a transaction is one, and so re-mints an unchanged wiring's
  membership, as specs#98's `restateResultWiring` requires of every
  restating setup, from a join holding none of the reads that chose the
  pattern. Whether that re-mint should also be limited to asking setups is a
  question for the specification, not a labs deviation. Those setups
  pass `runtimeStarted` (the source reconciler's adoption of a newer release
  of the source a piece follows, on open or while it runs, the piece
  controller's re-stage of a stale root
  setup, its cold-start setup repair and its roll-forward, `wish.ts`'s
  sidecar run in a continuation's transaction, compile-and-run's
  instantiation and the LLM dialog's tool-call instantiation), which
  `#runtimeStartedSetupTransactions` records and the `result-wiring` input
  carries, and a restated result holding data takes its value entry only
  from a setup that is not one of them. A transaction the runner makes
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
- A result document holding data beside its references has its value entry
  re-derived at a restatement and none of its membership, so a setup that
  leaves it unchanged keeps the stored membership: an over-taint where an
  earlier attempt's stamp is wider than the setup's own.
- A result document holding data and no reference at any depth is not restated,
  so a stale value entry on it stays, pending specs#98's answer on whether
  `restateResultWiring` covers such a root
  ([comment](https://github.com/commonfabric/specs/pull/98#issuecomment-6899569496)).
- A release the source reconciler adopts, on open or while a piece runs, is
  runtime-started, so it leaves a stored value entry in place, pending
  specs#98's answer on whether such an adoption is an asking setup. A hidden
  view therefore heals at an update a caller asks for (`cf piece setsrc`, a
  FUSE source write, a bulk retarget, the harness's source tool, the served
  `setsrc` verb), whether or not the update touches the view, except the case
  the next bullet describes, and not at an adopted release that leaves the
  view unchanged. An update of either kind that rewrites the view replaces its
  value entry, as a write does.
- A setup of the pattern a result was set up with, other than one that
  rebuilds the stored setup state (`reapplyStoredSetup`), reads the name it
  would carry over from the stored result, whether or not one is stored, and
  that read consumes the root's value entry. Its restatement re-derives the entry
  from a join that carries the stored entry's clauses again, so a stale value
  stamp comes off only at an asking setup of another pattern, such as an
  update that changes the sub-pattern's module.

## 10. Write-policy alternatives across a release (§8.15.6, §8.15.13)

The specification at the pin has no write policy: nothing in it names
`writePolicyAnyOf`, a list of alternatives at one position, each pairing a
writer with an optional UI contract. Its rules for a schema that changes a
stored claim are general: §4.2.2.1 rule 4 has schema evolution preserve the IFC
contract attached to a path, and §8.15.3 has write authority stable.
[specs#96](https://github.com/commonfabric/specs/pull/96), stacked on
[specs#52](https://github.com/commonfabric/specs/pull/52), proposes the
construct (§8.15.6.1, "Write-Policy Alternatives"), that a later schema may omit
a stored alternative, which the merge keeps exactly as stored, in every write, a
release included, and a release that may append an alternative to a stored
policy (carve-out (c) of §8.15.13, "Release", `mergeWritePolicy` and
`admissible`).

**What the runtime does.** `mergeWritePolicyAnyOf` in `cfc/schema-merge.ts`
matches each stored alternative to a candidate's by content: the same keys, the
same contract, and writer claims that reconcile as two lone `writeAuthorizedBy`
claims do (`reconcileWriterClaimStamp`). It keeps the stored alternatives as
stored, in stored order, whatever order the candidate lists them in, and keeps
one the candidate does not list as stored too, in every write, a release
included. Its caller says which side is stored (`storedSide`): the persist
loop's merge of the stored envelope with the writer's schema
(`mergeStoredCfcEnvelope`), the dry run of that merge
(`storedCfcEnvelopeMergeIssue`), and the merge of a linked document's stored
envelope with the schema the transaction writes it under
(`linkedSourceEvidence`) name the stored envelope; the verification overlay,
which merges the writer's schema with the claims the merged envelope holds where
the write puts links, names those claims. A merge of two schemas neither of
which is stored, such as two inputs of one transaction to the same document,
refuses a candidate that lacks an alternative. Every write, a link write too, is
verified against its writer's own schema as well as the stored envelope, so a
writer the candidate omits writes only under a schema that lists it, and only
with the stamp that schema gives it. It appends a candidate's alternative that
matches none only in a release, and only where
`writePolicyAlternativeAdmissible` admits it: its writer carries a module stamp
the release installs, and one stored alternative names the same keys and the
same contract with a writer stamped with that module or with one the space
attests the installed module succeeds, whose claim the appended one's is but for
the symbol it binds, a nonempty path of names, and its stamp and file spelling.
The commit site in `prepareBoundaryCommit` (`cfc/prepare.ts`) knows a release by
the runtime's `release-program` input (`transactionReleasesStore`), names the
installed modules from it (`releaseProgramModules`), and reads succession from
the delegations the transaction is pinned to (`moduleSucceeds`), which for a
source update's setup include the ones the update proposes. `droppedStoredClaim`
in `cfc/claim-preservation.ts` checks the merged envelope again, reading it
independently of how the merge built it: every stored alternative kept, wherever
it sits. It shares the merge's admission predicate,
`writePolicyAlternativeAdmissible`, for every other alternative, so a defect in
that predicate passes both. `piece setsrc --check` and the origin-following
review merge in dry run through a transaction pinned to the delegations the
update would propose (`PatternManager.proposedSourceUpdateDelegations`,
`Runtime.readTxProposingDelegations`), derived from the same verified source
closures as the update's own where the space holds the candidate's, so the check
and the commit give one verdict. A candidate the space does not hold yet, as
`--check` compiles one, is derived from the modules this session evaluated it
with, which leave out a module the program imports only for its types; there the
check can refuse an appended writer the commit admits.

This implements specs#96 ahead of its ruling, at strict and with no dial:
@danfuzz ruled that it lands at the strict default with no default-off dial,
recorded in the correspondence procedure as a nonconforming semantic gap,
pending specs#96. Against the pin it admits more: an appended writer, a
candidate listing the stored alternatives in another order, and a candidate
omitting a stored alternative, which the pin's general stability rules refuse.
The last follows specs#96 as amended, and @danfuzz ruled on 2026-11-15 that it
lands the same way, at the strict default with no dial. So it does not satisfy
the correspondence procedure's step 4, which asks for a default-off dial for a
change admitting more. Its four deciding sites, the merge's matching and its
append, and the keep rule's matching and its admission, carry its `SPEC-PENDING`
marker, and the kernel manifest carries no row for `mergeWritePolicy` until a
regenerated snapshot defines it.

**The restatement waiver across a release.** A setup that carries a protected
argument slot over unchanged has its writer refusal deferred and then waived
where the envelope it would store declares the same policy throughout the
document ([specs#67](https://github.com/commonfabric/specs/pull/67), §8.15.4,
which the pin does not have). A release that appends an alternative changes the
policy at that position, so the waiver's comparison would refuse every release
of a piece whose argument holds a value under a lone writer claim beside the
extended policy. In a release, the comparison that stores the derived envelope
counts such a position as unchanged where the stored alternatives begin the
derived list, element for element and in order, stamps and files included, each
further alternative is one `writePolicyAlternativeAdmissible` admits, and every
other claim there is the same (`ifcDiffersOnlyByReleaseAppend` in
`cfc/schema-merge.ts`). A position whose logical path the comparison cannot
tell, or that is at, above or beneath a deferred field, is compared exactly.
That is specs#67 as amended (§8.15.4, the replayed-setup restatement), which
decides the deferred paths against the stored envelope's requirements alone;
the runtime decides them against every schema the write answers to, the
stored envelope among them, so it compares at least the positions the
amendment compares exactly. Against the pin the runtime admits more; @danfuzz
ruled on 2026-11-17 that this lands at the strict default with no dial, ahead
of specs#67's ruling, under its `SPEC-PENDING` marker.

**Residuals.**

- The merge also requires an appended alternative to hold the same keys as the
  stored one it pairs with, which the proposal does not ask: an over-taint.
- An unstamped stored writer claim, lone or a write policy's alternative, is
  adopted wherever the merge runs: a write whose schema restates it stamped,
  with a file spelling that corresponds, stamps it in that write, whichever
  writer makes the write, in a release or outside one. The proposal lets only
  the writer the stamp names bring the stamp over outside a release (§8.15.13,
  "Release"), and asks of the spelling a directory as well as a file name
  (§8.15.1, "Handler-Declared Write Capability"), so the runtime admits more
  there. A write whose schema differs from the stored envelope only in its
  stamps takes the persist loop's unchanged-envelope shortcut and adopts
  nothing. A compiled pattern's claims are stamped when the compiler mints
  them: a module compile carries each module's identity
  (`ModuleCompileRequest.moduleIdentities` in `harness/module-compile.ts`),
  and the schema transformer refuses to mint a claim for a module it has none
  for (`schema-generator.ts` in `base/ts-transformers`). So an unstamped claim
  is stored only from a schema the compiler did not mint, or from data stored
  before claims were minted stamped.
- A schema declaring an empty list where the document stores a policy is
  refused by the merge ("the candidate lists no alternative"), whatever the
  write touches, and one declaring nothing there keeps the stored policy as
  stored, as the proposal has them. Where the document stores no policy at the
  position, an empty list is refused as malformed only by a write that touches
  the position; a write that leaves it untouched stores the empty list, which
  then admits no writer there.

## 11. Writer delegations across a source update (§8.11.3)

A source update lets the successor pattern's modules exercise the writer
authority of the modules they replace. The runtime keeps that relation in a
registry of module delegations (`ModuleDelegationRegistry` in
`module-delegations.ts`), which the commit site reads (`moduleSucceeds` in
`cfc/prepare.ts`).

**What the runtime does.** The transition, `applyPieceSourceTransition` in
`runner.ts`, reads the piece's data and writes no cache document. It records
what it grants in the piece's `pieceSourceDelegations` meta member, through the
runtime's meta seam, naming the pattern it is for, in two fields: `edges`, every
delegation edge the piece's history recorded, each with every position in the
piece's source history at which a transition recorded it, never removed; and
`delegations`, each module of that pattern's closure closed over `edges` along
non-increasing positions (`inheritedAlongStamps` in `module-delegations.ts`), so
a module takes what its predecessor held when the module was granted it.
`PatternManager.prepareSourceUpdate` records each successor's edge to the module
it succeeds at one past the piece's history length, never 0, and an entry of the
predecessor record's attested list the edges do not already reach as the
successor's own edge at that same position, marked terminal, which a walk
reaches from that position or later and does not continue past, so the successor
gets the list as written and no earlier successor of the predecessor or of the
successor sees it (`composeRecordedEdges`), and closes the candidate's modules,
before the transaction opens, so the transaction is pinned to the closed set;
the transition is refused as a source that moved if the member has changed
since. Any other transition carries `edges` and closes the next pattern's
modules over them, so a module the next pattern keeps or brings back keeps its
grant and a new module gets none. Once a source update's transition commits, the
runtime registers its delegations and stages them on the successor's source and
compiled cache records, on a cache transaction of its own that reads only those
records (`#stageCommittedDelegations`). A staging that fails is not retried; the
piece's next committed update stages the closed entries of the modules it then
runs. A runtime that starts or swaps the piece to the member's pattern registers
the `delegations` entries whose module is in the successor's closure, verified
as it loads it (`PatternManager.readInheritedAuthority`), reads nothing else of
the member, closes nothing, and writes nothing. A member that is absent or names
another pattern registers nothing, and the records' own lists decide.

This implements [specs#101](https://github.com/commonfabric/specs/pull/101)
ahead of its ruling, at strict and with no dial. @danfuzz
authorized landing this design ahead of the ruling, without a flag, on
2026-11-14, recorded in the correspondence procedure as a nonconforming semantic
gap. Against the pin it admits more, since a pattern update no longer labels the
cache records it delegates through, so it does not satisfy the correspondence
procedure's step 4. Its two deciding sites, the recording in
`applyPieceSourceTransition` and the registration in `PatternManager`, carry its
`SPEC-PENDING` marker.

**Residuals.**

- An under-taint: the decision label. A transition that chose its successor
  by a labeled value put that value's clause on the records it staged, which
  §8.11.3 asks of a decision's downstream outputs. The staging transaction
  reads no piece data, so the records carry none, and the member carries no
  flow label either.
- Authority also comes from the piece's `pieceSourceDelegations` member, not
  only from a closure's own records, and the member is trusted on its shape: its
  predecessors are not checked against anything. Only the runtime's meta seam
  writes it. A client that bypasses its runtime can forge it, as it can forge
  the compiler's attestation on a record (`memory/v2/envelope-admission.ts`), so
  no new attacker gains anything. What a forged entry reaches is wider than a
  forged record: any runtime that starts the piece registers it for the whole
  space. A start writes nothing, so the entry reaches the cache records only
  when the piece's next honest update composes it into its own and stages it
  there under the compiler's attestation, after which it cannot be told apart
  from an attested entry.
- Growth. `edges` grows by one edge, or one position on an edge already
  recorded, per module an update replaces, and `delegations` by one predecessor
  per earlier version of each module of the running pattern, so both grow
  linearly with the piece's updates; nothing bounds the number of updates over a
  long-lived piece. A record's attested list adds an edge only for a predecessor
  the piece's own history does not already reach, as one another piece's update
  gave a shared successor. The closure expands each module once, taking first
  the module it reaches with the largest position, so one closure costs time
  linear in the edges and their positions, times a logarithm. An honest member
  keeps each file's versions in a chain of their own, a listed entry ending its
  walk, so a walk covers one chain: an update after a thousand updates of a
  hundred files composes in about 90 milliseconds, measured. Only a forged
  member makes the edges dense, and one with a million edges costs one
  preparation about twelve seconds, measured.
- A grant whose staging failed. The piece's own authority does not depend on
  the staging, but the grant stays missing from the cache records where nothing
  of the piece's carries it to them, so three readers of the records alone are
  refused it, where `main`'s staging in the transition would have kept it. A
  runtime from before the member that makes any transition of the piece after
  the failed staging, a source update or not, leaves the member naming another
  pattern, so the member is ignored, the unstaged record decides, and the
  runtime is refused the grant and granted nothing more (pinned by a test that
  expects the refusal). A source update of another piece from the ungranted
  module after the failed staging takes in its unstaged record, so it is refused
  the grant, carries the loss into that piece's record and on to its successors,
  and is granted nothing more. A module of another piece that writes, through a
  link, into a field the granting module protects after the failed staging is
  refused the grant, since that runtime registers it only from the records, and
  is granted nothing more.
- Records an earlier transition stamped keep their clause until the load
  ahead of a setup repairs them (`module-loading.md`, "Repairing a stamped
  record"). The repair erases a stamped compiled record and rewrites a stamped
  source record to the value the compile-cache writer stores for its identity,
  which lowers a stored label at strict ahead of the specification's ruling
  (commonfabric/specs#103, §18.6.2.1). What §18.6.4 asks a repairing runtime
  to record:
  - When it runs: in `PatternManager.prepareSourceClosureVerification()`,
    ahead of a setup that verifies the closure, once a check of the closure's
    labels finds a stamp. A child a pattern's own graph places in another
    space is created without that preparation, and is not repaired first
    (`module-loading.md`).
  - The identity it writes under: the `compile-cache-repair` builtin, through
    `writeRepairedCompileCacheRecord()`, which refuses any other identity and
    any key but a compile-cache record's.
  - How the attestation at a delegation list is kept to lists the
    compile-cache writer wrote: the writer mints it only on a list it writes
    in an attempt of its own, and a write by another identity strips it at
    the path it reaches, before or after the writer's write
    (`module-loading.md`, "Per-space containment"). That cannot be
    established for records a runtime before #9868 wrote, which staged the
    lists in the update's own transaction. Nor does it hold for a write at
    the `disabled` rung, which leaves the attestation over a list another
    writer chose; no shipped host runs `disabled`.
  - The four residuals it releases: the attested delegation list, carried
    unlabeled; the cache-root edge set of the entry's record, kept as a set
    of verified members; existence, since a reader not cleared for the
    removed clauses learns that the record was once written under a label;
    and program text a writer chose under a label below strict, released as
    the canonical value of the record's key.

  A record the repair refuses keeps its clause, and a setup that reads it
  keeps refusing. A write-back still re-stamps the root of a record that
  already carries a clause, which a later load repairs again. A closure whose
  repair lost a race, or whose commit was refused for want of write access, is
  tried again at its next load; one the repair refused is not tried again in
  that session. A stamped compiled record of a
  `fabric:` dependency is not repaired, and a write-back of its importer that
  reads it re-stamps the importer's compiled record, which the next load
  erases again; a setup of the importer still commits, since it reads source
  records only.
