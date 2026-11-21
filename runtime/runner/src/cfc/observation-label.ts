/**
 * The label one flow observation consumes: for a journaled read of a document
 * at a path, in one observation class, the stored label-map entries the read
 * consumes and the one label they resolve to, with the exclusions the flow
 * join applies to template entries. `deriveFlowJoin` joins these per
 * observation, and a compiled pattern's template resolves a slot through the
 * same resolver, so a slot's label is the label the join takes from the same
 * read.
 */

import type { FabricValue } from "@commonfabric/api";
import { stringTupleKey } from "@commonfabric/collections/string-tuple-key";
import { linkProbeSubPath } from "@commonfabric/data-model/cell-rep";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { encodePointer } from "../../../memory/v2/path.ts";
import { isPrimitiveCellLink } from "../link-utils.ts";
import { isRuntimeSecretId } from "../runtime-secret-id.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  MediaType,
} from "../storage/interface.ts";
import { stableInternalVerifierRead } from "../storage/reactivity-log.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import {
  consumedEntriesForRead,
  isRuntimeMintedTemplate,
  labelForConsumedEntries,
} from "./consumed-label.ts";
import {
  ConsumedLabelIndex,
  type ConsumedLabelSelection,
} from "./consumed-label-index.ts";
import {
  readConsumesEntry,
  type ReadObservationShape,
} from "./observation-classes.ts";
import { isPrefix, PathPrefixIndex } from "./path-prefix-index.ts";
import type { CfcMetadata, IFCLabel, LabelMapEntry } from "./types.ts";

/** A document an observation read, with its scope normalized. */
export interface ObservedDocument {
  readonly space: MemorySpace;
  readonly id: URI;
  readonly scope: ReturnType<typeof normalizeCellScope>;
}

/**
 * What decides the label of one flow observation, as the walk of a
 * transaction's flow observations reports it.
 */
export interface ObservationProfile {
  readonly shape: ReadObservationShape;
  readonly nonRecursive: boolean | undefined;
  /** A dereference trace of the same transaction covers the read. */
  readonly coveredByTrace: boolean;
  /** The read carries the runtime's wiring marker. */
  readonly machinery: boolean;
  /** The read is declared onward; only whether it is matters here. */
  readonly declaredOnward: unknown;
}

/** What the resolver needs from the preparation that owns it. */
export interface ObservationLabelDependencies {
  /** The stored label metadata of a document, read as a verifier read. */
  storedMetadata(
    document: ObservedDocument,
    type: MediaType,
  ): CfcMetadata | undefined;

  /**
   * The container paths, by document key, whose membership entries this
   * transaction re-stamps, so its own reads of them do not consume them
   * (`ownRestampContainerPaths` in `prepare.ts`).
   */
  readonly ownRestamps: ReadonlyMap<string, ReadonlySet<string>>;

  /** The paths this transaction wrote, by document key. */
  writtenPaths(): ReadonlyMap<string, readonly (readonly string[])[]>;

  /**
   * What a written document held at a path before this transaction, or
   * `undefined` where that cannot be told.
   */
  valuesBefore(
    document: ObservedDocument,
  ): (path: readonly string[]) => readonly FabricValue[] | undefined;
}

/** One document's stored metadata and the indexes built over it. */
export interface ObservedDocumentLabels {
  readonly key: string;
  readonly metadata: CfcMetadata | undefined;
  /** The index of the entries a read of `shape` consumes, built once. */
  indexFor(shape: ReadObservationShape): ConsumedLabelIndex | undefined;
}

/** The label one observation resolved to, and what it was resolved from. */
export interface ResolvedObservation {
  readonly document: ObservedDocumentLabels;
  /** True the first time the resolver saw this document. */
  readonly firstOfDocument: boolean;
  /** The key one document's observations with equal labels share. */
  readonly labelKey: string;
  readonly label: IFCLabel | undefined;
  /**
   * Present the first time `labelKey` is resolved in the document: the
   * entries the label resolved from (`undefined` for a document with no
   * metadata), and the exclusion applied to them.
   */
  readonly fresh?: {
    readonly entries: readonly LabelMapEntry[] | undefined;
    readonly exclusion: {
      readonly excludeEntry?: (entry: LabelMapEntry) => boolean;
    };
  };
}

/** The key the flow stage keys a document by: space, scope and id. */
export const observedDocumentKey = (target: {
  space: MemorySpace;
  id: string;
  scope?: ReturnType<typeof normalizeCellScope>;
}): string =>
  `${target.space}\u0000${normalizeCellScope(target.scope)}\u0000${target.id}`;

const pathKey = (path: readonly string[]): string => encodePointer(path);

/**
 * The slot a link-resolution probe asked about: its path without the sub-path
 * at which a link exposes its recognizable form (`linkProbeSubPath`, the
 * sigil's `["/", "link@1"]` in the legacy layout, nothing in the atomic one).
 */
export const probedSlotPath = (path: readonly string[]): readonly string[] => {
  const sigil = linkProbeSubPath();
  const slotLength = path.length - sigil.length;
  if (sigil.length === 0 || slotLength < 0) return path;
  return sigil.every((segment, index) => path[slotLength + index] === segment)
    ? path.slice(0, slotLength)
    : path;
};

/**
 * The entries a read of `shape` consumes, as the selection an index shares
 * across transactions: one predicate per shape, under the shape's name.
 */
const consumedByShape = (
  shape: ReadObservationShape,
): ConsumedLabelSelection => {
  let selection = consumedByShapeSelections.get(shape);
  if (selection === undefined) {
    selection = {
      key: shape,
      keeps: (entry) => readConsumesEntry(shape, entry),
    };
    consumedByShapeSelections.set(shape, selection);
  }
  return selection;
};

const consumedByShapeSelections = new Map<
  ReadObservationShape,
  ConsumedLabelSelection
>();

/**
 * Whether `entry` is one of the membership entries a re-stamp of the given
 * container paths replaces: the container-anchored enumerate stamp, or a
 * `*`-child class template of one of the containers.
 */
const isReplacedMembershipEntry = (
  entry: LabelMapEntry,
  containers: ReadonlySet<string>,
): boolean => {
  if (entry.origin !== "structure") {
    return false;
  }
  const entryPath = canonicalizeLogicalPath(entry.path);
  if (entry.observes === "enumerate") {
    return containers.has(pathKey(entryPath));
  }
  return entryPath.length > 0 &&
    entryPath[entryPath.length - 1] === "*" &&
    containers.has(pathKey(entryPath.slice(0, -1)));
};

/**
 * Whether `entry` is a runtime-minted `*`-child template strictly beneath
 * `slot`: one labeling which reference sits at a child of the slot, or deeper.
 * `*` matches on either side, as it does wherever an entry is resolved.
 */
const isRuntimeTemplateBeneath = (
  entry: LabelMapEntry,
  slot: readonly string[],
): boolean => {
  const path = canonicalizeLogicalPath(entry.path);
  return path.length > slot.length &&
    isRuntimeMintedTemplate({ origin: entry.origin, path }) &&
    isPrefix(slot, path);
};

/** Whether the concrete `path` starts with the concrete `prefix`. */
const concretePathHasPrefix = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => path[index] === segment);

/**
 * Whether `entry` is a link entry strictly beneath `slot`. Beneath a slot
 * that holds a reference, the document has no position of its own, so such
 * an entry labels a position of the reference's target.
 */
const isLinkEntryBeneath = (
  entry: LabelMapEntry,
  slot: readonly string[],
): boolean => {
  if (entry.origin !== "link") return false;
  const path = canonicalizeLogicalPath(entry.path);
  return path.length > slot.length && concretePathHasPrefix(path, slot);
};

/**
 * Resolves the label of each flow observation of one transaction, caching
 * per document the stored metadata, the index of each observation shape, and
 * the label of each distinct observation. One resolver serves one pass over a
 * transaction: what it caches is the state that pass reads.
 */
export class ObservationLabelResolver {
  readonly #tx: IExtendedStorageTransaction;
  readonly #deps: ObservationLabelDependencies;
  readonly #documents = new Map<string, {
    labels: ObservedDocumentLabels;
    resolved: Map<string, IFCLabel | undefined>;
  }>();
  #writtenPaths: Map<string, PathPrefixIndex> | undefined;
  readonly #valuesAsRead = new Map<string, { value: unknown } | undefined>();
  readonly #valuesBefore = new Map<
    string,
    (path: readonly string[]) => readonly FabricValue[] | undefined
  >();

  constructor(
    tx: IExtendedStorageTransaction,
    deps: ObservationLabelDependencies,
  ) {
    this.#tx = tx;
    this.#deps = deps;
  }

  /**
   * Returns the label the observation of `document` at `logicalPath`
   * consumes. `type` is the media type the document is read as.
   */
  resolve(
    document: ObservedDocument,
    type: MediaType,
    logicalPath: readonly string[],
    observation: ObservationProfile,
  ): ResolvedObservation {
    const key = observedDocumentKey(document);
    let state = this.#documents.get(key);
    const firstOfDocument = state === undefined;
    if (state === undefined) {
      state = {
        labels: this.#documentLabels(
          key,
          this.#deps.storedMetadata(document, type),
        ),
        resolved: new Map(),
      };
      this.#documents.set(key, state);
    }
    const labels = state.labels;
    const index = labels.indexFor(observation.shape);
    const ownedContainers = this.#deps.ownRestamps.get(key);
    // `*`-template consumption keeps the C0 §6.1 row-3/row-4 boundary the
    // probe channel already has, extended to PLAIN reads: resolution
    // machinery journals ordinary reads at followed slots (the slot
    // scalar, the sigil interior) on its way to the target, and those
    // must not consume the slot templates — the follow's taint arrives
    // via the target's own reads (row 4) and via the probe of the followed
    // slot, which consumes the slot's `followRef` template once, while
    // STANDALONE slot observations (no covering trace) consume in full
    // (row 3, the SC-8 closures). Without this, every traversal hop through
    // a stamped container smears the container's J onto whatever the
    // transaction writes — re-importing the pointwise smear the S16
    // substrate removed (measured: the phase-B pointwise map suite). The
    // `machinery` arm is the same boundary for the wiring reads no trace
    // covers: op instantiation, dependency seeding, result plumbing and
    // coordinator scaffolding read plumbing containers' child paths
    // (slot scalars, `length`, alias shells) as scaffolding, and letting
    // those standalone-shaped reads consume templates smeared one
    // reconcile's J into the next op's action chain — what kept the
    // generic mint route off in Stage A (the SC-8 remainder). Marked
    // reads keep every OTHER consumption (link entries, concrete
    // structure/derived) — byte-identical to their pre-template
    // behavior, so the exclusion cannot under-taint relative to main.
    //
    // The `probedSlot` arm is of another kind: it says what a pointer
    // observation is about. A probe keeps the templates at its slot and
    // drops the runtime-minted ones beneath it. It asks which reference
    // sits at ONE slot, and a template beneath labels which reference sits
    // at a child. Read at the sigil's path, a probe of a container matches
    // the container's own child template through the sigil key, as though
    // "/" were a child, and in the atomic layout, where the probe reads the
    // slot itself, recursion reaches it too. `Cell.set` probes the root of
    // the store it writes, so without this arm a writer of a store created
    // under a label carries that label onto every document it writes.
    //
    // The arm takes nothing from a reader of the children. Following a
    // child's slot consumes the template there through the probe of that
    // slot, reading a child's content or existence consumes the
    // `value`/`shape` twins, and a probe of a child's own slot consumes the
    // template there. Declared entries are the schema's policy and stay
    // consumed: a declared `observes:"followRef"` entry has no twin, and
    // this probe is what reaches it when a reader takes a whole
    // container's references.
    //
    // A probe of a slot that holds a reference drops the link entries
    // beneath the slot as well. The document has no position there, so
    // such an entry labels a position of the target, which the target
    // labels itself and a dereference consumes there: a reference-identity
    // read consumes no observation of the target (§4.6.3), and a copy of
    // the target's labels is no part of the reference's own (§8.2.5). A
    // link write persists none, but a stored envelope can hold them, as
    // copies of the target's labels. The link entry at the slot, which
    // carries such an envelope's restrictions on the reference itself,
    // stays consumed (§18.7).
    //
    // Whether the slot holds a reference is asked of the state the stored
    // envelope describes, the one before this transaction, so a
    // transaction that takes the reference and then writes the slot, as a
    // conditional re-pointing does, drops them too.
    const probedSlot = observation.shape === "followRef"
      ? probedSlotPath(logicalPath)
      : undefined;
    let holdsReferenceMemo: boolean | undefined;
    const holdsReference = (slot: readonly string[]): boolean =>
      holdsReferenceMemo ??= this.heldReferenceBefore(document, slot);
    const excludesTemplates = observation.coveredByTrace ||
      observation.machinery ||
      ownedContainers !== undefined || probedSlot !== undefined;
    const labelKey = stringTupleKey([
      observation.shape,
      String(observation.nonRecursive === true),
      String(observation.coveredByTrace || observation.machinery),
      String(observation.declaredOnward !== undefined),
      encodePointer(logicalPath),
    ]);
    if (state.resolved.has(labelKey)) {
      return {
        document: labels,
        firstOfDocument,
        labelKey,
        label: state.resolved.get(labelKey),
      };
    }
    const exclusion = excludesTemplates
      ? {
        excludeEntry: (entry: LabelMapEntry) =>
          ((observation.coveredByTrace || observation.machinery) &&
            isRuntimeMintedTemplate({
              origin: entry.origin,
              path: canonicalizeLogicalPath(entry.path),
            })) ||
          (ownedContainers !== undefined &&
            isReplacedMembershipEntry(entry, ownedContainers)) ||
          (probedSlot !== undefined &&
            (isRuntimeTemplateBeneath(entry, probedSlot) ||
              (isLinkEntryBeneath(entry, probedSlot) &&
                holdsReference(probedSlot)))),
      }
      : {};
    const entries = labels.metadata === undefined
      ? undefined
      : consumedEntriesForRead(
        labels.metadata,
        logicalPath,
        {
          nonRecursive: observation.nonRecursive,
          consumes: observation.shape,
          ...exclusion,
        },
        index,
      );
    const label = entries === undefined ? undefined : labelForConsumedEntries(
      entries,
      logicalPath,
      observation.nonRecursive,
    );
    state.resolved.set(labelKey, label);
    return {
      document: labels,
      firstOfDocument,
      labelKey,
      label,
      fresh: { entries, exclusion },
    };
  }

  /**
   * Returns the stored metadata and indexes of a document the resolver has
   * seen, or reads them now. `type` is the media type it is read as.
   */
  documentLabels(
    document: ObservedDocument,
    type: MediaType,
  ): ObservedDocumentLabels {
    const key = observedDocumentKey(document);
    const seen = this.#documents.get(key);
    if (seen !== undefined) return seen.labels;
    return this.#documentLabels(
      key,
      this.#deps.storedMetadata(document, type),
    );
  }

  /**
   * Returns the value at `path` of the document `target` names as this
   * transaction read it, or `undefined` when that is not known: the
   * transaction wrote at, above or beneath `path`, so what it holds now is
   * not what was read, or the document is a runtime secret, whose value only
   * its own module reads. The stored label metadata is the state the reads
   * consumed, so a value compared against it has to be that state too.
   *
   * A read records no value, so outside those two cases this returns the
   * value at prepare. The writes it checks are `valueWriteTargets`', which
   * leaves out content-addressed and reserved documents and the runtime's own
   * link plumbing; none of those puts a value where a probe found a
   * reference. A replica change after the read fails the commit's read-set
   * validation instead, except for a read the commit does not validate
   * (`ignoreReadForCommit`).
   */
  valueAsRead(
    target: ObservedDocument,
    path: readonly string[],
  ): { value: unknown } | undefined {
    const documentKey = observedDocumentKey(target);
    const key = stringTupleKey([documentKey, pathKey(path)]);
    if (this.#valuesAsRead.has(key)) return this.#valuesAsRead.get(key);
    const read = isRuntimeSecretId(target.id) ||
        this.#writtenPathIndex().get(documentKey)?.overlaps(path)
      ? undefined
      : {
        value: this.#tx.readValueOrThrow({ ...target, path }, {
          meta: stableInternalVerifierRead,
          nonRecursive: true,
        }),
      };
    this.#valuesAsRead.set(key, read);
    return read;
  }

  /**
   * Returns whether the slot at `path` of the document `target` names held a
   * reference in the state its stored label metadata describes, which is the
   * state before this transaction. Where the transaction left the slot alone,
   * that is the value as read. Where it wrote at or above the slot, what the
   * slot held before is recovered from the transaction's writes. A slot the
   * transaction wrote only beneath, whose earlier state can't be told, or of
   * a runtime secret, is taken to hold none, so everything stored beneath it
   * stays consumed.
   */
  heldReferenceBefore(
    target: ObservedDocument,
    path: readonly string[],
  ): boolean {
    const read = this.valueAsRead(target, path);
    if (read !== undefined) return isPrimitiveCellLink(read.value);
    if (isRuntimeSecretId(target.id)) return false;
    const key = observedDocumentKey(target);
    const coveredByWrite = this.#deps.writtenPaths().get(key)?.some(
      (written) => concretePathHasPrefix(path, written),
    );
    if (coveredByWrite !== true) return false;
    let before = this.#valuesBefore.get(key);
    if (before === undefined) {
      before = this.#deps.valuesBefore(target);
      this.#valuesBefore.set(key, before);
    }
    const held = before(path);
    return held?.length === 1 && isPrimitiveCellLink(held[0]);
  }

  /** Builds a document's lazily indexed view of its stored metadata. */
  #documentLabels(
    key: string,
    metadata: CfcMetadata | undefined,
  ): ObservedDocumentLabels {
    const indexes = new Map<ReadObservationShape, ConsumedLabelIndex>();
    const tx = this.#tx;
    return {
      key,
      metadata,
      indexFor: (shape) => {
        let index = indexes.get(shape);
        if (index === undefined && metadata !== undefined) {
          index = new ConsumedLabelIndex(metadata.labelMap.entries, {
            onQuery: (wildcard) =>
              tx.noteCfcPreparationWork?.(
                wildcard ? "overlapWildcardQueries" : "overlapConcreteQueries",
              ),
            select: consumedByShape(shape),
          });
          indexes.set(shape, index);
        }
        return index;
      },
    };
  }

  /** The paths this transaction wrote, indexed by document, built once. */
  #writtenPathIndex(): Map<string, PathPrefixIndex> {
    if (this.#writtenPaths === undefined) {
      this.#writtenPaths = new Map();
      for (const [document, paths] of this.#deps.writtenPaths()) {
        const index = new PathPrefixIndex();
        for (const writtenPath of paths) index.add(writtenPath);
        this.#writtenPaths.set(document, index);
      }
    }
    return this.#writtenPaths;
  }
}
