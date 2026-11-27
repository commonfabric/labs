/**
 * A cell that delivers a value held in memory rather than its document's, for
 * tests that hand the reconciler what no document can hold: a value that is
 * itself a cell, an object a key hash refuses, a cycle, or a whole render tree
 * replaced at once.
 */

import type {
  Cell,
  MemorySpace,
  Runtime,
  SinkConsumedLabel,
} from "@commonfabric/runner";
import { patchableCell } from "../../runner/test/support/patchable-cell.ts";

/** What a read of a value cell consumes: no labels. */
const CONSUMED_NOTHING: SinkConsumedLabel = {
  confidentiality: [],
  integrity: [],
  modulePolicySpaces: new Map(),
  sources: [],
  locations: () => [],
};

/** A value cell, and the way to give it a new value. */
export interface ValueCell<T extends object> {
  /** The cell, to put where the reconciler reads a cell. */
  readonly cell: Cell<T>;

  /** Delivers `value` to every subscriber of {@link cell}. */
  set(value: T): void;
}

/** How many value cells have been made; it names the next one's document. */
let made = 0;

/**
 * Returns a cell naming a document of its own in `space`, which nothing
 * writes, whose `sink()` delivers `value`, and each value `set()` gives it
 * after that, to every subscriber. It carries no metadata, and resolves to
 * itself.
 */
export function valueCell<T extends object>(
  runtime: Runtime,
  space: MemorySpace,
  value: T,
): ValueCell<T> {
  const cell = patchableCell(
    runtime.getCell<T>(space, `value cell ${made++}`),
  );
  let current = value;
  const deliveries = new Set<(value: T) => void>();
  cell.sink = (callback, options) => {
    const deliver = (next: T) =>
      callback(
        next,
        undefined,
        options?.includeConsumedLabel ? CONSUMED_NOTHING : undefined,
      );
    deliveries.add(deliver);
    deliver(current);
    return () => {
      deliveries.delete(deliver);
    };
  };
  cell.getMetaRaw = () => undefined;
  cell.resolveAsCell = () => cell;
  return {
    cell,
    set: (next) => {
      current = next;
      for (const deliver of deliveries) deliver(next);
    },
  };
}
