/**
 * The per-space estimate of how much a replica's documents weigh, for the
 * sizes read that tells which spaces carry a worker's working set. Measuring
 * a document walks it, so the estimate is built across reads: each read
 * measures documents until a node budget shared by every space is spent,
 * remembers each measurement for as long as the measured value lives, and
 * reports how far it has got. A read on a quiet replica soon costs nothing
 * but cache lookups, and a document a frame replaces is measured again at
 * the next read with budget to spare. The budget bounds every read: a
 * document the budget runs out inside is reported as a lower bound and
 * measured again when a read has more to spend on it.
 */

import {
  type FabricValue,
  isFabricSpecialObject,
} from "@commonfabric/data-model";
import { NULL_LIVE_ENVIRONMENT } from "@commonfabric/data-model/codec-common";
import { createDefaultJsonRegistry } from "@commonfabric/data-model/codecs";
import {
  FabricError,
  FabricMap,
  FabricSet,
} from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricKeyPair,
} from "@commonfabric/data-model/fabric-primitives";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import {
  approximateJsonSize,
  type InstanceMeasure,
} from "@commonfabric/utils/approximate-json-size";

/** One space's share of the documents a storage manager holds. */
export type SpaceDocumentSizes = {
  space: MemorySpace;

  /** Documents the space's replica holds, absent ones included. */
  documents: number;

  /** Documents watched on the space's session. */
  watched: number;

  /**
   * Documents whose confirmed value has been measured whole, or that have
   * none. Equal to `documents` once the estimate has caught up with the
   * replica.
   */
  measuredDocuments: number;

  /**
   * Documents the budget ran out inside, whose size the estimate holds as
   * a lower bound until a read has more budget to spend on them than the
   * last attempt did. One that stays here across reads is larger than the
   * whole budget.
   */
  truncatedDocuments: number;

  /**
   * The approximate JSON length of the space's confirmed documents, as
   * `approximateJsonSize()` measures one: the measured documents' sizes,
   * the truncated documents' lower bounds, and the measured documents' mean
   * for each document not yet reached. The pending layers over a document,
   * the materialized views cached beside it and the cells built over it are
   * not in the number, and neither is the heap's own per-object overhead;
   * what it ranks is the stored content each space keeps decoded in this
   * process.
   */
  approxBytes: number;
};

/**
 * Nodes the document measurement may visit in one sizes read, across every
 * space. The walk visits about a hundred thousand nodes a millisecond, so a
 * read spends at most about ten milliseconds measuring, and a replica whose
 * documents outrun the budget is measured across several reads.
 */
export const DOCUMENT_SIZE_NODE_BUDGET = 1_000_000;

/** The nodes one sizes read may still spend on measuring documents. */
export type MeasureBudget = { remaining: number };

/** A replica as the measurement sees one: its documents and their sizes. */
export type MeasurableSpace = {
  getDocumentSizes(budget: MeasureBudget): SpaceDocumentSizes;
};

/** The codecs the Fabric classes hand the walk their state through. */
const fabricCodecs = createDefaultJsonRegistry();

/**
 * How the walk measures a Fabric class, which keeps its payload where the
 * walk cannot see it: as a view of its state that the walk visits in its
 * place, within the same node budget. The view is what the class's own
 * codec encodes it to, one level deep, which shares the instance's strings
 * and values and allocates a wrapper around them; so an `UnknownValue` or
 * `ProblematicValue` hands over the state it preserves, a `FabricRegExp`
 * its source, flags and flavor, a `FabricLink` its payload. Four classes
 * are measured otherwise: a `FabricBytes` counts its bytes outright; a
 * `FabricError` hands over its fields and its extras as the lazy iterator
 * `extraEntries()` returns, so a budget runs out inside a large extras bag
 * without the bag being copied; a `FabricMap` or `FabricSet` hands over its
 * contents, their codecs having no encoding yet; a `FabricKeyPair` hands
 * over its algorithm alone, so its material stays where it is. An object
 * that is no Fabric class, or whose codec refuses it, is left to the walk.
 */
function fabricInstanceMeasure(instance: object): InstanceMeasure | undefined {
  if (instance instanceof FabricBytes) return { bytes: instance.length };
  if (instance instanceof FabricError) {
    return {
      view: {
        type: instance.type,
        name: instance.name,
        message: instance.message,
        stack: instance.stack,
        cause: instance.cause,
        extras: instance.extraEntries(),
      },
    };
  }
  if (instance instanceof FabricMap) return { view: instance.map };
  if (instance instanceof FabricSet) return { view: instance.set };
  if (instance instanceof FabricKeyPair) {
    return { view: { algorithm: instance.algorithm } };
  }
  if (!isFabricSpecialObject(instance)) return undefined;
  const codec = fabricCodecs.codecFromValue(instance as FabricValue);
  if (typeof codec !== "object") return undefined;
  try {
    return {
      view: codec.encode(instance as FabricValue, NULL_LIVE_ENVIRONMENT),
    };
  } catch {
    return undefined;
  }
}

/**
 * Measures every space's documents within `budget` nodes, shared so that no
 * space goes unmeasured in a read: each space is first given an equal share,
 * the division's remainder going one node each to the first spaces so the
 * shares add up to the budget, and what the shares leave unspent then goes,
 * in order, to the spaces still holding documents not measured whole, the
 * truncated ones among them. A share admits at least one document while the
 * budget covers every space, so each space's `approxBytes` then rests on a
 * sample of its own from the first read, and the estimate converges across
 * reads as `DocumentSizeEstimate` says.
 */
export function measureDocumentSizes(
  spaces: readonly MeasurableSpace[],
  budget: number,
): SpaceDocumentSizes[] {
  if (spaces.length === 0) return [];
  const share = Math.floor(budget / spaces.length);
  const remainder = budget - share * spaces.length;
  let unspent = 0;
  const measured = spaces.map((space, index) => {
    const own: MeasureBudget = {
      remaining: share + (index < remainder ? 1 : 0),
    };
    const sizes = space.getDocumentSizes(own);
    unspent += Math.max(0, own.remaining);
    return sizes;
  });
  const pooled: MeasureBudget = { remaining: unspent };
  return measured.map((sizes, index) =>
    pooled.remaining > 0 && sizes.measuredDocuments < sizes.documents
      ? spaces[index].getDocumentSizes(pooled)
      : sizes
  );
}

/**
 * Remembers the measured size of each document value it has seen, and sums a
 * replica's documents from those measurements within a budget. A value is
 * remembered for as long as the replica holds it: the cache is keyed weakly
 * by the value object, and a document whose confirmed value is replaced is
 * measured afresh.
 */
export class DocumentSizeEstimate {
  /**
   * What each value's last walk found: its size, or a lower bound and the
   * nodes the walk had visited when the budget ran out.
   */
  readonly #measured = new WeakMap<
    object,
    { bytes: number; nodes: number; complete: boolean }
  >();

  /**
   * Sums the confirmed `values` of one replica's documents. A value already
   * measured whole costs a lookup; one not yet measured is walked within
   * what `budget` has left, which the walk draws down as it goes, and one
   * the budget ran out inside keeps its lower bound until a read has more
   * budget left than that walk spent. An absent document, whose value is
   * `undefined`, counts as measured at no bytes.
   */
  measure(
    values: Iterable<EntityDocument | undefined>,
    budget: MeasureBudget,
  ): {
    documents: number;
    measuredDocuments: number;
    truncatedDocuments: number;
    approxBytes: number;
  } {
    let documents = 0;
    let measuredDocuments = 0;
    let measuredBytes = 0;
    let truncatedDocuments = 0;
    let truncatedBytes = 0;
    for (const value of values) {
      documents++;
      if (value === undefined) {
        measuredDocuments++;
        continue;
      }
      let size = this.#measured.get(value);
      if (
        size === undefined ||
        (!size.complete && budget.remaining > size.nodes)
      ) {
        if (budget.remaining <= 0) {
          if (size === undefined) continue;
        } else {
          size = approximateJsonSize(value, {
            instanceMeasure: fabricInstanceMeasure,
            nodeLimit: budget.remaining,
          });
          budget.remaining -= size.nodes;
          // A document is an object, and only an object can key the cache;
          // a value that is not one is measured again each read, which
          // costs what one leaf costs.
          if (typeof value === "object") this.#measured.set(value, size);
        }
      }
      if (size.complete) {
        measuredDocuments++;
        measuredBytes += size.bytes;
      } else {
        truncatedDocuments++;
        truncatedBytes += size.bytes;
      }
    }
    const unreached = documents - measuredDocuments - truncatedDocuments;
    const approxBytes = measuredBytes + truncatedBytes +
      (measuredDocuments === 0
        ? 0
        : Math.round(measuredBytes / measuredDocuments * unreached));
    return { documents, measuredDocuments, truncatedDocuments, approxBytes };
  }
}
