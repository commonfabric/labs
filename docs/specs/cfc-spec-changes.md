# CFC Spec Change List (running)

Changes `~/src/specs/cfc` needs so the spec can answer the questions that came
up while designing implementation work. Started 2026-06-10 during the S16
(default transition) design; intended to grow as later sessions hit new gaps.
Each item: where, what's missing or contradictory, proposed edit. Tags:
[clarify] prose fix, [normative] new requirement/profile text, [reconcile] two
spec passages disagree, [registry] table data.

Status legend: `open` (not yet applied to the spec), `applied`.

## From the S16 default-transition design

**SC-1 [normative] Store labels vs per-value data labels — §8.12 + §4.6.4.** The
biggest gap this design hit. §8.12 makes "store labels" monotonically
non-decreasing; §8.9/§4.6.1 derive per-value labels at every write/recompute;
§4.6.4's persisted `cfc.labels` map never says which of the two it holds, and
§8.12.4 says readers are tainted by "the store's label" as if there were only
one object. Consequence: it's unanswerable from the spec whether a persisted
path label may _decrease_ when the value at that path is overwritten by a
less-tainted computation — i.e. whether the envelope ratchets forever (label
creep) or tracks the current value. Proposed edit: define **label components**
with distinct update disciplines — `declared` store policy (monotone per §8.12;
the thing §8.12.4's reader-taint and writer-fit rules refer to), `derived`
per-value data labels (replace-on-overwrite by the committing attempt's verified
derivation; an ancestor overwrite clears derived descendants), `link/carried`
reference labels (replaced when the reference is rewritten). Effective label at
a path = join of components. State explicitly that derived-component decrease on
value replacement is sound because reads journal labels at read time (§8.12.2's
aliasing rationale concerns the declared policy, not data labels). Update
§4.6.4's envelope to carry the component tag.

**SC-2 [clarify] Stale derived labels — §8.9 (new subsection).** Nothing says
what happens when a _source's_ label grows after an output was derived from it:
the output keeps a point-in-time label that is now lower than a fresh derivation
would produce. State the intended model: derived labels are facts about the
write-time derivation; re-derivation on recompute refreshes them; there is no
retroactive relabeling obligation for cold copies (and if a deployment wants
one, it's a policy-layer sweep, not a runtime invariant).

**SC-3 [normative] Trigger reads for dependency-scheduled reruns — §8.9.2.** The
PC definition includes "trigger or gating reads that determined whether the
handler ran at all" but is written for explicitly-invoked handlers. For a
reactive runtime, define the trigger set of a scheduled rerun: the addresses
whose invalidating writes caused the scheduling, joined at their current labels.
Note the residual channel this closes (~1 bit per change event via write timing
of a rerun that branches away from re-reading the changed input) so implementers
know what skipping it costs.

**SC-4 [clarify] Existence channel under whole-path labels — §4.6.3 or §8.12.**
Until the `shape`/`value`/`iterate` observation classes are implemented, one
label covers all observation kinds at a path; replacing a derived label on
overwrite then also shrinks the _existence_ label, leaving "this path was once
written" as a public bit. Document as a known residual of the phase profile,
fixed by PathLabelTemplate observation classes. (Closed in two steps: the C2/C3
persist split gave existence its own frozen `observes:"shape"` entry, and
template-population Stage A closed the per-child half — a `*`-path `shape`
template on declared list-coordinator containers makes a per-child existence
probe consume the membership `J`; see
[`cfc-template-population.md`](./cfc-template-population.md) §6.)

**SC-5 [normative] Bless the prepare/digest factoring — §8.10.1.** The runner
implements the per-attempt verify loop as verify-at-prepare + a canonical-digest
recheck at commit with invalidation on post-prepare activity. Add a conformance
note: this factoring satisfies §8.10.1 iff the digest binds _that verification
ran over exactly this activity_ (not merely that activity matched some
caller-supplied input — the audit's S2 bypass), and any post-prepare read/write
invalidates the preparation. (Already flagged as audit item 2.1/3.2; the S16
design extends the digest to cover staged label-metadata writes, so the
requirement should be stated once, normatively.)

**SC-6 [normative] Relevance predicate / conforming fast path — new §18 profile
text.** The spec assumes boundary verification everywhere; real runtimes need a
skip. Define when skipping is conforming: a transaction whose reads touch no
labeled document (no persisted labels, no carried views), whose writes touch no
labeled document, and which triggers no policy-bearing schema may treat boundary
evaluation as a no-op. Also specify the read-exclusion mirror: runtime-internal
reads (verifier reads, label metadata at `["cfc"]`, program/source text,
content-addressed schema docs) do not enter the consumed set or PC — and note
this is a profile decision that must be revisited when label-metadata
confidentiality (invariant 12) is implemented. (Revisit discharged 2026-07-09
by inv-12 Stage 2: label metadata now has exactly one APPLICATION read
surface — the `inspectConfLabel` introspection builtin — and that surface
CONSUMES: its metadata observations enter the consumed set and the flow
derivation as an explicit `labelMetadata` observation class carrying §4.6.4.2
population-rule labels (runner `cfc/label-introspection.ts`,
`recordCfcLabelMetadataObservation`). Runtime-internal verifier reads —
including the raw `["cfc"]` reads the introspection evaluator itself issues
underneath — stay excluded from the consumed set and PC exactly as this entry
specifies; the exclusion is now a statement about VERIFIER reads only, no
longer about label metadata as such.)

**SC-7 [clarify] Pointwise precision by transaction decomposition — §8.9.1 and
§8.5.** §8.9.1's flow-precision claims assume one boundary observes the whole
collection op. A runtime that runs each element op in its own transaction
reading only that element gets pointwise output labels as a _structural fact_,
with no trust gate needed (the per-element journal simply doesn't contain the
other elements). State that decomposition is the preferred mechanism; trusted
claims exist for runtimes/ops that cannot decompose. Clarify what the
coordinator's own writes (container structure, membership, order, length) must
be tainted by — the container/enumeration observations plus any predicate
outputs it consumed (this also gives the §8.5.6.1 membership taint without
claims). Also note that dependency-structure assertions, if they return, are
expected to originate from static analysis earlier in the pipeline (§14.4.4)
rather than runtime schema metadata — the claim mechanism should not assume
schema embedding is the only carrier. (Implementation note 2026-06-10: claim
minting deleted from the list builtins; the schema key is reserved-and-tolerated
for already-persisted data. The coordinator-write taint is implemented as the
`structure` labelMap component: container nodes of pure-link-structure writes
carry the writing tx's J as exact-path shape labels — joined by reads at the
container path and by recursive ancestor reads, never by reads strictly below —
so the §8.5.6.1 membership/length channel is labeled while per-slot pointer
handling stays clean. Pointer identity at a slot, i.e. WHICH element sits
there observed without dereferencing, was an SC-4/SC-8 residual until
template-population Stage A: a standalone slot observation now consumes the
assignment `J` through the `*`-path `followRef` template — on declared
list-coordinator containers since Stage A, and on ALL pure-link containers
since the machinery-read marker landed (#4674; see the SC-8 note below).)

**SC-8 [normative] Read-API → observation-class mapping — §4.6.3.** The
primitive read profile defines `shape`/`value`/`enumerate`/`count`/ `followRef`,
but there's no mapping from a concrete runtime's read API to those classes.
Minimal needed now: reading an array whose items resolve to references _without
dereferencing_ consumes container enumeration + per-item shape only — not
element `value`. (This is what makes SC-7's coordinator taint well-defined.) A
fuller table can come with the observation-class implementation.
(Container-membership encoding residual, found 2026-07-06 during the C3
follow-up's spec ground-truthing: the spec encodes membership as per-child
`shape` entries plus container-level `iterate` (§8.5.6.1); the runner's
container-anchored structure stamp is an undefined compaction with a known
under-taint — a static per-child existence probe ("is `/items/3` present?")
is a `shape` read at the child (§8.10.1.1) and does not consume the
exact-path container stamp. The spec-conforming fix is per-slot shape
entries, at the per-row entry-count cost (#3998). **Closed by
template-population Stage A** (declared list-coordinator containers — the
actual §8.5.6.1 membership subjects) **and completed for ALL pure-link
containers by the machinery-read marker (#4674)**: runtime-minted `*`-path
per-class entries — O(1) per container where per-slot entries were O(n) —
make the per-child probe, the raw slot materialization, and the standalone
slot-pointer observation consume the membership/assignment `J`
([`cfc-template-population.md`](./cfc-template-population.md) §6 Stage A,
including the frozen-vs-membership join rule and the machinery boundaries).
The formerly remaining slice — generic pure-link value writes
(non-declared containers) kept the container-anchored compaction because
the runner's op-instantiation scaffolding read plumbing containers' child
paths with no distinguishing journal shape (measured re-smear on the
phase-B pointwise suite) — closed in #4674: those wiring reads now carry
the `machineryRead` marker (`reactivity-log.ts`, the
`schedulerDependencyRead` family) and skip `*`-template consumption in the
flow join only (every other consumption kept — byte-identical to their
pre-template behavior; the egress/observation-gate screens stay
over-inclusive), and the generic route mints the same three `*`-child
templates as the declared route. Existence-entry update discipline settled
as freeze-at-creation — spec §8.12.8, normative since the 2026-07-10 spec
landing (amended on branch `cfc/existence-freeze-at-creation`, mechanized
in `formal/Cfc/StoreExistence.lean`); the runner conforms including the
delete/re-create arm — re-creation REPLACES the frozen entry at the
re-creating attempt's join (`prepare.ts` re-mint-on-recreation; deletion
alone still leaves the entry as a fail-safe over-taint).)

(Design settled 2026-07-02, C0 #4476 + follow-up patches:
`docs/specs/cfc-observation-classes.md` — the §4 read-API → class table, the
§5 SC-4 grow-vs-replace split, the §3 `origin:"link"` ⇒ implicit
`observes:"followRef"` covering-rule carve-out, and `count` folding into
`enumerate`. The §4.6.3 spec table LANDED 2026-07-10 (specs 31220671: the
six-row normative mapping + count-folds MAY + the link-carve-out refinements;
75d97ec9 added the template-population conformance note + §8.12.8 rewrite);
file it once C1 validates the mapping in code.)

**SC-9 [normative] Staged conformance for the default transition — §8.9.3 or
§18.** §8.9.3 derives both confidentiality and integrity (TransformedBy +
hereditary meet). An implementation that derives confidentiality only and
attaches _no_ integrity to outputs under-claims integrity, which is sound
(fail-safe) but on its face non-conformant. Bless the staging:
confidentiality-join first; hereditary meet second; TransformedBy minting third
— with the invariant that no stage may _over_-claim integrity.

**SC-10 [registry] Propagation classes per atom — §15.** The hereditary meet
(§8.9.3, §3.1.6.2) needs `propagationClass(atomType)` to be normative data, but
§15 doesn't assign classes. Add a propagation-class column (hereditary |
value-bound | provenance/non-propagating) for every registered atom. Also
register the implementation's atoms that are missing entirely (`LinkReference`,
`PromptSlotInfluence`, caveat alias kind strings — already an audit hygiene
item).

**SC-11 [normative] Idempotent label persistence — §4.6.4.** Reactive runtimes
re-derive labels on every recompute; require that persisting an unchanged
effective label is a no-op (no envelope write, no version bump, no replication
traffic), with equality defined over the canonical form (§4.1.3 c14n). One
exception, taken once per document: a stored version-1 envelope is rewritten
in version 2 with unchanged labels by a writer selecting version 2
([content-addressed-cfc-labels.md](content-addressed-cfc-labels.md)), and
never the reverse. Without
this, label persistence and reactive scheduling interact pathologically.

**SC-12 [clarify] Degenerate CNF join — §8.9.3.** `concatClauses` over
all-singleton clauses is atom-set union; confirm that structural dedup of
identical clauses/atoms is conforming (the monotonicity section has the
all-singleton note, the join section doesn't).

**SC-13 [normative] Propagation dial × enforcement ladder — §18.** The runner
has enforcement modes (`disabled|observe|enforce-explicit|strict`, audit item
3.1) and S16 adds a propagation dial (`off|observe|persist`). Spec the matrix:
what each combination means, which combinations are conforming deployment
states, and the rollout ordering constraint (propagation-observe before
propagation-persist; persist before any enforcement that consumes derived
labels). `applied` — specs 9e0ecd9c (2026-07-10): new §18.6.3.1 with the
dial semantics as profile knobs, five ordering constraints (incl. the
one-hop laundering counterexample), the `enforce-strict` delta with the
SC-18b/c writer-fit reject + stable-reason contract, and the informative
progression table; §18.6.3's ladder bullets corrected (missing-policy is
pinned at explicit, not strict-only) and §18.6.4's checklist extended.

**SC-14 [clarify] Cross-space derived labels — §4.6.4.1 or §17.** Deriving J
from space-A reads and persisting it into a space-B document's envelope
discloses A-derived label metadata to B's readers. Until label-metadata
confidentiality (invariant 12) exists, note the exposure and that atom payloads
(e.g. `Caveat.source`) are the sensitive part.

**SC-15 [reconcile] §4.6.1 vs §8.9.3 integrity meet.** §4.6.1 (reactive
propagation) intersects _all_ integrity atoms; §8.9.3 (default transition) keeps
only the _hereditary_ subset of the intersection plus TransformedBy. Plain
intersection can carry a value-bound atom whose binding no longer holds (caught
later only by §8.10.4 binding checks, and only at boundaries that run them).
Make §4.6.1 class-aware to match §8.9.3/§3.1.6.2.

**SC-16 [normative] Default display-boundary release profile — §8.10.5 / §18.**
Owner direction (2026-06-10): rendering is the first label-gated egress, with a
default ceiling of roughly _acting-user identity atoms plus an allow-list of
caveat-kind confidentiality classes_, admitted by default and tightened over
time; author-supplied declassification on render boundaries is policy-gated (the
`renderDeclassificationPolicy` knob of PR #3994, end state = verified authority
only). The spec has display-sink boundary context (§8.10.5
`sinkClass: "display"`) and caveat discharge rules, but no notion of a _default_
release profile for display sinks when no policy is authored. Spec the profile:
which atom families a display sink admits by default (acting-user/audience
identity; enumerated caveat kinds whose display-stage discharge rules apply),
that everything else fails closed, and that the default may only be tightened,
not loosened, without a new release judgment (§8.10.5.2 audience-expansion logic
applies).

## Status: SC-1..SC-16 applied (2026-06-10)

Applied to `~/src/specs/cfc` by the spec/Lean session: prose commit `f4647273`,
Lean mechanization `ce595217` (StoreComponents: declared monotonicity under the
combined update rule, effective ≥ declared, ancestor derived-clears never bypass
declared, journaled reads stable under later derived writes; TriggerReads:
PC-with-triggers is a monotone strengthening; DegenerateJoin: all-singleton CNF
join = dedup union — all sorry-free, `lake build` green), correspondence-block
sync `6ac0060f`. SC-16 landed as new §8.10.6; SC-1 as §8.12.8 + §4.6.4
`LabelComponent`; SC-6/SC-13 as §18.6.1-3.

## New observations (from applying SC-1..16; re-scoped by the 2026-06-12
## verification sweep)

A targeted verification sweep (2026-06-12) checked each open item against the
spec as it stands after SC-1..16. Several were narrower than recorded — the
spec already had a position — and two acquired owner decisions. Status per
item below.

**SC-17 [reconcile → decided] `provenance` class × §8.4 exact copies —
provenance SURVIVES; nothing drops on a verified exact copy.** Verification
found this is not a gap but a conflict: §15.1.1 bars provenance atoms from
every carriage path ("**no** binding verification, projection scoping, or
endorsed transformer may carry them onto an output either") and §3.1.6.2's
output-integrity enumeration ("exactly" items 1–3) admits them nowhere, while
§8.4.2's verification pseudocode preserves the input path's integrity
**unfiltered** when `refer(input) == refer(output)`. Owner decision
(2026-06-12): §8.4.2 is right and the class machinery is overly cautious — a
runtime-verified exact copy preserves the **entire** integrity label, all
classes; the output IS the value the evidence attaches to, so there is
nothing for any class to lose. §15.1.1's bar is re-scoped to what its
rationale actually protects: **registry claims** (endorsed transformers,
projection scoping) may never claim preservation authority over provenance
evidence; runtime-**verified** identity transitions (pass-through §8.2, exact
copy §8.4) are not claims and carry everything. Edits: §3.1.6.2 gets a
lead-in stating verified pass-through/exact-copy preserve all input integrity
at the path, with the class rule applying to value-changing computations;
§15.1.1's "no … may carry" narrows to registry claims; check
`formal/Cfc/Proofs/PropagationClass.lean` for any lemma encoding the broader
bar and keep the correspondence note honest.

**SC-18 [normative] Writer-fit under derived labels — confidentiality
direction verified non-silent; integrity direction decided.** Verification:
the confidentiality side is already addressed. §8.12.4 states writer-fit
"remains an enforcement question against the declared policy" (a
non-rejecting deployment still persists the derived component; readers are
protected by the effective-label floor; "the derived component is a
measurement, not a write ceiling"), and §8.12.5 enumerates reject / upgrade /
new-store with upgrade blessed as monotone-safe. Genuinely open there: (a) no
standard profile picks a **default** the way §8.10.6 does for display; (b)
whether `enforce-strict` makes writer-fit itself reject — §18.6.3's
derived-consuming list names the display ceiling and missing-policy rules,
not writer-fit; (c) the rejection error contract and the audit/diagnostics
contract for persist-and-flag.

(b) and (c) are now **decided and landed (Epic H4 code step)**: the `canWrite`
confidentiality misfit — the per-tx flow join measured against the declared
store-policy component at each derived-stamp path — rejects at
`enforce-strict` only, and persists-and-flags (a
`writer-fit(persist-and-flag)` diagnostic carrying the identical reason
string) under every lower mode, with the stable SC-18c reason
`writer-fit confidentiality misfit for <doc> at /<path> (canWrite, §8.12.4):
<offending clauses>`. Contract text in
`docs/specs/cfc-enforcement-matrix.md` §4; implementation in
`prepareBoundaryCommit` (runner `cfc/prepare.ts`) sharing the egress gates'
clause-subsumption predicate; tests `cfc-writer-fit.test.ts`. Two items stay
open on the confidentiality side: (a) the standard-profile default, and (d)
the residency half of the write ceiling, recorded next.

The spec has since taken (b) and (c). §18.6.3 lists the writer-fit misfit
among `enforce-strict`'s strict-only rejects, and §18.6.3.1 carries the
bullet, the rule that an absent declaration is the empty ceiling and fails
closed, and the stable-reason requirement. What this entry still owes the
spec is the narrowings below. §18.6.3.1 states the measurement over its
targets with no exempt class named, and the addresses §18.6.2 excludes —
`/cfc/...` label metadata, `cid:`-addressed schema documents, program text —
do not reach them; that section is also where the shape belongs, since it
already calls its own exclusion "a profile decision, not a core-semantics
fact" and mirrors it to "the write-side rule that the same addresses are not
value-write targets".

One narrowing landed alongside: the measurement quantifies over paths a
schema could have declared a policy at, and the raw meta seam is not one.
`setMetaRaw` lands on a document-root sibling of `value` (`schema`,
`internal`, `patternIdentity`, and the rest of the `MetaField` union), which
no value schema describes. The seam is outside the check at every rung, so a
meta path raises neither a strict reject nor a persist-and-flag diagnostic.

A ceiling can still resolve at a meta path, from a document-root declared
entry by longest prefix, and that route is skipped too. The entry sits at
logical `[]`, the payload root, and reaches the seam only because
canonicalization strips a leading `value`. Honoring it would make a piece
updatable or not according to whether its pattern carries a root `ifc`.
Declaring on a single result field, which is how a pattern normally labels
one, leaves the seam's ceiling empty; the piece is then un-updatable under
strict, because the pattern updater, `setsrc`, and setup over an existing
piece all stamp meta.

Nothing is laundered. A path counts as meta only while no payload write
landed on it too, so a transaction writing both leaves the path measured; the
ancestor collapse runs over measured paths only, so an exempt meta path
cannot shadow a value write beneath it; meta paths remain flow-label targets,
so the join persists there and the egress, display, and observation gates
read the unchanged label; and the seam shares the document, space, and
replica set of the value surface beside it, so it reaches no further. The
residual is the shared namespace: where a payload field carries a `MetaField`
name, an exempt meta write can raise the stored derived label at their common
logical path past what that field declares. That is over-taint, so reads stay
protected, and giving the envelope seam its own path space is the fix. Shares
the meta-seam predicate with the schema write-policy requirement (#6077).

A second narrowing follows the same rule over a document rather than a path,
and covers two id classes.
A computed cell is the derived internal cell the runtime materializes to hold
a derivation's result, addressed under its own URI scheme
(`computed:fid1:<hash>`). No author declares a store policy on one — a
pattern names the data it declares policy on, and does not name the
intermediates the reactive graph materializes for it — so its ceiling is the
empty one, and measuring it refuses every derivation that reads labeled data
and writes its result. That is ordinary reactive computation, so the refusal
reaches product flows and not only tests.

A stream's entries document is the second id class the narrowing covers. It
holds a stream's durable event entries and the marks recording which have
been handled, at an id derived from the stream's link
(`STREAM_ENTRIES_DOC_PREFIX`) so that every party addresses the same document
with no coordination. No pattern names it and no value schema describes it,
so its ceiling is the empty one, and measuring it refuses every mark a served
run writes to record that it handled an event. Route 2 below is not open to
it: that route declares out of one piece's flow join and is keyed on that
piece's own nodes, while an entries document is keyed on the stream, is
written by every party that can reach the stream, and outlives all of them.

A third narrowing covers the program-text half of the §18.6.2 exclusion the
paragraph above names, and it is the one place where the shape the spec
states and the shape the runtime implements come apart. A compilation-cache
record holds one module for the compiler — the `cid:` document its bytes
live in, its import identities, and the predecessor identities its writer
authority descends from. The cache addresses it by the cause
`pattern:<identity>`, or `compileCache:<runtimeVersion>/<identity>` for the
compiled set, whose `<identity>` is the module's content-derived Merkle
identity; the entity id that cause mints is an ordinary `of:fid1:<hash>`. No
pattern names the record and the only schemas describing its fields are the
cache's own, which declare integrity alone. Because the id is that ordinary
shape, no predicate over id strings can recognize the class: the write side
names each document instead, under an authorized whole-document marker the
measurement reads off the transaction.

Where the two come apart is the write side. §18.6.2 mirrors its read
exclusion to "the write-side rule that the same addresses are not value-
write targets", which would leave a cache document unstamped as well as
unmeasured. The runtime keeps it as a stamp target and skips the ceiling
alone, which is what the two narrowings above do and what §4 of the
enforcement matrix states at length. Safety invariant 9 is what keeps the
stamp rather than a preference. The delegation metadata holds module
identities, and §17.7 says holding one grants no access to the artifact it
names, so the content written there is public. Which identity appears is the
other question: a transaction that read a labeled value and chose a
successor by it writes that choice into the record, and §8.11.3 puts a
decision's label on every downstream output whatever the output's own
content is. Unstamping the record would drop exactly that. The bytes are
unaffected either way, being in a `cid:` document that already takes
§18.6.2's route on both sides, so the divergence covers the compiler's
bookkeeping and nothing else. Its cost is that a later reader of that field
consumes the clause, which is a recorded residual rather than a claim that
the two shapes agree. For a join the target's own space produced the two
differ only in what is labeled: neither refuses. They part on a join that
drew a clause from elsewhere, which the skip is scoped away from, so the
implemented shape measures the cache write and can refuse it at strict where
§18.6.2's shape, having no write target there at all, would not.

Route 2 is not open to this class, on the keying ground an entries document
is off it for — a cache document is keyed on module content, every piece in
the space running that module addresses it, and it outlives all of them —
and on a second: route 2 leaves a `declared` entry per measured path, which
§8.12.1 does not let back, on a document nothing collects.

All three are outside the check at every rung, through the same
predicate the meta seam uses, and the skip is scoped to a join the target's
own space produced: the join records the space each contributing document
lived in, and a target whose join drew a clause from elsewhere is measured
like any other document. The residency half of the ceiling therefore still
holds for the direction it was written for, while work over its own space's
data proceeds — within one space a computed cell shares a replica set with
its source, and an entries document with the document holding its stream.

An enumeration is what this is, rather than a rule about documents the
runtime mints. The document anchoring splits out of a value has an id
derived from its parent's, which no author named either, and it is measured
— except where its parent is itself outside the check by the marker, which
carries down to it, because it holds part of the value the marker names. The
compilation cache reaches that carry today only through the general rule:
its own records are written raw, with their import edges inline, so the
cache itself anchors nothing.

Nothing is laundered here either. The join still lands on the exempt
document as its `derived` component, so a later read of it is tainted and a
later write of what it read misfits on the original clause. What the
exemption gives up is a refusal that was doing an egress gate's work by
accident: a value derived from labeled data now lands, and whether it may
LEAVE is the sink's question. Where the host is the one releasing — a tool
answering a model with the values a piece computed — there is no sink request
to record and no commit to gate, so the release is measured directly: read
what is about to be released through a transaction, and fit that
transaction's consumed join to the destination's ceiling, which for a model's
context is the empty one. What is released is a value. A reference the tool
hands back names the result without carrying it, so it is not measured, and a
refusal withholds the values while the reference goes out. `describeSinkReleaseRefusal` (runner `cfc/prepare.ts`) is that
measurement, and it shares `atomsOutsideCeiling` and the refusal-detail
construction with the in-commit sink gate, so a clause outside a ceiling on
one route is outside it on the other. Two differences are worth recording:
the host route measures what releasing the answer resolved rather than what a
whole transaction consumed, and it applies no exchange-rule rewriting, so it
refuses a clause a policy evaluation would have discharged. A residual stands where a declared entry did reach a
computed document, from a schema-carrying write: it stops being a write
ceiling there, and stays a read floor.

A fourth narrowing does not skip the measurement but answers it. The runtime
materializes documents to hold a piece's MACHINERY rather than data an author
named: a piece's argument, result and internal documents, minted by the runner
from the piece's result cause; the state documents a builtin mints from its own
node's cause; and the documents that anchoring splits out of a value written
into any of those. The atoms these carry are a property of the transaction that
filled them, so a declaration written into a schema either misses them or
over-declares every instance of the pattern. §8.12.5's route 2 is what the
runtime uses instead: the write that puts the join on a path also declares, in
that same transaction, a policy covering it — the ceiling that resolved at the
path plus exactly the clauses that had nowhere to go. The store's promise
becomes the audience of what it holds, rather than the check being skipped.

This is not a new route. §8.12.8's component table already names "explicit
store-label operations (upgrades per §8.12.5 …)" as a provenance of the
declared component, alongside schema `ifc` declarations — so a runtime-made
upgrade is a sanctioned way for that component to change, and §8.12.5 option 2
states the discipline: atomically tighten the store's label, then write. The
runtime declares in the transaction that writes, which is that atomicity.

What the widening adds is that the route runs on every write to such a store
rather than only while a piece is being set up, and what licenses that is a
property of the declaration rather than of when it is made. A declared clause
list is a ceiling under §8.12.4 — `canWrite` asks that the store's declared
confidentiality be at least as restrictive as the data's, which is `∃` a
declared clause subsuming each label clause — and it is the reader's floor
under the same section: a reader is tainted by at least the declared label, and
§8.12.8 makes reader taint consume the effective label, which always includes
the declared component. Subsumption makes the two agree: satisfying a declared
clause implies satisfying the label it admits, so every reader of the store
satisfies every clause the store admits. Each upgrade therefore admits more
data AND narrows the audience by the same step. An unbounded reactive stream of
upgrades leaves the store readable by fewer principals than it started with,
never by more, which is why the route needs no bound on how often it may fire
or on which clauses a later transaction may contribute. §8.12.5's own
soundness argument is the same one: existing readers already expect data at the
original label level.

The route adds CLAUSES and never alternatives, which is the line §8.12.7 and
safety invariant 1 draw. Adding a clause is the tightening §8.12.1 admits.
Adding an alternative to a clause already stored grows that clause's reader set
and is a widening, which those sections admit only through a grant record
consulted at access time or an intent-gated declassification event — neither of
which a write-side fit check is or could be. The mint folds clause LISTS, so a
stored disjunction comes back with the alternatives it went in with.

The cost is §8.12.2's ratchet: a store that once held data derived from a
labeled read keeps that clause after the read stops, which is the over-taint
direction. Its end state is a declared list whose clauses have disjoint
audiences, which no principal satisfies — the store keeps admitting writes and
stops being readable. §8.12.7 records that outcome for its own case as safe and
an operational footgun worth flagging in review, and the direction here is the
same: refusal, not disclosure.

The claim that a store is the runtime's is made by the runtime, never measured
from an input's own fields: the recording method is on the public transaction
interface, so a marker without the runtime's authorization names nothing, and
neither does one naming a store outside the owner's own space. It lasts for one
transaction where the store is minted and filled in one go, and is enrolled for
as long as the piece's nodes run where the store is written by the reactive
updates, event handlers and settled requests that follow the mint. Ownership
passes to an anchored child, whose id is derived from its parent's rather than
named by an author. A document nobody named is untouched: a write to an
ordinary document measures against its own ceiling whichever transaction makes
it, so widening the route in time does not widen it in scope.

Two costs sit outside the store, and both belong to the route rather than to
the widening. The declared list is a conjunction every reader carries, so a
store accumulating clauses with disjoint audiences ends up readable by nobody
while still admitting writes — §8.12.2's ratchet reaching its end, refusal
rather than disclosure. And a transaction that could not commit now commits, so
whatever else it staged proceeds: a post-commit effect, a sink request. A
builtin whose store moves onto the route therefore needs something else to
refuse its request, which is a `sink-request` ceiling where the builtin stages
one and nothing where it does not. Contract text in
`docs/specs/cfc-enforcement-matrix.md` §4; tests `cfc-writer-fit.test.ts`.

(d) **[normative] Residency fit — the ceiling a document carries by living
where it lives.** The fit measurement joins the target's declared policy with
one RESIDENCY clause, `Space(<the space the document resides in>)`. A flow
clause listing that space among its alternatives therefore fits the document
whatever it declares. The soundness argument is that writing into the space
the clause already names discloses nothing: the `Space` atom's audience is
that space's reader set — §4.9.3 resolves it by dereferencing its id against
the space's ACL, the same document that decides who receives a replica — so
every principal holding the target is inside the audience the alternative
names, and the write reaches no reader the data had not already reached. The
guarantee is therefore exactly as strong as the deployment's ACL posture, the
same bound the §4.9.3 membership lookup carries.

The rule is confined to `Space` deliberately, and for two different reasons.
`User(<subject>)` and the bare DID spelling name a person: a space grants
reader roles that person does not hold, so admitting them would place data
readable by one principal into a store its co-readers sync. That argument
does not reach `PersonalSpace(<owner>)`, which names a space rather than a
person (SC-39). What keeps that form out is narrower and mechanical: the
residency clause is built from the target's address alone — `Space(<the space
this document is stored in>)` — and the runtime cannot form
`PersonalSpace(<owner>)` from an address, because nothing marks a space as
personal (§3.6.4 has one stop being personal with no marker changing) or
names its owner without resolving its ACL. The clause is
unavailable rather than unsound. A deployment that did resolve ownership
could admit it on the same footing as `Space`, since the two atoms would then
name one space and so one audience; the limit is what the measurement can
construct, not what it may admit.

One spec question this exposes and should settle: §4.9.4 describes
`HasRole(user, PersonalSpace(User), reader)` as minted by a §4.9.3 point query
against that space's own ACL record, and calls it one of "the two `Space(...)`
atoms", which reads `PersonalSpace` as an ACL-dereferenced container atom. That
sits in tension with §3.6.4's fixed membership, and with a deployment
classification that commits the very field such a point query would have to
read. SC-39 settles it: §3.6.5 has a member added to a space gain access to
all data in it with no labels rewritten, so a personal space's audience grows
after the fact and the atom is an ACL-dereferenced container. The
fixed-membership reading recorded here is therefore wrong, and the rationale
above has been rewritten accordingly. Residency's behavior is unchanged, but
its ground moves: the atom stays out because the measurement cannot construct
it from an address, not because its audience is one person. Reading
back is unaffected in every case: the derived stamp persists the full join, so
the egress and display ceilings fit the unchanged label, and the space
principal there resolves to a reader only through the §4.3.3
`SpaceReaderAccess` exchange rule on verified `HasRole` membership. The
ungrantable read-failed marker stays outside the residency clause as it stays
outside every ceiling.

Spec home: §8.12.4's `canWrite`, alongside the declared-policy measurement.
Two points the spec should settle explicitly. Residency is a property of the
store rather than a carve-out for an atom family: a store satisfies a clause
whose audience already contains everyone the store's bytes reach. And
residency holds over a declared policy rather than only in its absence — a
declaration narrower than the physical audience of the space cannot be
enforced by the store anyway, and making residency a fallback would mean that
adding a narrow declaration newly breaks space-internal flows.

The **integrity direction** is genuinely unstated (§8.12.4's `canWrite`
checks confidentiality only; §8.10.3's `requiredIntegrity` is consume-side)
and is now decided (owner, 2026-06-12): the schema's `requiredIntegrity` is a
**floor**, typically a concept-level principal/pattern (e.g. "minted by a
valid GPS measurement"); a write conforms iff the value's integrity satisfies
the floor by pattern match / exchange-rule derivation — any concrete
measurement sits above the concept in the trust lattice and passes. Writes
**above** the floor are always acceptable; an overwrite is checked against
the **declared floor only**, never against the prior value's integrity —
sibling replacement (B not ≥ A, both ≥ floor) conforms, and **no meet across
successive writes** is taken (the derived integrity component is
replace-on-overwrite per §8.12.8). Also state the near-collision explicitly:
§8.12.1's store-label integrity rule ("can only remove atoms") governs the
declared label as a **claim** about contents; the `requiredIntegrity` floor
is a **requirement**, and tightening it is the restrictive (allowed)
direction — the two must not be conflated. Write-side floor checking needs a
home in §8.10 (today §8.10.3 is input/consume-side only).

The **integrity-direction code home is now landed (Epic D3, `verifyWriteFloor`
in `prepare.ts`)** behind the `cfcWriteFloor: off | observe | enforce` dial
(default `off`, orthogonal to the enforcement and flow dials). It tests the
**written value's** integrity — the schema-derived label (`addIntegrity` mints
+ `exactCopyOf` carry, evidence-gated by `gateRuntimeMintedIntegrity` so a
pattern cannot forge runtime-minted atoms to pass its own floor), each link
written at/under the path (the linked source's own label — the D2 by-reference
contract on the write side, one contribution per link so no laundering across
siblings), and the flow hereditary meet when flow labels persist — against the
floor with **exact-match** membership via the single shared predicate
`cfcIntegritySatisfiesFloor` (observation.ts), which the read-side gate and the
D2 tool-input floor now also call so D5's pattern/concept upgrade lands in one
place. SC-18's own semantics are honored: floor-is-a-minimum, overwrite checked
against the declared floor only (no meet across successive writes, no prior-
value consultation), and empty integrity on a floor-declaring path fails (a
stamped-`LlmDerived`-only value fails any floor by construction — closing the
write-side half of the vacuous pass). Wildcard (`*`) floor entries and
pattern-setup/seed initialization stay exempt (v1 scope); (a) the standard-
profile default and (c) the §8.10 spec home remain open — (b),
`enforce-strict` making writer-fit itself reject, landed with the H4 code
step (see the confidentiality paragraph above).

**SC-19 [clarify] Blanket "confidentiality always joins" dependency.**
Verified open (the rule is stated as fact in §15.1 and §3.1.2, nowhere
recorded as a revisit-trigger assumption). Record the assumption where the
rule is stated; one sentence.

**SC-20 [registry] `UserSurfaceInput` registry status.** Verified: §15.6
lists it in the explicitly non-normative example/extension table, classed
**value-bound** (`valueDigest`-bound), with no minting discipline — while the
implementation gates it in `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`. Promote to
a registered atom with its minting discipline (runtime-minted only), keeping
or justifying the value-bound class.

**SC-21 [normative] Read-classification markers — shrunk to a delta.**
Verification: §18.6.1–.2 already enumerate four exclusion classes
(verifier-internal reads, which "MUST be marked as such in the journal per
§8.10.1"; label-metadata reads at `/cfc/...`; program/source text;
content-addressed schema docs), state the default (everything else is
consumed), and flag the invariant-12 revisit; §4.6.3 has the
reference-without-dereference mapping and §8.9.2 makes trigger reads
normatively INCLUDED. Remaining delta: (a) the implementation's
`linkResolutionProbe` (coordinator link/slot scaffolding) and
`schedulerDependencyRead` (dependency seeding) are machinery but not
"verification machinery" — either generalize class 1 to runtime-internal
machinery reads or add them as named classes; (b) state explicitly that
markers are attachable only by runtime code, never pattern-controlled; (c)
state the asymmetry: over-exclusion is unsound (leak), under-exclusion merely
coarsens J.

**SC-22 [normative] Implementation identity = content hash of the code
artifact + symbol within it — §8.15.** §8.15.6 currently says "the handler's
identity (code hash) is the unit of write authorization—no separate naming
scheme is required" and leaves the hash target and rebinding semantics
undefined (audit 3.4). Owner decision (2026-06-12), matching the shipped
scheme (identity PRs E1–E4; `docs/specs/content-addressed-action-identity.md`
in the labs repo): implementation identity is the pair **(content hash of the
verified code artifact, symbol/binding path within it)**. Same artifact hash
+ same symbol = same identity wherever the artifact is loaded; any code
change changes the hash and with it every identity within the artifact.
Rebinding does not inherit authority by default. Two updates are the exception,
and derive the same delegation: an explicit `piece setsrc` update, and an
unattended update to a `system:` origin — a release the deployment gated
through its golden replays (owner decision 2026-09-17; an update to any other
origin inherits nothing, since nobody promised anything about what it ships).
In either, the new entry succeeds the old entry
outright, since the update is what names the pair, and every other module in
the old and new recursive closures matches by canonical filename — directly,
or under the root substitution the two entry names define when they share a
tail (the same authored tree served under `/api/patterns` and supplied from a
checkout under `/packages/patterns`) — persisting a cumulative
successor-to-predecessor delegation; an ambiguous match derives none.
`writeAuthorizedBy` accepts the current module hash or a predecessor reachable
through the delegation map authenticated in the target document's space, but
still requires the same symbol/binding path. A delegation loaded from another
space grants no authority. Source-file spelling remains diagnostic at
verification; whether `setsrc` derives a delegation for a module below the
entry is governed by canonical authored filenames under either root. Because
the delegation list is mutable and
outside the source Merkle identity, it is authority-bearing only when protected
by the compiler's integrity attestation (field-level in source documents,
root-level in compiled documents). Replace §8.15.6's "no separate naming
scheme" claim with the pair definition and this explicit delegation rule.

**SC-23 [interpretation] Per-write read-prefix provenance classed as
decomposition-grade precision — §8.9.1/§8.9.2 (Epic D4).** The runner's
input-requirement gate (`requiredIntegrity`/`maxConfidentiality` in
`verifyInputRequirements`) quantifies each protected write over the reads
whose activity-clock position precedes the LAST write attempt overlapping the
protected path (either prefix direction, matching floor applicability),
trigger reads joining every prefix at −∞. Interpretation call (owner note in
`cfc-write-prefix-provenance.md` §7.4): this is treated as a **structural
fact of the journal order in §8.9.1's decomposition class** — a read past the
last overlapping write provably did not feed the committed value — so it is
applied WITHOUT the `flow-taint-precision` trust gate; it is not an untrusted
`L_claim`. Two boundaries of the interpretation, both deliberate: (a) the
confidentiality **egress ceiling** stays transaction-global (a sink request
records no per-write provenance — §8.10); (b) the flow-label join `J(tx)` and
the D3 floor's flow-meet credit stay transaction-global too (one per-tx label
is load-bearing for stamp-collapse and persist-credit coherence); per-write
narrowing there needs per-path derived components first. The audit-#14
read-side vacuous pass resolves by DELEGATION: with an empty prefix the only
possible endorsement is the one the written value carries, which is exactly
the D3 write floor's check (§8.12.4.1) under its staged dial — an
unconditional read-side rejection would duplicate it under `enforce` and
break the pinned dial-off/observe byte-compat. If the spec wants the read
gate itself to reject empty-input floored writes independent of the floor
dial, that needs its own normative text + rollout dial. _Spec home landed:
specs#14 added §8.9.1.1 (journal-order structural precision — the prefix,
its bounds, trigger reads, digest binding), discharging the owed home; the
interpretation recorded here is now normative text._

**SC-24 [normative] Journal-order precision blessed; span-attributed
provenance profiled — §8.9.1.** SC-23's interpretation still has no spec home:
§8.9.1 names decomposition and trusted claims only, and nothing in the spec
mentions journal-order bounds. Proposed edit, two parts
([`cfc-value-level-provenance.md`](./cfc-value-level-provenance.md)): (1) a
normative paragraph sanctioning per-write gating over the last-overlapping-
write read prefix as structural precision (both prefix directions, trigger
reads at −∞, read|write interleaving digest-bound per §8.10.1) — the shipped
D4 mechanism; (2) a MAY profile for span-attributed provenance: runtime-
bracketed span tags on the activity record, per-write feeds-closure over
observed span edges, sound only where the executor structurally enforces span
non-interference — interpreter-class executors under §18.7-style obligations
(specs#11); sandboxed executors under the **instance rule** (the span is the
executor instance: executions sharing a live user-code instance share one
span; per-run instantiation recovers per-run spans) plus SES-closed
cross-instance channels and a commit-time observed-vs-attributed consistency
check — **no trusted static analysis assumed anywhere**; violations surface
as late errors (prefix fallback / commit rejection), never unsoundness. Bare
opaque handlers stay at the prefix; the §8.9.1 `flow-taint-precision` gate
remains only for semantic claims beyond runtime structure. States that the
egress ceiling / flow join / floor credit MAY upgrade from transaction-global
where the profile is enforced (upgrades SC-23's boundaries (a)/(b) from
deliberate to staged). `applied` — specs#14 (2026-07-09): part (1) as
§8.9.1.1, part (2) as the §8.9.1.2 span-attributed provenance profile
(executor classes incl. the instance rule, late-error framing, digest
discipline, predictions-never-narrow). Runner-side stage 0 (precision
counters) shipped as labs#4623; span machinery remains behind the
entry criteria in `cfc-value-level-provenance.md`.

**SC-25 [normative] Cross-space label-metadata representation classes —
§4.6.4.1/§4.6.4.2 (inv-12; supersedes SC-14's posture).** §4.6.4.1's
known-exposure paragraph is posture ("MUST treat persisted label metadata as
visible … SHOULD prefer atom forms"); the enforcement design
([`cfc-label-metadata-confidentiality.md`](./cfc-label-metadata-confidentiality.md))
needs it normative: cross-space persistence of source-bearing atom fields
follows a classification-governed representation — `public` / `commitment`
(canonical digest, equality-preserving, honestly probe-able) / `reference`
(source-space back-reference; resolution rides the source's read authority;
failure collapses to `notAvailable`) — applied identically to envelope
entries and sigil-carried label views, with same-form matching semantics.
Initial-assignment exception to record: `Space.id` in confidentiality clauses
stays `public` because §4.9.3's ACL point query must dereference it. Also:
§4.6.4.2 gains the interim population rule (source-identity confidentiality
when known; else, for **derived-component** entries only, the entry's own
effective confidentiality — sound because the §8.9.2 conservative join
contains each influencing source's confidentiality; else fail closed —
computable without new persisted metadata), and SC-6's "revisit when
invariant 12 is implemented" note is discharged by the introspection-surface
observation channel. `applied` — specs#14 (2026-07-09): the §4.6.4.1
known-exposure paragraph upgraded to the normative representation rule
(public/commitment/reference, same-form matching, `notAvailable` collapse)
and §4.6.4.2 gained the derived-component interim fallback. Runner-side:
stage 0 shipped as labs#4624 (seam close, persist re-derivation, sigil
redaction, classification table), stage 1 as labs#4638
(`cfcLabelMetadataProtection` dial, `{digestOf}` commitment transform,
commitment-aware matching), stage 2 as labs#4657
(`inspectConfLabel` builtin + §4.6.4.2 interim population rule +
`labelMetadata` observation channel — the SC-6 revisit discharged)
completed by template-population Stage B (labs#4660): the full per-field
§4.6.4.2 profile persists as multi-`*` templates under `/cfc/labels/...`
(`origin:"label-metadata"`, `observes:"labelMetadata"` — no payload read
class consumes them), minted at the persist seam from each source-bearing
derived-containment payload entry, resolved by `inspectConfLabel` at
concrete clause/alternative metadata paths with the interim rule staying
the label source and the in-hand computation the fallback on template-less
envelopes ([`cfc-template-population.md`](./cfc-template-population.md)
§5/§6 Stage B note); stage 3 remains per the design doc.

**SC-26 [reconcile] §8.12.7 route 2 conflates grant records with the rewrite
event — §8.12.7/§13.4.3.** Route 2's cited shape (§13.4.3) persists a
ShareGrant consulted at access time — a durable *input* to route-1 evaluation
— while route 2's text describes an in-place store-label rewrite (durable
*output*); the §13 summary table says "persistent policy state / label
rewrite" as if one thing. Proposed edit
([`cfc-persisted-declassification.md`](./cfc-persisted-declassification.md)):
split into 2a (grant records: reserved-path, trusted-writer,
content-addressed, fail-closed point-query resolution per §4.9.3, consumed
via a `policyState` exchange-rule guard kind, revocable, digest-bound into
the evaluation) and 2b (the rewrite event proper: intent-gated per §6.5 +
§3.8.4, authority-verified per §8.10.5.2, requires a declared-component
monotonicity gate to exist first, event record = a create-only document
causal to the consumed intent's id — the shipped `commitPreconditions`
receipt discipline — with canonical clause-digest identity, outside the
churn-free envelope). Guidance refines to:
2a when revocable or policy-derived; 2b only when the widening must survive
without evaluation (export/publish). Unconflate the §13 table row.
`applied` — specs#14 (2026-07-09): §8.12.7 route 2 split into 2a/2b with the
2b contract (including the create-only intent-causal record shape) and the
§13 summary-table row unconflated. Runner-side: grants build-order items 1–3
shipped as labs#4627 (`policyState` guards, owner-space `grant:cfc:` records,
consulted-grant digest binding); the rewrite event is **superseded** per
`cfc-persisted-declassification.md` §5 (owner decision 2026-07-10: in-fabric
federation trust comes from remote attestation, so trust-free release buys
nothing; out-of-fabric irrevocability is served by egress records, SC-27).

**SC-27 [normative] Egress records at send sinks — §8.10.5.2 follow-up.**
Out-of-fabric egress is irrevocable; modeling it with the same revocable
artifact as internal sharing invites the un-sending confusion (revoking the
record of a send is not un-sending). Proposed edit
([`cfc-persisted-declassification.md`](./cfc-persisted-declassification.md)
§6): the permanent **sent** record is minted by the successful post-commit
send path (the transaction commits before the outbox flush, and the release
can still be refused during the flush — a commit-time record would assert
disclosures that never happened): a create-only record causal to the outbox
idempotency key — `{valueDigest, destination, boundaryContext,
releasedAudienceEvidence, at, intentId}`, destination per the §8.10.5.2
destination/audience binding (discharging the audit's open
"destination-binding follow-up"), written record-then-clear against the
outbox entry so the record can understate but never overstate; an optional
commit-time attempt marker MUST NOT display as sent. Spec this together
with the audit's open "post-commit outbox + sink-release re-verification
contract" item (§8.10 is entirely pre-commit today).
The record is permanent (create-only, never deleted, no revocation surface)
and has **no enforcement role**: it never feeds a future release decision —
labels keep governing what the fabric serves; the record exists for honesty,
audit, and deriving "who could have this" (current grants ∪ past egress).
State the shared-vs-sent vocabulary distinction normatively so UIs cannot
present an egress as revocable. `applied` — specs b020ea87 (2026-07-10):
new §8.10.7 with the post-commit re-verification contract (discharging the
audit-3.11 queue item), sent-record-on-successful-send, record-then-clear,
attempt-markers-never-sent, no-enforcement-role, and the normative
shared-vs-sent vocabulary; §8.10.5.2 links the record as durable
destination-binding evidence. Runner build remains open (the SC-27 build
item).

**SC-28 [normative] Attested deployment config is a federation-sound policy
store; space-hosted policy documents descoped — §4.4.1/§4.4.5/§5.7.2.** The
archived B2b plan (`docs/history/plans/cfc-future-work-implementation.md`
§3, decision 2) treated `RuntimeOptions.cfcPolicyRecords` as an interim
source because two federated instances with different deployment config
would silently fire different exchange rules, and scheduled space-hosted
policy docs as the federation-correct form — restated as recently as the
SC-14 Stage-3 federation constraint ("B2a's deployment-config policy source
is federation-hostile"). Revised owner decision (2026-07-10, extending the
same day's federation resolution — SC-26's superseded note, SC-27): remote
attestation covers deployment config for security-sensitive inputs like
`cfcPolicyRecords` — the §5.7.2 runtime-environment claims extend to the
enforcement configuration the runtime boots with (measured image identity
covers it) — so attested federated peers provably evaluate the same record
set, and space-hosted policy documents are not needed for federation
soundness (the Stage-3 note's conclusion is superseded in place; its
*evidence replicates, evaluation is local* rule stands — config rides the
attested evaluator, not the data). Proposed edit:
§4.4.1's storage-location list gains the attested deployment/system policy
root as a sanctioned primary store (space-hosted discovery stays optional,
never required for federation); §4.4.5 adds the CT-1874/SP-1 constraint —
rules a label-carried `Policy(...)`/`Context(...)` principal brings into
scope may rewrite ONLY that principal's home clause(s), the mechanical form
of §5.3.3's clause-local declassification authority (§4.4.5's informative
pseudocode selects target clauses purely by pattern match and would
otherwise let a policy referenced in clause k widen sibling clause j: a
cross-principal implicit release, invariant 11/§3.1.8(3)). Runner-side,
labs#4652: the surviving non-storage half of B2b
shipped against the deployment snapshot — `PolicyRecord.selection:
"ambient" | "referenced"` (`policy.ts`, digest projection v3), hash-bound
fail-closed ref matching per §4.4.2/§4.4.3, the home-clause gate with
per-batch recomputation (`exchange-eval.ts`), and inv-12 representation
rows for the ref atom's fields (name/hash public, subject commitment);
grants (labs#4627) remain the one space-hosted policy state. `applied` —
specs a788e3aa (2026-07-10): §4.4.1 attested deployment/system policy root,
§4.4.5 home-clause locality for label-carried refs (CT-1874/SP-1), §5.7.2
attestation-measures-config conformance sentence. Also landed same day:
§4.3.5 grant records + policyState guards + single-use semantics (9f334163,
0b970117) and the §6.8 grantConsumed row.

## Queue (from the audit; statuses re-checked by the 2026-06-12 sweep where
## noted)

These were identified during the audit as spec-absent implementation mechanisms
that should become normative text once their design sessions happen; listed so
this file is the single tracking place:

- Enforcement-mode ladder semantics incl. `enforce-strict` (audit 3.1 —
  partially covered by SC-13; the writer-fit remainder is SC-18 (a)–(c)).
- Setup-projection structural provenance carve-out (audit 3.3). Not
  re-verified.
- ~~Implementation-identity scheme (audit 3.4)~~ — superseded by **SC-22**
  (decided: artifact content hash + symbol).
- `ownerPrincipal` / `__ctCurrentPrincipal` + companion-claim chain (audit
  3.5). **Verified silent** 2026-06-12: no principal-resolution chain in §6 or
  §8.15 — confirmed open.
- ~~`addIntegrity` annotation (audit 3.6)~~ — **verified: spec already
  explicit.** §8.8/§8.7.3 define `addedIntegrity` with semantics (transformer-
  minted output atoms, boundary-verified). The remaining work is
  **implementation conformance**, not spec text: the code's `addIntegrity`
  spelling and the schema-merge path that silently drops the annotation need
  to align with the spec's name and honor it (or visibly reject it).
- Claim-only labelMap entries as policy-applicability markers (audit 3.7 —
  partially covered by SC-1's component model). Not re-verified.
- Carried label views / dereference-trace merging / `LinkReference` atom (audit
  3.8 — atom registration covered by SC-10). Not re-verified.
- uiContract trusted-event system as normative (audit 3.9). Not re-verified.
- Schema-merge per-key direction table (audit 3.10). **Verified silent**
  2026-06-12: §4.2.2.1 covers schema evolution, not per-key conflict
  resolution between composed schemas' IFC annotations — confirmed open.
- ~~Post-commit outbox + sink-release re-verification contract (audit
  3.11)~~ — **discharged 2026-07-10** by the new §8.10.7 (specs b020ea87):
  the flush re-verifies the release decision's bindings before sending
  (the §8.10.1 conformance shape shifted post-commit); egress records ride
  the same section (SC-27).
- Schema-sanitization / contamination scoping promotion from ch. 14 to
  normative (audit 3.12). Not re-verified.
- ~~`/value` envelope-prefix wire-format decision (audit Wave 4 #28)~~ —
  **verified: decided by the spec.** §4.6.4/§4.6.5 normatively require the
  `/value` envelope prefix for persisted payload labels and value-relative
  normalization before IFC matching. Remaining work is **implementation
  conformance** (or documenting equivalence), not a decision.

## Also noted by the sweep (not previously tracked)

- §8.10.6 already specifies the display-ceiling atom families exactly
  (`User(actingUser)` + `PersonalSpace`/`Space`-with-`HasRole` principal forms
  resolved by exchange rules, plus the deployment-declared caveat-kind
  allow-list seeded from influence-class kinds). The shell ceiling flip is
  therefore **implementation alignment** — the runner's render-gate atom
  vocabulary does not currently use the §15.2 shapes, and the
  exchange-rule resolution step does not exist in the reconciler — not an
  atom-shape design question.
- §8.12.8 already documents the observation-class residuals (existence
  channel; pointer-identity-at-a-slot) as profile residuals with
  `PathLabelTemplate` named as the fix; the open part of that build is the
  envelope persistence/population design, tracked with SC-4/SC-8 — **design
  settled 2026-07-10 in
  [`cfc-template-population.md`](./cfc-template-population.md)**:
  runtime-minted `*`-path per-class entries (the existing declared-`*`
  entry form; no new wire shape), closing both SC-8 under-taints in Stage
  A and carrying Stage-2 full metadata population in Stage B. **Stage A
  landed** (declared list-coordinator containers), and the generic
  pure-link-write slice **closed in #4674** via the machinery-read marker
  — see the SC-8 note and the design's §6 implementation note.

## From the exchange-rules pattern-authoring design (2026-07-11)

Companion design: [`cfc-exchange-rules-authoring.md`](./cfc-exchange-rules-authoring.md).
Critical review and dependency-ordered implementation work:
[`cfc-exchange-rule-authoring.md`](../plans/cfc-exchange-rule-authoring.md).
All `open`; Stage 0 of that plan records corrections required before these
items become implementation contracts.

**SC-29 [normative] Module-identity-addressed policy references — §4.4.2 +
§15.3.** Policy principals today are `{name, subject, hash}` with a
name→hash discovery step (§4.4.1). For rule sets declared in authored modules,
the reference should carry the SC-22 identity pair —
`{module identity, symbol}` (content-addressed module identity + exported name)
— plus a canonical `policyDigest` and concrete `subject`. The pair names the
defining source export. The digest is canonical `hashStringOf` over `{ domain:
"cfc/policy-manifest/v1", manifest: {formatVersion, moduleIdentity, symbol,
template} }`; an envelope may repeat the digest but excludes
it from its own hash projection.
The subject is bound relative to each invoking piece. A trusted compiler or
verifier must attest the source-closure→export→manifest lowering; checking the
digest alone proves byte integrity, not that derivation. No space may commit a
persisted reference unless it already has, or atomically creates, a verified
local manifest copy, so later evaluation is no less durable than that space and
does not require retaining the defining source closure. Source-closure changes
create a new pair and, because the pair is in the manifest body, a new digest
for future labels; existing labels keep their old tuple until explicit §4.4.4
migration. The subject-independent digest plus the label subject is a new
module-policy binding form that §4.4.2/§4.4.3 must define explicitly. Proposed
edit: add it to §4.4.2 and the §15.3 table alongside the name-addressed form,
define trusted derivation, local verification/retention, and commitment-aware
subject instantiation, and state that home-clause locality (§4.4.5) and
clause-local authority (§5.3.3) apply identically.

**SC-30 [normative] Concept-scoped owner policy records (user defaults) —
§4.3/§4.4.1 + new §13 worked example.** Define the indirect-raise mechanism:
a **concept id** (well-known URI per §4.8.1/§5.7.1, or `{identity, symbol}`
per SC-29) crossed with an **owner subject** selects the owner's policy record
for that concept — the home of user default policies. Normative content
needed: (a) atom shape — extend `Context` with a `concept` field (or a
sibling atom; decide), keyed `(concept, subject)`; (b) the
**stable-kernel-plus-grants** profile: the record is a hash-stable kernel of
generic grant-guarded rules; user defaults are §4.3.5 grant records (reserved
kind `ConceptGrant {concept, owner, audience, requiredIntent, expires?,
singleUse?}`) so default edits are grant CRUD (no label migration), revocation
is grant deletion, one-shot release rides single-use grants; (c) bootstrap —
raising to an unconfigured concept resolves the substrate-shipped kernel
(covered by attested deployment configuration, SC-28) with zero grants:
owner-only until granted. This discharges the open questions recorded in
`notes/WORKING_GOVERNANCE_EXAMPLES.md` (how "Alice's medical policy at the
time" is represented; what changes automatically for future vs existing data).
Runtime prerequisites already shipped: grant records with `policyState`
guards, reserved-path storage and single-use commit-precondition receipts
(`packages/runner/src/cfc/grants.ts`, #4627/#4649), and label-carried
`referenced` record selection with home-clause locality (CT-1874, #4652) —
SC-30 is the spec-side profile plus the reserved grant kind.

**SC-31 [registry] `ConsumerIntent` integrity atom — §15.** Runtime-minted
evidence that a consuming pattern's module statically declares an intent for
what flows in (`{intent, surface, pattern}`); matched by concept-kernel grant
rules' `requiredIntent`. Evidence, not authorable in schemas — same posture
as `UserSurfaceInput`/`LlmDerived`. Needs a registry row and a minting rule.

**SC-32 [clarify] Concept identity coordination — §4.8.1 + §5.7.1.** State
that concept ids have exactly two forms — well-known URIs (ecosystem
coordination) and module-relative `{identity, symbol}` (no registration;
globally referencable once deployed, resolvable via `cf:` imports per the
labs pattern-imports design) — and that bare string names are not a
coordination form. Note the same concept id may appear in confidentiality
position (context principal selecting an owner's record, SC-30), in integrity
guards (trust-closure satisfaction, §4.8.9), and in caveat kinds; position
selects the machinery. §5.7.1's "public concept directory" should say who
mints well-known URIs or point to the process.

**SC-33 [normative] Adoption paths for third-party-authored rules — new §13
worked example.** Publishing a pattern that declares exchange rules is not
adoption. Enumerate the three adoption paths and their evidence: (a)
**instantiation** — owner instantiates the pattern; its rules govern only
clauses the pattern itself raises (authoring authority bound; conjunctive-join
rule); (b) **grant** — owner accepts a standing concept default via the
trusted review surface: state-scoped intent → trusted policy writer → grant
record (§13.4.3 + §4.3.5 write gate); (c) **verifier trust statement**
(§4.8.2) for concept-guard satisfaction. Add the parameter-integrity rule:
the policy writer MUST source grant parameters (audience, requiredIntent,
expiry) from endorsed intent evidence minted at the review surface, never
from the proposing pattern's data — this is §3.8.4 applied to adoption, and
it is what makes "propose" safe as a pure out-of-code workflow.

**SC-34 [normative] Bulk migration for concept kernels — §4.4.4.** §4.4.4
defines per-label migration only. Grants make kernel changes rare, not never
(kernel bugs, new guard families). Define the owner-initiated sweep: re-pin
every value carrying `(concept, owner)` from kernel hash A to B, as an
intent-gated batch declassification event with an auditable record (the
§8.12.7 route-2b shape, batched).

**SC-35 [clarify] Grant-set recombination — §14.3.2 pointer from SC-30.**
Multiple grants on one concept are multiple declassification paths; the
§14.3.2 recombination attack applies directly to user defaults. No mechanism
proposed; require that owner-facing surfaces can enumerate a concept's active
grants (the precondition for any future budget mechanism) and cross-reference
§14.3.2 from the SC-30 text.

**SC-36 [normative] Pattern-requested execution-policy envelopes — §5.5.2.**
§5.5.2 says patterns don't request certification — it's a consequence of the
execution environment — but never says how a pattern comes to execute under
policy P in the first place. Add the request surface: a pattern MAY declare an
execution-policy envelope (by policy reference, SC-29 pair form); the runtime
either enforces P for that pattern's execution (outputs then gain
`PolicyCertified(P)` exactly as §5.5.2 already specifies) or refuses to run
the pattern — never runs it unenforced. State the monotonicity: a
pattern-requested envelope can only constrain its own execution; it adds no
authority, and the attestation remains runtime-minted (§5.5.7's trust model
unchanged). Authoring sketch:
`cfc-exchange-rules-authoring-extensions.md` §5.

**SC-37 [registry] Reserved `ConsentEvidence` integrity family — §5.3.4 +
§15.** §5.3.4 requires consent evidence to "bind scope, audience, and purpose
strongly enough that the shared-result rewrite is clause-local and
reviewable," while deliberately not privileging a payload. Reserve the family
shape so profiles interoperate: `ConsentEvidence {participant, scope,
audience, purpose, expires?}`, minted only by trusted consent surfaces (the
§13.4.3 state-scoped-intent shape per participant), matched per participant
clause by ordinary rules (each participant's evidence rewrites only that
participant's clause; the multi-party conjunction dissolves exactly when all
are present — §5.3.3 stated operationally). Registry row + a note in §5.3.4
pointing at the reserved shape. Authoring sketch:
`cfc-exchange-rules-authoring-extensions.md` §4.

## From the served-execution attribution build (OW34-family, RULED 2026-08-21)

Design of record:
`docs/history/plans/server-execution-v2/optimize/ow34-attribution-design.md`.
The serving-side binding sentence lives in
`docs/specs/server-side-execution/serving-loop.md` §3c; the coverage row is
verification-coverage.md OW59.

**SC-38 [normative] The current-principal family's served-execution reading
— the audit-3.5 principal-resolution chain (§6/§8.15).** `open`. The
`__ctCurrentPrincipal` placeholder (authored-by / represents-principal /
`ownerPrincipal` subjects) resolves at commit-prep against the transaction's
trust snapshot, and under served execution that snapshot is PER-RUN: it
carries the run's acting principal — the event's server-stamped actor, the
demanded instance's principal, or the delegated carriage's actor — never the
serving runtime's ambient service identity. The resolved labels are
indistinguishable from the same run's client-side mint (no served-provenance
mark; the memory plane already records the delegation per commit via
`acting_principal` + `capabilityRef`). A run with no acting principal keeps
the ambient service snapshot. Literal-DID current-principal subjects stay
refused at authoring; the only path to a user-named label remains a run
actually carrying that user's acting identity. Proposed edit: when the
audit-3.5 chain is written into §6/§8.15, state the snapshot's per-run
binding and the acting-principal resolution as the normative reading for
serving hosts, citing serving-loop.md §3c.

## From the strict-defaults prerequisites (2026-08-31)

**SC-39 [normative] A personal space's owner is one of its readers —
§8.12.1's `atomLe`.** `open`. §8.12.1 defines the alternative-level relation
`atomLe` as structural equality for every atom type but `Expires`, and
§8.12.4's `canWrite` restates it that way. Under that relation a store
declaring `User(P)` refuses a value labeled `PersonalSpace(P)`, even though
P is an owner of that space and therefore one of its readers. Under
`enforce-strict` that is a refused write. The runtime adds one case to the
relation, on the LABEL side only: a `PersonalSpace(owner)` alternative also
answers a ceiling alternative naming that owner.

The criterion is the one §8.12.1 gives for `atomLe` itself — satisfying the
more restrictive side implies satisfying the other. The guarantee comes from
the role order rather than from any ACL configuration: §3.6.2 states `owner
⊃ writer ⊃ reader` — "owners are implicitly writers; writers are implicitly
readers" — and §3.6.4 makes the named principal the space's sole owner, so
that principal is one of its readers normatively. A ceiling whose audience
is that owner is therefore inside the label's audience however the
membership has since changed, which is the containment the fit test asks
for. Grounding this in §3.6.4's `readers: {Alice}` would not do: that is a
starting configuration, and this entry declines to treat it as an invariant
when it refuses the reverse rule.

The reverse does not hold, and the reverse is the tempting rule. A ceiling
declaring `PersonalSpace(P)` would have to be read by P ALONE for it to admit
a `User(P)` label. §3.6.4's fixed membership does not deliver that, and the
reason is not that a personal space's membership grows — its own sharing
bullet has adding a member CONVERT the space into a shared one, so
membership is fixed exactly as long as the space stays personal. What
defeats the one-person reading is that the label outlives the conversion:
§3.6.5 rewrites **no labels** when a member is added, so a
`PersonalSpace(P)` clause stamped beforehand goes on naming a space that has
stopped being personal. §4.9.4 agrees
from the other side: it generates `HasRole(user, PersonalSpace(User), reader)`
by a §4.9.3 point query against that space's own ACL record and calls the
form one of "the two `Space(...)` atoms", and §15.2 and §4.1.2 both call it a
convenience form for a per-user space principal. A store declaring it would
take data labeled for the owner alone and replicate it to a member added
later.

This corrects the framing SC-18(d) recorded. That note treated §3.6.4's fixed
membership and §4.9.4's point query as an unsettled tension and took the
fixed-membership reading as the fail-closed one. The tension dissolves rather
than resolving against §3.6.4: membership is fixed while the space is
personal, adding a member converts it, and §3.6.5 rewrites no labels when it
does — so a stamped clause outlives the conversion and the atom is an
ACL-dereferenced container. That leaves SC-18(d)'s behavior intact but
replaces its reason. Residency excludes the atom because its clause is built
from the target's address and nothing there names a space's owner or marks it
as personal — not because the atom names one principal, which it does not.
SC-18(d)'s rationale is rewritten there to say so.

`Space(id)` gains no case. §15.2 derives its access through verified `HasRole`
exchange, which the fit kernel cannot run, and SC-18(d) already joins
`Space(<the space the document resides in>)` onto every document's write
ceiling, so covering it here would admit a person's data into every store in
that space.

The bare DID string gains no case either, and the runtime's use of one should
be retired rather than taught. §4.1.1 states that an atom is "not a simple
string but a structured value with a type and parameters", and §15.2 lists no
string form. The shell's default display ceiling nonetheless carries a raw
acting-user DID beside `User` and `PersonalSpace`; §8.10.6's illustrative
profile lists only the latter two, and its tighten-only rule forbids
admitting an additional atom family without a release judgment. That entry is
a pre-existing loosening and wants removing, not generalizing.

Only canonical shapes participate, the discipline §8.12.1 already applies to
`Expires`: a two-field `PersonalSpace` whose `owner` is a plaintext DID or
its §4.6.4.1 `{digestOf}` commitment. A record carrying further fields is not
the atom it resembles. The owner value carries across untouched, so a
committed field still meets its plaintext twin under the same-form
comparison.

Clause IDENTITY is untouched: `clausesEqual`, the canonical clause digest,
and the ceiling meet all still tell the two atoms apart, so a
mutually-subsuming pair can carry different digests. Every place that shows
is fail-closed — a §8.12.7 route-2b exemption naming one does not exempt the
other, and a meet keeps both alternatives rather than collapsing them.

Spec home: §8.12.1's `atomLe`, with the restatement in §8.12.4's `canWrite`
comment following it. Three points the spec should settle. Whether the case
belongs in `atomLe` or in a normalization ahead of it — the runtime takes the
second, so the relation keeps its "equality except `Expires`" shape and the
integrity floor, which shares the relation, is untouched. Whether the
one-sided form is permanent, which turns on whether a `PersonalSpace` clause
may outlive its space's conversion at all: if §3.6.4's conversion re-spelled
the clause, or §3.6.5 rewrote it, the atom's audience would stay its owner's
and the relation could be symmetric. And whether a §4.6.4.1 commitment should
carry its field's type. It does not today, so a well-formedness test on a
committed field is unenforceable — the plaintext arm of this rule rejects a
malformed owner and the committed arm cannot, which is a general property of
every check that validates a commitment-classified field rather than
something particular to this one.

## From the redundant-entry collapse (2026-09-01)

**SC-40 [editorial] The redundant-entry collapse spans components —
§4.6.4.** `open`. §4.6.4's idempotent-label-persistence paragraph closes
with a redundancy rule: "A derived-component entry whose label equals the
effective label of its parent entry for the same component is redundant and
SHOULD be dropped at persist time." The qualifier bounds the rule to an
ancestor of the entry's own component. The runner drops a per-value entry
whose clauses the DECLARED component already carries at that path, which the
sentence does not describe.

Three parts of the specification make the broader rule sound, and the entry
proposes writing them into the sentence rather than leaving an
implementation to assemble them. §8.12.8 makes the effective label at a path
the join of the components present there, and that join is a clause union.
§8.11.4 stores content and flow clauses in one array and does not track them
apart at runtime, so a clause is the same clause whichever component supplies
it. §10's compact observer model states that boundary noninterference is
"not about forcing hidden clauses to be literally identical", and that a
label map reached outside the first-layer introspection API is an
"enforcement and proof/model artifact, not a public raw-label surface".
§4.6.4's own operational guidance already permits avoiding a redundant stored
template "as long as effective observation labels computed at boundaries are
identical", which is the test the broader rule meets.

The supplying component's update discipline is the part that has to be said
out loud. A declared entry may supply the cover because §8.12.1 forbids it to
shrink, so a clause it carries today it carries tomorrow. A link-carried
entry may not: §8.12.8 has it replaced when the reference at the path is
rewritten, which would take the covered clauses with it and leave nothing
stating them.

One boundary-visible difference follows from the drop rather than from the
rule. §4.6.4.2 has metadata population fail closed for a declared entry —
"This interim does not extend to declared or authored entries" — so a path
left carrying its declaration alone reports its atoms' source-bearing fields
as unobservable, where the derived entry that was dropped supplied them the
interim label. That is §4.6.4.2's own treatment of a declared-only path,
reached by removing an entry rather than by changing what any entry means.

Proposed edit: restate the redundancy sentence over the effective label
rather than over one component. A per-value entry whose clauses the
components present at its path already carry is redundant and SHOULD be
dropped at persist time, provided every supplying component's discipline
forbids it to lower them — which admits the declared component and excludes
the link-carried one. Name the observation-class axis in the same breath: the
cover has to hold under each read class that consumes the entry, since a
class-scoped declared entry can shadow a covering one for some classes and
not others.

## From the write-path self-read exclusion (2026-09-15)

**SC-41 [normative] A write path's read of its own destination is a
runtime-internal read — §18.6.2.** §18.6.2 derives two things from the
attempt's journal minus runtime-internal reads: the consumed set, and the
conservative flow-path confidentiality. This entry proposes a fifth kind of
runtime-internal read, and the runner subtracts it from the second alone —
the boundary at the end of this entry says so, and a runtime that adopts the
amended list owes either the wider application or that boundary stated.
§18.6.2 enumerates four kinds today: verifier-internal reads,
label-metadata reads at the envelope's own metadata paths, program and source
text loaded to run the handler, and content-addressed schema documents. The
list does not contemplate a write path that reads its own destination, and the
omission has a cost a deployment meets as soon as both `cfcFlowLabels` is
`persist` and `cfcEnforcementMode` is `enforce-strict`: a whole-object
`Cell.set()` into a document whose fields carry different confidentiality is
refused by the §8.12.4 writer-fit rule on every write after the first that
changes any field's value. The runtime's diff reads the destination
recursively to decide which sub-paths differ, so the transaction's join
carries every field's label, and the write to each field is then measured
against that field's own declared ceiling. The stream-marker probe `set()`
makes before choosing between an event send and a stored write has the same
effect over a document whose label sits at its root, and reaches further: a
transaction that rewrites such a document carries its label onto every other
write it makes, which is how the runner's sqlite commit-evaluation
integration case fails. What the refusal blocks is a
whole-object write whose value the program did not read out of the
destination — an event payload, a form's contents, a computed record. A
read-modify-write spelled `cell.set({ ...cell.get(), secret: x })` is refused
before and after this entry alike, and correctly so: the program did read the
sibling, so §8.9.2's conservative join covers it. Narrowing that case is the
per-write question SC-23 left transaction-global and SC-24 profiles, not this
one.

Proposed edit: add a fifth kind to §18.6.2's excluded set — a read the
runtime's own write machinery makes of the region it is about to write, whose
result decides how and whether to write rather than what is written. The
runner has two: the stream-marker probe that chooses between an event send
and a stored write, and the diff's read of each destination path. Two conditions belong in the text with it, because they are
what keep the exclusion from being the flow-precision claim §8.9.2 forbids by
default, gating it exactly as §8.9.1 gates a schema-level claim. The excluded
read's result MUST reach no written value: where the stored content steers the
write rather than merely gating it, the runtime takes a separate,
non-excluded read of the same address. And the marking MUST be runtime
recording rather than anything executed code can assert, the same discipline
§8.10.1 already puts on marking verifier-internal reads. The class is scoped
to the write path rather than to the probe: the runner's `isStream()` takes
its read metadata from its caller, so the same probe made to decide whether
to add a listener joins like any other observation.

The residual this admits is the write-elision channel: whether a path was
written is visible, so dropping a write tells an observer of the write set
that the writer's value equalled the stored one, and repeated attempts with
chosen values make that an equality oracle on that path's prior value.
Elision opens the channel and predates the exclusion; what the exclusion
changes is that the influence is no longer labeled at all, where before it
was labeled at the wrong paths. Recording a channel a profile does not close
is the discipline §18.6.4's conformance checklist asks for, and §4.6.3's
existence channel (SC-4) is the neighbouring disclosure.

The runner applies the exclusion to the flow join alone. The consumed set the
egress and sink ceilings read, and the per-write read-prefix gate of SC-23,
both still count these reads, which over-gates and never under-gates; §18.6.2
governs both sets, so a runtime that claims the amended list owes either the
wider application or this boundary stated, as SC-23 stated its own. The design and the runner's
implementation are in
[`cfc-write-destination-reads.md`](./cfc-write-destination-reads.md); the
runtime marks the class with `writeDestinationRead` rather than by address, so
§18.6.4's "excluded address patterns" obligation is discharged for this class
by naming the marker. `open`.

## From the wiring-probe classification (2026-09-16)

**SC-42 [normative] A runtime wiring read is not an observation — §4.6.3 +
§18.6.2.** `open`. §4.6.3's read-API mapping puts the link-carried label on a
"standalone reference-identity read", and the refinement beneath it defines
standalone by the dereference trace: a probe covered at or above by a trace
the same transaction recorded is resolution machinery, and every other probe
consumes the reference-identity row. No second boundary is named.

The runner has a second class of probe that boundary does not reach. When the
runtime wires an operation up — binding a node's inputs and outputs,
resolving a write redirect, plumbing a result, scaffolding a list
coordinator's container — it reads slots to find out which reference sits
there, and follows none of them, so no trace covers the read. Those scopes
carry the `machineryRead` marker and contain no pattern or handler code. What
the runtime does with the reference is write that same reference into another
slot, and the link write mints the source document's own label there, so the
pointer's protection reaches the slot that receives it whatever the probe
consumed. The per-transaction join is a second, coarser copy of it, stamped
over every other path the transaction wrote.

The cost of that copy is not theoretical. Setting a piece up rewrites the
complete result projection, so the copy lands at the ROOT of each sub-piece's
result document, where a covering entry covers `$UI` and the §8.10.6 display
ceiling denies the piece's whole user interface rather than the confidential
field inside it. Measured on
`packages/patterns/integration/cfc-render-policy-demo.test.ts` at the strict
dials: the clause reached the flow join through one observation, a `followRef`
read at the sigil interior carrying the wiring marker, and the §8.12.5 route-2
declaration then wrote it at `path: []` of four documents at once.

Proposed edit: say in §4.6.3's refinement list that the dereference trace is
one of two things that make a reference-identity probe something other than a
standalone observation, and that a read the runtime issues as its own
plumbing is the other. The table classifies observations a computation makes;
a runtime moving a reference from one slot to another makes none. State the
condition the exclusion rests on, which is the same one §18.6.2's list rests
on: the excluded scopes contain no program code, and a scope that computes
content from which reference sits at a slot is not one of them. §18.6.2 is
the other place this could live — its enumerated set already excludes
"reference resolution performed by the verification machinery itself", and
wiring reads are the same kind of thing one layer out — so the two sections
should at least cross-reference whichever carries it.

Section 8.12.8 anticipates this entry. Its existence-channel paragraph says
closing the per-child half for generic reference-structure containers "first
requires the runtime to distinguish its own container-scaffolding reads from
application reads (a machinery-read class beyond those of §18.6.2)", which is
that marker, named as something the spec does not yet have.

## From the input-witnessed `TransformedBy` (2026-09-23)

Design of record: [`cfc-transformed-by-input-witnesses.md`](cfc-transformed-by-input-witnesses.md).

**SC-43 [reconcile] `TransformedBy`'s input witnesses as standalone summary
atoms — §8.9.3, §8.7.1, §15.** `open`. Three passages give the atom three
shapes: §15's registry row and §4.5.4 carry `inputs: Array<{ ref, witnesses?
}>`, §8.7.1 carries parallel `inputs` and `inputIntegrity` arrays, and §8.9.3's
code sketch carries the §15 form. None says how an exchange rule reads a
per-input list, and the §4.4.5 pattern calculus has no quantifier to do it with:
an array pattern matches elementwise at equal length. The runtime mints the
conservative summary §8.9.3 already permits, as standalone atoms:
`TransformedBy{identity}` beside one `TransformedBy{identity, inputWitness: W}`
per atom `W` that held at every confidential input location, with no input
references. Proposed edit: make the summary form a registered alternative to
`inputs` in §15, with its meaning stated once (the transformer wrote the value,
and every confidential input it consumed carried `W`), and give §8.7.1's
parallel `inputs` and `inputIntegrity` arrays the §15 shape; state in §8.7.2
that a rule releasing an endorsed transformer's output guards on the
witness-bearing form, since the identity alone admits any caller's choice of
input; and note in §8.9.3 that input references are a read-path channel when
persisted, which is a reason to prefer the summary where no consumer
dereferences them.

## From the display-boundary module-policy build (2026-09-24)

**SC-44 [normative] A module policy's subject space is a membership candidate
— §4.9.3 + §18.4.5.** `open`. §4.9.3 discovers the spaces to point-query for
`HasRole` facts "from the `Space(...)` atoms present in the label being
evaluated", and §18.4.5 subscribes a gated cell to the ACL documents of exactly
those spaces. A module policy's rules release on evidence about
`THIS_POLICY.subject`, and §4.4.2's own example guards on
`HasRole(reviewer, subject, reader)`. A label selecting that policy carries the
subject inside the `Policy` reference, not as a `Space(...)` atom, so under the
text as written no point query is ever addressed to it: the rule can fire for
a viewer whose own or session space is the subject, and for no other reader.

The runtime adds the plaintext `subject` of each exact module-policy reference
the label selects to the candidate set, and the reconciler watches that
space's ACL document as it watches a `Space(X)` atom's. The discipline is
unchanged: one point query per `(principal, space)`, no member enumeration, and
no inference from residency.

Two things are left as they are. A subject in commitment form (§4.6.4.1) names
no space and is not a candidate: a committed subject is never opened (§4.3.6);
minted facts for other candidates still unify with it. Those are the facts the
boundary mints for another reason — the viewer's own or session space, or a
`Space` atom the same label names — so the commitment adds no candidate and no
new fact. A space a module rule adds from
any binding other than the subject is not a candidate either, and its `Space`
alternative stays sealed; consulting spaces that first appear in the rewritten
label would need a watch set that depends on evaluation, which §18.4.5's
reactive model does not have.

The same reactive obligation extends to manifests. A label whose manifest
has not reached the local replica fails closed (§4.4.3), and nothing in
§18.4.5 re-evaluates it when the manifest arrives. The runtime subscribes a
gated cell to the manifest document at `policyDigest` in each space its label
was derived from — the local digest-addressed store of §4.4.1, where the
persisting transaction installed it — until one verifies. For a label view
carried on a cell rather than stored on its document, those are the spaces the
carried view was derived from: the holder's, per §4.4.1, such as the document
holding a link the cell was resolved through, not the space of the value it
reaches.

Proposed edit: add the plaintext module-policy subject to §4.9.3's
candidate-discovery sentence, with the commitment-form carve-out; and add
subject-space ACL documents and unverified manifest documents to §18.4.5's
reactive re-render paragraph. Implemented in
`packages/runner/src/cfc/render-ceiling.ts`
(`membershipSpacesInConfidentiality`) and
`packages/html/src/worker/reconciler.ts` (`#watchCellMembership`).
