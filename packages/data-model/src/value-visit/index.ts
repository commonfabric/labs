/**
 * Types and classes for visiting (a/k/a, iterating or walking over) values in
 * the `FabricValuePlus` family.
 *
 * As with the `data-model` in general, the visitor engine uses `Object.is()`
 * comparisons (or equivalent) to determine value-sameness. This means that `0`
 * and `-0` are considered distinct, and that `NaN` is equal to itself.
 *
 * **IMPORTANT NOTE:** This submodule is a work-in-progress and not meant to be
 * used outside of the `data-model`. This is why it is _not_ exposed via the
 * `data-model`'s export map.
 */

export * from "./interface.ts";
export { BaseValueVisitor } from "./BaseValueVisitor.ts";
export { DefaultValueVisitor } from "./DefaultValueVisitor.ts";

export {
  makeMapValueFunction,
  makeVisitValueFunction,
  mapValue,
  visitValue,
} from "./impl.ts";
