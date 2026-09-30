import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  cellRuntime,
  cellTx,
  cellWriteSchema,
  getCarriedCfcLabelView,
  isCell,
} from "../cell.ts";
import {
  isPrimitiveCellLink,
  type NormalizedFullLink,
  parseLink,
} from "../link-utils.ts";
import { resolveLink } from "../link-resolution.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { normalizeCellScope } from "../scope.ts";
import { getCfcReferenceProvenance } from "./reference-provenance.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type { CfcMetadata } from "./types.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "./observation.ts";
import {
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewFromMetadata,
  cfcLabelViewOriginSpaces,
  cfcReferenceLabelViewForAddress,
  mergeCfcLabelViews,
  withCfcLabelViewOrigins,
} from "./label-view-state.ts";

export type { CfcLabelView, CfcLabelViewEntry };
export {
  cfcLabelViewForAddress,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewFromMetadata,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-state.ts";
export { getCarriedCfcLabelView } from "../cell.ts";
export { redactCaveatSourcesForDisplay } from "./label-view-core.ts";

type LabelQueryableCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
};

type LinkedValueMetadata = {
  metadata: CfcMetadata;
  path: readonly string[];
  space: string;
};

// `readFailed` distinguishes a genuine metadata read error (fail closed) from a
// cleanly-absent label (`readOrThrow` already maps NotFound/TypeMismatch to
// undefined without throwing, so those are NOT failures).
type StoredMetadataResult = {
  metadata: CfcMetadata | undefined;
  readFailed: boolean;
};

type LinkedValueMetadataResult = {
  referenceView?: CfcLabelView;
  linkedValue: LinkedValueMetadata | undefined;
  readFailed: boolean;
};

export type CfcLabelViewStatus = {
  view: CfcLabelView | undefined;
  readFailed: boolean;
};

/**
 * {@link CfcLabelViewStatus}, plus the spaces of the documents whose stored
 * labels the view was derived from — where a module policy the label selects
 * has its manifest installed (spec §4.4.1). For a view carried on the cell,
 * these are the spaces it was read from wherever it was first read, such as
 * the document holding a link the cell was resolved through.
 */
export type CfcLabelViewSource = CfcLabelViewStatus & {
  spaces: readonly string[];
};

const storedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): StoredMetadataResult => {
  if (!isCell(cell)) {
    return { metadata: undefined, readFailed: false };
  }
  try {
    return {
      metadata: readStoredCfcMetadata(
        cellRuntime(cell).readTx(cellTx(cell)),
        {
          space: link.space,
          id: link.id,
          scope: link.scope,
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
  if (!isCell(cell) || link.path.length === 0) {
    return { linkedValue: undefined, readFailed: false };
  }
  try {
    const tx = cellRuntime(cell).readTx(cellTx(cell));
    const value = tx.readValueOrThrow(link, { meta: internalVerifierRead });
    if (!isPrimitiveCellLink(value)) {
      return { linkedValue: undefined, readFailed: false };
    }
    const referenceView = cfcReferenceLabelViewForAddress(tx, {
      space: link.space,
      id: link.id,
      scope: normalizeCellScope(link.scope),
      path: link.path,
    }, getCfcReferenceProvenance(cell));
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
      referenceView,
      linkedValue: metadata === undefined
        ? undefined
        : { metadata, path: target.path, space: target.space },
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
  const { view, readFailed } = cfcLabelViewSourceForCell(cell);
  return { view, readFailed };
};

/**
 * {@link cfcLabelViewForCellWithStatus}, also naming the spaces of the
 * documents the view was derived from, the carried part included (see
 * {@link CfcLabelViewSource}). A carried view that crossed a worker boundary
 * or a persisted link names no space.
 */
export const cfcLabelViewSourceForCell = (
  cell: unknown,
): CfcLabelViewSource => {
  if (
    !isObjectOrArray(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    const view = getCarriedCfcLabelView(cell);
    return {
      view,
      readFailed: false,
      spaces: cfcLabelViewOriginSpaces(view),
    };
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    const view = getCarriedCfcLabelView(cell);
    return {
      view,
      readFailed: true,
      spaces: cfcLabelViewOriginSpaces(view),
    };
  }

  const stored = storedMetadataForCell(cell as LabelQueryableCell, link);
  const metadataView = withCfcLabelViewOrigins(
    cfcLabelViewFromMetadata(stored.metadata, link.path),
    [link.space],
  );
  const linked = linkedValueMetadataForCell(cell as LabelQueryableCell, link);
  const linkedValueView = withCfcLabelViewOrigins(
    cfcLabelViewFromMetadata(
      linked.linkedValue?.metadata,
      linked.linkedValue?.path ?? [],
    ),
    linked.linkedValue === undefined ? [] : [linked.linkedValue.space],
  );
  const view = mergeCfcLabelViews([
    metadataView,
    linkedValueView,
    linked.referenceView,
    getCarriedCfcLabelView(cell),
  ]);
  return {
    view,
    readFailed: stored.readFailed || linked.readFailed,
    spaces: cfcLabelViewOriginSpaces(view),
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
  referenceView?: CfcLabelView;
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
  lastNode: "value" | "writeRedirect" = "value",
): ResolvedMetadataResult => {
  if (!isCell(cell)) {
    return { metadata: undefined, readFailed: false, path: link.path };
  }
  try {
    const runtime = cellRuntime(cell);
    const tx = runtime.readTx(cellTx(cell));
    const traceStart = tx.getCfcState().dereferenceTraces.length;
    // `markIfcCrossings` is what a read entry point passes. On the CLI's path
    // it changes nothing observable: the cell carries no transaction, so
    // `readTx` mints a throwaway that is never committed and the marks die
    // with it. It is here for a caller that hands in a cell with a LIVE
    // transaction, where an ifc-bearing link crossed to reach a label counts
    // against that transaction's accounting like any other crossing.
    const targetLink = lastNode === "writeRedirect"
      ? { ...link, schema: cellWriteSchema(cell) }
      : link;
    const resolved = resolveLink(runtime, tx, targetLink, lastNode, {
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
      referenceView: cfcLabelViewForDereferenceTraces(
        tx,
        tx.getCfcState().dereferenceTraces.slice(traceStart),
        getCarriedCfcLabelView(cell),
      ),
    };
  } catch {
    return { metadata: undefined, readFailed: true, path: link.path };
  }
};

/**
 * The label stored on the document that holds the value at `cell`'s path,
 * rebased onto that value, or undefined when `cell` names no document.
 */
const resolvedTargetLabelView = (
  cell: unknown,
  options: ResolvedLabelReadOptions,
  lastNode: "value" | "writeRedirect" = "value",
): (CfcLabelViewStatus & { referenceView?: CfcLabelView }) | undefined => {
  if (
    !isObjectOrArray(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return undefined;
  }
  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return { view: undefined, readFailed: true };
  }
  const resolved = resolvedMetadataForCell(
    cell as LabelQueryableCell,
    link,
    options,
    lastNode,
  );
  return {
    view: cfcLabelViewFromMetadata(resolved.metadata, resolved.path),
    referenceView: resolved.referenceView,
    readFailed: resolved.readFailed,
  };
};

/**
 * Labels at the destination of a schema update. Ordinary links at the selected
 * slot remain in that slot; write redirects and intermediate links are followed.
 * Reference labels accumulated while reaching the destination are excluded.
 */
export const cfcLabelViewForWriteTargetWithStatus = (
  cell: unknown,
): CfcLabelViewStatus => {
  const target = resolvedTargetLabelView(cell, {}, "writeRedirect");
  return { view: target?.view, readFailed: target?.readFailed ?? false };
};

/**
 * The label stored on the document that holds the value at `cell`'s path,
 * found by the runtime's own link resolution and rebased onto that value.
 *
 * It leaves out the labels of the documents the path passes through on the way
 * there, and any view the cell carries. A label on a document that holds a
 * link is about the link: what integrity it carries endorses the reference,
 * not the current contents of its target (spec §3.7.2, §8.2.4). This is
 * therefore the view that says what vouches for the value itself, which is what
 * a check requiring integrity of the value reads. It is undefined when no
 * label is stored and when the read fails.
 */
export const cfcLabelViewForResolvedTarget = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelView | undefined => resolvedTargetLabelView(cell, options)?.view;

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
 * The view combines labels by observation class and path. Reference labels
 * accumulated while following the path remain distinct from target content
 * labels. A resolution that throws reports a failed read, not an absent label.
 */
export const cfcLabelViewForResolvedCellWithStatus = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelViewStatus => {
  const unresolved = cfcLabelViewForCellWithStatus(cell);
  const target = resolvedTargetLabelView(cell, options);
  if (target === undefined) return unresolved;
  return {
    view: mergeCfcLabelViews([
      unresolved.view,
      target.referenceView,
      target.view,
    ]),
    readFailed: unresolved.readFailed || target.readFailed,
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
