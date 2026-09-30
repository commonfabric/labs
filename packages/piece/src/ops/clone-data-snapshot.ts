/**
 * Materializes and preloads values used by cross-space piece data snapshots.
 * The piece controller coordinates the surrounding storage transactions.
 */

import {
  type Cell,
  getCellOrThrow,
  isCell,
  isCellResult,
  isStream,
} from "@commonfabric/runner";
import {
  FabricInstance,
  isFabricSpecialObject,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  assertCloneDataUnlabeled,
  assertNoCloneFabricInstance,
  cloneCellKey,
  cloneEntityKey,
} from "./clone-data-guards.ts";

/** Copy materialized piece data into detached arrays and plain objects. */
export function snapshotCloneValue(
  value: unknown,
  sourceCell?: Cell<unknown>,
  seen = new WeakMap<object, unknown>(),
  cells = new Map<string, Cell<unknown>>(),
  preloadedCells?: { has(key: string): boolean },
): unknown {
  let cell = sourceCell;
  if (isCell(value)) {
    cell = value;
    if (
      preloadedCells !== undefined && !preloadedCells.has(cloneCellKey(cell))
    ) {
      throw new Error("piece data changed while it was being cloned");
    }
    value = value.get();
  } else if (isCellResult(value)) {
    cell = getCellOrThrow(value);
  }

  if (cell !== undefined) {
    const key = cloneCellKey(cell);
    if (preloadedCells !== undefined && !preloadedCells.has(key)) {
      throw new Error("piece data changed while it was being cloned");
    }
    cells.set(key, cell);
  }
  assertCloneDataUnlabeled(cell);
  assertCloneDataUnlabeled(value);
  const raw = cell?.getRawUntyped();
  if (value instanceof FabricInstance || raw instanceof FabricInstance) {
    throw new Error(
      "piece data containing FabricInstance values cannot be copied",
    );
  }
  if (!isWalkableObjectOrArray(value)) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    seen.set(value, snapshot);
    for (let index = 0; index < value.length; index++) {
      snapshot[index] = snapshotCloneValue(
        value[index],
        cell?.key(index),
        seen,
        cells,
        preloadedCells,
      );
    }
    return snapshot;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "piece data containing unsupported object values cannot be copied",
    );
  }
  const snapshot = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, snapshot);
  for (const key of Object.keys(value)) {
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: snapshotCloneValue(
        (value as Record<string, unknown>)[key],
        cell?.key(key),
        seen,
        cells,
        preloadedCells,
      ),
    });
  }
  return snapshot;
}

/** Load every linked cell that a later synchronous transaction read can reach. */
export async function preloadCloneValue(
  value: unknown,
  sourceCell: Cell<unknown> | undefined,
  cells: Map<string, Cell<unknown>>,
  loadedEntities = new Set<string>(),
  seen = new WeakSet<object>(),
): Promise<void> {
  let cell = sourceCell;
  if (isCell(value)) {
    cell = value;
  } else if (isCellResult(value)) {
    cell = getCellOrThrow(value);
  }

  if (cell !== undefined) {
    const key = cloneCellKey(cell);
    if (!cells.has(key)) {
      cells.set(key, cell);
      const entityKey = cloneEntityKey(cell);
      if (!loadedEntities.has(entityKey)) {
        if (isStream(cell)) {
          throw new Error("piece input containing streams cannot be copied");
        }
        assertNoCloneFabricInstance(cell.getRawUntyped());
        loadedEntities.add(entityKey);
        value = await cell.pull();
      } else if (isCell(value)) {
        value = value.get();
      }
    }
    if (isCell(value)) value = value.get();
  }

  assertNoCloneFabricInstance(value);
  assertCloneDataUnlabeled(cell);
  assertCloneDataUnlabeled(value);
  if (
    !isObjectOrArray(value) ||
    isFabricSpecialObject(value) || seen.has(value)
  ) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      await preloadCloneValue(
        value[index],
        cell?.key(index),
        cells,
        loadedEntities,
        seen,
      );
    }
    return;
  }
  for (const key of Object.keys(value)) {
    await preloadCloneValue(
      (value as Record<string, unknown>)[key],
      cell?.key(key),
      cells,
      loadedEntities,
      seen,
    );
  }
}
