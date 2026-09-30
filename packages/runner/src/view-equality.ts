import {
  fabricAwareEqual,
  isFabricSpecialObject,
} from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";

/**
 * `fabricAwareEqual()` for operands that may hold query-result views, deciding
 * each view as the value it reads.
 *
 * `fabricAwareEqual()` takes no views. This one walks the same structure,
 * reading through views the way they are read anywhere else, with no read
 * beyond the ones the walk makes, and hands the value model only the special
 * objects it reaches, which a read hands back as themselves rather than as
 * views. On operands holding no view it returns what `fabricAwareEqual()`
 * returns.
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
 * in which either side is a special object, and declining the rest.
 */
function specialObjectThroughViewsEqual(
  left: object,
  right: object,
): boolean | undefined {
  const leftIsSpecial = isFabricSpecialObject(left);
  const rightIsSpecial = isFabricSpecialObject(right);
  if (!(leftIsSpecial || rightIsSpecial)) return undefined;
  if (!(leftIsSpecial && rightIsSpecial)) return false;

  return fabricAwareEqual(left, right);
}
