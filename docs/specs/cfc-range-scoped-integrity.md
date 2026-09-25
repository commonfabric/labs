# CFC range-scoped integrity for collaborative fields (Epic F) — design

_Epic F of
[`docs/history/plans/cfc-future-work-implementation.md`](../history/plans/cfc-future-work-implementation.md)
(§8). Spec: `commonfabric/specs` `cfc/14-open-problems-and-proposals.md`
§14.4.8 (collaborative documents, OT materialization, range-scoped integrity)
plus the `views` storage hook the spec already reserves in
`cfc/04-label-representation.md` §4.6.3. This doc is the F0 gate the plan
requires: no runner code before it exists, and nothing in Epics A–E depends on
it. The epic stays deliberately unscheduled — this doc fixes the semantics (the
range representation, the `IntegritySummary` contract, witness-bearing
materialization, anchors/partial reads, and the memory/runner split) so the
stages have a stable target whenever it is picked up._

## 1. Problem

The flat model carries one label per path. A collaborative text field is one
value whose *parts* have different pedigree: "chars [0:100] authored by Alice,
[100:200] by Bob". §14.4.8 names three needs the flat model cannot meet — the
whole materialized value needs integrity about the trusted materializer and the
witnesses it consumed; some direct claims are true only of surviving spans; and
readers need both the whole-field label and the finer view.

Today's machinery cannot say any of this, and the failure is *honest* — which
is what makes it useless. §4.5.5 admits exactly three ways an integrity claim
survives onto a computed output, and all three fail for mixed content:

- **Verified binding** — value-bound claims (`authored-by`, `Signature`) bind
  to exact bytes; any edit by anyone destroys them on the whole field.
- **Heredity** — authorship is explicitly non-hereditary (§15 registry,
  §3.1.6.1): Alice's claim on an input must not survive onto a merge that
  contains Bob's words.
- **Endorsed re-minting** — an endorsed content-preserving reformatter can
  re-assert a claim it preserves, but a merge of two authors' edits preserves
  *neither* author's whole-value claim, so there is nothing to re-mint.

So after any real collaboration the sound whole-field integrity is **empty**
(the fail-safe drop of the §8.9.3 meet). Correct under the flat model — and it
makes per-span authorship UI impossible, starves `requiredIntegrity` floors
(Epic D3) of any positive claim, and leaves anchored annotations (comments on
a span) with no integrity story at all. There is also an expressiveness gap
the audit ([`cfc-runner-future-work.md`](./cfc-runner-future-work.md) Epic F)
already flagged: "every surviving part is covered by at least one of
{Alice, Bob}" is a quantified claim, and a runtime label is a flat atom set —
the quantifier is not encodable, only over-restriction is (safe, useless).

## 2. What already exists (the substrate F builds on)

Spec side — more is reserved than the "open problem" framing suggests:

- **The storage hook is already in the normative representation.** §4.6.3's
  `PathLabelTemplate` carries `views?: { ranges?: Array<{ span; label }> }` —
  "optional view-specific refinements (for example collaborative-text
  ranges)" — inline under the same path entry. §14.4.8.2 sketches the richer
  `CollaborativeFieldView` around it.
- **All three atom roles are already registered** (§15): `AuthoredBy`
  (value-bound, explicitly non-hereditary), `TransformedBy` (witness-bearing:
  `codeHash`, `operation?`, `inputs: [{ ref, witnesses? }]`), and
  `IntegritySummary` (`family`, `semantics: contributors | covered-by`,
  `members`, `basis?`), with the basis-dependent propagation rule in §15.1.1:
  hereditary when `basis` is `consumed-inputs`/`integrated-history`,
  value-bound when `surviving-content`. §4.5.1.1 defines the three roles.

Runner side:

- **The persisted entry already has two orthogonal axes.** `LabelMapEntry`
  (`path`, `label`, `origin?`, `observes?` —
  [types.ts](../../packages/runner/src/cfc/types.ts)) carries update
  discipline (S16) and consumption class (Epic C). `CfcMetadata` rides the
  entity doc at path `["cfc"]`
  ([metadata.ts](../../packages/runner/src/cfc/metadata.ts)). F adds a third
  *refinement* to one entry, not a new model.
- **Observation classes are landed (C1–C5)**: per-class consumption in
  `prepare.ts` and per-class label views
  ([label-view-core.ts](../../packages/runner/src/cfc/label-view-core.ts),
  C4). Partial reads (§7) ride this frame; they need no new class.
- **Propagation classes with a fail-safe default.** `atomPropagationClass`
  ([atom-classes.ts](../../packages/runner/src/cfc/atom-classes.ts)) defaults
  unknown types to value-bound (SC-10), so new atom families are safe before
  their class entry ships. `TransformedBy` is classed value-bound, so it drops
  in the §8.9.3 meet and is not eligible for endorsed preservation.
- **The authorship family exists as an authoring alias.**
  `AuthoredByCurrentUser` ([api/cfc.ts](../../packages/api/cfc.ts)) mints
  kind-shaped `{ kind: "authored-by", subject }` atoms with acting-user
  substitution — the per-range claim family.
- **A mint-authority chokepoint exists.** The runtime-minted evidence gate
  ([prepare.ts](../../packages/runner/src/cfc/prepare.ts)) strips
  runtime-minted atom families from author-influenceable labels (the
  discipline `LlmDerived`/`ExternalIngest` already follow).
- **Verified implementation identity** for trusted computations:
  [implementation-identity.ts](../../packages/runner/src/cfc/implementation-identity.ts)
  over
  [verified-provenance.ts](../../packages/runner/src/harness/verified-provenance.ts).

Memory side — the sqlite per-row work is the nearest shipped analog:

- **Fine-grained labels as a pure function of stored data**, re-derivable on
  either side identically
  ([`sqlite-builtin/06-cfc.md`](./sqlite-builtin/06-cfc.md)); a shared
  declarative evaluator
  ([memory/v2/sqlite/row-label.ts](../../packages/memory/v2/sqlite/row-label.ts),
  [builtins/sqlite/row-label-read.ts](../../packages/runner/src/builtins/sqlite/row-label-read.ts)).
- **Server-applied operations inside the commit apply loop**
  (`applySqliteOperation`,
  [memory/v2/engine.ts](../../packages/memory/v2/engine.ts);
  [`sqlite-builtin/04`](./sqlite-builtin/04-server-execution-and-transactions.md)),
  gated by a **capability handshake**
  ([memory/v2/handshake.ts](../../packages/memory/v2/handshake.ts), the E4
  shape).
- **Verified commit signers** (Epic E;
  [memory/v2/session-open-auth.ts](../../packages/memory/v2/session-open-auth.ts))
  — the evidence source for op authorship.
- And the named hole to avoid: sqlite's `authoredBy(sender)` rule mints
  provenance from a **stored column any writer controls** (audit; ties to
  D2). Authorship evidence must come from verified identity, never payload.

## 3. Design decision: ranges are integrator-derived side-data on the field's own label entry

The repo rendering of §4.6.3 `views` / §14.4.8.2 is one optional refinement on
the collaborative field's persisted entry:

```ts
// Shown for illustration only.
type CollaborativeFieldView = {
  kind: "collaborative-text";
  codec: string; // op/anchor encoding, e.g. "cf-text-ot@1"
  version: number; // integrated version this side-data describes
  ranges: Array<{
    span: { start: number; end: number } | unknown; // codec-defined anchor
    label: IFCLabel; // integrity-only until F5 (see channel split below)
  }>;
};

type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin?: LabelEntryOrigin; // update discipline (unchanged)
  observes?: LabelObservationClass; // consumption class (unchanged)
  view?: CollaborativeFieldView; // NEW — declared collaborative fields only
};
```

- **inv-F1 — ignoring ranges is sound.** The whole-field label at the entry
  MUST be at least as restrictive as the join of every range's
  confidentiality plus the field's path/root/structural taint (§14.4.8.2's
  MUST), while range *integrity* MAY exceed whole-field integrity — that
  asymmetry is the entire point. A range-unaware reader therefore over-taints
  or exactly-taints on confidentiality (it consumes the covering entry) and
  under-claims on integrity (it sees only whole-field claims). Both are the
  fail-safe direction — the same wire-compat argument as C0's covering
  entries, so old persisted data needs no migration and (unlike C0's
  `followRef` slice) no reader-first ordering for the F3 axis (§10).
- **inv-F4 — side-data is a cache of a pure function.** `ranges` =
  f(integrated history up to `version`): recomputable at any time, by either
  side, identically — the sqlite audit property transplanted. `version` binds
  the side-data to the integrated stream; a lag or mismatch is detectable and
  resolves by re-derivation, and the fail-safe fallback is to *drop* the view
  (an integrity under-claim), never to guess spans.
- **Channel split: integrity-only until partial reads exist.** Per-range
  confidentiality has no sound consumer before a partial-read primitive: the
  materialized read observes every span, and the covering entry already
  carries the join, so earlier per-range confidentiality would be data
  readers must be told *not* to consume. F3 mints integrity-only ranges;
  per-range confidentiality arrives with F5 (§7, §10) — the same honest
  channel-splitting C2 did for existence entries.
- **inv-F3 — mint authority: runtime-authored, verified-evidence-only.**
  Range side-data and every §5/§6 atom are minted exclusively by the trusted
  integrator through the runtime-minted path. The existing runtime-minted
  evidence gate ([prepare.ts](../../packages/runner/src/cfc/prepare.ts))
  filters flat `IFCLabel.integrity` arrays only — it cannot see nested range
  side-data — so F3 MUST extend it to the `view` refinement, and the sound
  extension is wholesale: an author-influenceable channel (a carried label
  view or link schema, a direct write at the cfc metadata path) never
  contributes a `view` at all — dropped, not atom-filtered — since
  re-derivation from integrated history (inv-F4) is always available and
  dropping is the fail-safe under-claim. A range's `authored-by` subject is
  the **verified signer of the commit that appended the op** (Epic E), never
  a payload field — sqlite's `authoredBy(sender)` self-mint is the named
  counterexample.

**Alternative considered and rejected — the sqlite split move (one doc per
range).** Phase 3.a attaches per-row labels by writing each row as its own
entity doc under a root-ifc schema. That works because rows have stable
identity and independent storage. Spans have neither: every edit shifts
offsets (identity churn per keystroke), a substring is not addressable as a
doc, and the labeled value is one string at one path. The split would turn
each edit into a fan-out rewrite of range docs and the field read into a
multi-doc join. Inline side-data keeps range maintenance inside the
integrator, where span-threading through transforms already happens.

**Also rejected — authorable range labels** (a schema or pattern surface for
writing ranges): it grants exactly the self-mint hole above. Every useful
range claim is authorship/coverage *evidence*, and evidence is only credible
from the runtime.

## 4. The three projections (§14.4.8.1)

A **declared collaborative field** is an authoring-surface marker (a
`Cfc<>`-family alias alongside the existing canonical aliases in
[api/cfc.ts](../../packages/api/cfc.ts)). The declaration is what turns on
memory-side op storage and the opt-in projections; undeclared fields are
untouched.

- **Submitted ops** — the original client payloads as accepted: ordinary
  appends by the submitting session, labeled by the ordinary write rules (the
  submitting transaction's flow label), authorship evidenced by the commit
  signer.
- **Integrated ops** — the trusted canonical stream after rebase/transform: a
  computation over submitted ops, so the §8.9.3 class-aware meet applies to
  what it consumes, and the integrator mints
  `TransformedBy { operation: "integrate-collaborative-op" }` fresh per
  batch.
- **Materialized value** — deterministic replay of integrated history: the
  field's value, the §3 side-data, and the §6 whole-field mints.

The materialized read stays the default and the only general-purpose read.
Each op projection is its own address with its own labels — an op-log read is
an ordinary value read at the op log's path, so no new observation class.

## 5. `IntegritySummary` — what the runtime records vs what it enforces (§14.4.8.3)

| `semantics` | claim about the current field | typical family |
|---|---|---|
| `contributors` | surviving content came from members of the set | `authored-by` |
| `covered-by` | every surviving part is covered by at least one member's verified claim | `Signature` |

| `basis` | claim is about | propagation (§15.1.1) |
|---|---|---|
| `surviving-content` | the current materialized bytes | value-bound (any transform invalidates) |
| `consumed-inputs` / `integrated-history` | the derivation's inputs | hereditary ("derived only from inputs with X" is closed under derivation) |

Design points, each normative for F:

- **The quantifier is opaque to the runtime.** The runtime never evaluates
  "covered-by"; it mints summaries with correct semantics (trusted integrator
  only, §3.3 minting rule) and matches them structurally in floors and
  exchange rules, like any parameterized atom. **Rejected alternative:**
  encoding the quantifier in label structure (integrity OR-clauses, the Epic
  A move on the confidentiality side). Integrity composes by meet, not join —
  alternatives-in-integrity would need its own soundness story for zero
  payoff, because an opaque atom minted by trusted code can state the
  quantifier exactly (this is the audit's "expressiveness only; over-restricts,
  safe" observation resolved in place).
- **inv-F2 — a summary never satisfies a direct floor.** A
  `requiredIntegrity` floor naming the direct family (`authored-by`,
  `Signature`) MUST NOT be satisfied by
  `IntegritySummary(family=<that family>)`. Today this is structurally free
  (different atom type; floor matching is structural), but it must be stated
  and red-tested so the planned matcher upgrade (Epic B's §8.10.3 work) never
  helpfully bridges it.
- **First parameter-sensitive propagation class.** `CLASS_BY_TYPE`
  ([atom-classes.ts](../../packages/runner/src/cfc/atom-classes.ts)) keys on
  `type` alone; `IntegritySummary` needs a predicate on `basis`. SC-10's
  unknown→value-bound default means summaries persisted before that entry
  ships behave fail-safe (a hereditary-basis summary temporarily drops — an
  under-claim).
- **Mint discipline.** Members are deduplicated and canonically ordered
  (`cfc-canonicalize` tests, like every digest input); summaries are minted
  alongside the same materialization's `TransformedBy` (§6) so a consumer can
  bind the summary to the materializer identity via one label.
- **Lift rule — both halves of §14.4.8.3.** When every surviving range
  carries the *same* direct claim and the ranges cover the whole field, the
  integrator lifts that direct claim to the whole-field label. This is not an
  optimization nicety: without it, declaring a field collaborative would
  *downgrade* the common single-author case (Alice's solo doc loses
  `authored-by(Alice)`). Uniform-and-covering is re-derivable from the same
  side-data, so the lift is cheap and auditable. When direct claims differ,
  the integrator MUST NOT lift any of them — it mints summaries instead.
- **Spec-owed honesty note.** The registry's `contributors` wording is the
  weak reading ("some surviving content came from members"). This integrator
  mints an *exhaustive* roster — every surviving span's verified author is a
  member — which is the reading policies actually want ("only team members
  touched this"). Portable consumers may rely only on the spec reading; a
  policy that needs exhaustiveness is relying on this integrator's mint
  discipline, bindable via the accompanying `TransformedBy`. Proposing the
  registry state exhaustiveness explicitly (a field or strengthened wording)
  is a spec-owed item (§10).

## 6. Materialization as witness-bearing computation (§14.4.8.4)

The integrator/materializer is one trusted implementation with verified
identity
([implementation-identity.ts](../../packages/runner/src/cfc/implementation-identity.ts);
builtins resolve `kind: "builtin"` like the sqlite builtins). Its authority is
a reviewable registry surface — a trust-concept entry in the
§8.7.2/§8.9.1 style (`collaborative-integration`), not ambient runner code.
Per materialization it mints, whole-field:

```ts
// Shown for illustration only.
{
  type: "https://commonfabric.org/cfc/atom/TransformedBy",
  operation: "materialize-collaborative-field",
  codeHash: "<verified materializer identity>",
  inputs: [
    { ref: "<integrated checkpoint ref>", witnesses: ["<checkpoint mints>"] },
    {
      ref: "<op batch ref>",
      witnesses: [{ kind: "authored-by", subject: "did:key:alice…" }],
    },
  ],
}
```

- **Witnesses record what was verified, not what is inherited.** Each input's
  `witnesses` are the atoms actually verified on that integrated input at
  consumption time (the checkpoint's own prior mints; op authorship from
  verified commit signers). Per §4.5.1.1 the mint says which trusted
  implementation ran and what evidence it checked — it does not claim the
  output inherits any input atom. It is minted fresh per materialization and is
  excluded from the hereditary meet on later value-changing transitions as
  value-bound evidence.
- **Checkpoint granularity is the confidentiality honesty unit.** The
  materialized field's derived confidentiality follows the default transition
  over what the materializing computation consumed: the checkpoint plus ops
  since. Stated plainly: deleting a secret span does **not** shed the
  whole-field taint until the derivation re-bases on a compacted checkpoint
  that no longer contains it — replace-on-overwrite (§8.12.8) applied at
  checkpoint granularity. Compaction policy is therefore a *labels* lever,
  not just a storage lever; F2 owns it memory-side.
- **Everything re-derivable (inv-F4).** The mint's inputs cite
  content-addressed checkpoint/batch refs, so an auditor (offline, via the
  state-inspector tooling) can replay integration and recompute the value,
  the side-data, and every mint byte-identically.

## 7. Anchors and partial reads (§14.4.8.5)

- **Anchors are ordinary application data**: `{ field link, codec-defined
  anchor }`, and the annotation payload is ordinary data with its own labels
  — nothing new there. The system-owned part is (a) **mapping anchors through
  integration**: a deterministic function of the same integrated history,
  owned by the same integrator, with one shared codec implementation on both
  sides (the row-label.ts shared-evaluator discipline) — two divergent
  mappers would silently drift every annotation; and (b) **exposing
  range/summary integrity for the anchored span** so an annotation consumer
  can reason about what it is anchored to.
- **A partial read is a `value` observation refined by a span** — the Epic C
  frame absorbs it; no new observation class. At F3 a partial read consumes
  the covering entry (whole-field) — a sound over-approximation. At F5,
  consumption narrows **in the derived content component only**. inv-F1 does
  not put declared/root labels or structural taint into ranges, so a literal
  "overlapping ranges only" rule would under-taint. The F5 rule: a partial
  read still consumes the covering entry's declared, link, and structure
  components and the field's path/root taint unchanged; plus the field's
  `shape` (span *positions* are membership facts — knowing where spans fall
  is observing structure, the §8.5.6.1 asymmetry again); plus the
  overlapping ranges' confidentiality; plus the **derived residual**. The
  integrator maintains the field's derived content confidentiality as
  join(range confidentiality) ⊔ residual, where the residual carries what is
  not attributable to surviving spans (e.g. deleted-span taint until
  checkpoint compaction, §6), and a partial read always consumes the
  residual. What a partial read sheds is therefore only ever *other spans'*
  decomposed labels — never a whole-field component.
- **Integrity of a partial read** is the meet of the overlapping ranges'
  integrity, scoped as a projection of the field (§4.5.3) — valid as a
  component of the field, not as a standalone value.
- **Label views carry the same refinement.** `CfcLabelViewEntry`
  ([label-view-core.ts](../../packages/runner/src/cfc/label-view-core.ts))
  gains the `view` field so the UI renders per-span authorship through the
  existing per-class view protocol (C4 lineage) — no new render machinery.

## 8. What lands memory-side vs runner-side

Memory-side (`packages/memory/v2`) — canonical history and storage; no label
semantics beyond persisting side-data:

1. **The integrated op log per declared field**: append + transform inside
   the commit apply loop — the `applySqliteOperation` precedent
   ([engine.ts](../../packages/memory/v2/engine.ts)). Server-authoritative
   ordering is what makes the history *canonical*; this is
   [`sqlite-builtin/06-cfc.md`](./sqlite-builtin/06-cfc.md)'s "why this stays
   declarative" argument transplanted: the transform runs where no sandbox
   code runs, so the codec must be a small fixed evaluator, not pattern code.
2. **Checkpoints and compaction** — the §6 confidentiality lever.
3. **Range side-data + `version` persisted with the field's cfc metadata.**
   Memory stores it and threads spans/anchors through transforms (the one
   memory-side computation — deterministic and label-blind); it never joins
   labels or evaluates policy.
4. **Verified op authorship** recorded per op from the commit signer
   ([session-open-auth.ts](../../packages/memory/v2/session-open-auth.ts)).
5. **Capability handshake**
   ([handshake.ts](../../packages/memory/v2/handshake.ts), the E4 shape): a
   server without the codec refuses declared-field ops rather than corrupt
   the canonical stream — fail-closed, like sqlite 3.c's absent capability.

Runner-side (`packages/runner`) — declaration, minting, consumption:

1. **The authoring surface** (declared-field alias) and the submit path, with
   speculative local apply (the client materializes optimistically; server
   order is canonical).
2. **The integrator/materializer builtin** and every mint (`TransformedBy`,
   summaries, the lift) through the runtime-minted path, identity via
   [implementation-identity.ts](../../packages/runner/src/cfc/implementation-identity.ts).
3. **Consumption**: the `prepare.ts` flow join and `effectiveReadLabel` are
   unchanged for whole-field reads; F5 adds the partial-read refinement;
   label views expose ranges (§7).
4. **Atom registry + classes**: `CFC_ATOM_TYPE.IntegritySummary`
   ([api/cfc.ts](../../packages/api/cfc.ts)), the parameter-sensitive class
   entry, and the inv-F2 floor non-satisfaction test at the floor matcher.
5. **The anchors API** (map-anchor read surface over the integrator).

**Rejected alternative — client-authoritative integration** (runners
integrate, memory stores a materialized blob): with N runtimes each
integrating their own stream there is no canonical history, so inv-F4 dies —
and with it the witness story, because `TransformedBy.inputs` would cite refs
no other party can replay. The sqlite server-execution split
([`04-server-execution-and-transactions.md`](./sqlite-builtin/04-server-execution-and-transactions.md))
already picked the server-canonical side for the same reason, and multi-user
correctness there is exactly what the multi-runtime worker harness (the
plan's cross-cutting test infrastructure) keeps honest.

## 9. Staging (F1–F5)

1. **F1 — atoms + classes.** `IntegritySummary` in `CFC_ATOM_TYPE`; the
   parameter-sensitive propagation entry; canonicalization (member
   dedup/order); red-first inv-F2 test (summary must not satisfy the direct
   floor). Independently useful before any collaborative machinery: gives the
   sqlite aggregate story (§8.17.4) a summary vocabulary and D2's
   `ClaimedAuthoredBy` interim a landing target.
2. **F2 — declared fields + the memory op log.** The schema alias; op append
   and integration inside commit apply; checkpoints + compaction; the
   handshake; submitted/integrated projections as opt-in reads. No range
   labels yet.
3. **F3 — side-data + whole-field mints.** Integrity-only ranges from
   verified op authorship; `TransformedBy` + summaries + the uniform-covering
   lift; label-view exposure; the runtime-minted gate extended to the `view`
   refinement (inv-F3). Red-first: a mixed-author doc MUST NOT carry either
   author's direct claim whole-field (§14.4.8.3's MUST NOT) while a
   single-author doc keeps its lifted claim; side-data must re-derive
   byte-identically from the op log (inv-F4); a forged `view` with nested
   `TransformedBy`/`IntegritySummary`/`authored-by` atoms carried on an
   author-influenceable label view or link schema is dropped wholesale — it
   survives today's flat-array gate, so the test is red by construction.
4. **F4 — covered-by families.** Signature-style per-span claim verification;
   until it lands the integrator mints `contributors` only.
5. **F5 — anchors + partial reads.** The anchor-mapping surface; partial-read
   consumption narrows per the §7 component-precise rule (only other spans'
   decomposed labels are shed, never a whole-field component); per-range
   confidentiality becomes mintable and consumable (closing §3's channel
   split).

F1 and F2 are parallel; F3 needs both; F4/F5 need F3. Nothing in Epics A–E
waits on any stage. F consumes what already landed: Epic A's clause profile,
Epic C's observation classes and views, Epic D's minting discipline, Epic E's
verified identities.

## 10. Rollout

- **The dial is the declaration.** No global flag: a field opts in via
  schema, and the handshake gates servers — a non-supporting server refuses
  declared-field commits (fail-closed), so a mixed fleet degrades to "the
  feature is unavailable", never to a corrupted canonical stream.
- **Mixed-version label safety needs no reader-first ordering at F3**
  (contrast C0's `followRef` slice): the range axis only *adds* integrity
  that old readers ignore (under-claim) while confidentiality stays on the
  covering entry they already consume (inv-F1). The one ordering rule is
  F5's: per-range *confidentiality consumption* must not narrow any read
  before every live reader understands ranges — an under-taint risk of the
  same shape as C0 §9, so F5 ships reader-first or dialed.
- **Perf.** Side-data size is bounded by span count; the integrator merges
  adjacent same-label spans at mint, and a pathological interleave degrades
  toward O(edits) — F3 owns a cap-and-coalesce policy, benched with
  `cfc-label-sync-strategy`/`cfc-canonicalize` like C0. Op-log growth is
  F2's compaction policy — which §6 makes a labels decision, not only a
  storage one.
- **Spec-owed** (tracked in [`cfc-spec-changes.md`](./cfc-spec-changes.md)
  when F3 settles): promote §14.4.8.2–.4's illustrative shapes to normative;
  the `contributors` exhaustiveness clarification (§5); record the
  checkpoint-granularity confidentiality consequence against §8.12.8.

## Provenance

Grounded in `commonfabric/specs` `cfc/`:
`14-open-problems-and-proposals.md` §14.4.8.1–.5 (projections, whole-field vs
range labels, claims/summaries, witness-bearing materialization,
anchors/partial reads); `04-label-representation.md` §4.6.3
(`PathLabelTemplate.views`, the primitive read profile), §4.6.4 (the stored
envelope and label components), §4.5.1.1 (direct vs witness-bearing vs
summary), §4.5.3 (scoped projection), §4.5.5 (the three survival paths);
`15-atom-registry.md` §15.1.1 (propagation classes; the `IntegritySummary`
basis rule; `AuthoredBy` non-hereditary; the `TransformedBy` entry);
`08-09-runtime-label-propagation.md` §8.9.3 (the class-aware meet). Runner
seams: [types.ts](../../packages/runner/src/cfc/types.ts)
(`LabelMapEntry`/`CfcMetadata`),
[metadata.ts](../../packages/runner/src/cfc/metadata.ts) (`readStoredCfcMetadata`
at `["cfc"]`),
[label-view-core.ts](../../packages/runner/src/cfc/label-view-core.ts)
(`IFCLabel`, `CfcLabelView`),
[atom-classes.ts](../../packages/runner/src/cfc/atom-classes.ts)
(`atomPropagationClass`, the SC-10 default),
[prepare.ts](../../packages/runner/src/cfc/prepare.ts) (the runtime-minted
evidence gate and floor matcher), [api/cfc.ts](../../packages/api/cfc.ts)
(`CFC_ATOM_TYPE`, `AuthoredByCurrentUser`),
[implementation-identity.ts](../../packages/runner/src/cfc/implementation-identity.ts)
+ [verified-provenance.ts](../../packages/runner/src/harness/verified-provenance.ts).
Memory seams: [engine.ts](../../packages/memory/v2/engine.ts)
(`applySqliteOperation`, the server-applied-op precedent),
[handshake.ts](../../packages/memory/v2/handshake.ts),
[session-open-auth.ts](../../packages/memory/v2/session-open-auth.ts),
[row-label.ts](../../packages/memory/v2/sqlite/row-label.ts) +
[row-label-read.ts](../../packages/runner/src/builtins/sqlite/row-label-read.ts)
with [`sqlite-builtin/06-cfc.md`](./sqlite-builtin/06-cfc.md) (the per-row
precedent and its `authoredBy(sender)` hole) and
[`04-server-execution-and-transactions.md`](./sqlite-builtin/04-server-execution-and-transactions.md);
plus [`cfc-observation-classes.md`](./cfc-observation-classes.md) (the C0
frame partial reads reuse) and
[`cfc-runner-future-work.md`](./cfc-runner-future-work.md) (the Epic F audit
entry).
