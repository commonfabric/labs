/**
 * A props cell some of whose slots fail, for tests of what the reconciler does
 * when a slot cannot be followed or read.
 */

import type { Cell } from "@commonfabric/runner";
import { patchableCell } from "../../runner/test/support/patchable-cell.ts";

/**
 * Returns a copy of `cell`, as `patchableCell()` makes one, whose `key(name)`
 * returns what `slot` makes of the slot `cell.key(name)` returns.
 */
export function withSlots(
  cell: Cell<unknown>,
  slot: (name: string, original: () => Cell<unknown>) => Cell<unknown>,
): Cell<unknown> {
  const patched = patchableCell(cell);
  Object.defineProperty(patched, "key", {
    value: (name: string) => slot(name, () => cell.key(name)),
  });
  return patched;
}

/** A copy of `slot` that can be read but not followed to a cell of its own. */
export function unfollowable(slot: Cell<unknown>): Cell<unknown> {
  const patched = patchableCell(slot);
  patched.resolveAsCell = () => {
    throw new Error("slot cannot be followed");
  };
  patched.asSchema = () => unfollowable(slot);
  return patched;
}
