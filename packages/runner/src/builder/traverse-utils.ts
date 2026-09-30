import { isInertArray } from "@commonfabric/utils/arrays";
import { isInertPlainObject } from "@commonfabric/utils/objects";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { FabricInstance, refuseFabricInstance } from "@commonfabric/data-model";
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

  // Traverse value. The walk descends a pattern, and a container it can
  // rebuild without changing what it is: an inert plain object or array, a
  // direct `Object` or `Array` whose own properties are all data properties,
  // under enumerable string keys or array indices. Those are the containers
  // `withAliasBindings()` walks as well. Anything else has already been shown
  // to `fn` above like any other leaf, and passes through as itself, because
  // the rebuild would lose what it is: a `FabricPrimitive`, an `Error` or a
  // `Date` would come back `{}`, as would a `FabricInstance` the check above
  // lets through, a `Uint8Array` as a record of its bytes, and a class
  // instance as a plain record; an accessor would be run, a symbol or
  // non-enumerable key dropped, a `null` prototype replaced. This walk converts
  // nothing, so such a value is given its fabric form, or refused, by the
  // conversion `withAliasBindings()` makes. `fn` is not shown what one holds,
  // such as a cell in an `Error`'s `cause` or in a class instance's field.
  //
  // The reactive, cell and query-result tests come first: a query-result proxy
  // over a record or an array answers the inertness question as its target
  // does.
  if (
    !isReactive(value) &&
    !isCell(value) &&
    !isCellResultForDereferencing(value) &&
    (isInertPlainObject(value) || isInertArray(value) || isPattern(value))
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
