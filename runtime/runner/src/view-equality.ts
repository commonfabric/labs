import {
  fabricAwareEqual,
  isFabricSpecialObject,
} from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { instanceReadThroughView } from "./query-result-proxy.ts";

/**
 * `fabricAwareEqual()` for operands that may hold query-result views, deciding
 * each view as the value it reads.
 *
 * `fabricAwareEqual()` takes no views. A view of a `FabricInstance` hides the
 * instance from `instanceof` and has no own keys, so that walk would read it
 * as an empty record, and two views of different instances as equal. This one
 * walks the same structure, reading through views the way they are read
 * anywhere else, and hands the value model only what a view cannot
 * misrepresent: a view built over an instance gives way to the instance it
 * reads, at the view's own instant, and every other view is walked as it
 * reads, with no read beyond the ones the walk makes. On operands holding no
 * view it answers as `fabricAwareEqual()` does.
 *
 * A pair of objects the walk meets again is taken as equal: had the first
 * meeting found a difference, the walk would already have returned `false`.
 * So a value whose links lead back into it compares without recursing forever,
 * and a document two paths share is walked once rather than once per path.
 */
export function fabricAwareEqualThroughViews(
  left: unknown,
  right: unknown,
): boolean {
  const met = new WeakMap<object, WeakSet<object>>();
  return deepEqual(left, right, (a, b) => {
    const partners = met.get(a);
    if (partners?.has(b)) return true;
    const answer = specialObjectThroughViewsEqual(a, b);
    if (answer === undefined) {
      if (partners === undefined) met.set(a, new WeakSet([b]));
      else partners.add(b);
    }
    return answer;
  });
}

/**
 * Helper for {@link fabricAwareEqualThroughViews}, deciding the object pairs
 * in which either side is a special object, held directly or read through a
 * view, and declining the rest.
 */
function specialObjectThroughViewsEqual(
  left: object,
  right: object,
): boolean | undefined {
  const leftValue = instanceReadThroughView(left) ?? left;
  const rightValue = instanceReadThroughView(right) ?? right;
  const leftIsSpecial = isFabricSpecialObject(leftValue);
  const rightIsSpecial = isFabricSpecialObject(rightValue);
  if (!(leftIsSpecial || rightIsSpecial)) return undefined;
  if (!(leftIsSpecial && rightIsSpecial)) return false;

  return fabricAwareEqual(leftValue, rightValue);
}
