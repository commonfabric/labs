# CFC template population — closing SC-4/SC-8 with `*`-path class entries

_Design for the envelope persistence/population piece `cfc-spec-changes.md`
tracks with SC-4/SC-8 ("the open part of that build is the envelope
persistence/population design") and that inv-12 Stage 2's full profile
co-builds with (`cfc-label-metadata-confidentiality.md` §5 — "same machinery,
build once"). Grounded in spec §4.6.3 `PathLabelTemplate`, §8.5.6.1,
§8.10.1.1, §8.12.8, and the shipped runner machinery at origin/main
`62048eeeb`. Written 2026-07-10 under the standing autonomous directive._

## 1. The two under-taints, demonstrated from code

Membership and slot observations ride *compactions* today, and two reads
escape them:

1. **Per-child existence probe.** "Is `/items/3` present?" is, per spec
   §8.10.1.1, a `shape` read **at the child**. The runner's membership stamp
   is container-anchored — `{path: ["items"], origin: "structure",
   observes: "enumerate"}` — and structure entries apply only at exactly
   their own path (`labelForEntriesAtPath`'s
   `origin === "structure" && entry.path.length !== path.length` skip;
   the same exact-path rule in `collectConsumedLabel`). The probe's read at
   `["items","3"]` is neither exact-path nor an ancestor of the stamp, and
   no per-child `shape` entries exist — nothing mints them. The probe
   consumes only frozen doc-level existence entries; the membership `J`
   (the filter predicate's taint, which decided whether slot 3 survived)
   is never consumed.
2. **Pointer identity at a slot.** *Which* element sits at `/items/3`,
   observed by materializing the reference scalar without dereferencing, is
   per spec §4.6.3's ref-container rule a `value` observation of the
   reference scalar at the slot. A `followRef` read consumes only the
   per-slot link entry (the *target's* transport label); the coordinator
   `J` that *assigned* the slot lives only in the container-anchored
   structure entries — wrong path, wrong class, never consumed. Recorded as
   the SC-7 implementation note's residual.

Both were accepted because the spec-conforming fix — per-slot `shape`
entries (§8.5.6.1: "child paths like `/items/0` carry `shape`
(membership/domain) and `value` (member payload)") — was priced as the
per-row entry-count cost (#3998) and parked.

## 2. The insight: both template axes already exist; nothing mints their product

Two facts from the current code dissolve most of the anticipated build:

- **The spec's template dimension** is per-observation-class labels at a
  path with recursive `children` descent (§4.6.3 `PathLabelTemplate`,
  replace-down per class). The runner already implements the class axis as
  *additive sibling entries* — `LabelMapEntry.observes` — a shape C0
  deliberately chose over a template-shaped mega-entry (wire-compat +
  resolution reuse; `cfc-observation-classes.md` §3).
- **The runner's own template dimension already exists in the wild**: the
  schema walk descends `items` as a literal `"*"` segment
  (`walkIfcSchema`), declared entries persist with the `*` verbatim, and
  `isPrefix` matches `*` bidirectionally in `labelAtPath`,
  `effectiveReadLabel`, `collectConsumedLabel`, and the write-cover
  predicates. `*`-path entries are not a new wire form — old readers
  already resolve them.

What no code path produces is the **cross product**: a *runtime-minted*
(`structure`/`derived`-origin) entry at `[...container, "*"]` carrying a
per-class label. That combination is the whole fix:

```text
Shown for illustration only.
{ path: ["items", "*"], label: {confidentiality: J}, origin: "structure", observes: "shape" }
{ path: ["items", "*"], label: {confidentiality: J}, origin: "structure", observes: "value" }
{ path: ["items", "*"], label: {confidentiality: J}, origin: "structure", observes: "followRef" }
```

One entry per class per container — O(1) in the container's size — where
the spec's naive encoding needed O(n) per-slot records. The child-probe
read (`shape` class at `["items","3"]`) resolves the `shape` entry
through `isPrefix` as an equal-length match; a raw sigil-materialization
read (`value` class at the slot) resolves the `value` twin; and — because
the runner classifies slot-pointer observations as `followRef`
(`isLinkResolutionProbe` → `followRef` in `forEachFlowObservation`;
observation-classes §4/§7) — the **`followRef` twin is what actually
closes the pointer-identity residual**: a probe or dereference at a
computed slot consumes the assignment decision (`J` decided *which*
element the reader resolves through — inv-9 flow-path confidentiality),
while still consuming nothing of the container's *content* classes and
nothing of the target beyond its own link entry. The pointer/content
split that today hangs on the exact-path anchoring hack moves onto the
class axis, where it belongs — refined, not dissolved: probes stay clean
of content taint (`shape`/`value` templates are not followRef-consumable)
but carry the slot-assignment taint they genuinely depend on. One caution
is inherited from the reactive-interpreter work, where over-tainting
probes has bitten before (list-root reads misclassified as probes): the
followRef template must carry only the membership `J`, never the
container's value-class label, and Stage A must run the S16
filter/group-chat integration flows to catch over-taint regressions
before merge.

## 3. Entry semantics

### 3.1 Minting

- **Membership/slot templates** (the SC-8 fixes): wherever the runner
  today stamps a container-anchored
  `{origin:"structure", observes:"enumerate"}` entry (pure-link-structure
  writes; the S16 list-coordinator `recordCfcStructureContainer` hook), it
  additionally mints the two `*`-child entries above from the same per-tx
  `J`, under the same replace-from-criteria discipline (#4546): dropped
  and restamped from current `J` each reconcile, cleared (never pooled) on
  covering writes. The container-anchored `enumerate` entry stays — it is
  the container-level `iterate` observation (order/count), correct as-is.
- **Metadata population templates** (Stage-2 full, §6): the same entry
  form under `/cfc/labels/<target-path>/...` — §5 below.
- **Declared `*` entries** (from `items` schemas) are unchanged; this
  design adds a runtime mint of the same form, not a new form.

### 3.2 Resolution and precedence

- Class filtering is `readConsumesEntry`, unchanged: `shape`-class reads
  consume `shape`+`enumerate` entries; `value` reads consume
  `value`+`shape`+`enumerate`; `followRef` reads consume only `followRef` —
  so slot templates never taint blind pass-through resolution (the
  types.ts:194-199 property, preserved by class rather than by path
  anchoring).
- Within one origin and class, `labelAtPath` replace-down applies with
  concrete-more-specific-than-`*`: a concrete entry at `/items/3` replaces
  the `*` template for that slot (§4.6.3: "a more specific template
  **replaces** the inherited value for that class"). Two deliberate
  exceptions, both fail-toward-taint:
  1. **Frozen existence vs membership templates.** A frozen
     (`freeze-at-creation`) concrete `shape` entry records *departed
     history*; the `*` membership template records *current shape*. They
     answer different questions under one class, so where both cover a
     read, their labels **join** rather than replace — replacing would let
     a stale frozen label mask current membership taint or vice versa.
     Implementation: the join is scoped to structure/derived-origin
     `shape`-class collisions between a `*` entry and a concrete entry;
     everything else keeps replace-down.
  2. **`collectConsumedLabel` stays additive** (it already joins every
     overlapping entry; templates just participate).
- The exact-path structure skip in `labelForEntriesAtPath` /
  `collectConsumedLabel` is **retained for concrete structure entries**
  (container-anchored stamps keep today's semantics) and does not apply to
  `*`-path structure entries (their whole point is child-path
  consumption). This makes the change purely additive for existing
  entries.

### 3.3 Canonicalization, idempotence, transform — no changes required

Verified against the current seams: `canonicalizeCfcMetadata` sorts by
(pointer-encoded path, origin, observes) — `*` is a literal segment;
`coalesceLabelEntries` keys on (origin, observes, pathKey) — templates
coalesce correctly with themselves and never with concrete siblings; the
SC-11 skip compares post-canonical bytes — templates are re-derived
deterministically from `J` like every other stamp; the Stage-1
representation transform walks only `label` content and tracks
cross-space eligibility by entry identity (`markFlowStampEntry`) — template
entries opt in at mint exactly like the container stamps they accompany.
The one hard rule: **templates carry a plain `IFCLabel` under `label` and
nothing else** — any richer per-class or recursive-`children` field on the
entry is invisible to canonicalization and is thereby banned from this
design (that is C0's rejection, kept).

### 3.4 What templates are NOT for (the #3998 boundary)

Templates carry **class-of-path-uniform** labels: one label for "every
child of this container this reconcile." Per-slot-*varying* labels (each
row its own confidentiality) remain what they became in Phase 3: per-row
documents with their own envelopes (`row-label.ts` rules evaluated at
observation time). The two compose — a row-set container gets membership
templates; each row doc keeps its per-row label — and the design
explicitly does not attempt varying labels under one template.

## 4. Object containers: the `additionalProperties` gap

Arrays have a template spelling (`items` → `*`); record-keyed containers
have none — `walkIfcSchema` does not descend `additionalProperties` at
all, so "every child of this map" is inexpressible even as a declared
label. This design extends the schema walk: `additionalProperties`
(schema-object form) descends as the same `*` segment — **restricted to
record-only objects (no named property; an empty `properties: {}` names
no key, so every key is a properties miss and it stays record-only —
settled on the Stage-A PR review)**. The restriction is
load-bearing: `isPrefix`'s `*` matches *any* segment, but
`additionalProperties` semantically covers only keys *not* listed under
`properties` (the runner's own `schemaAtPath` traversal consults
`additionalProperties` only on a `properties` miss) — an unrestricted `*`
entry from a mixed schema would over-taint the named fields. Mixed
fixed-plus-record-tail schemas therefore remain template-inexpressible
for now; expressing them would need exclusion semantics on the entry,
which §3.3's plain-`IFCLabel`-only rule forbids. Record-only maps (the
per-user/group-chat shapes) get the spelling arrays have, and the runtime
mints of §3.1 stay uniform across both container kinds. (`count` stays
folded into `enumerate` per C0; the spec's separable `iterate.count` is
noted for the owed §4.6.3 spec-table PR, not resurrected here.)

## 5. Stage-2 full population on the same form

The §4.6.4.2 full profile addresses per-clause/per-alternative/per-field
metadata paths
(`/cfc/labels/value/body/confidentiality/clauses/0/alternatives/0/source`).
Materializing those concretely is the same entry-count wall one level up.
With multi-`*` templates (segment-wise `isPrefix` already handles several
wildcards in one path), the field-precise profile is a handful of entries
per labeled target path:

```text
Shown for illustration only.
/cfc/labels/value/body/…/clauses/*/alternatives/*/source   → source-field label (per §4.6.4.2 rule)
/cfc/labels/value/body/…/clauses/*/alternatives/*          → whole-atom projection label (join of fields)
/cfc/labels/value/body                                     → presence/type/kind (public unless policy says else)
```

populated at the same persist seam that writes the payload entries,
consumed by the Stage-2 introspection surface (`inspectConfLabel`'s reads
land at concrete metadata paths and resolve templates like any other
read). The interim rule (entry's-own-label fallback for derived
components) remains the label *source*; templates are the label *carrier*
— upgrading precision later (true per-source labels) changes the labels
minted into the same entries, not the mechanism.

## 6. Staging, tests, and measures

- **Stage A (substrate + SC-8 fixes; one PR):** the three `*`-child mints
  at the structure-stamp sites, the shape-class join exception (§3.2.1),
  the record-only `additionalProperties` walk, red-first tests: the §1.1
  probe consumes membership `J` (red on main today — write it first and
  confirm the under-taint); the §1.2 slot observation consumes the
  assignment `J` through the `followRef` template (and a raw sigil `value`
  read through the `value` twin); a slot `followRef` consumes NO
  content-class template and nothing of the target beyond its link entry
  (the refined split, pinned); a mixed properties+additionalProperties
  schema mints no `*` entry (the §4 restriction, pinned); the S16
  filter/group-chat integration flows green (probe over-taint guard);
  frozen+template join; replace-from-criteria restamp; SC-11 recompute
  no-op with templates present; Stage-1 transform applies to template
  labels; declared `*` entries byte-identical (regression); coalescing +
  canonicalization property tests with multi-`*` paths.

  **Implementation note (Stage A landed).** Shipped in
  `packages/runner/src/cfc/prepare.ts` + `types.ts` with the full test
  list in `packages/runner/test/cfc-template-population.test.ts` (both
  §1 under-taints red-first on main: the child probe joined nothing, the
  slot probe joined only the transport label). Two measured refinements
  against the §2 caution, both found by the phase-B pointwise suite —
  the same arbiter that forced the C0 §6.1 refinements:

  1. **Template mints ride the DECLARED coordinator route only** (the S16
     `recordCfcStructureContainer` containers — filter/flatMap results,
     where the §8.5.6.1 membership decision lives), not the generic
     pure-link value-write route. Minting on every pure-link write puts
     templates on the runtime's own builder/coordination plumbing (alias
     shells, internal arrays), and the op-instantiation machinery reads
     those docs' child paths (slot scalars, `length`) as scaffolding with
     no distinguishing journal marker — neither probe-classified nor
     trace-covered — so each reconcile's `J` smeared into the next
     (measured: `cfc-flow-pointwise` map). The generic route keeps
     today's container-anchored stamps; extending mints to it needs a
     machinery-read marker first (recorded as the remaining slice of the
     SC-8 residual in `cfc-spec-changes.md`).

     **Update (SC-8 remainder closed).** The generic route now mints too —
     §3.1's "both routes" holds as designed. The enabling piece is the
     `machineryRead` marker (`reactivity-log.ts`, the
     `schedulerDependencyRead` family): the op-instantiation/wiring
     machinery's reads — node-IO binding's write-redirect walk, static
     redirect-target collection, dependency seeding's input/output
     materialization, `sendValueToBinding` result plumbing, and the list
     coordinators' container scaffolding (the `probeScoped` scopes,
     `exposedResultCell`'s identity reads) — carry the marker via ambient
     read-meta scopes and are excluded from `*`-template consumption in
     `deriveFlowJoin` ONLY: marked reads keep their ordinary consumption
     (link-origin pointer labels, concrete structure/derived entries), so
     their flow contribution is byte-identical to pre-template behavior
     and the exclusion cannot under-taint relative to before. The
     seam placement mirrors `schedulerDependencyRead` (flow derivation
     only; the egress/observation-gate consumed sets stay deliberately
     over-inclusive — screens keep the fail-safe direction). Stamp
     discipline: only scopes whose every read the machinery itself issues
     are marked — pattern/handler code never runs inside a marked scope
     (over-marking an application observation would under-taint, the
     forbidden direction; a missed machinery read merely leaves residual
     over-taint). The re-smear scenario is pinned green by the
     `cfc-flow-pointwise` map test running with the generic route on;
     the non-coordinator closures and the marked-reads-consume-nothing
     asymmetry are pinned in `cfc-template-population.test.ts` ("SC-8
     remainder" block).
  2. **Two machinery boundaries on template consumption**, both
     inherited-from-existing disciplines rather than new semantics: a
     transaction re-deriving a container's membership stamps does not
     consume the very entries it replaces (`ownRestampContainerPaths` —
     otherwise an incremental reconciler's readback of its own previous
     output turns §8.12.8 replace-from-criteria into accumulate-forever,
     measured on the no-write re-stamp test), and reads covered by a
     same-tx dereference trace skip templates (the C0 §6.1 row-4
     machinery rule extended to the plain reads resolution journals at
     followed slots; standalone observations — the row-3 SC-8 closures —
     consume in full). Consequence of the second: a full dereference
     consumes the target's content but not the slot's membership `J`;
     §2's "probe **or dereference**" overstated what the shipped row-3/
     row-4 boundary distinguishes, and the probe/standalone-read half is
     what landed.
- **Stage B (Stage-2 full population; one PR, after A):** the
  `/cfc/labels/...` template mints per §5 + `inspectConfLabel` consuming
  them (upgrading WP7's computed-in-hand labels to persisted templates),
  per-field tests from the §4.6.4.2 example, SC-25 tail updated.

  **Implementation note (Stage B landed, 2026-07-10, #4660).** Shipped in
  `packages/runner/src/cfc/label-metadata-population.ts` (mint derivation +
  wildcard resolver) wired into the `prepare.ts` persist seam and the
  `label-introspection.ts` consumption, tests in
  `packages/runner/test/cfc-template-metadata-population.test.ts`. Entry
  form: `origin:"label-metadata"` with `observes:"labelMetadata"`, plain
  `IFCLabel` under `label` per §3.3. The dedicated ORIGIN because the origin
  axis is the update-discipline axis and these entries' discipline — a pure
  function of the payload entries in the SAME envelope, re-derived from the
  final entry set at every persist (never carried forward) — is none of the
  existing ones; it buys replace-on-overwrite / cleared-with-the-described-
  entry / SC-11-no-op by construction and keeps every derived/structure-
  keyed persist rule (freeze-carry, SC-4 pooling, writer-fit selection,
  restamp drops) ignoring them without carve-outs. The Stage-2 observation
  CLASS on the `observes` axis because `readConsumesEntry` then already
  yields the needed consumption table: no payload read class consumes them —
  the introspection surface is the only consumer (the deliberately
  over-inclusive `"all"` write-gate selection may, harmlessly: template
  content duplicates the payload entries it derives from). Per labeled
  target path: the whole-atom template plus one per-field template per
  DISTINCT protected top-level field name (deeper protected content —
  nested atoms behind public wrapper fields, array elements, bare
  commitment markers — rides the whole-atom template only); templates
  derive AFTER the Stage-1 representation transform, so committed forms
  carry through identically. Two measured semantics notes: (1) the §4.6.4.1
  metadata addressing concatenates clause indices across the entries stored
  at one path, so coalescing JOINS same-path payload entries' population
  labels (the C2 value/shape split) into one per-path template —
  fail-toward-taint vs the per-entry in-hand rule, exact on the
  single-source-bearing-entry common case (agreement pinned by test); (2)
  consumption keeps the containment gate FIRST — a persisted template never
  re-opens a declared/authored sibling's fields — and falls back to the
  computed-in-hand rule on template-less (pre-Stage-B) envelopes, which
  also heals the mixed-version residual (an older runtime rewriting payload
  entries carries stale templates forward; the next Stage-B-runtime persist
  re-derives them). Recorded `labelMetadata` observations now reference the
  CONCRETE consulted clause/alternative metadata paths rather than the
  subtree root.
- **No new dial.** Template mints ride the existing dials of the stamps
  they accompany (`cfcFlowLabels` for flow-derived structure stamps); the
  new entries are additive taint (fail-safe direction). If review finds a
  compat risk, the fallback is gating the *mint* (not the resolution)
  behind `cfcFlowLabels: "persist"`, which it already effectively rides.
- **Measures:** envelope entry counts per container before/after (expect
  +2 per structure-stamped container, independent of length); the
  under-taint tests as the correctness metric.

## 7. Spec-change queue

_Applied to the spec 2026-07-10 (specs 31220671 + 75d97ec9: the §4.6.3
read-API table, the template conformance note incl. the join rule and the
record-only restriction, and the §8.12.8 shipped-with-scope rewrite)._

- The owed **§4.6.3 read-API → class table** (SC-8's "file it once C1
  validates the mapping in code" — long since validated) should ship
  together with a normative note that a conforming implementation MAY
  carry `PathLabelTemplate` semantics as additive per-class entries with
  wildcard child segments (the entry-form equivalence §4.6.4's
  "Implementations may avoid storing redundant path templates" already
  gestures at), including the frozen-vs-membership join rule of §3.2.1 —
  the one place this design *interprets* rather than implements the spec
  (§8.5.6.1's per-child `shape` conflates "exists" with "survived the
  filter"; the join is the sound reading).
- SC-4 and SC-8 close (their residual paragraphs updated) when Stage A
  merges; SC-25's Stage-2 tail updates when Stage B merges.

## Provenance

Spec: §4.6.3 (`PathLabelTemplate`, replace-down, the primitive read
profile and ref-container rule), §4.6.4/.1/.2 (envelope embedding,
metadata-subtree reuse, field-precise population + interim fallback),
§8.5.6.1 (member vs structural; the per-child encoding), §8.10.1.1
(activity ops; child probes are `shape` at the child), §8.12.8 (component
disciplines; the existence residual naming `PathLabelTemplate`). Runner
(origin/main `62048eeeb`): `cfc/types.ts` `LabelMapEntry`/origins/class
axis + the structure doc comment; `cfc/observation-classes.ts`
(`CONSUMED_CLASSES`, the followRef carve-outs); `cfc/prepare.ts` —
`isPrefix` wildcard matching, `labelForEntriesAtPath`/`labelAtPath`
replace-down + the structure exact-path skip, `collectConsumedLabel`,
`walkIfcSchema` (`items` → `*`; no `additionalProperties`),
`pureLinkContainerPaths` + the S16 coordinator hook, the C2 per-class
persist split, freeze-at-creation + pooling arms, `coalesceLabelEntries`,
the SC-11 skip, the Stage-1 transform seam (`markFlowStampEntry`);
`cfc/canonical.ts` entry sort. Labs docs: `cfc-observation-classes.md`
(C0's template-entry rejection — kept for the class axis, inapplicable to
the path axis), `cfc-spec-changes.md` SC-4/SC-7(note)/SC-8/SC-25/SC-28,
`cfc-label-metadata-confidentiality.md` §5 (co-build), the #3998 per-row
lesson (templates = uniform labels only; varying labels = row docs).
