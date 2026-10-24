# Independent reference labels: retiring the carried target view and the `LinkReference` atom

_Proposed 2026-10-12. Stage 3 is merged in the specification; stages 1, 2, 4
and 5 are implemented on the stacked branches that carry this plan and await
review; each stage below says what it depends on and what lands with it._

## What this plan holds to

The specification settled what a reference carries in `cfc/08-02-pass-through-via-references.md`
(§8.2) and `cfc/08-12-store-label-monotonicity.md` (§8.12.8). A reference is
independently labeled data. Its label is the join of how the reference was
acquired and what the creating attempt observed (§8.2.3: identity and
acquisition restrictions, plus the attempt's conservative observation and
control join, triggers included). The target's content labels stay on the
target and are consumed when the target is read through the reference
(§8.2.4): confidentiality of a dereference is the reference restriction
conjoined with the target's current labels; integrity is the target's current
integrity plus the reference's still-applicable scoped endorsements. The
link-carried component a slot persists is "the reference's own
identity/acquisition restrictions and validated reference provenance; excludes
target-content labels and target-evidence caches" (§8.12.8), and it is replaced
when the reference at the slot is rewritten.

A runtime may instead add historical target restrictions to the reference
label, but only as a declared over-approximation, and that posture "is not the
precise reference profile" (§8.2.5). Stage 1 of this plan holds the runtime to
the specified contract: `linkSlotLabel` in `packages/runner/src/cfc/prepare.ts`
persists the reference's own label at the slot and nothing of the source's,
and `linkedSourceEvidence` keeps the source-derived label, through the
references staged into the source, for write floors alone. The later stages
remove the atom that the over-approximation left behind.

## The atom and what reads it

Until stage 4, every link write minted a `LinkReference` integrity atom naming
the pointee and the slot, and a second mint site added one to the writer's
value stamp at a slot the runtime recorded storing a reference at; the rest of
this section describes the runtime as that stage found it. The atom restates
the link value beside it: for an entry at a
slot, its `source` is the link stored there and its `target` is the document
plus the entry's own path. The specification itself says what this proves:
"Merely recording 'this reference was written' proves no semantic property"
(§3.7.2). The runtime classifies it accordingly: its fields are
"display/provenance only; nothing dereferences the persisted copy"
(`cfc/label-field-classification.ts`), it never gates a `requiredIntegrity`
write (`STRUCTURAL_LINK_PROVENANCE_ATOM_TYPES`), and it never enters the
hereditary meet.

Two readers depend on it, and both exist because of something else:

- `stampNamesReference` and `slotStampDescribesAnother`, which
  `followedReferenceWitnesses` consults. They decide whether a writer's value
  stamp at a slot describes the reference the slot holds now. The question
  arises because an append commits as a tail-relative operation that the server
  places at the list's live tail, while the label envelope the appending
  transaction wrote is positional and describes the list as the transaction saw
  it. Under concurrent appends the envelope written last describes one element
  at the position another took. The atom lets the witness pass refuse a stamp
  that sits beside another writer's reference. It does not put the labels at
  the right positions: the element the server moved to the tail is left with
  no slot entry at all, and the slot it was described at carries another
  writer's label. That is an under-taint of "which reference sits at this slot"
  that stage 2 closes at the append, after which the guard has nothing to
  guard.
- The root entry at every accepted link, as the runtime persisted it before
  stage 1: `persistedLinkEntries` kept an entry only when its label had
  values, and for a link to an unlabeled source by an attempt with an empty
  join, the atom was the only value. The entry existed to hold the atom. With
  the slot carrying the creation join, which stage 1 does, a slot with nothing
  to say persists nothing, and every consumer of a missing link entry already
  reads it as "no restriction".

The carried descendants, which the atom's `target` field exists to address
once copied away from their origin, are what stage 1 removes.

## What a link slot persists after this plan

A link write persists at most two entries at the slot, both of the pointer
class, and nothing beneath it. A writer's value stamp can stand at the slot
beside them, in the one case the paragraph after the list names:

- The link entry, `origin: "link"`, holding what the reference declares and
  carries: the link schema's declared confidentiality, the acquisition
  restriction the written handle carries (the root of its `cfcLabelView`,
  which is what `referenceRestrictionsOf` in `cfc/label-view-state.ts`
  already extracts for a dereference), and the link schema's integrity after
  `gateRuntimeMintedIntegrity`. No `LinkReference` once stage 4 lands; until
  then the entry carries the atom as before. A reference with nothing of its
  own persists no link entry. It is replaced when the pointer at the slot is
  rewritten and cleared when an ancestor overwrite removes the pointer
  (§8.12.8, as `linkEntrySuperseded` already does).
- The join stamp, `origin: "structure"`, `observes: "followRef"`, holding the
  creating attempt's flow join (its reads, PC and triggers) where flow labels
  persist. It is a flow stamp: derived, so label metadata introspection may
  observe it, and cleared with the flow stamps when the slot is rewritten. A
  slot of a container the transaction stamps as a whole has no stamp of its
  own; the container's `*` template carries the same join to every slot.

The join's integrity, which certifies what the attempt computed rather than
what its pointer reaches (§3.7.2), stays off the slot, and a link write mints
no `derived` value stamp at a slot the flow stage would otherwise stamp. One
value stamp can still land at a reference slot: the writer's `TransformedBy`
stamp at a whole-value root the write asserted (`assertedValueRootPaths`),
where the asserted value is the reference. Until stage 4, the `LinkReference`
beside it binds that stamp to the pointer it described; stage 4 states which
such stamps keep their witness once the atom is gone, and the invariant stage
2 establishes is what makes a stamp persisted under it describe the value the
slot holds.

A dereference composes the slot's restriction with the target's own labels.
That is already how `cfcLabelViewForDereference` builds a label view and how
the flow join's `followRef` probe consumes the followed slot; neither reads the
copies beneath the slot. A link write takes nothing of the source's labels
from its stored envelope. It reads that envelope for one thing of its own: a
`CurrentPrincipal` reader placeholder in the link schema or the carried
restriction is bound to the reader the source stores at the linked path,
before the acting principal. Beyond that, the envelope is read only when an
assertion about linked content (a write floor, an exact-copy claim) needs the
source's evidence, which `verifyWriteFloor` resolves through the link resolver
against the current source and keeps doing.

## Stages

### Stage 1: a link write persists its own label, not the target's

Implemented. What the later stages depend on it leaving behind:

- `linkSlotLabel` derives the slot's entry from the link schema, the handle's
  carried root restriction and the acting principal, and nothing the source
  holds; the persist loop stamps the creating attempt's flow join at the slot
  beside it where flow labels persist, as a pointer-class `structure` entry
  that label metadata introspection may observe and a reconciler's readback
  exclusion treats as derived, except at a slot of a container the
  transaction stamps as a whole, whose `*` template carries the same join.
  A reference with no restriction of its own persists no link entry.
  `linkedSourceEvidence` keeps the source-derived label, through the
  references staged into the source, for write floors alone, which the deriver
  exposes as `evidence` beside `persisted`. In that evidence the source's
  stored integrity stands as stored: the commit that persisted it held its
  author to the mint, and the floor asks whether the linked value carries the
  endorsement, not who points at it. The author-influenced parts, the link
  schema's integrity and a schema the transaction writes the source under,
  stay gated against runtime-minted atoms.
- `recordLinkWritePolicyInput` in `data-updating.ts` no longer reads the
  source's envelope. Every link write is recorded, so that a floor or claim
  the slot's schema declares is checked whenever that schema arrives in the
  transaction; the write marks the transaction relevant only when the link
  schema declares policy, the handle carries a restriction, or the target
  carries stored or arriving policy at the slot. A bare pointer written by a
  transaction nothing else makes relevant, the ordinary list reconcile, is
  not prepared, which is both the cost the plan is after and what keeps an
  action still bound to such a transaction from invalidating it with a read
  after its commit was prepared. A transaction whose attempt read labeled
  data is marked relevant by the flow-label probe as before.
- A `requiredIntegrity` floor declared under a wildcard, on every element of
  a list or every value of a record, is held against the references written
  at the positions it covers, each to its evidence. Before this plan the
  refusal of an unendorsed assertion linked into such a list came from the
  "missing link source metadata" rule, which needed the source's envelope;
  the floor is the stated contract (§8.12.4.1 over §8.2.6) and needs only the
  source's evidence. A plain value written at a covered position stays with
  the per-element read gate, as before. A floor on a concrete path is held
  the same way at a reference: a stamp the writer's schema mints at the path
  credits nothing there, since the store keeps no stamp at a position holding
  a reference, so a link written at the floor path, or above it, is judged by
  the declared label and the source's evidence. A stamp at a container the
  write persists, the minted list a roster is, covers the references beneath
  it.
- The slot carries the creating attempt's join on a pointer-class stamp of
  its own, beside the link entry. A link-covered path is still skipped by the
  flow stage's derived stamp; the link loop mints the slot stamp instead. The
  wildcard `*` templates a coordinator mints at a pure-link container carry
  the join to its children, so such a slot gets no stamp of its own and
  coordinator slots change little; a single link written by a handler newly
  carries the handler's join on pointer reads, which is the §8.2.3 precision
  the contract asks for.
- A cell's stored label view, `cfcLabelViewForCell` and its fail-closed forms
  in `cfc/label-view.ts`, follows the links the cell's path lands on or
  crosses to the document holding the value. It joins the labels the cell's
  own document stores at the path with the reference restrictions of each
  slot followed in another document and the labels stored with the value.
  With nothing of a target copied to a slot, that is where a boundary that
  asks a cell for its labels finds the labels of a value a reference
  forwards: the sqlite write ceiling, the LLM observation ceiling and the
  harness's result writer among them. Links below the cell's path are
  references in the value, and the view reports their slots' own labels.
- A link to a document that stores no label is written like any other. The
  "missing link source metadata" refusal existed because the slot had to copy
  the source's label, and it goes with the copy. Two patterns had documented
  it as a property of their participant rosters, the Loom root and the
  default app: a roster now links a bare document as it links a labeled
  profile. Both describe a roster entry as a claim, which does not say that
  the profile's principal holds access, and the Loom's consumers keep only
  the entries whose profile names a principal with access. A roster that
  should refuse a document outright states that as a `requiredIntegrity`
  floor on its items.
- The live documents that describe the copy are rewritten:
  `docs/specs/cfc-cross-space-integrity.md` (its premise that a reference
  carries the label across a space boundary becomes: a reference carries its
  own restriction, and the target's labels are consulted at dereference),
  `docs/specs/cfc-observation-classes.md` ("Label views across a link"),
  `docs/specs/cfc-label-metadata-confidentiality.md`, and the conformance
  statement, which stops needing the over-approximation that was never
  declared.
- The tests that pin copying are reshaped, not deleted:
  `cfc-cross-space-integrity.test.ts` scenarios 1c, 1d, 3b, 3d and 3e assert
  that the slot stores nothing of the source and that a dereference view
  composed by `cfcLabelViewForDereference` reaches the source's labels;
  `cfc-list-link-labels.test.ts` links the labeled element under its own
  schema, so the slot carries the link schema's declaration and nothing below
  it, and its refusals of an unlabeled element at a declared position become
  acceptances that keep the declaration; `cfc-link-integrity-gate.test.ts`
  binds a link schema's `CurrentPrincipal` reader to the acting principal.
  Scenario 1c is the contract's "publicly acquired reference to confidential
  content" case; `cfc-probe-slot-anchoring.test.ts` covers "a private
  selection among public targets labels the pointer".

Acceptance for stage 1: the first-run commit of the thirty-row fabrichat room
(the capture `docs/plans/resume-presync-cost.md` tracks) writes no `["array",
k]` entry on any row's argument document, and the staged-reference diamond
probe of
`docs/history/development/performance/2026-09-25-staged-reference-cache/README.md`
prepares a map whose entry count is the number of references, not the number
of root-to-leaf paths.

### Stage 2: a label envelope describes the document it commits into

Depends on nothing; can land beside stage 1.

The envelope a transaction writes at the document's reserved position is a
whole-member replace, computed against the list the transaction read. The
mergeable tail operation beside it is resolved by the server against the live
list. The seam is `SpaceReplica.#commitReadActivities` in
`packages/runner/src/storage/v2.ts`, which drops the envelope read from the
commit's conflict set on two arms: every verifier read of the label, and every
read of a document with a mergeable op. Both are right for a transaction that
only reads the label and wrong for one that writes it: without the dependency,
two concurrent labeled appends both commit, the later envelope describes the
earlier list, the element the store moved to the tail has no slot entry, and
the earlier writer's entries are dropped. The fix keeps every read of a
document whose envelope the transaction writes beside a mergeable op, so the
commit conflicts and the handler re-runs against the live list through
`editWithRetry`; preparation then stamps the live position. The tail operation
stays mergeable, an append that persists no labels keeps its zero-read merge,
and what stops merging is a stale envelope. `docs/specs/memory-v2/08-conflict-granularity.md`
§4 states the rule. The retry cost on the chat-room workload, where every
message append under persisted flow labels is a labeled append, is measured
with the rest of this plan's probes.

With that in place, a value stamp at a slot describes the value the slot holds
in the committed document. `cfc-transformed-by-input-witness-concurrent-append.test.ts`
appends through `editWithRetry` and asserts that a labeled append whose list
moved under it lands its stamp beside its own element; the "copied reference"
attack is still refused, because the slot holding the copy carries the
attacker's stamp, not the submit step's. Its seeded scenarios, which stamp a
slot beside another writer's reference by hand, remain the legacy case the
guard still answers until stage 4.

If the retry cost on contended lists proves too high, the follow-on is an
append operation that carries the entries for the elements it appends,
relative to the operation, which the server places with them. That is a
memory protocol change and a specs change to §4.6.4; it is not needed for this
plan's correctness.

### Stage 3: the specification retires the atom

Depends on stages 1 and 2 being understood, not on their landing; a ruling
can be sought in parallel. This is a semantic gap under
`docs/development/cfc-spec-correspondence.md`, filed as a ruling in the form
of `cfc/13-11-decisions.md`:

- `cfc/15-atom-registry.md` §15.4: remove the `LinkReference` row, or keep it
  marked as a legacy atom no conforming runtime mints. "The only evidence atom
  a link write may legitimately mint" becomes "a link write mints no evidence
  atom; the writer's scoped endorsement is its value stamp (§3.7.2)".
- `cfc/08-15-write-authority.md` §8.15.4 item 3: a staged reference "carries at
  most the reference provenance a link write may mint" becomes "carries the
  staging attempt's reference restriction and its writer's stamp, and no
  claim about the entry's content".
- `cfc/08-12-store-label-monotonicity.md` §8.12.8: "validated reference
  provenance" in the link-carried row is stated as the writer's scoped
  endorsement persisted at the slot, so that nothing in the row names an atom.
- A sentence under §8.10.2 or §15's `TransformedBy` row stating the invariant
  stage 2 establishes: a value stamp persisted at a slot describes the value
  the committed document holds there, and a runtime whose storage can move a
  written element after the stamp was computed must re-derive the stamp.
- Legacy: the §18.7 rule that unresolved legacy mixtures stay conservatively
  restricted already covers confidentiality. For integrity, the ruling adds
  that a value stamp at a reference slot persisted before the invariant held
  is not input-witness evidence.

The Lean development needs no new theorem: `StoreComponents.linkCarried` is a
label, `Reference.create` takes endorsements as a separate list, and nothing
mechanizes the atom. The ruling's correspondence note says so.

### Stage 4: the runtime stops minting and reading the atom (labs companion)

Implemented, against the ruling merged as specs commit `132653b3`
(commonfabric/specs#66), with the snapshot regenerated. Depends on stages 2
and 3. What it leaves behind:

- No link write mints the atom. `linkReferenceIntegrity`, the atom the
  asserted-root stamp named its pointer with, `stampNamesReference` and
  `slotStampDescribesAnother` are gone, and a link entry holds the
  reference's declared and carried restriction and nothing minted.
  `recordedReferences` stays: `assertedValueRootPaths` still asks it which
  references anchoring stored, and the persist loop asks it which stamped
  roots are slots holding one.
- The atom stays registered as retired, which is a deviation from this
  plan's first draft, where its rows were to be removed. It stays in
  `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`, so that a pattern spelling its URI
  in a schema has it stripped and cannot persist evidence a stored floor or
  guard once took from the runtime alone; in
  `STRUCTURAL_LINK_PROVENANCE_ATOM_TYPES`, so that a label stored before the
  retirement, whose integrity is the atom and a principal claim, still does
  not gate a `requiredIntegrity` write; and in `cfc/atom-classes.ts` and
  `cfc/label-field-classification.ts`, so that a stored one keeps its class
  and its `source` and `target` are still committed when a label crosses
  spaces. `packages/api/cfc.ts` keeps the constant, under which `cf label`
  shows a stored one, and the pattern-facing ambient type generated from it
  (`packages/static/assets/types/cfc.ts`) lists it still; a pattern that
  names it has it stripped by the mint gate.
- Which reference a writer's stamp at a slot describes is answered by the
  envelope and not by an atom. An envelope carries `stampPlacement:
  "committed"` when its writers' stamps at reference slots were persisted
  beside the references their attempts anchored: the stored envelope said so
  or this transaction stamped such a slot, and no stamp carried over from an
  envelope that did not say it stands at a slot holding a reference.
  `slotStampPlacementUnknown` in `cfc/prepare.ts` withholds the witness of a
  writer's stamp at a reference slot of an envelope that does not say it
  (§18.7). A writer's stamp is one the flow stage minted, a `derived` or
  `structure` entry; a `TransformedBy` a schema declares at a slot, or in a
  template over a list's items, names no attempt and is no witness, at a
  reference slot or at a value, however trusted the declaring code
  (`asWitnessEvidence`, §15.4). The member sits beside the ones the
  envelope's version defines
  and is no version of its own, which is the second deviation from the first
  draft's "bump to version 3": a version this build's predecessors do not
  know makes every labeled document unreadable to them, where a member they
  do not read leaves the document readable and is dropped by a writer that
  rewrites the envelope without knowing it, which is the conservative
  outcome (`docs/specs/cfc-stored-envelope.md`). Envelopes that hold no such
  stamp are written byte for byte as before.
- A document stored before this stage is read as it stands and is not
  rewritten for it. Its link entries keep their atoms and the copies beneath
  them as conservative restrictions until the pointer at each slot is
  replaced. Its writers' stamps at reference slots are no input witness, and
  an append beside them does not make them one: the envelope says where its
  stamps sit only once none of them stands at a reference slot. An exchange
  rule that pins a witness through such a list refuses until the endorsed
  step has rewritten the slots.
- The tests that named the atom as what a link write mints are updated.
  The ones that seed it into a stored label, to hold the S7 exemption and
  the mint gate to it, keep it: `cfc-required-integrity-provenance.test.ts`,
  `cfc-write-prefix-provenance.test.ts`,
  `cfc-prefix-provenance-stats.test.ts` and
  `cfc-label-field-classification.test.ts`.
  `cfc-transformed-by-input-witness-concurrent-append.test.ts` pins the
  envelope's statement and the legacy rule.

### Stage 5: a handle carries its acquisition, not the target's labels

Depends on stage 1; independent of stages 2 to 4.

Implemented for the resolution routes: `cfcAcquisitionViewForDereferenceTraces`
in `cfc/label-view-state.ts` gives a handle the reference restrictions of
every slot its resolution left, and `Cell.resolveAsCell`, the query-result
proxy, the schema reader's value and write-redirect resolutions and its
`asCell` hop take that in place of the dereference's full view. The schema
traversal's `cross` already carried the slot's restrictions alone. What is
carried is confidentiality: the slot's integrity, an endorsement of the
selection the slot holds, is not a property a copy of the handle inherits
(§3.7.2), so a handle recovered from a query result carries the target's
labels, read where they are, and nothing the slot endorsed. The reading
attempt's own join is not carried on the handle either: a link written in
the same transaction takes it from the slot stamp the persist loop mints, and
a handle held across transactions carries the slot restriction alone. The
resolution still reads the labels of every document it followed into, for
the dependency a subscription needs: a label-only write to such a document
re-fires a sink that followed the reference. `cfc-handle-acquisition.test.ts`
pins both directions, and `cfc-label-view.test.ts` the handles recovered
from query results, schema materialization and array proxies.

The `cfcLabelView` a handle carries into a link write is the view the handle
was minted with: `Cell.resolveAsCell`, the query-result proxy
(`packages/runner/src/query-result-proxy.ts`), the schema reader's
resolutions (`packages/runner/src/schema.ts`) and the schema view's
`createOpaqueReference` and `readChild` (`packages/runner/src/schema-view.ts`,
which rebase what the cell handed them) give it, and
`packages/runner/src/data-updating.ts` (`cfcLabelViewForPrimitiveLink`, the
carried view on `set`) reads it off the handle at the write. Before this
stage it was the label view of the read that produced the handle, the
target's labels at read time; it is now the acquisition restriction stated
above, so that a handle obtained from a query result under a secret filter
carries the filter and nothing else, and a handle read from a public slot
carries nothing. Worker reference tokens forward whichever view a handle
holds, so they shrink with it. The stage is measured on the room capture
separately from stage 1, since stage 1 removes the persisted copies and this
stage removes what a handle holds in memory and sends over IPC; that
measurement is still owed.

### Stage 6: retire what the copying made necessary

Depends on stage 1's acceptance measurement.

`docs/plans/compact-cfc-label-maps.md` proposes a shared-subtree label map to
bound the exponential growth of staged-reference diamonds. The growth is the
copy; with stage 1 a diamond's map holds one entry per reference. Archive that
plan to `docs/history/plans/` as superseded once the diamond probe confirms the
bound, with the measurement linked from the archive note.

The sqlite builtin holds two arrangements that the refusal of a link to an
unlabeled document made necessary, in `builtins/sqlite-builtins.ts` and
`docs/specs/sqlite-builtin/06-cfc.md`. A row that holds a link column
declares no existence label, so that the links beneath its root would not
meet the refusal; its existence therefore lacks the join of its column
labels, and it should declare that join as every other row does. A row with
no label of its own declares an empty one into a labeled store, so that a
re-link of the standing row would find a declaration; nothing reads it, and
it goes.

The harness audit's AUD-25, "labels across a followed link", counts the links
a run's cells hold by the `origin: "link"` entries in the run's cell-labels
snapshot (`packages/cf-harness/audit/checks/structural.ts`). A reference with
no label of its own stores no such entry, so the check reads a run whose links
are bare, as a sqlite result's row links are, as holding no link at all and
reports itself not applicable. The snapshot reader in
`packages/cf-harness/src/space-labels.ts` walks values and already knows every
link it found. The snapshot should record those paths and the check should
count them, with its fixtures rebuilt on what a reader reports.

## Legacy data

No migration runs. A link entry persisted under the over-approximation carries
the target's labels of its day; the specification admits that as a
conservative restriction (§8.2.5, §18.7), and it is replaced the first time the
pointer at its slot is rewritten (§8.12.8), which the persist loop already does
through `linkEntrySuperseded`. The carried descendants beneath a legacy slot
clear with it. A reader that follows a legacy link composes the stale
restriction with the target's current labels, which over-taints and never
under-taints. The only data rule is the one stage 3 states for input
witnesses, applied lazily where an envelope is re-persisted. No Home contract
changes, no readiness marker, no admission gate.

## Measurements and gates

Before stage 1 and after each of stages 1, 2 and 5, on the same checkout:

| Probe | What it measures |
|---|---|
| The thirty-row room's first-run commit (`commit288.json` capture, or a fresh capture through `seed-room.ts`) | Per-row label-map bytes and entry count; today 36 KB of a 40 KB row and 85 entries, 63 of them copies and 16 KB of them atoms |
| The staged-reference diamond probe at depths 8, 10 and 12 | Prepared entry count and serialized bytes; before stage 1, 24,560 entries and about 3 MB at depth 12. With stages 1 to 5 on 2026-10-13, run with the probe's commit calls brought to the current receipt API and its copied-leaf assertion removed: 11 entries and 1,016 bytes at depth 8, 13 and 1,210 at depth 10, 15 and 1,404 at depth 12, one declared entry per node, in both staging orders, prepared in under 20 ms |
| `cfc-prepare-ladder.bench.ts`, `cfc-staged-reference.bench.ts`, `cfc-input-witness.bench.ts` | Preparation time; the `authoritativeCoverCalls` and `stagedReferenceDerivations` work counters should fall to the number of links written |
| The `cfc*` pattern integration tests and the CFC demos under `packages/patterns` | Refusals that appear because a pointer read newly carries its writer's join; each one is either the contract working or a coordinator whose read should carry the wiring marker of §18.6.2 |

The usual gates apply: `deno task check`, `deno task check-cfc-correspondence`
(the `§` citations the removed code carried go with it), `deno task
check-docs`, and the coverage ratchet on `packages/runner`.

## Pull request 7243

[commonfabric/labs#7243](https://github.com/commonfabric/labs/pull/7243)
implemented the same contract and is not merged. This plan does not rebase it.
What it carries that this plan reuses, lifted by hand:

- its §8.2 scenario tests (public pointer to secret content; private selection
  of public targets; mixed identity read and dereference in one attempt);
- its finding that the reserved position's read must not be filtered by the
  mergeable-write conflict filter, which is stage 2;
- the prose of its `docs/specs/cfc-references.md` as the seed of the live
  document that describes a link slot's label after stage 1.

What it carries that this plan does not take: the version-3 envelope with a
per-slot `referenceAcquisition` marker and the readiness classification built
on it; refusing legacy references in a precise mode; the Home published
contract change and its migration protocol; worker acquisition tokens and the
event dispatch-context version. Each of those follows from treating a legacy
reference as unresolved rather than as a conservative restriction, which the
specification does not require.

## Behavior changes to watch

- A pointer read through a slot written by a handler that read confidential
  data carries that confidentiality, where today it carries the target's. A
  public target reached through such a slot is confidential to read, which is
  §8.2.4; a pattern that relied on the pointer being public needs the handler
  to not have read the secret, not an exemption.
- A pointer read through a slot holding a public reference to a confidential
  target is public, where today it carries the target's label. Content reads
  through it are unchanged.
- A link write to a document whose envelope the transaction cannot read no
  longer refuses with "missing link source metadata"; it needs the source only
  when an assertion about linked content needs it. A list whose elements
  require an integrity atom refuses an unendorsed element through its floor
  instead, which reads the element's own evidence. Where the transaction
  holds every document the floor weighed for that evidence, the element and
  any document a reference on the way leads to, the refusal is a verdict, as
  the retired one was for a source whose root the transaction could read. The
  floor then reads those documents' stored labels, and the values along the
  linked path, again where reactivity sees them, so a reactive writer it
  refuses runs again when the element stores the atom, and a served event
  gets an error consequence sealed for it. A client that delivers its own
  events reports the verdict as a dropped write rather than through the error
  channel, as it does any CFC verdict. Where the floor weighed a document the
  transaction does not hold, which reads the same as one that lacks the atom,
  the refusal is not a verdict: a reactive writer takes its bounded retries, a
  client that delivers its own events reports the refused commit after one
  attempt, and a served event is deferred as a commit-preparation delivery
  failure, held at the head of its stream, retried on input, and covered for
  attention once its failed-state budget is spent. A floor's failure over a
  plain value is a verdict on the same terms, the documents being those whose
  stored labels the flow join read; it is not one where the flow join also
  weighed the flow of external content, which no document holds. Where several
  contributions miss one floor, the refusal is a verdict only when every one
  of them is decided that way, and a source whose stored labels name a schema
  document the transaction could not read decides nothing.
- A reference written at a concrete floor path whose schema mints the floor's
  atom is held to the source's evidence, where the mint used to credit it.
  The store keeps no stamp at a slot holding a reference, so a floor the mint
  passed was one no reader of the slot or of its target could see satisfied.
  A list path that mints the atom still covers the references beneath it,
  which is the roster shape of the lobby and the group-chat demo.
- Under flow labels `persist`, a reference written by an attempt that read
  labeled data carries that join at its slot even when the reference has no
  declared or carried restriction, unless the container it sits in is
  stamped as a whole by the same transaction. A write that replaces a
  reference at a declared position reads the position it overwrites, so the
  slot's join stamp repeats the position's declared label; the stamp labels
  the reference and leaves with it, the declaration stays.
- A labeled append to a list another session appended to concurrently retries
  instead of committing a misplaced envelope.
- A link to a piece document that holds no value yet carries nothing of the
  piece's result schema, which the piece's setup wrote as its schema meta. The
  slot used to copy that schema's root declaration. The piece's own writes
  label its content when it arrives, under that schema; until then there is
  nothing to read through the link.
- A reference-identity probe of a slot consumes the slot's own entries and
  the wildcard templates at it, and nothing of the element's labels, which a
  content read of the element consumes. Tests that read a labeled element's
  taint off a pointer probe now read it off the content read.
- Outside this change and left as found: a cross-space link write whose link
  schema declares a `PolicyOf` installs the policy manifest in the source's
  space, which opens a second space writer in the transaction and fails with
  a write-isolation error. `linkSlotLabel` passes the same owning space to
  `rootLabelFromSchema` that the previous derivation did.
