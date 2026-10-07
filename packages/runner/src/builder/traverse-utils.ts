import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  FabricInstance,
  isFabricSpecialObject,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import { isUnavailable } from "@commonfabric/data-model/availability";
import { type FactoryInput, isPattern, isReactive } from "./types.ts";
import { noteDerivedCopy } from "./pattern-metadata.ts";
import { isCell } from "../cell.ts";
import { isCellResultForDereferencing } from "../query-result-proxy.ts";

/**
 * Traverse a value, _not_ entering cells
 *
 * @param value - The value to traverse
 * @param fn - The function to apply to each value, which can return a new value
 * @returns Transformed value
 */
export function traverseValue(
  unprocessedValue: FactoryInput<any>,
  fn: (value: any) => any,
  seen: Set<FactoryInput<any>> = new Set(),
): any {
  // Perform operation, replaces value if non-undefined is returned
  const result = fn(unprocessedValue);
  const value = result !== undefined ? result : unprocessedValue;

  // Prevent infinite recursion
  if (seen.has(value) || seen.has(result)) return value;
  if (isObjectOrArray(result)) seen.add(result);
  else if (isObjectOrArray(unprocessedValue)) seen.add(unprocessedValue);

  // A `FabricInstance` is NOT a leaf. It is a container reached by its codec
  // contents rather than by property name, which this walk cannot do, so the
  // rebuild below would hand back a bare `{}` -- and whatever `fn` was looking
  // for inside it would go unseen. It refuses instead of doing that quietly.
  //
  // This sits after `fn`, not before it, for the same reason the primitive
  // guard does: an instance is a value `fn` gets to see and may replace, and
  // only descending into one is refused.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction: a `FabricError` is exposed to pattern authors and ungated, so
  // what keeps this safe is that no caller yet puts one in a builder value.
  //
  // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
  // point this becomes a walk rather than a refusal.
  if (
    (value as object) instanceof FabricInstance && !isUnavailable(value)
  ) {
    refuseFabricInstance(
      value as FabricInstance,
      "when traversing a builder value",
    );
  }

  // Traverse value. A `FabricPrimitive` is an atomic value whose state lives
  // in private fields (zero enumerable own-props); descending into one would
  // rebuild it as `{}`, corrupting it. It has already been shown to `fn` above
  // like any other leaf — here we just decline to descend, so the original
  // value passes through intact. The test names the base class rather than
  // that one: an instance is refused above, so the two select the same values
  // here, and the class this walk declines to descend is the wider one.
  if (
    !isReactive(value) &&
    !isCell(value) &&
    !isCellResultForDereferencing(value) &&
    !isFabricSpecialObject(value) &&
    (isObjectOrArray(value) || isPattern(value))
  ) {
    if (Array.isArray(value)) {
      return (value as Array<any>).map((v) => traverseValue(v, fn, seen));
    } else {
      const copy = Object.fromEntries(
        Object.entries(value).map((
          [key, v],
        ) => [key, traverseValue(v, fn, seen)]),
      );
      // A pattern copied here must keep its link back to the original
      // (branded, content-addressed) factory — otherwise
      // `resolveOriginal`/`getArtifactEntryRef` would be severed, which is how
      // a pattern passed as an `op` is later identified by
      // `{ identity, symbol }`. Mirrors the registration in
      // `withAliasBindings`.
      if (isPattern(value)) noteDerivedCopy(copy, value);
      return copy;
    }
  } else {
    return value;
  }
}
