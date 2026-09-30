# CFC observation classes (`PathLabelTemplate`)

This document describes the runner's observation-class mapping for
`commontoolsinc/specs` `cfc/04-label-representation.md` §4.6.3 (the primitive
read profile) and §4.5.2. Related spec clarifications are recorded as SC-4 /
SC-8 in [CFC spec changes](cfc-spec-changes.md). Reference acquisition and
metadata compatibility are defined in [CFC references](cfc-references.md).

## 1. Problem

Reads of one path can observe different channels: `value`, `shape`
(existence/type), `enumerate` (membership/keys/length/order), `count`, and
`followRef` (which reference sits at a slot). Observation classes keep the
labels for those channels separate:

- **SC-4 — existence channel.** Replacing a derived value label on overwrite
  (§8.12.8) preserves the separate label for the path's creation. Deleting and
  re-creating the path establishes a new creation label (§5).
- **SC-8 — pointer-identity-at-a-slot.** Reading _which_ reference sits at a
  slot without dereferencing it consumes that slot's `followRef`
  confidentiality. Following it also consumes the observations made at the
  target; target content labels do not label an independently held reference.

Each observation contributes its confidentiality to the attempt's flow join.
Reference relationship evidence does not endorse the referenced contents.

## 2. Runtime representation

- **Provenance on the persisted entry.** `LabelMapEntry.origin` (`declared` |
  `link` | `derived` | `structure` | `external-ingest`,
  `packages/runner/src/cfc/types.ts`) tags _update discipline_. This is
  independent of the `observes` consumption axis.
- **Read classification.** `IReadActivity.nonRecursive` (`storage/interface.ts`)
  marks shape-only observations (key-add, length); `linkResolutionProbe`
  (`storage/reactivity-log.ts`) marks "is there a link here?" probes.
  `forEachFlowObservation` classifies those probes as `followRef`, and
  `deriveFlowJoin` consumes their reference confidentiality.
- **Read-side label resolution.**
  `effectiveReadLabel(metadata, logicalPath, { nonRecursive, consumes })`
  (`prepare.ts`) selects entries by observation class and resolves the labels at
  the read path. Recursive reads also join matching descendant entries.
- **The `structure` origin labels container membership** at exact paths
  (`prepare.ts` persist region), applying to reads _at_ the container path and
  to recursive ancestor reads, never to reads strictly below it (per the
  `types.ts` component contract and the SC-7 note in `cfc-spec-changes.md`).

## 3. The `observes?` axis

Persisted entries carry an optional consumption axis, independent of `origin`:

```ts
// Shown for illustration only.
type LabelObservationClass = "value" | "shape" | "enumerate" | "followRef";

type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin?: LabelEntryOrigin; // update discipline
  observes?: LabelObservationClass; // consumption class; absent = covering
};
```

- **`origin` stays the update-discipline axis; `observes` is the consumption
  axis.** They are independent: a `derived` entry can be `observes:"value"`, a
  `structure` entry `observes:"shape"`, etc.
- An entry without `observes` covers the content observation classes.
- A legacy `origin:"link"` entry without `observes` has the `followRef`
  consumption class. Materializing a subtree exposes its contained references
  and consumes this class too. Precise reference acquisition requires the
  provenance and compatibility rules in [CFC references](cfc-references.md).

Entries with separate classes share the same path-label resolution machinery.
Each component retains its own update discipline when entries are coalesced.

## 4. Read-classification table (the SC-8 normative mapping)

Which observation class(es) each concrete runtime read consumes at its path. A
read consumes the join of every entry whose class is in its consumed set:

| Runtime read                                         | Consumes classes                                                         | Notes                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| recursive value read                                 | `value` + `shape` + `enumerate` + `followRef`                            | materializing a subtree exposes contained values and reference identities                  |
| `nonRecursive` read (key-add, length)                | `shape` + `enumerate`                                                    | observes presence/cardinality, not element content                                         |
| `linkResolutionProbe` / slot-pointer read (no deref) | `followRef`                                                              | consumes reference confidentiality at the slot, without consuming target content           |
| dereference (follow a ref to its target)             | reference restrictions at every hop, then the target observation classes | traces record topology; actual reads and held-reference observations determine consumption |

Materializing a scalar through `Cell.get()`, a query-result proxy, or a schema
view records a value observation. A shallow read used to find the scalar does
not replace that observation. Container key and presence probes retain their
shape classification. Live property descriptors expose getters, so enumerating
keys need not materialize the values; invoking the getter consumes the value.
Schema-view optional-property checks use shape alone for exact stored-kind
schemas (`string`, `number`, `boolean`, `null`, or `undefined`). Integer checks
inspect numeric payloads and retain value observations, as do other projections
outside that set. See
[reflection on lazy views](../features/lazy-cell-materialization.md#reflection-observes-properties-lazily).

The `followRef` observation remains in the flow join even when the attempt
subsequently dereferences the same slot. A runtime-owned bookkeeping marker can
exclude its own machinery reads; the probe marker itself grants no exemption.

Two runtime reads have no row here, though the walk classifies them like any
other: the stream-marker probe the write path makes to choose between an
event send and a stored write, and the diff's read of the address it is about
to write. `deriveFlowJoin()` drops them after classification, so neither
consumes any of the classes above, and the walk's other consumers see them
unchanged. Per §18.6.2 each is a runtime-internal read rather than a handler
observation —
[`cfc-write-destination-reads.md`](./cfc-write-destination-reads.md) covers
them.

**Where `count` went.** The spec's fifth class (§4.6.3) deliberately does not
get its own axis value: a count observation (cardinality without membership) is
strictly weaker than `enumerate`, so count-shaped reads (length, `COUNT`)
consume the `enumerate` class — a sound over-approximation. A distinct `count`
value is additive later if a consumer ever needs the precision (e.g. releasing a
count more widely than membership).

## 5. SC-4: existence freezes, value replaces

On a value overwrite:

- **`observes:"value"` derived entries are replaced** by the committing
  attempt's derivation — the §8.12.8 replace-on-overwrite rule. A less-tainted
  recomputation legitimately lowers the _value_ label.
- **`observes:"shape"` (existence) entries freeze at creation**: minted once
  with the creating attempt's join (legacy pre-class entries are absorbed at the
  one-time migration, conservatively over-attributed to the first labeled
  stamping), never cleared and never grown by overwrites of a still-existing
  path. Soundness: a writer conditional on existence journals that observation
  itself (§8.10.1/§8.9.2). **Delete + re-create re-mints**: §8.12.8 makes
  re-creation a fresh creation event — the frozen entry is REPLACED at the
  re-creating attempt's join (`recreate_remints` in the spec's
  `formal/Cfc/StoreExistence.lean`), since carrying the stale join would
  UNDERSTATE the re-created path's existence channel, the direction the spec
  forbids. The carry in `prepare.ts` refuses a frozen entry whose path shows the
  per-path transition absent-before → present-after against the recorded writes'
  pre-transaction snapshots (`previousValue`, probed relative to each write's
  materialization point; the probes walk own-key PRESENCE — a slot holding
  `undefined` is present, per the storage patch layer — and at the recorded path
  itself the detail's `previousPresent` flag decides, with value-definedness as
  the fallback for transactions that do not provide it), and a replacement mints
  at the entry's own path with the current join — empty join mints nothing (a
  cleanly re-created path's existence is public; pre-deletion observations stay
  protected by their journaled reads). Remaining residual: deletion alone leaves
  the frozen entry in place until a re-creation (over-taint, the fail-safe
  direction — documentable).
- **`origin:"structure"` membership stamps are `observes:"enumerate"`**,
  replace-from-criteria per §8.12.8 (normative — its rationale names and rejects
  accumulate-forever). Axis-mapping note: the labs `observes` axis is read-op
  shaped, so labs `enumerate` at a container approximates the spec's
  container-level `iterate.{order,count}` label classes; the spec's per-child
  `shape` encoding of membership is a recorded residual (see SC note in
  `cfc-spec-changes.md`: a static per-child existence probe does not consume the
  container-anchored stamp).
- Cleared `link` entries never fold (pointer labels; folding them into content
  shape would re-smear the pointer/content split). Legacy migration conf not
  covered by any stamp path lands as a frozen shape entry at the shallowest
  covering written path, or the entry's own path.

Existence entries carry confidentiality only. They do not carry the creating
attempt's integrity into the hereditary meet: a shape observation does not
certify contents. The value entry carries both confidentiality and integrity;
membership stamps additionally retain the `TransformedBy` attribution common to
their writers; that attribution is not hereditary content certification.

## 6. What `deriveFlowJoin` consumes per read shape

`forEachFlowObservation` (`prepare.ts`) classifies application reads as value,
shape, enumeration, or reference observations and selects compatible entries.
Reference probes consume the slot's reference confidentiality. Materializing a
value through a reference consumes both that restriction and the current target
content labels. Explicit identity observations and held-reference history also
contribute to the join; a later dereference trace does not erase them.

Trusted coordinator machinery may exclude its own bookkeeping reads. This
exemption follows the runtime-owned marker, not the shape of the resulting
write. A generic pass-through or container rewrite therefore retains semantic
selection observations even when all of its written leaves are references.

### 6.1 Reference and content boundaries

The class selection in `cfc/observation-classes.ts` and the flow derivation in
`prepare.ts` enforce three boundaries:

- **Journal followRef probes consume only followRef-class entries — covering
  entries are content.** §3's absent-`observes` default covers the content
  classes (`value`/`shape`/`enumerate`) only. A followRef observation reads a
  pointer, not content: letting it consume covering entries would taint the
  terminal resolution probe of every blind pass-through with the target doc's
  content label, re-smearing the §2 pointer/content distinction. Trusted
  reference acquisition additionally retains the source slot's applicable
  confidentiality declarations and acquisition history in the held reference.
  Those restrictions contribute through explicit reference observations; they do
  not turn a terminal journal probe into a target-content observation.
- **A dereference trace does not erase a semantic observation.** A pointer
  comparison remains a dependency when a later read follows the same reference.
  Application traversal consumes each hop's reference restrictions. Trusted
  wiring can mark its own bookkeeping reads as machinery; application code does
  not execute in that scope.
- **Reference evidence does not endorse content.** Reference probes contribute
  confidentiality without crediting their relationship integrity as content
  evidence. A confidential held-reference observation contributes a dependency
  with no content endorsement to the hereditary integrity meet. Relationship
  evidence remains on the reference component.

- **An `enumerate` entry applies at its container only.** It labels a
  container's membership, order and count, so it is consumed by a read of
  the container. A read of an array's native `length`, which the journal
  records beneath the array, is also measured as a shape read of the array;
  a verifier probe of the parent tells an array from an object with a field
  named `length`, and a machinery-marked read is left as it is. It is not
  consumed by a read of one child, which observes that child: longest-prefix
  resolution would otherwise put the membership of every element on a read
  of any one of them. A concrete `structure` entry takes the same exact-path
  rule, and a recursive read of an ancestor consumes either.

## 7. Observation ceiling (LLM path) and render

Observation ceilings and rendering use the §4 classification and path-label
resolution for the observations they expose:

- **LLM observation ceiling (`llm.ts` / llm-dialog).** Serializing a value into
  a prompt or tool context is a **recursive value read**: the ceiling fit
  consumes `value + shape + enumerate + followRef` entries at each serialized
  path, including held-reference restrictions. **Opaque link handles**
  (`cfcOpaqueLinkForPath`): rendering WHICH reference sits at a slot without
  dereferencing it is a `followRef` observation, so an opaque handle consumes
  the link entry's `followRef` label only — not the target's `value` label. An
  opaque handle to a secret document taints the prompt with the reference's
  acquisition and selection restrictions. The ceiling-fit path uses the same
  class-selection helper as `forEachFlowObservation`.
- **Render label views** consume per-class the same way: a public `value` read
  of a child does not inherit an exact-path container `structure` label.

## 8. Implementation

1. **Read classification.** `forEachFlowObservation` classifies observations;
   `effectiveReadLabel` selects matching entries, including `followRef` for
   reference probes and recursive value reads.
2. **Persistence.** Derived values use `observes:"value"`, existence uses
   `observes:"shape"`, and container membership uses
   `origin:"structure", observes:"enumerate"`. Each follows §5's discipline.
3. **Consumers.** Observation ceilings, render views, and SQLite label
   derivation select the classes their operations consume.

## 9. Reader compatibility

Compatibility depends on which observation classes a reader understands:

- **`value` / `shape` / `enumerate`.** A class-unaware reader that treats these
  entries as covering consumes a conservative superset of their labels.
- **`followRef`.** Readers that exclude reference probes or link-origin entries
  cannot enforce reference confidentiality. Deployments require class-aware
  readers before enabling writers that rely on those restrictions. Precise
  reference writers also require the version-3 metadata compatibility rules in
  [CFC references](cfc-references.md).

## Provenance

The implementation lives in `cfc/types.ts` (`LabelMapEntry`/`LabelEntryOrigin`),
`storage/interface.ts` (`IReadActivity.nonRecursive`),
`storage/reactivity-log.ts` (`linkResolutionProbe`), and `prepare.ts`
(`forEachFlowObservation`, `effectiveReadLabel`, `deriveFlowJoin`, the persist
region). Residuals SC-4 / SC-8 are from `cfc-spec-changes.md`.
