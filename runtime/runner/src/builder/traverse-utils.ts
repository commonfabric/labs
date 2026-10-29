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

/**
 * Traverse a value, _not_ entering cells, rebuilding each container reached
 * from what `fn` returns for its members.
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
  return walkValue(unprocessedValue, fn, seen, true);
}

/**
 * Like {@link traverseValue}, except nothing is rebuilt: `fn` sees every
 * value the traversal reaches, and what it returns decides only what is
 * descended into. For a caller that collects what a value holds, this is the
 * traversal without the copy it would throw away.
 */
export function visitValue(
  value: FactoryInput<any>,
  fn: (value: any) => any,
): void {
  walkValue(value, fn, new Set(), false);
}

/**
 * Helper for the rebuild, which gives `copy` the own property `key` holding
 * `value`. An assignment would do for every name but `__proto__`, which an
 * engine that keeps the `Object.prototype` accessor routes to the prototype
 * setter; that one is defined instead.
 */
function defineOwn(
  copy: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === "__proto__") {
    Object.defineProperty(copy, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    copy[key] = value;
  }
}

/**
 * Helper for `traverseValue()` and `visitValue()`, which walks one value and
 * rebuilds its containers only when `rebuild` is set.
 */
function walkValue(
  unprocessedValue: FactoryInput<any>,
  fn: (value: any) => any,
  seen: Set<FactoryInput<any>>,
  rebuild: boolean,
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
  if ((value as object) instanceof FabricInstance) {
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
      const elements = value as unknown[];
      if (!rebuild) {
        // By index, skipping holes, as the rebuild's `map()` does: a hole is
        // no value for `fn` to see.
        for (let index = 0; index < elements.length; index++) {
          if (index in elements) walkValue(elements[index], fn, seen, false);
        }
        return value;
      }
      return elements.map((v) => walkValue(v, fn, seen, true));
    } else {
      const record = value as Record<string, unknown>;
      if (!rebuild) {
        for (const key in record) {
          if (Object.hasOwn(record, key)) {
            walkValue(record[key], fn, seen, false);
          }
        }
        return value;
      }
      const copy: Record<string, unknown> = {};
      for (const key in record) {
        if (Object.hasOwn(record, key)) {
          defineOwn(copy, key, walkValue(record[key], fn, seen, true));
        }
      }
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
