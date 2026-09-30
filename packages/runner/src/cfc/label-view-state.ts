import { isCellLink, parseLink } from "../link-utils.ts";
import { followedReferenceWitnesses } from "./prepare.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { immutableReferenceSourceAcquisition } from "./immutable-reference.ts";
import { readStoredCfcMetadata, StoredCfcMetadataError } from "./metadata.ts";
import { entryObservationClass } from "./observation-classes.ts";
import {
  type CfcReferenceProvenance,
  withCfcReferenceConfidentiality,
} from "./reference-provenance.ts";
import {
  type CfcAddress,
  type CfcDereferenceTrace,
  type CfcMetadata,
  isCompleteCfcReferenceEntry,
  runtimeWritePolicyAuthorization,
} from "./types.ts";
import { PathPrefixIndex } from "./path-prefix-index.ts";
import {
  authorizationRead,
  internalVerifierRead,
} from "../storage/reactivity-log.ts";
import {
  canonicalizeCfcLogicalPath,
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewOriginSpaces,
  cfcLabelViewPathKey,
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

const cfcMetadataForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcMetadata | undefined => {
  const memo = tx.getSnapshotMemo?.();
  const key = `cfcViewMetadata:${address.space}|${address.scope}|${address.id}`;
  const cached = memo?.get(key) as
    | { metadata: CfcMetadata | undefined }
    | undefined;
  if (cached !== undefined) return cached.metadata;
  const metadata = readStoredCfcMetadata(tx, address, {
    meta: tx.getCfcState().flowLabelsMode === "persist"
      ? { ...internalVerifierRead, ...authorizationRead }
      : internalVerifierRead,
  });
  memo?.set(key, { metadata });
  return metadata;
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
    metadata = cfcMetadataForAddress(tx, address);
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
  if (memo === undefined) {
    return deriveCfcLabelViewForAddress(tx, address);
  }
  const key = `cfcLabels:${address.space}|${address.scope ?? ""}|` +
    `${address.id}|${JSON.stringify(address.path)}`;
  // Two-level, so a memoized `undefined` is a hit rather than a miss — an
  // address with no stored labels is the common case and the one worth having.
  const cached = memo.get(key) as
    | { view: CfcLabelView | undefined }
    | undefined;
  if (cached !== undefined) return cached.view;
  const view = deriveCfcLabelViewForAddress(
    tx,
    address,
  );
  memo.set(key, { view });
  return view;
};

/** A stored reference has no authenticated acquisition history. */
export class UnresolvedCfcReferenceAcquisitionError extends Error {
  constructor() {
    super("Reference acquisition lacks complete legacy provenance");
    this.name = "UnresolvedCfcReferenceAcquisitionError";
  }
}

/** Acquires the restrictions on a stored reference without opening its target. */
export const cfcReferenceLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  sourceAcquisition?: CfcReferenceProvenance,
  onAcquisition?: (acquisition: CfcReferenceProvenance) => void,
): CfcLabelView | undefined => {
  const metadata = cfcMetadataForAddress(tx, source);
  const complete = metadata !== undefined && metadata.labelMap.entries.some(
    (entry) =>
      isCompleteCfcReferenceEntry(metadata.version, entry) &&
      deepEqual(
        canonicalizeCfcLogicalPath(entry.path),
        canonicalizeCfcLogicalPath(source.path),
      ),
  );
  const precise = tx.getCfcState().flowLabelsMode === "persist";
  const pendingReference = precise &&
    tx.getCfcState().writePolicyInputs.some((input) =>
      input.kind === "link-write" && deepEqual(input.target, source) &&
      tx.isRuntimeWritePolicyInput(input)
    );
  const valuePath = ["value", ...source.path];
  const pendingValue = precise &&
    [
      ...(tx.getWriteDetailsForTarget?.({ ...source, id: source.id as URI }) ??
        tx.getWriteDetails?.(source.space) ?? []),
    ].some((detail) =>
      detail.address.id === source.id &&
      detail.address.scope === source.scope &&
      (detail.address.path.every((part, index) => valuePath[index] === part) ||
        valuePath.every((part, index) => detail.address.path[index] === part))
    );
  if (
    precise && (pendingReference || pendingValue || !complete)
  ) {
    const acquisition = tx.acquireCfcReference(
      source,
      sourceAcquisition,
      runtimeWritePolicyAuthorization,
    );
    if (acquisition === undefined) {
      throw new UnresolvedCfcReferenceAcquisitionError();
    }
    onAcquisition?.(acquisition);
    return withCfcLabelViewOrigins(
      withCfcReferenceConfidentiality(
        undefined,
        acquisition.confidentiality,
        acquisition.selectionWitnesses,
      ),
      acquisition.originSpaces ?? [],
    );
  }
  const reference = cfcLabelViewForAddress(tx, source);
  const raw = precise
    ? tx.readValueOrThrow({ ...source, id: source.id as URI }, {
      meta: { ...internalVerifierRead, ...authorizationRead },
    })
    : undefined;
  const actual = isCellLink(raw)
    ? parseLink(raw, { ...source, id: source.id as URI })
    : undefined;
  const witnesses = actual === undefined
    ? []
    : followedReferenceWitnesses(metadata, source.path, actual);
  const confidentiality =
    reference?.entries.flatMap((entry) =>
      entry.path.length === 0 ? entry.label.confidentiality ?? [] : []
    ) ?? [];
  const entries = reference?.entries.filter((entry) => entry.path.length === 0)
    .map((entry) => ({ ...entry, observes: "followRef" as const }));
  return withCfcLabelViewOrigins(
    withCfcReferenceConfidentiality(
      entries?.length
        ? mergeCfcLabelViews([{ version: 1, entries }])
        : undefined,
      confidentiality,
      witnesses,
    ),
    cfcLabelViewOriginSpaces(reference),
  );
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
  sourceAcquisition?: CfcReferenceProvenance,
): CfcLabelView | undefined => {
  return mergeCfcLabelViews([
    cfcReferenceLabelViewForAddress(tx, source, sourceAcquisition),
    cfcLabelViewForAddress(tx, target),
  ]);
};

export const cfcLabelViewForDereferenceTraces = (
  tx: IExtendedStorageTransaction,
  traces: readonly CfcDereferenceTrace[],
  carriedView?: CfcLabelView,
  mode: "content" | "reference" = "content",
): CfcLabelView | undefined => {
  const derived: CfcLabelView[] = [];
  let referenceView = carriedView;
  for (const trace of traces) {
    const acquisition = immutableReferenceSourceAcquisition(
      referenceView,
      trace.source,
    );
    const view = cfcReferenceLabelViewForAddress(tx, trace.source, acquisition);
    if (view !== undefined) derived.push(view);
    referenceView = mergeCfcLabelViews([referenceView, view]);
  }
  // An intermediate target path may continue through another link, so its
  // projected labels describe no content this resolution actually reaches.
  // Only the terminal target supplies the resolved value's content labels.
  const terminal = traces.at(-1)?.target;
  if (mode === "content" && terminal !== undefined) {
    const content = cfcLabelViewForAddress(tx, terminal);
    if (content !== undefined) derived.push(content);
  }
  return mergeCfcLabelViews(derived);
};
