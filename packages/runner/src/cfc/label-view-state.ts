import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { readStoredCfcMetadata, StoredCfcMetadataError } from "./metadata.ts";
import { entryObservationClass } from "./observation-classes.ts";
import type { CfcAddress, CfcDereferenceTrace, CfcMetadata } from "./types.ts";
import {
  canonicalizeCfcLogicalPath,
  type CfcLabelView,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-core.ts";

export type {
  CfcLabelView,
  CfcLabelViewEntry,
  IFCLabel,
} from "./label-view-core.ts";
export {
  canonicalizeCfcLogicalPath,
  cfcLabelViewPathKey,
  cfcLabelViewsEqual,
  cloneCfcLabel,
  cloneCfcLabelView,
  hasCfcLabelValues,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-core.ts";

export const cfcLabelViewSymbol: unique symbol = Symbol("cfcLabelView");

type CfcLabelCarrier = {
  [cfcLabelViewSymbol]?(): CfcLabelView | undefined;
};

export const cfcLabelViewFromMetadata = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
): CfcLabelView | undefined => {
  if (!metadata) {
    return undefined;
  }

  return rebaseCfcLabelView(
    {
      version: 1,
      entries: metadata.labelMap.entries.flatMap((entry) => {
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
      }),
    },
    path,
  );
};

const deriveCfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined => {
  try {
    return cfcLabelViewFromMetadata(
      readStoredCfcMetadata(tx, address),
      canonicalizeCfcLogicalPath(address.path),
    );
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

export const cfcLabelViewForDereference = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  target: CfcAddress,
): CfcLabelView | undefined =>
  mergeCfcLabelViews([
    cfcLabelViewForAddress(tx, source),
    cfcLabelViewForAddress(tx, target),
  ]);

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
