import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  FabricInstance,
  isFabricSpecialObject,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import { type FactoryInput, isPattern, isReactive } from "./types.ts";
import { noteDerivedCopy } from "./pattern-metadata.ts";
import { isCell } from "../cell.ts";
import { isCellResultForDereferencing } from "../query-result-proxy.ts";
import { canCarryFabricInstanceWhole } from "../whole-instance.ts";

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
  // for inside it would go unseen. One holding nothing but fabric data has
  // nothing inside for `fn` to find, and passes through whole, as a
  // `FabricPrimitive` does; anything else is refused rather than lost quietly.
  //
  // This sits after `fn`, not before it, for the same reason the primitive
  // guard does: an instance is a value `fn` gets to see and may replace, and
  // only descending into one is refused.
  //
  // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
  // point this becomes a walk rather than a refusal.
  if (
    (value as object) instanceof FabricInstance &&
    !canCarryFabricInstanceWhole(value as FabricInstance)
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
  // value passes through intact, and so does an instance that reaches here,
  // which holds nothing but fabric data.
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
