/**
 * A copy of a cell whose members a test can replace. A cell, and the prototype
 * every cell shares, is frozen, so a test that stands in for one of a cell's
 * members works on a copy this makes instead.
 */

import {
  type Cell,
  CellImpl,
  cellRuntime,
  cellTx,
  getCarriedCfcLabelView,
} from "../../src/cell.ts";
import type { FabricValue } from "@commonfabric/data-model";

// A cell whose own class holds every method, writable, so that assigning one
// on an instance shadows it rather than failing on the frozen prototype.
class PatchableCell extends CellImpl<FabricValue> {}

for (const name of Object.getOwnPropertyNames(CellImpl.prototype)) {
  const descriptor = Object.getOwnPropertyDescriptor(CellImpl.prototype, name)!;
  if (name === "constructor" || typeof descriptor.value !== "function") {
    continue;
  }
  Object.defineProperty(PatchableCell.prototype, name, {
    ...descriptor,
    writable: true,
    configurable: true,
  });
}

/**
 * Returns a cell naming what `cell` names, through the same runtime and
 * transaction, with the same kind and carried labels, whose methods a test can
 * replace or spy on.
 */
export function patchableCell<T>(cell: Cell<T>): Cell<T> {
  return new PatchableCell(
    cellRuntime(cell),
    cellTx(cell),
    cell.getAsNormalizedFullLink(),
    false,
    undefined,
    cell.kind,
    getCarriedCfcLabelView(cell),
  ) as unknown as Cell<T>;
}
