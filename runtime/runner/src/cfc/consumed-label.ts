/**
 * How the entries of a stored label map resolve into the label of a read: what
 * a read at a path consumes, and the one label that stands for it. These are
 * pure functions of the entries. They have their own module so that a reader
 * outside the runtime that shows a stored value resolves its label by the
 * runtime's code without loading `prepare.ts` and the transaction machinery it
 * reads.
 */

import { uniqueCfcAtoms } from "./atoms.ts";
import type { ConsumedLabelIndex } from "./consumed-label-index.ts";
import {
  type ReadClassSelection,
  readConsumesEntry,
} from "./observation-classes.ts";
import { isPrefix } from "./path-prefix-index.ts";
import type { CfcMetadata, IFCLabel, LabelMapEntry } from "./types.ts";

// A runtime-minted `*`-path class template (template-population §3.1): the
// membership/slot twins minted beside the container-anchored structure
// stamps (and any future derived-origin population entries of the same
// form). Declared `*` entries (items/additionalProperties schemas) are NOT
// templates in this sense — they keep the declared component's resolution
// untouched.
export const isRuntimeMintedTemplate = (
  entry: Pick<LabelMapEntry, "path" | "origin">,
): boolean =>
  (entry.origin === "structure" || entry.origin === "derived") &&
  entry.path.includes("*");

/**
 * Returns whether `entry` applies to a read at exactly its own path and not
 * to a read below it: a concrete `structure` entry, which labels a container
 * node's shape, and an `enumerate` entry, which labels a container's
 * membership. A recursive read of an ancestor still consumes either, since it
 * materializes the container. `template` says whether the entry is a
 * runtime-minted `*` template, which is consumed at the children it matches.
 */
export const appliesAtItsPathOnly = (
  entry: Pick<LabelMapEntry, "origin" | "observes">,
  template: boolean,
): boolean =>
  entry.observes === "enumerate" ||
  (entry.origin === "structure" && !template);

export const labelForEntriesAtPath = (
  entries: readonly LabelMapEntry[],
  path: readonly string[],
): IFCLabel | undefined => {
  // Per-component longest-prefix resolution: within one origin component a
  // more specific entry replaces its ancestor (§4.6.3 replace-down), but
  // components layer independently, so the effective label is the join of
  // each component's most-specific ancestor-or-equal entry. Legacy entries
  // (no origin) form one combined component, preserving the historical
  // single-map resolution for pre-component metadata.
  const matches = new Map<
    string,
    { depth: number; labels: IFCLabel[] }
  >();
  for (const entry of entries) {
    if (!isPrefix(entry.path, path)) {
      continue;
    }
    const template = isRuntimeMintedTemplate(entry);
    // CONCRETE structure entries label the container's SHAPE: they apply
    // when the container node itself is observed (read at exactly the
    // entry path), not to reads strictly below it — slot pointer reads and
    // dereferences are pointer handling, and tainting them with shape
    // would re-smear the pointwise split the structure component exists to
    // preserve. `*`-path templates are the opposite by construction
    // (template-population §3.2): their whole point is consumption at
    // matching child paths, so the exact-path rule does not apply to them.
    // An `enumerate` entry, whatever its origin, takes the same rule: it
    // labels the container's membership, order and count, which a read of
    // one addressed child does not observe.
    if (
      appliesAtItsPathOnly(entry, template) &&
      entry.path.length !== path.length
    ) {
      continue;
    }
    const component = entry.origin ?? "legacy";
    // Runtime existence and current value measurements resolve independently
    // (§4.6.3): a public child in either class cannot shadow the other's
    // secret ancestor. Frozen existence also joins current membership
    // templates (§4.6.3), which describe a different fact in the shape
    // channel. Each keeps replace-down within its own component and class.
    const bucket = entry.observes === "shape" &&
        (entry.origin === "derived" || entry.origin === "structure")
      ? `${component}\u0000${template ? "shape-template" : "shape"}`
      : component;
    const match = matches.get(bucket);
    if (match === undefined || match.depth < entry.path.length) {
      matches.set(bucket, { depth: entry.path.length, labels: [entry.label] });
    } else if (match.depth === entry.path.length) {
      // Two equally specific prefixes of one queried path are the same
      // path — or, with wildcard segments, a concrete entry and a `*`
      // template covering the same slot; duplicate (path, origin) entries
      // shouldn't survive coalescing, but join defensively (fail-toward-
      // taint) rather than drop one.
      match.labels.push(entry.label);
    }
  }
  if (matches.size === 0) {
    return undefined;
  }
  const labels = Array.from(
    matches.values(),
    (match) =>
      match.labels.length === 1 ? match.labels[0] : joinLabels(match.labels),
  );
  return labels.length === 1 ? labels[0] : joinLabels(labels);
};

/**
 * The label-map entries a read at `path` consumes: `effectiveReadLabel`'s
 * candidate set, before it is resolved into one label.
 */
export const consumedEntriesForRead = (
  metadata: CfcMetadata,
  path: readonly string[],
  read: {
    nonRecursive: boolean | undefined;
    consumes: ReadClassSelection;
    excludeEntry?: (entry: LabelMapEntry) => boolean;
  },
  index?: ConsumedLabelIndex,
): readonly LabelMapEntry[] => {
  const candidates = index === undefined
    ? metadata.labelMap.entries
    : index.overlapping(path, read.nonRecursive !== true).map(({ entry }) =>
      entry
    );
  return read.consumes === "all" && read.excludeEntry === undefined
    ? candidates
    : candidates.filter((entry) =>
      readConsumesEntry(read.consumes, entry) &&
      read.excludeEntry?.(entry) !== true
    );
};

/**
 * One label for everything a read at `path` consumed: the resolution at the
 * read's own path, joined, for a recursive read, with every entry below it.
 * The join is a union on both axes, so its integrity is evidence found
 * SOMEWHERE in the value read; `observationInputWitnesses` is the form that
 * holds of all of it, and `consumedLocations` the form the release gates'
 * per-access join reads.
 */
export const labelForConsumedEntries = (
  entries: readonly LabelMapEntry[],
  path: readonly string[],
  nonRecursive: boolean | undefined,
): IFCLabel | undefined => {
  const base = labelForEntriesAtPath(entries, path);
  if (nonRecursive === true) return base;
  const parts: (IFCLabel | undefined)[] = [base];
  for (const entry of entries) {
    if (entry.path.length <= path.length) continue;
    if (!isPrefix(path, entry.path)) continue;
    parts.push(entry.label);
  }
  return parts.length === 1 ? base : joinLabels(parts);
};

/**
 * The label of everything reading the whole value at `path` of a document
 * whose resolved envelope is `metadata` consumes, resolved as a read of the
 * classes `consumes` selects resolves it, a content read by default. This
 * is for a reader outside the runtime that shows a stored value to a
 * person, such as a terminal view of it, and so has to say what CFC says
 * of what it shows.
 */
export const wholeValueLabel = (
  metadata: CfcMetadata,
  path: readonly string[],
  consumes: ReadClassSelection = "value",
): IFCLabel | undefined =>
  labelForConsumedEntries(
    consumedEntriesForRead(metadata, path, { nonRecursive: false, consumes }),
    path,
    false,
  );

export const joinLabelValues = (
  sources: Iterable<readonly unknown[] | undefined>,
) => {
  // Structural dedup via `uniqueCfcAtoms()` rather than reference dedup
  // via `new Set()`. Atoms can be fabric-converted clones (each
  // `cloneIfNecessary()` produces a fresh frozen object), so two
  // logically-identical caveats may not share a JS reference.
  //
  // Every source is collected before the dedup runs, so a join over any number
  // of sources deduplicates once.
  const atoms: unknown[] = [];
  const seen = new Set<readonly unknown[]>();
  for (const source of sources) {
    if (source !== undefined && !seen.has(source)) {
      seen.add(source);
      for (const atom of source) {
        atoms.push(atom);
      }
    }
  }
  const merged = uniqueCfcAtoms(atoms);
  return merged.length > 0 ? merged : undefined;
};

// Join a series of labels in one pass: each channel collects its atoms from
// every part and deduplicates them once.
export const joinLabels = (
  parts: readonly (IFCLabel | undefined)[],
): IFCLabel => ({
  confidentiality: joinLabelValues(
    parts.map((part) => part?.confidentiality),
  ),
  integrity: joinLabelValues(parts.map((part) => part?.integrity)),
});
