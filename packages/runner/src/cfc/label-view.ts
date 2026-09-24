import { isObjectOrArray } from "@commonfabric/utils/types";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  isPrimitiveCellLink,
  type NormalizedFullLink,
  parseLink,
} from "../link-utils.ts";
import { resolveLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type { CfcMetadata } from "./types.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "./observation.ts";
import {
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewFromMetadata,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
} from "./label-view-state.ts";

export type { CfcLabelView, CfcLabelViewEntry };
export {
  cfcLabelViewForAddress,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewFromMetadata,
  cfcLabelViewSymbol,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-state.ts";
export { redactCaveatSourcesForDisplay } from "./label-view-core.ts";

type LabelQueryableCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
};

type LinkedValueMetadata = {
  metadata: CfcMetadata;
  path: readonly string[];
};

// `readFailed` distinguishes a genuine metadata read error (fail closed) from a
// cleanly-absent label (`readOrThrow` already maps NotFound/TypeMismatch to
// undefined without throwing, so those are NOT failures).
type StoredMetadataResult = {
  metadata: CfcMetadata | undefined;
  readFailed: boolean;
};

type LinkedValueMetadataResult = {
  linkedValue: LinkedValueMetadata | undefined;
  readFailed: boolean;
};

export type CfcLabelViewStatus = {
  view: CfcLabelView | undefined;
  readFailed: boolean;
};

const storedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): StoredMetadataResult => {
  if (!cell.runtime) {
    return { metadata: undefined, readFailed: false };
  }
  try {
    return {
      metadata: readStoredCfcMetadata(
        cell.runtime.readTx(cell.tx),
        {
          space: link.space,
          id: link.id,
        },
      ),
      readFailed: false,
    };
  } catch {
    return { metadata: undefined, readFailed: true };
  }
};

const linkedValueMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): LinkedValueMetadataResult => {
  if (!cell.runtime || link.path.length === 0) {
    return { linkedValue: undefined, readFailed: false };
  }
  try {
    const tx = cell.runtime.readTx(cell.tx);
    const value = tx.readValueOrThrow(link);
    if (!isPrimitiveCellLink(value)) {
      return { linkedValue: undefined, readFailed: false };
    }
    const target = parseLink(value, link);
    if (target?.id === undefined || target.space === undefined) {
      return { linkedValue: undefined, readFailed: false };
    }
    const metadata = readStoredCfcMetadata(tx, {
      space: target.space,
      id: target.id,
      scope: target.scope,
    });
    return {
      linkedValue: metadata === undefined
        ? undefined
        : { metadata, path: target.path },
      readFailed: false,
    };
  } catch {
    return { linkedValue: undefined, readFailed: true };
  }
};

/**
 * Acquire a cell's display label view AND report whether a metadata read
 * errored while doing so. `cfcLabelViewForCell` drops the flag (the common
 * consumers treat a missing view as blocked); fail-closed consumers retain it
 * through `cfcLabelViewForCellFailClosedWithStatus`.
 */
export const cfcLabelViewForCellWithStatus = (
  cell: unknown,
): CfcLabelViewStatus => {
  if (
    !isObjectOrArray(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return { view: getCarriedCfcLabelView(cell), readFailed: false };
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return { view: getCarriedCfcLabelView(cell), readFailed: false };
  }

  const stored = storedMetadataForCell(cell as LabelQueryableCell, link);
  const metadataView = cfcLabelViewFromMetadata(stored.metadata, link.path);
  const linked = linkedValueMetadataForCell(cell as LabelQueryableCell, link);
  const linkedValueView = cfcLabelViewFromMetadata(
    linked.linkedValue?.metadata,
    linked.linkedValue?.path ?? [],
  );

  return {
    view: mergeCfcLabelViews([
      metadataView,
      linkedValueView,
      getCarriedCfcLabelView(cell),
    ]),
    readFailed: stored.readFailed || linked.readFailed,
  };
};

export const cfcLabelViewForCell = (
  cell: unknown,
): CfcLabelView | undefined => cfcLabelViewForCellWithStatus(cell).view;

/** Options for a label read that resolves the cell's path through links. */
export type ResolvedLabelReadOptions = {
  /**
   * Whether resolving the path kicks a sync of each hop target in another
   * space. On by default. A reader that resolves a link its caller's value
   * read has already resolved, and so already kicked, turns it off.
   */
  kickCrossSpaceTargets?: boolean;
};

type ResolvedMetadataResult = StoredMetadataResult & {
  /** The resolved doc's path, which the view is rebased against. */
  path: readonly string[];
};

/**
 * Stored metadata of the doc that actually HOLDS the value at `link`, found by
 * the runtime's own link resolution — the following `.get()` performs.
 *
 * `storedMetadataForCell` reads the doc the cell names, and
 * `linkedValueMetadataForCell` follows one link when the selected path lands ON
 * one. Neither reaches a doc behind a link the path crosses part way through,
 * and a labeled read commonly has one: a sqlite query result splits each row
 * into its own entity doc and stores the row's labels there, so
 * `q/result/0/secret` crosses a link at `result/0` and its label is two docs
 * away from the doc the path started in.
 */
const resolvedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
  options: ResolvedLabelReadOptions,
): ResolvedMetadataResult => {
  if (!cell.runtime) {
    return { metadata: undefined, readFailed: false, path: link.path };
  }
  try {
    const tx = cell.runtime.readTx(cell.tx);
    // `markIfcCrossings` is what a read entry point passes. On the CLI's path
    // it changes nothing observable: the cell carries no transaction, so
    // `readTx` mints a throwaway that is never committed and the marks die
    // with it. It is here for a caller that hands in a cell with a LIVE
    // transaction, where an ifc-bearing link crossed to reach a label counts
    // against that transaction's accounting like any other crossing.
    const resolved = resolveLink(cell.runtime, tx, link, "value", {
      markIfcCrossings: true,
      ...(options.kickCrossSpaceTargets === false
        ? { kickCrossSpaceTargets: false }
        : {}),
    });
    return {
      metadata: readStoredCfcMetadata(tx, {
        space: resolved.space,
        id: resolved.id,
        scope: resolved.scope,
      }),
      readFailed: false,
      path: resolved.path,
    };
  } catch {
    return { metadata: undefined, readFailed: true, path: link.path };
  }
};

/**
 * {@link cfcLabelViewForCellWithStatus}, plus the label stored on the doc the
 * selected path RESOLVES to.
 *
 * For an inspection or display surface that answers "what is the label here"
 * about a path a person typed or a value a view is bound to, the one-hop read
 * is not enough: a path that crosses a link part way through reports no label
 * for a value that plainly carries one. This
 * merges the resolved doc's stored label into the same view, rebased so its
 * entries stay relative to the selected cell.
 *
 * Strictly additive. Every view the one-hop read produces is still in the
 * merge, and merging is keyed per (observation class, path) with a union of the
 * labels, so a leaf-link read — where the resolution lands on the same doc the
 * one hop already found — returns exactly what it returns today. `readFailed`
 * stays fail-closed across both: a resolution that throws is a failed read, not
 * an absent label.
 */
export const cfcLabelViewForResolvedCellWithStatus = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelViewStatus => {
  const unresolved = cfcLabelViewForCellWithStatus(cell);
  if (
    !isObjectOrArray(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return unresolved;
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return unresolved;
  }

  const resolved = resolvedMetadataForCell(
    cell as LabelQueryableCell,
    link,
    options,
  );
  return {
    view: mergeCfcLabelViews([
      unresolved.view,
      cfcLabelViewFromMetadata(resolved.metadata, resolved.path),
    ]),
    readFailed: unresolved.readFailed || resolved.readFailed,
  };
};

/**
 * The label view a display surface shows for a cell: the view-only form of
 * {@link cfcLabelViewForResolvedCellWithStatus}. A value bound to a label
 * display is commonly reached across a link part way along its path, as a
 * list element that links to the document holding the value, and the label
 * that vouches for that value is stored on the linked document.
 */
export const cfcLabelViewForResolvedCell = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelView | undefined =>
  cfcLabelViewForResolvedCellWithStatus(cell, options).view;

/**
 * Fail-closed label acquisition for the LLM-observation egress path (audit 22),
 * including whether a metadata read failed. When a read fails, the returned
 * view is tainted at the root with `CFC_LABEL_READ_FAILED_ATOM`, so every
 * observation node under it fails any declared confidentiality ceiling and is
 * redacted rather than serialized to the model as public. A cleanly-absent
 * label (no read error) is unchanged, so normal unlabelled data is not
 * over-redacted.
 */
export const cfcLabelViewForCellFailClosedWithStatus = (
  cell: unknown,
): CfcLabelViewStatus => {
  const { view, readFailed } = cfcLabelViewForCellWithStatus(cell);
  if (!readFailed) {
    return { view, readFailed };
  }
  return {
    view: mergeCfcLabelViews([
      view,
      {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: [CFC_LABEL_READ_FAILED_ATOM] },
        }],
      },
    ]),
    readFailed,
  };
};

/** The view-only surface of fail-closed label acquisition. */
export const cfcLabelViewForCellFailClosed = (
  cell: unknown,
): CfcLabelView | undefined =>
  cfcLabelViewForCellFailClosedWithStatus(cell).view;
