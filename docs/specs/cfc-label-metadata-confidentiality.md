# CFC label-metadata confidentiality (invariant 12 / SC-14) — design

_Design for enforcing spec invariant 12 ("labels are not public payload by
default") in the runner: the cross-space carried-label exposure the spec
records as a known gap (`04-label-representation.md` §4.6.4.1), the
`inspectConfLabel` observation profile (§4.6.4.1–.2), and the read-side gating
SC-6 promised to revisit. Grounded in the shipped envelope machinery
(`cfc/prepare.ts`, `cfc/label-view-core.ts`) and the audit item
"`Caveat.source` redaction is display-only" (inv-12; SC-14). Written
2026-07-09 at owner request._

## 1. The exposure, measured against the code (not the audit sentence)

What a destination space's **readers** — every client that syncs the doc, not
just its runtime — can observe today when a label derived from space-A reads
persists into a space-B document:

| Persisted field | Names A-side principals/spaces? | Consumer that needs it |
|---|---|---|
| `User{subject}`, `Space{id}`, `PersonalSpace{owner}` clause atoms | **yes — DIDs** | read gating (equality), §4.9.3 ACL point query (`Space.id` dereference) |
| `Caveat{kind, source, by}` | **yes** — `source` is a full nested atom | evidence binding (inv-10: discharge must bind the same caveat source) |
| `LinkReference{source:{space,id,path}, target:{…}}` | **yes** — space DID + doc id + path | provenance display; S7 exemption keys on atom *type* only |
| `TransformedBy{codeHash, operation?, inputs}` | artifact and operation identity plus consumed content references | trust statements (B3 pattern match); input-witness guards |
| `HasRole`, `UserSurfaceInput`, vouched-channel `ExternalIngest`, `authored-by`/`represents-principal` | **yes — DIDs** | role guards; authorship UI (product feature); fetch-ingest provenance carries a URL and commit SHA instead |
| sigil-link `cfcLabelView` **inside `value`** | same atom set, second copy | link-carried enforcement at B |
| `cfc.schemaHash` + replicated schema doc (`ensureSchemaDocument`) | policy structure, field names | schema-driven enforcement |
| version-2 envelope `label.$ref` + replicated `cid:` label document | same atom set as the inline label, one copy per space | label resolution (`resolveStoredCfcMetadata`) |

Two corrections to the audit item's inherited wording: `Origin` URIs have **no
mint site** in the runner (nothing persists them), and policy names were never
persisted **until label-carried `Policy(...)`/`Context(...)` refs shipped**
(B2b label-carried selection, 2026-07-09): a ref atom persists `name` + `hash`
(public by design — they identify a deployment policy profile and must stay
dereferenceable against the destination's snapshot) and a DID `subject`
(commitment, same posture as `User.subject`). The live leak set is the
DID-bearing rows above.

Three structural facts shape everything below:

1. **The replica is the disclosure.** Envelopes ride the doc JSON
   (`EntityDocumentWithCfc`); memory access is per-space session partitioning
   with no sub-document ACL. Any space-B session holds the bytes. A
   view-transform at an API seam (the shipped `Caveat.source` display
   redaction) cannot protect what sync already delivered.
2. **Enforcement is local-first.** B's *runtime* legitimately evaluates these
   labels — read gating, ceiling fit, exchange rules, evidence binding. There
   is no trusted-server-only evaluation point that could hold plaintext while
   clients receive redacted copies. So protection must live in the **persisted
   representation** itself, per atom field, chosen so enforcement still works.
3. **Some identities are public by design.** `represents-principal` /
   `authored-by` subjects feed the authorship badge; blanket source-field
   redaction breaks the product. Classification, not blanket redaction.

## 2. Design: three representation classes per atom field

At the cross-space persist seam (`prepareBoundaryCommit`'s envelope write plus
the sigil `cfcLabelView` attachment), every source-bearing atom field is
persisted in one of three forms, per a classification table owned alongside
the atom registry:

- **`public`** — verbatim. For fields whose disclosure is the feature
  (authorship subjects where the author chose attribution) and for
  non-identifying fields (`kind`, `type`, `Expires.timestamp`,
  `Builtin.name`, `LlmDerived.model`).
- **`commitment`** — the field value is replaced by its unsalted canonical
  digest (`hashStringOf`), same idiom as the shipped `valueDigest` /
  `evidenceDigest` atom fields. Preserves: equality matching (read gating
  computes `H(reader)` and compares; evidence binding compares digests;
  SC-11 idempotence — the transform is deterministic). Loses: dereference
  (no §4.9.3 ACL lookup from a digested `Space.id`) and variable-binding
  pattern matches over the field. Privacy honesty: digests of DIDs are
  **probe-able** (an adversary can hash candidate DIDs and test) — this form
  hides identities from casual observation, not from targeted enumeration.
  It is the pragmatic middle, and the spec's fallback posture ("SHOULD prefer
  atom forms whose payloads are not themselves sensitive") upgraded to a
  mechanism.
- **`reference`** — the strong form. The destination envelope stores an
  opaque back-reference (`{space: A, entry: <content address>}`) to the label
  entry in the **source space**; no atom payload crosses. Resolution happens
  at evaluation time under **A's read authority**: a reader whose session can
  read A resolves and evaluates; one who cannot gets the spec's
  `notAvailable` collapse — the clause is unsatisfiable and the protected
  value stays closed. This makes inv-12's "source identity confidentiality"
  literal: *the label's readability is the source's own read authority.*
  Fail-closed by construction; availability-coupled (A unreachable ⇒ B's
  protected values unreadable even for legitimate readers) — mitigated by
  per-reader local materialization after a successful resolve (cache the
  resolved entry under the reader's own session, revalidated by content
  address).

Default assignments (initial table, revisable per family):

| Field | Class | Rationale |
|---|---|---|
| `Caveat.source`, nested caveat sources | commitment | consumed by equality-shaped evidence binding; the audit's named leak |
| `User.subject` / `PersonalSpace.owner` in confidentiality clauses | commitment | gating is pure equality against the acting reader |
| `Space.id` in clauses | **public** (initially) | §4.9.3 must dereference it for the ACL point query; a commitment breaks membership-based release. Space DIDs identify a *container*, not a person; revisit under `reference` when cross-space resolution ships |
| `Policy`/`Context` ref `.name`/`.hash` | **public** | B2b label-carried selection must dereference them against the destination's deployment snapshot (the `Space.id` argument); they identify a policy profile, not a person, and `hash` is already a content digest |
| `Policy`/`Context` ref `.subject` | commitment | a DID, equality-shaped at selection (well-formedness only — selection keys on name+hash and accepts the commitment marker); rules binding variables from it fail closed at the destination, the narrow direction |
| `LinkReference.source/target` | commitment (paths), public (space? no — commitment) | display/provenance only; nothing dereferences the persisted copy |
| `TransformedBy.codeHash` / `.operation` | public | content-addressed trust anchors used by operation patterns |
| `TransformedBy.inputs[].ref` | commitment | source topology; persisted policy evidence does not dereference the copy |
| unrecognized retained `TransformedBy.identity` | commitment | the whole payload is opaque, so code layout cannot cross the space boundary |
| `authored-by` / `represents-principal` `.subject` | public | product-displayed attribution, minted under the acting principal's own authority |
| `HasRole` / `UserSurfaceInput.user` / vouched-channel `ExternalIngest.audience` | commitment | evidence families; equality-consumed; fetch-ingest provenance has no audience |

The classification is enforced where atoms are already canonicalized
(`canonicalizeCfcMetadata` / the persist loop), applies **identically to the
envelope entries and the sigil-link `cfcLabelView`** (one transform, two
sinks — missing the in-`value` copy voids the whole design), and only fires
for **cross-space** persistence: a label whose observations all originate in
the destination space persists verbatim (nothing foreign to protect, and
same-space tooling keeps full fidelity).

Same-form matching keeps enforcement sound: a clause atom in commitment form
is satisfied by digesting the candidate before comparison; an exchange-rule
`appliesTo` in commitment form matches commitment atoms. Rules that need
plaintext variables over a committed field simply do not fire at B — the
fail-closed direction (a release that cannot be evaluated does not happen).

## 3. The read side: label metadata becomes an observation

Representation limits what B's replicas contain; inv-12 additionally requires
that *observing* label metadata is itself a labeled observation. Today the
read side has no channel at all: `["cfc"]` reads are excluded from flow/PC
(`flowReadExcluded`), runtime reads go through `INTERNAL_VERIFIER_META`, and
one **raw unredacted IPC seam is open** — `handleCellGet` with `meta: "cfc"`
returns the raw envelope (`runtime-processor.ts` `getMetaRaw`; zero live
callers). SC-6 records the exclusion as "a profile decision that must be
revisited when invariant 12 is implemented." This is that revisit:

1. **Close the raw seam.** `meta: "cfc"` over IPC either returns the same
   redacted view as `getCfcLabel` or is removed (no callers today — remove).
2. **`inspectConfLabel` is the only pattern-facing surface**, implemented per
   §4.6.4.1: equality predicates only; result is a runtime-labeled value
   whose label joins the consumed metadata observations + query-input
   confidentiality + PC; `notAvailable` normalization for unobservable /
   missing / matching-but-unreadable (the `reference`-form resolution failure
   maps onto exactly this outcome — no new case).
3. **Population profile (§4.6.4.2), staged.** Full per-field
   `PathLabelTemplate` entries under `/cfc/labels/...` are the end state and
   overlap the SC-4/SC-8 envelope-population design (same machinery — build
   once). The interim rule, implementable now without new persisted metadata:
   a source-bearing field's observation label = the source identity's
   confidentiality when known, else — **for derived-component entries only** —
   the entry's own effective confidentiality (sound because the §8.9.2
   conservative join already contains each influencing source's
   confidentiality; declared/authored entries carry no such containment
   guarantee and stay fail-closed), else fail closed. Computable from the
   entry in hand, no cross-space resolution. `type`/`kind`/presence stay
   public per the default profile. _Note (2026-07-10): the full profile now
   ships — template-population Stage B persists it as multi-`*` templates
   under `/cfc/labels/...` at the same seam that writes the payload entries
   (`cfc-template-population.md` §5/§6). The interim rule remains the label
   SOURCE; the templates are its CARRIER (the labels minted into them), the
   introspection surface resolves them at concrete metadata paths and falls
   back to computing the rule in hand on template-less envelopes, and the
   fail-closed arm is unchanged — declared/authored fields mint nothing and
   a sibling template never re-opens them._
4. **Runtime enforcement reads stay outside the consumed set** (verifier
   reads are not observations — §8.10.1), unchanged. What changes is that
   *application-visible* projections of label metadata always pass through
   (2)'s labeling.

The shipped display redaction (`redactCaveatSourcesForDisplay` at the three
IPC response sites) remains as defense-in-depth for same-space views.
Extending it to the sigil `cfcLabelView` copies in `handleCellGet`/
`subscribe` value payloads is **not safe by itself**: those views round-trip
— `CellHandle.deserialize` preserves the view on the `CellRef`,
`mapCellRefsToSigilLinks` sends it back to the worker, and
`prepareBoundaryCommit` persists `input.cfcLabelView` entries as link-origin
labels — so response-side redaction would persist redacted, under-labeled
views on copy-forward/link writes. The prerequisite (independently
motivated: a round-tripped view is main-thread-influenceable, and today it
is gated only for runtime-minted-integrity forgery) is **re-derivation at
the persist seam**: the worker treats an inbound `cfcLabelView` as an
untrusted display artifact and persists link-origin labels only from its own
authoritative sources (stored source metadata / the worker-side label-view
state), never from the round-tripped copy. Once persistence no longer
consumes inbound views, redacting the outbound copies is safe.

## 4. What this deliberately does not do

- **No label-of-label recursion.** First-layer only, per §4.6.4.1; the
  population profile's labels are runtime-enforced metadata, not
  introspectable payload.
- **No cryptographic audience encryption.** Encrypting envelope fields to the
  clause's reader set would give strong privacy *and* offline evaluation, but
  imports key distribution and revocation machinery the runtime does not
  have; the `reference` form achieves the same authority semantics through
  the existing session/ACL layer. Recorded as the upgrade path if probe-able
  commitments prove insufficient.
- **No existence hiding.** "This path carries *a* label entry" stays
  observable (the spec: "the bare existence of a label entry is usually less
  revealing than the source identities inside it"). SC-4's existence channel
  is a payload-label concern, tracked separately.
- **Schema replication stays.** Content-addressed schema docs continue to
  cross spaces; `ifc` annotations reveal policy *structure*, accepted (they
  are code, not data). Noted so the boundary is explicit.

## 5. Staging

- **Stage 0 (now, no representation change):** remove/redact the `meta:"cfc"`
  IPC seam; make the persist seam re-derive link-origin labels from
  worker-authoritative sources instead of the round-tripped `cfcLabelView`
  (the §3 prerequisite — a hardening on its own); then extend display
  redaction to sigil `cfcLabelView` in IPC value payloads; add the
  classification table as data (no transform yet). Each is small and
  independently shippable, in that order. _Implementation note (2026-07-09):
  shipped — `MetaField` drops `"cfc"` (fail-closed at `handleCellGet`), the
  persist loop re-derives the source's stored label map per link write while
  the IPC ingress stops consuming inbound views, all main-thread-facing view
  copies redact `Caveat.source`, and the §2 table lives at
  `runner/src/cfc/label-field-classification.ts`._
- **Stage 1 (representation):** the cross-space persist transform
  (commitment/public per §2's table) behind a dial
  (`cfcLabelMetadataProtection: off | observe | enforce` — observe computes
  the transformed form and diagnoses divergence without persisting it, which
  is the measurement stage a deployment states when it wants one; the dial
  defaults to `enforce`). Migration: transformed and verbatim envelopes
  coexist (entries are self-describing; a commitment field carries a marker
  wrapper `{digestOf: <hash>}` so consumers dispatch on shape, and SC-11
  equality is computed post-transform). _Implementation note (2026-07-09):
  shipped — the transform lives in `runner/src/cfc/label-representation.ts`
  and runs in `prepareBoundaryCommit`'s persist loop for cross-space-eligible
  entries (link-origin entries when the link source's space differs from the
  target's — covering the re-derived view AND the carried in-value sigil
  `cfcLabelView`; flow-derived stamps when `deriveFlowJoin` consumed a
  labeled foreign observation; ambiguity fails toward protection). Same-form
  matching landed in `atomEntails` (read gating digests the candidate) and
  `matchAtomPattern` (concrete patterns digest-match; variables refuse fresh
  bindings from committed fields — variable-needing rules fail closed at the
  destination; bound-variable unification digest-compares across forms).
  Declared entries persist verbatim (the schema doc replicates to the
  destination regardless — the §4 boundary), as do carried-forward existing
  entries (no envelope rewrite on migration) and the local external-ingest
  mark._
- **Stage 2 (observation):** `inspectConfLabel` + interim population rule +
  the label-metadata observation channel (SC-6 revisit). _Implementation note
  (2026-07-09): shipped (initially in reduced form — §3 items 2–4; the full
  per-field `PathLabelTemplate` profile co-built with SC-4/SC-8, designed in
  [`cfc-template-population.md`](./cfc-template-population.md) — its Stage B
  landed 2026-07-10, upgrading this stage's computed-in-hand labels to
  persisted `/cfc/labels/...` templates resolved at concrete metadata paths,
  with the in-hand rule as fallback on template-less envelopes). The
  §4.6.4.1 evaluator + §4.6.4.2 interim population rule live in
  `runner/src/cfc/label-introspection.ts`: equality predicates over the six
  query fields; first-layer only (a `/cfc/...` target path refuses — payload
  fields literally named `cfc` fail closed on the collision); ONE normalized
  `notAvailable` constant across the unobservable / missing /
  matching-but-unreadable arms; Stage 1 commitment-aware matching with
  verbatim committed projections (a miss over committed fields still
  consumes the per-field labels); population = atom presence/`type`/`kind`
  public, §2-table-`public` fields public, every other present field
  source-protected — the source identity's confidentiality when known (no
  carrier exists yet), else the derived-component (`derived`/`structure`)
  entry's own effective confidentiality, else fail closed. The
  pattern-facing surface is the `inspectConfLabel` BUILTIN
  (`runner/src/builtins/inspect-conf-label.ts`, exposed as
  `commonfabric.inspectConfLabel`): builtins are the one channel pattern
  code has into runtime capability and the node runs inside the observing
  transaction; the target rides `asCell`, so inspecting a label never reads
  the labeled payload; the display path (`getCfcLabel`) is untouched.
  Consumption is a `labelMetadata` observation class beside
  value/shape/followRef, recorded explicitly
  (`recordCfcLabelMetadataObservation`) with the population-rule label and
  folded into `deriveFlowJoin` (confidentiality-only, like followRef), the
  egress consumed set (`collectConsumedLabel`), the per-write input gate
  (`verifyInputRequirements`, at -Infinity like trigger reads), and the
  prepared digest (absent-when-empty); runtime-internal verifier reads stay
  excluded exactly as before. No new dial: the API is additive and
  fail-closed by construction — a result whose evaluation consumed
  protected metadata observations is returned only when
  `cfcFlowLabels: "persist"` under a non-disabled enforcement mode can carry
  the joined label onto the result doc through the normal flow derivation;
  under every other configuration it degrades to the same `notAvailable`
  (never an unlabeled copy of protected label metadata, and the degraded
  arm stays indistinguishable from the hidden ones)._
- **Stage 3 (strong form):** `reference`-form carried labels + per-reader
  materialization; entry criteria: a concrete deployment whose threat model
  includes targeted DID probing, and cross-space resolution latency measured
  acceptable on the shared-profile / group-chat flows. **Federation
  constraint (owner decision 2026-07-10):** the federation design rule is
  *evidence replicates with the data; evaluation is local* (attested
  runtimes enforce locally — reads must never phone the origin to be
  authorized). The `reference` form is origin-coupled by construction —
  label readability rides the source's read authority — so in a federated
  deployment the default stays `commitment`; `reference` is admissible only
  with per-reader materialization proven on realistic flows, and only for
  the highest-sensitivity fields. Grants and `commitment`-form labels
  satisfy the rule as-is. The deployment-config policy source
  (`cfcPolicyRecords`) satisfies it through the ATTESTATION channel rather
  than replication (revised owner decision 2026-07-10, superseding this
  note's earlier "federation-hostile" conclusion; SC-28 in
  [`cfc-spec-changes.md`](./cfc-spec-changes.md)): remote attestation
  covers deployment config for security-sensitive inputs, so attested
  federated peers provably run the same record set — a config difference is
  an attestation difference, never a silent rule divergence. The
  space-hosted policy docs originally scheduled as B2b are descoped; the
  label-carried `Policy(...)`/`Context(...)` selection half of B2b shipped
  against the deployment snapshot (its ref fields classified in the §2
  table: name/hash public so refs stay dereferenceable at the destination,
  subject commitment).

Dependencies: none on Epics B/D/E remainder; Stage 2's full population
profile co-builds with the SC-4/SC-8 envelope design. The D4 value-level
provenance design (`cfc-value-level-provenance.md`) independently *shrinks*
this disclosure surface — a pointwise flow join stamps each written path with
only the atoms that fed it, so fewer A-side atoms reach B's envelopes at all
(today's per-tx global `J` is a broader-than-necessary disclosure, its §1
tension 8).

## 6. Spec-change queue

- §4.6.4.1's known-exposure paragraph upgrades from posture ("MUST treat as
  visible … SHOULD prefer atom forms") to the normative representation rule:
  cross-space persistence of source-bearing fields MUST use a
  classification-governed form (public / commitment / reference), with
  same-form matching semantics and the reference form's `notAvailable`
  collapse.
- §4.6.4.2 gains the interim population rule (effective-confidentiality
  fallback computed from the entry in hand) as a sanctioned partial profile.
- SC-6's exclusion text gets its revisit note discharged (label-metadata
  reads become observations at the introspection surface; verifier reads
  unchanged).
- New SC entry in `cfc-spec-changes.md` recording the classification table's
  initial assignments and the `Space.id`-stays-public-for-§4.9.3 exception.

## Provenance

Runner seams: envelope persist loop + `ensureSchemaDocument`
(`cfc/prepare.ts`), `derivePersistedLinkLabel` + `LinkReference` mint
(`cfc/prepare.ts`), flow join `deriveFlowJoin` (`cfc/prepare.ts`),
`redactCaveatSourceAtom`/`redactCaveatSourcesForDisplay` + the
keep-source-intact scope comment (`cfc/label-view-core.ts`), the three IPC
redaction sites + the open `meta:"cfc"` raw seam
(`runtime-client/src/backends/runtime-processor.ts`), sigil label views
(`cfc/link-label-view.ts`, `cell.ts` `convertCellsToLinks`),
`flowReadExcluded` + S18 write guard (`cfc/prepare.ts`),
`CFC_LABEL_READ_FAILED_ATOM` ungrantable marker (`cfc/observation.ts`),
digest idiom (`cfc/canonical.ts`, `UserSurfaceInput.valueDigest` et al.),
session partitioning (`memory/v2/session-open-auth.ts`), ACL point query
(`runner/src/acl-manager.ts`, `cfc/space-membership.ts`). Spec:
`10-safety-invariants.md` inv-12, `04-label-representation.md` §4.6.4–.5
(storage profile, observation profile, population profile, known-exposure
paragraph), `08-10-validation-at-boundaries.md` §8.10.6 (redacted placeholder
discloses neither value nor label payloads) and §8.10.5 (evidence binding
needs the source), merged §4.9.3 (ACL point query). Labs-side:
[SC-6, SC-14](./cfc-spec-changes.md), audit item 28b and the shipped display
redaction (#4052), Epic C observation classes
([`cfc-observation-classes.md`](./cfc-observation-classes.md), which this
design extends to label metadata).
