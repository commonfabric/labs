/**
 * Top-level `export`ed visitor functions.
 */

import type { FabricValuePlus } from "@/interface.ts";

import type { ValueVisitor } from "./interface.ts";
import { VisitInProgress } from "./VisitInProgress.ts";

/**
 * Performs a one-off visit of a value, with the given visitor.
 *
 * The engine does not validate `value`; it trusts the static type. Each value
 * it encounters is dispatched by a shallow inspection of its shape: an array,
 * a plain object, or a `FabricSpecialObject` is taken to be the fabric
 * container or primitive its shape indicates, whatever it holds, and only a
 * value whose shape is none of those is put to the visitor's `isPlusType()`.
 * So a container which is not inert is walked as its shape says: an array
 * carrying a named property `throw`s when its elements are iterated, and a
 * plain object's entries are read the way `Object.entries()` reads them, which
 * skips a symbol-keyed or non-enumerable property and runs an accessor. A
 * caller which needs a value validated does that before visiting it.
 */
export function visitValue<PlusType, ResultType>(
  value: NoInfer<FabricValuePlus<PlusType>>,
  visitor: ValueVisitor<PlusType, ResultType>,
): ResultType {
  const inProgress = new VisitInProgress<PlusType, ResultType>(visitor);
  return inProgress.visit(value);
}

/**
 * Creates a visitor function bound to the given visitor. The result is a
 * single-argument `visit(value)` function.
 */
export function makeVisitValueFunction<PlusType, ResultType>(
  visitor: ValueVisitor<PlusType, ResultType>,
): (
  value: FabricValuePlus<PlusType>,
) => ResultType {
  return (value: FabricValuePlus<PlusType>) => visitValue(value, visitor);
}
