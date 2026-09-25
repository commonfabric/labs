import {
  fabricAwareEqual,
  isFabricSpecialObject,
} from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { getCellOrThrow, isCellResult } from "./query-result-proxy.ts";

/**
 * `fabricAwareEqual()` for operands that may hold query-result views, deciding
 * each view as the stored value it reads.
 *
 * `fabricAwareEqual()` takes no views. A view of a `FabricInstance` hides the
 * instance from `instanceof` and has no own keys, so that walk would read it
 * as an empty record, and two views of different instances as equal. This one
 * walks the same structure, reading through views the way they are read
 * anywhere else, and hands the value model only what a view cannot
 * misrepresent: where a view reads a special object, the stored one takes its
 * place, whether it sits inline or behind a link. On operands holding no view
 * it answers as `fabricAwareEqual()` does.
 */
export function fabricAwareEqualThroughViews(
  left: unknown,
  right: unknown,
): boolean {
  return deepEqual(left, right, specialObjectThroughViewsEqual);
}

/**
 * Helper for {@link fabricAwareEqualThroughViews}, deciding the object pairs
 * in which either side is a special object, stored or read through a view, and
 * declining the rest.
 */
function specialObjectThroughViewsEqual(
  left: object,
  right: object,
): boolean | undefined {
  const leftValue = isCellResult(left)
    ? storedSpecialObject(left) ?? left
    : left;
  const rightValue = isCellResult(right)
    ? storedSpecialObject(right) ?? right
    : right;
  const leftIsSpecial = isFabricSpecialObject(leftValue);
  const rightIsSpecial = isFabricSpecialObject(rightValue);
  if (!(leftIsSpecial || rightIsSpecial)) return undefined;
  if (!(leftIsSpecial && rightIsSpecial)) return false;

  return fabricAwareEqual(leftValue, rightValue);
}

/** The special object stored where `view` reads, when one is. */
function storedSpecialObject(view: object): object | undefined {
  const stored = getCellOrThrow(view).getRaw();
  return isFabricSpecialObject(stored) ? stored : undefined;
}
