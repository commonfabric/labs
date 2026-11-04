import type {
  LabelMapEntry,
  LabelMetadataObservationClass,
  LabelObservationClass,
} from "./types.ts";

// Read-side half of the observation-class design (Epic C stage C1,
// docs/specs/cfc-observation-classes.md §4/§6; spec §4.6.3): every concrete
// runtime read is classified by WHAT it observed, and consumes only the
// labelMap entries whose class matches. The write side (persisting entries
// with explicit `observes`) is stage C2 and must not ship before this reader
// is deployed — a class-unaware reader DROPS link-origin entries instead of
// treating them as covering, so writer-first would under-taint (C0 §9).

/**
 * How a read observed its path (the C0 §4 classification):
 * - `value`: recursive value read — materializes content, which also reveals
 *   presence/type and, for containers, membership.
 * - `shape`: `nonRecursive` read (key-add, length) — observes presence and
 *   cardinality, not element content. Count-shaped reads land here and
 *   consume `enumerate` (the spec's `count` class folds into it, C0 §4).
 * - `followRef`: a link-resolution probe / slot-pointer read without
 *   dereference — observes WHICH reference sits at the slot.
 */
export type ReadObservationShape = "value" | "shape" | "followRef";

/**
 * The label-METADATA observation class (inv-12 Stage 2), beside the payload
 * shapes above. An `inspectConfLabel` evaluation observes the first-layer
 * label metadata subtree (`/cfc/labels/<target-envelope-path>/...`), not
 * payload content, so it is NOT a `ReadObservationShape`: journal reads never
 * classify as it (raw `["cfc"]` reads stay verifier-marked / flow-excluded,
 * SC-6), it consumes no persisted labelMap entry class (its labels come from
 * the §4.6.4.2 population rule, computed from the entry in hand), and its
 * records enter the transaction explicitly
 * (`recordCfcLabelMetadataObservation`) rather than through the journal. The
 * consumed-set/flow consumers fold those records in beside the classified
 * journal reads (`deriveFlowJoin`, `collectConsumedLabel`,
 * `verifyInputRequirements`).
 */
export const LABEL_METADATA_OBSERVATION: LabelMetadataObservationClass =
  "labelMetadata";

export type { LabelMetadataObservationClass };

/**
 * Entry selection for a read: one of the classified shapes, or `"all"` for
 * call sites that deliberately keep the legacy every-entry resolution (the
 * write-gate quantification in `verifyInputRequirements` — over-inclusive is
 * fail-safe for a screen; per-class narrowing there is C4 territory).
 */
export type ReadClassSelection = ReadObservationShape | "all";

// Which entry classes each read shape consumes (C0 §4 table). A covering
// entry (class undefined) is handled separately in `readConsumesEntry`.
const CONSUMED_CLASSES: Record<
  ReadObservationShape,
  readonly LabelObservationClass[]
> = {
  value: ["value", "shape", "enumerate"],
  shape: ["shape", "enumerate"],
  followRef: ["followRef"],
};

/**
 * Every classified read shape, in the order {@link CONSUMED_CLASSES} declares
 * them. That record is typed over the whole union, so a shape added to
 * {@link ReadObservationShape} without an entry there does not compile, and
 * this list cannot fall behind it — which a hand-written array can, silently,
 * for a caller that quantifies over the shapes to prove something about all
 * of them.
 */
export const readObservationShapes = (): ReadObservationShape[] =>
  Object.keys(CONSUMED_CLASSES) as ReadObservationShape[];

/**
 * The consumption class of a persisted entry; `undefined` means covering
 * (consumed by every content read class). Implements the C0 §3 carve-out: a
 * legacy `origin:"link"` entry with absent `observes` is implicitly
 * `observes:"followRef"` — never covering. Without the carve-out, plain
 * value reads would start consuming link-origin pointer labels, breaking
 * the §6 byte-identity contract (and the blind-passing split) on day one.
 */
export const entryObservationClass = (
  entry: Pick<LabelMapEntry, "origin" | "observes">,
): LabelObservationClass | LabelMetadataObservationClass | undefined =>
  entry.observes ?? (entry.origin === "link" ? "followRef" : undefined);

/** Whether a read of the given shape consumes the given entry's label. */
export const readConsumesEntry = (
  selection: ReadClassSelection,
  entry: Pick<LabelMapEntry, "origin" | "observes">,
): boolean => {
  if (selection === "all") {
    return true;
  }
  const entryClass = entryObservationClass(entry);
  if (entryClass === undefined) {
    // Covering entries conflate the CONTENT channels (value/shape/enumerate)
    // of the legacy one-label model; a followRef observation reads the
    // pointer, not the content. Consuming covering entries there would
    // taint the terminal resolution probe of every blind pass-through with
    // the target doc's content label — re-smearing exactly the
    // pointer/content split the S16 substrate (C0 §2) preserves. followRef
    // consumption is still strictly wider than pre-C1 behavior, which
    // consumed nothing for probes.
    return selection !== "followRef";
  }
  if (entryClass === LABEL_METADATA_OBSERVATION) {
    // Persisted label-metadata population templates (template-population
    // Stage B): NO payload read class consumes them — the introspection
    // surface is their only consumer, resolving them explicitly
    // (`resolveLabelMetadataTemplateConfidentiality`). The classified arms
    // above already returned for `"all"`, which deliberately stays
    // over-inclusive (a screen; the templates' content duplicates the
    // payload entries they were derived from, so the write gate sees no
    // new atoms through them).
    return false;
  }
  return CONSUMED_CLASSES[selection].includes(entryClass);
};
