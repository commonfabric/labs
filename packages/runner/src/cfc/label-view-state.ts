import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { readStoredCfcMetadata, StoredCfcMetadataError } from "./metadata.ts";
import { entryObservationClass } from "./observation-classes.ts";
import { PathPrefixIndex } from "./path-prefix-index.ts";
import type { CfcAddress, CfcDereferenceTrace, CfcMetadata } from "./types.ts";
import {
  canonicalizeCfcLogicalPath,
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewOriginSpaces,
  cfcLabelViewPathKey,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
  withCfcLabelViewOrigins,
} from "./label-view-core.ts";

export type {
  CfcLabelView,
  CfcLabelViewEntry,
  IFCLabel,
} from "./label-view-core.ts";
export {
  canonicalizeCfcLogicalPath,
  cfcLabelViewOriginSpaces,
  cfcLabelViewPathKey,
  cfcLabelViewsEqual,
  cloneCfcLabel,
  cloneCfcLabelView,
  hasCfcLabelValues,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
  withCfcLabelViewOrigins,
} from "./label-view-core.ts";

export const cfcLabelViewSymbol: unique symbol = Symbol("cfcLabelView");

type CfcLabelCarrier = {
  [cfcLabelViewSymbol]?(): CfcLabelView | undefined;
};

/**
 * The entries of a stored label map as label view entries, in stored order,
 * each carrying its effective observation class.
 */
const cfcLabelViewEntriesFromMetadata = (
  metadata: CfcMetadata,
): CfcLabelViewEntry[] =>
  metadata.labelMap.entries.flatMap((entry) => {
    // The view carries the EFFECTIVE class: the persisted
    // `origin:"link"` ⇒ implicit `followRef` carve-out (C0 §3) is
    // resolved here, so view consumers classify without knowing about
    // origins.
    const observes = entryObservationClass(entry);
    // Label-metadata population templates (template-population Stage B)
    // are envelope-LOCAL: they describe this envelope's own payload
    // entries and are re-derived per envelope at persist, so they never
    // ride label views — a link transports the source's payload labels,
    // and the target's envelope mints its own templates from whatever
    // entries land there.
    if (observes === "labelMetadata") {
      return [];
    }
    return [{
      path: entry.path,
      label: entry.label,
      ...(observes !== undefined ? { observes } : {}),
    }];
  });

export const cfcLabelViewFromMetadata = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
): CfcLabelView | undefined => {
  if (!metadata) {
    return undefined;
  }

  return rebaseCfcLabelView(
    { version: 1, entries: cfcLabelViewEntriesFromMetadata(metadata) },
    path,
  );
};

/**
 * The label view entries one document stores, indexed by path, so that the
 * view at one address costs the entries that overlap it rather than every
 * entry the document holds.
 */
export type CfcDocumentLabels = {
  /** The entries, in stored order. */
  readonly entries: readonly CfcLabelViewEntry[];

  /** The positions in `entries` of the entries at each logical path. */
  readonly positionsByPath: ReadonlyMap<string, readonly number[]>;

  /** Every logical path an entry is at. */
  readonly paths: PathPrefixIndex;
};

/**
 * The index of each stored label map's entries, by the identity of the
 * entries array the metadata reader returns. That array is the stored one, or
 * one the reader memoizes per stored label map, so a document whose labels
 * have not changed finds its index again, and one whose labels have changed
 * does not.
 */
const labelIndexByEntries = new WeakMap<object, CfcDocumentLabels>();

/** Helper for `readCfcDocumentLabels()`, which indexes `metadata`. */
const documentLabelIndex = (metadata: CfcMetadata): CfcDocumentLabels => {
  const stored = metadata.labelMap.entries;
  const cached = labelIndexByEntries.get(stored);
  if (cached !== undefined) return cached;
  const entries = cfcLabelViewEntriesFromMetadata(metadata);
  const positionsByPath = new Map<string, number[]>();
  const paths = new PathPrefixIndex();
  entries.forEach((entry, position) => {
    const path = canonicalizeCfcLogicalPath(entry.path);
    const key = cfcLabelViewPathKey(path);
    const positions = positionsByPath.get(key);
    if (positions === undefined) {
      positionsByPath.set(key, [position]);
      paths.add(path);
    } else {
      positions.push(position);
    }
  });
  const index = { entries, positionsByPath, paths };
  labelIndexByEntries.set(stored, index);
  return index;
};

/**
 * The labels stored in `address`'s document, indexed by path, or `undefined`
 * for a document storing none.
 */
export const readCfcDocumentLabels = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcDocumentLabels | undefined => {
  let metadata: CfcMetadata | undefined;
  try {
    metadata = readStoredCfcMetadata(tx, address);
  } catch (error) {
    // The errors the reader THROWS to fail closed must keep failing
    // closed here: swallowing one would serve this labeled document as
    // unlabeled — the exact reading the version guard and the label
    // resolver exist to prevent — and this view feeds the flow join that
    // decides what a write may carry. Every other failure keeps the
    // no-view answer.
    if (error instanceof StoredCfcMetadataError) throw error;
    return undefined;
  }
  return metadata === undefined ? undefined : documentLabelIndex(metadata);
};

/**
 * The labels in `labels`, stored in a document in `space`, that apply at
 * `path`, as a view rebased onto it. The entries that overlap `path` are the
 * only ones a rebase keeps, and taking them in stored order keeps the order a
 * rebase of every entry merges them in.
 */
export const cfcLabelViewInDocument = (
  labels: CfcDocumentLabels,
  space: string,
  path: readonly string[],
): CfcLabelView | undefined => {
  const logicalPath = canonicalizeCfcLogicalPath(path);
  const positions = labels.paths.overlapping(logicalPath)
    .flatMap((entryPath) =>
      labels.positionsByPath.get(cfcLabelViewPathKey(entryPath)) ?? []
    )
    .sort((left, right) => left - right);
  return withCfcLabelViewOrigins(
    rebaseCfcLabelView(
      {
        version: 1,
        entries: positions.map((position) => labels.entries[position]),
      },
      logicalPath,
    ),
    [space],
  );
};

/** Helper for `cfcLabelViewForAddress()`, which derives it unmemoized. */
const deriveCfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined => {
  const labels = readCfcDocumentLabels(tx, address);
  return labels === undefined
    ? undefined
    : cfcLabelViewInDocument(labels, address.space, address.path);
};

/**
 * The stored labels that apply at an address, as a view rebased onto it.
 *
 * Memoized on the transaction's snapshot: the derivation reads the target
 * document's `["cfc"]` metadata and nothing else, so it answers the same until
 * something is written, and every dereference on a scanned collection asks for
 * the same handful of addresses once per element. The memoized view is shared
 * rather than copied — every consumer merges, clones or rebases it into
 * something new, none writes to it.
 */
export const cfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined => {
  const memo = tx.getSnapshotMemo?.();
  if (memo === undefined) return deriveCfcLabelViewForAddress(tx, address);
  const key = `cfcLabels:${address.space}|${address.scope ?? ""}|` +
    `${address.id}|${JSON.stringify(address.path)}`;
  // Two-level, so a memoized `undefined` is a hit rather than a miss — an
  // address with no stored labels is the common case and the one worth having.
  const cached = memo.get(key) as
    | { view: CfcLabelView | undefined }
    | undefined;
  if (cached !== undefined) return cached.view;
  const view = deriveCfcLabelViewForAddress(tx, address);
  memo.set(key, { view });
  return view;
};

/**
 * The reference restrictions `view`, rooted at a link's slot, holds for what
 * is reached through the link: the confidentiality of everything that
 * resolves at the slot, whatever its observation class, wildcard templates
 * included (CFC §18.6.2 `referenceLabel`). A dereference retains them for
 * every observation it reaches (§4.6.3, §8.2.4), so they are one class-less
 * entry at the root, which a rebase carries to every position below. Entries
 * below the slot are left out, since the target's positions are labeled by
 * the target's own labels, and so is integrity, since observing a reference
 * endorses nothing it reaches.
 */
export const referenceRestrictionsOf = (
  view: CfcLabelView | undefined,
): CfcLabelView | undefined =>
  view === undefined ? undefined : withCfcLabelViewOrigins(
    mergeCfcLabelViews([{
      version: 1,
      entries: view.entries.flatMap(({ path, label }) =>
        path.length === 0 && label.confidentiality !== undefined
          ? [{ path: [], label: { confidentiality: label.confidentiality } }]
          : []
      ),
    }]),
    cfcLabelViewOriginSpaces(view),
  );

/**
 * The labels a dereference from the link slot at `source` to `target`
 * consumes: the labels stored at the slot and at the target, and the slot's
 * reference restrictions, which reach everything the dereference does.
 */
export const cfcLabelViewForDereference = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  target: CfcAddress,
): CfcLabelView | undefined => {
  const slot = cfcLabelViewForAddress(tx, source);
  return mergeCfcLabelViews([
    slot,
    referenceRestrictionsOf(slot),
    cfcLabelViewForAddress(tx, target),
  ]);
};

export const cfcLabelViewForDereferenceTraces = (
  tx: IExtendedStorageTransaction,
  traces: readonly CfcDereferenceTrace[],
): CfcLabelView | undefined =>
  mergeCfcLabelViews(
    traces.map((trace) =>
      cfcLabelViewForDereference(tx, trace.source, trace.target)
    ),
  );

export const getCarriedCfcLabelView = (
  value: unknown,
): CfcLabelView | undefined => {
  const carrier = value as Partial<CfcLabelCarrier> | undefined;
  if (typeof carrier?.[cfcLabelViewSymbol] !== "function") {
    return undefined;
  }
  return cloneCfcLabelView(carrier[cfcLabelViewSymbol]());
};
