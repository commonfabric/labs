import type { NonDocumentPath } from "@commonfabric/memory/v2";

import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { ConsumedLabelIndex } from "./consumed-label-index.ts";
import {
  readStoredCfcMetadata,
  type StoredCfcLabels,
  StoredCfcMetadataError,
} from "./metadata.ts";
import { entryObservationClass } from "./observation-classes.ts";
import type {
  CfcAddress,
  CfcDereferenceTrace,
  CfcMetadata,
  LabelMapEntry,
} from "./types.ts";
import {
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewOriginSpaces,
  confidentialityOnly,
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

/**
 * A stored label map entry as a label view entry, carrying its effective
 * observation class, or `undefined` for one no view carries.
 */
const viewEntryOf = (entry: LabelMapEntry): CfcLabelViewEntry | undefined => {
  // The view carries the EFFECTIVE class: the persisted
  // `origin:"link"` ⇒ implicit `followRef` carve-out (C0 §3) is
  // resolved here, so view consumers classify without knowing about
  // origins.
  const observes = entryObservationClass(entry);
  // Only a label-metadata template carries this class, and a decoded
  // envelope keeps templates out of its entries; a view entry cannot
  // carry the class either.
  if (observes === "labelMetadata") {
    return undefined;
  }
  return {
    path: entry.path,
    label: entry.label,
    ...(observes !== undefined ? { observes } : {}),
  };
};

/**
 * The entries of a stored label map as label view entries, in stored order,
 * each carrying its effective observation class.
 */
const cfcLabelViewEntriesFromMetadata = (
  metadata: StoredCfcLabels,
): CfcLabelViewEntry[] =>
  metadata.labelMap.entries.flatMap((entry) => viewEntryOf(entry) ?? []);

export const cfcLabelViewFromMetadata = (
  // A stored envelope, or a reader's labels without the envelope around them.
  metadata: CfcMetadata | StoredCfcLabels | undefined,
  path: NonDocumentPath,
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
  /** The stored entries, indexed by path. */
  readonly index: ConsumedLabelIndex;

  /** Each stored entry as a view entry, by its position in the label map. */
  readonly entries: readonly (CfcLabelViewEntry | undefined)[];
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
  const index = {
    index: new ConsumedLabelIndex(stored),
    entries: stored.map(viewEntryOf),
  };
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
): CfcLabelView | undefined =>
  withCfcLabelViewOrigins(
    rebaseCfcLabelView(
      {
        version: 1,
        entries: labels.index.overlapping(path).flatMap(({ ordinal }) =>
          labels.entries[ordinal] ?? []
        ),
      },
      path,
    ),
    [space],
  );

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
 * What a transaction's snapshot memo holds for one address: its view, and the
 * views derived from it as a link slot, each made the first time it is asked
 * for.
 */
type AddressLabels = {
  /** The stored labels that apply at the address. */
  view: CfcLabelView | undefined;

  /**
   * The slot's reference restrictions, and the spaces they were read from.
   * Wrapped, so that a slot restricting nothing is still a hit.
   */
  restrictions?: { view: CfcLabelView | undefined };

  /**
   * The view of a dereference from the slot, and the entry of its target. A
   * slot holds one link, so it has one target at a time.
   */
  dereference?: { target: AddressLabels; view: CfcLabelView | undefined };
};

/**
 * What the transaction's snapshot memo `memo` holds for `address`, made the
 * first time it is asked for. The derivations it holds read documents'
 * `["cfc"]` metadata and nothing else, so they answer the same until
 * something is written, and every dereference on a scanned collection asks
 * for the same handful of addresses once per element. The memoized views are
 * shared rather than copied — every consumer merges, clones or rebases them
 * into something new, none writes to them.
 */
const addressLabels = (
  tx: IExtendedStorageTransaction,
  memo: Map<string, unknown> | undefined,
  address: CfcAddress,
): AddressLabels => {
  if (memo === undefined) {
    return { view: deriveCfcLabelViewForAddress(tx, address) };
  }
  const key = `cfcLabels:${address.space}|${address.scope ?? ""}|` +
    `${address.id}|${JSON.stringify(address.path)}`;
  const cached = memo.get(key) as AddressLabels | undefined;
  if (cached !== undefined) return cached;
  const labels = { view: deriveCfcLabelViewForAddress(tx, address) };
  memo.set(key, labels);
  return labels;
};

/** The stored labels that apply at an address, as a view rebased onto it. */
export const cfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined =>
  addressLabels(tx, tx.getSnapshotMemo?.(), address).view;

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
  withCfcLabelViewOrigins(
    mergeCfcLabelViews([restrictionEntriesOf(view, () => true)]),
    cfcLabelViewOriginSpaces(view),
  );

/**
 * The reference restriction of each root entry of `view` that `from` takes,
 * each as a class-less root entry, unmerged and without the spaces `view` was
 * derived from.
 */
const restrictionEntriesOf = (
  view: CfcLabelView | undefined,
  from: (entry: CfcLabelViewEntry) => boolean,
): CfcLabelView | undefined => {
  let entries: CfcLabelViewEntry[] | undefined;
  for (const entry of view?.entries ?? []) {
    const restriction = entry.path.length === 0 && from(entry)
      ? confidentialityOnly(entry.label)
      : undefined;
    if (restriction !== undefined) {
      (entries ??= []).push({ path: [], label: restriction });
    }
  }
  return entries === undefined ? undefined : { version: 1, entries };
};

/**
 * The labels a dereference from the link slot at `source` to `target`
 * consumes: the labels stored at the slot and at the target, and the slot's
 * reference restrictions, which reach everything the dereference does.
 * Repeated calls within one snapshot return the same view.
 */
export const cfcLabelViewForDereference = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  target: CfcAddress,
): CfcLabelView | undefined => {
  const memo = tx.getSnapshotMemo?.();
  const slot = addressLabels(tx, memo, source);
  const reached = addressLabels(tx, memo, target);
  if (slot.dereference?.target !== reached) {
    slot.dereference = {
      target: reached,
      // The restrictions go in a class-less root entry, where the slot's own
      // class-less root entry already holds its confidentiality, so only the
      // root entries of an observation class add to it.
      view: mergeCfcLabelViews([
        slot.view,
        restrictionEntriesOf(
          slot.view,
          ({ observes }) => observes !== undefined,
        ),
        reached.view,
      ]),
    };
  }
  return slot.dereference.view;
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

/**
 * The restriction a handle acquires by being resolved through `traces`: the
 * reference restrictions of every slot the resolution left (CFC §8.2.3), and
 * nothing of what the slots reach. A handle is a reference; the labels of
 * the document it names are read from that document whenever the handle is
 * followed, so a handle carries only how it was obtained, and a link written
 * from it persists that and no copy of its target's labels (§8.2.5).
 */
export const cfcAcquisitionViewForDereferenceTraces = (
  tx: IExtendedStorageTransaction,
  traces: readonly CfcDereferenceTrace[],
): CfcLabelView | undefined => {
  const memo = tx.getSnapshotMemo?.();
  return mergeCfcLabelViews(
    traces.map(({ source, target }) => {
      // The target's labels are read and left out of the view. The read is
      // what a subscription depends on: a label-only write to a document the
      // resolution followed into re-fires a sink that followed it, and the
      // labels themselves are read again, where they are, by whatever
      // consumes them.
      addressLabels(tx, memo, target);
      const slot = addressLabels(tx, memo, source);
      slot.restrictions ??= { view: referenceRestrictionsOf(slot.view) };
      return slot.restrictions.view;
    }),
  );
};
