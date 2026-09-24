/**
 * Types and constants for the visitor engine.
 */

import { type FabricContainerValueTag, type FabricValuePlusTag } from "@/types";

import type {
  FabricArrayPlus,
  FabricContainerValuePlus,
  FabricInstancePlus,
  FabricPlainObjectPlus,
  FabricValuePlus,
} from "@/interface.ts";

//
// Individual result form types and associated definitions
//

/**
 * A `mainResult` form. `value` is a value that is to be returned from the
 * original main (top-level) `visit()` call, and by returning this form, a
 * visitor indicates that the `visit()` should end promptly (do no further
 * sub-visits), returning this value.
 */
export type MainResultForm<ResultType> = {
  readonly type: "mainResult";
  readonly value: ResultType;
};

/**
 * A `recurse` form. This is returned by visitor methods which visit containers.
 * This tells the visitor engine that it should recursively visit the contents
 * of the container, such that each visited item is known by the engine to be
 * contained by the container which is being recursed into. The two `boolean`
 * properties indicate whether the container's keys and/or values are to be
 * recursed over. `doKeys` is ignored in a context where there is no key.
 *
 * If a visitor returns an instance of this type which (implicitly) references a
 * non-container, that situation is detected by the visitor engine at runtime
 * and results in a `throw`n error.
 *
 * **Note:** The visit calls per-mapping are specifically in key-then-value
 * order, and if the result of visiting a key is a `mainResult`, then that ends
 * the iteration before the corresponding value is visited.
 *
 * **Note:** It is technically possible to define a no-op instance of this type,
 * which is the equivalent to returning `undefined`. This is pointless, but it
 * is not prevented.
 */
export type RecurseForm = {
  readonly type: "recurse";
  readonly doKeys: boolean;
  readonly doValues: boolean;
};

/**
 * A `replace` form. `value` is a value that is to be used in place of the value
 * originally received by the visitor method which returns this. This tells the
 * visitor engine to redo a visit on the replacement, as if the replacement were
 * the value in the same position as the original: by calling `visitValue()`, or
 * `visitCycle()` if the replacement is a container already being visited.
 */
export type ReplaceForm<PlusType> = {
  readonly type: "replace";
  readonly value: FabricValuePlus<PlusType>;
};

/**
 * Standard instance of `RecurseForm` for recursing over keys and values. This
 * is only meaningful for recursing over mappings.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_KEYS_VALUES: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: true, doValues: true } as const,
);

/**
 * Standard instance of `RecurseForm` for recursing over keys only. This is only
 * meaningful for recursing over mappings.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_KEYS: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: true, doValues: false } as const,
);

/**
 * Standard instance of `RecurseForm` for recursing over values only. This
 * includes array elements and mapping values.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_VALUES: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: false, doValues: true } as const,
);

//
// `visit*()` method result union types
//

/**
 * Baseline possible results from most `ValueVisitor` and `DefaultValueVisitor`
 * methods, defining the result cases common to all of these methods.
 *
 * See the included result types for details on what they mean. As for
 * `undefined`, if a visitor returns it in the context of this type, it means
 * that the visit of the given value was completed; the visitor engine will not
 * process it further, and there is no specific value to return from (this part
 * of) the visit.
 */
export type BaselineVisitorMethodResult<ResultType> =
  | MainResultForm<ResultType>
  | undefined;

/**
 * Possible results from `visitValue()`, `visitCycle()`, or one of the methods
 * that `DefaultValueVisitor.visitValue()` can call (directly or indirectly).
 *
 * See the included result types for details on what they mean.
 */
export type VisitResult<PlusType, ResultType> =
  | BaselineVisitorMethodResult<ResultType>
  | RecurseForm
  | ReplaceForm<PlusType>;

/**
 * Possible results from `visited*()` calls (container iteration post-visit
 * methods).
 */
export type VisitedResult<ResultType> = BaselineVisitorMethodResult<ResultType>;

//
// Visitor interface
//

/**
 * Interface for visit receivers.
 *
 * Each `visit*()` method accepts a `value` in the (parametric)
 * `FabricValuePlus<PlusType>` family, in some cases along with other arguments,
 * and returns a structured result or `undefined`, which indicates what the
 * visitor engine should do next.
 * Different methods are allowed to return different subsets of the full
 * complement of possible results (see their declarations for more detail). Each
 * structured result type is documented as to its meaning.
 *
 * The value domain of visitors always includes `FabricValue`, and the
 * `PlusType` type parameter is available to selectively include another type
 * (possibly itself compound) as an additional option.
 */
export interface ValueVisitor<
  PlusType = never,
  ResultType = FabricValuePlus<PlusType>,
> {
  /**
   * Indicates whether the complete domain of a visitor -- that is, the type
   * `FabricValuePlus<PlusType>` -- is considered assignable to the `ResultType`
   * defined by the visitor. This is called at the start of a structural-map
   * operation, to determine whether or not the visitor engine ever needs to use
   * `isResultType()`.
   *
   * **Note:** This method is nascent: There are no structural-map methods in
   * this module, yet.
   */
  isDomainAssignableToResultType(): boolean;

  /**
   * Indicates whether or not the given value is compatible with the `PlusType`
   * type defined by the visitor. This is a type predicate for `PlusType`. The
   * visitor engine consults it only for a value which cannot be a
   * `FabricValue` -- a function, a unique (uninterned) symbol, or an object
   * which is neither an array, a plain object, nor a `FabricSpecialObject` --
   * and its result decides whether such a value is tagged `PlusType` or
   * `null`. A value with a fabric shape is never put to it, so a predicate
   * which would accept, say, a plain object never sees one.
   */
  isPlusType(value: unknown): value is PlusType;

  /**
   * Indicates whether or not the given value is compatible with the
   * `ResultType` defined by the visitor. This is a type predicate for
   * `ResultType`. The visitor engine consults it only when it cannot otherwise
   * determine membership of a value in `ResultType`.
   */
  isResultType(
    value: FabricValuePlus<PlusType> | FabricValuePlus<ResultType>,
  ): value is ResultType;

  /**
   * Visits a container value which is already in the process of being visited.
   * The visitor engine calls this method _instead of_ calling `visitValue()`
   * when the value to be visited is already in the middle of being visited. If
   * the visitor returns `recurse`, then the visitor engine will recurse into it
   * just as with a non-cyclic value. Likewise, any other return value is
   * treated equivalently to `visitValue()`. A visitor which wants to _defer_ to
   * `visitValue()` can just call that method.
   */
  visitCycle(
    /** Value to visit. */
    value: FabricContainerValuePlus<PlusType>,
    /** Tag of `value`. */
    tag: FabricContainerValueTag,
    /** Depth at which `value` was originally encountered. */
    originalDepth: number,
    /** Depth of the current visit. */
    thisDepth: number,
  ): VisitResult<PlusType, ResultType>;

  /**
   * Visits the given arbitrary value. The visitor engine calls this method for
   * every value it encounters, other than a container which is already in the
   * middle of being visited (for which, see `visitCycle()`). `tag` is the tag
   * of `value`, or `null` if `value` has no fabric shape and `isPlusType()` did
   * not claim it.
   */
  visitValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricValuePlusTag | null,
  ): VisitResult<PlusType, ResultType>;

  /**
   * Indicates that an array element was just visited. This method is called as
   * a result of the visitor returning a `recurse` result for a visited array
   * and is called _after_ the element itself was directly visited.
   */
  visitedFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<PlusType>,
  ): VisitedResult<ResultType>;

  /**
   * Indicates that an array gap (one or more holes) was just nominally visited.
   * This method is called as a result of the visitor returning a `recurse`
   * result for a visited array and is called during iteration as gaps are
   * encountered. The sequencing of this call is meant to mirror
   * `visitedFabricArrayElement()`, but since there is nothing to recurse on
   * (it's a gap, not any actual values), there is no regular `visitValue()`
   * call which immediately precedes it (hence the visit was "nominal"). `start`
   * is the start index of the gap (integer `>= 0`), and `count` is the number
   * of holes in the gap (integer `>= 1`). This method is called as a result of
   * the visitor returning a `recurse` result for a visited array.
   */
  visitedFabricArrayGap(
    array: FabricArrayPlus<PlusType>,
    start: number,
    count: number,
  ): VisitedResult<ResultType>;

  /**
   * Indicates that the instance state of a `FabricInstance` was just visited.
   * This method is called as a result of the visitor returning a `recurse`
   * result for a visited `FabricInstance` and is called _after_ the instance's
   * state was directly visited.
   */
  visitedFabricInstance(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<PlusType>,
  ): VisitedResult<ResultType>;

  /**
   * Indicates that `FabricPlainObject` entry was just visited. This method is
   * called as a result of the visitor returning a `recurse` result for a
   * visited `FabricPlainObject` and is called _after_ the entry's key and/or
   * value were directly visited.
   */
  visitedFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: FabricValuePlus<PlusType>,
    value: FabricValuePlus<PlusType>,
  ): VisitedResult<ResultType>;
}
