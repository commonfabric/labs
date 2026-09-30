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
 * A `mapTo` form. `value` is a value in the domain of `ResultType` which is to
 * be substituted in place of the visited value in the structural-map result.
 * The visitor engine places `value` as given, frozen or not, whether or not the
 * operation freezes the structure it builds: it is the visitor's statement of
 * what it wants in that position.
 */
export type MapToForm<ResultType> = {
  readonly type: "mapTo";
  readonly value: ResultType;
};

/**
 * A `mapToEntry` form. This is analogous to `MapToForm` in every way except
 * that a string `key` is additionally included.
 *
 * `key` is held to the rules a visited key's result is: it must be a key which
 * is safe to set on a plain object, and it may not be a key already mapped in
 * the same result.
 */
export type MapToEntryForm<ResultType> = {
  readonly type: "mapTo";
  readonly key: string;
  readonly value: ResultType;
};

/**
 * An `omit` form. This is used by a `visiting*()` method to indicate to the
 * engine that the array element or plain object entry about to be visited is to
 * be omitted from the mapped result. In the case of an array, this leaves a hole
 * (as opposed to "compacting" the array).
 */
export type OmitForm = {
  readonly type: "omit";
};

/**
 * A `recurse` form. This is returned by visitor methods which visit containers.
 * This tells the visitor engine that it should recursively visit the contents
 * of the container, such that each visited item is known by the engine to be
 * contained by the container which is being recursed into. The container's
 * values are always visited. `doKeys` indicates whether its keys are visited
 * too, and is ignored in a context where there is no key.
 *
 * If a visitor returns an instance of this type which (implicitly) references a
 * non-container, that situation is detected by the visitor engine at runtime
 * and results in a `throw`n error.
 *
 * **Note:** The visit calls per keyed item are specifically in key-then-value
 * order, and if the result of visiting a key is a `mainResult`, then that ends
 * the iteration before the corresponding value is visited.
 */
export type RecurseForm = {
  readonly type: "recurse";
  readonly doKeys: boolean;
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
 * A `replaceEntry` form. This is analogous to `ReplaceForm` in every way except
 * that a string `key` is additionally included.
 *
 * `key` is visited only when the `recurse` that caused the iteration asked for
 * keys to be visited, and is otherwise taken as the entry's final key. Either
 * way, the final key is held to the rules a `MapToEntryForm`'s `key` is.
 */
export type ReplaceEntryForm<PlusType> = {
  readonly type: "replace";
  readonly key: string;
  readonly value: FabricValuePlus<PlusType>;
};

/**
 * Standard instance of `OmitForm`.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_OMIT: OmitForm = Object.freeze(
  { type: "omit" } as const,
);

/**
 * Standard instance of `RecurseForm` for recursing over keys and values. This
 * is only meaningful for recursing over mappings.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_KEYS_VALUES: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: true } as const,
);

/**
 * Standard instance of `RecurseForm` for recursing over values only. This
 * includes array elements and mapping values.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_VALUES: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: false } as const,
);

//
// Visitor method result union types
//

/**
 * Baseline possible results from most `ValueVisitor` and `DefaultValueVisitor`
 * methods, defining the result cases common to all of these methods.
 *
 * See the included result types for details on what they mean. As for
 * `undefined`, if a visitor returns it in the context of this type, it means
 * that the visit of the given value was completed; the visitor engine will not
 * process it further. (`VisitResult` gives `undefined` a more specific meaning
 * for a container.)
 */
export type BaselineVisitorMethodResult<ResultType> =
  | MainResultForm<ResultType>
  | undefined;

/**
 * Possible results from `mapped*()` calls (container iteration post-visit
 * methods).
 */
export type MappedResult<ResultType> = BaselineVisitorMethodResult<ResultType>;

/**
 * Possible results from `visitValue()`, `visitCycle()`, or one of the methods
 * that `DefaultValueVisitor.visitValue()` can call (directly or indirectly).
 *
 * See the included result types for details on what they mean. What
 * `undefined` means depends on the visited value:
 *
 * * For a non-container, `undefined` means that the visit of the value was
 *   completed. In a structural-map operation, the value maps to itself.
 * * For a container, `undefined` means exactly the same as a `replace` whose
 *   replacement is `undefined`: the visitor engine goes on to visit `undefined`
 *   in the container's place, and the visitor may handle that visit or not. A
 *   visitor which wants to finish with a container without that further visit
 *   returns a `mapTo` instead. Beneath the top level of a plain visit a `mapTo`
 *   is ignored, and in a structural-map operation it supplies the container's
 *   result directly.
 */
export type VisitResult<PlusType, ResultType> =
  | BaselineVisitorMethodResult<ResultType>
  | MapToForm<ResultType>
  | RecurseForm
  | ReplaceForm<PlusType>;

/**
 * Possible results from `visitingFabricArrayElement()`, and the forms the other
 * `visiting*()` result types are described in terms of.
 *
 * A `mapTo` settles the sub-value's position without visiting it: in a
 * structural-map operation its `value` is placed there as given, and in a plain
 * visit the position is simply not visited. A `replace` visits its `value` in
 * place of the sub-value, exactly as if `visitValue()` had returned that
 * `replace`. Either way, in a structural-map operation the position is then
 * reported to the matching `mapped*()` method, as any other is, unless the
 * visit of a replacement ended the walk with a `mainResult`. An `omit` leaves
 * the position out of a structural-map operation's result without visiting it,
 * and is reported to no `mapped*()` method, there being no result to report; in
 * a plain visit the position is simply not visited. `undefined` visits the
 * sub-value itself.
 */
export type VisitingResult<PlusType, ResultType> =
  | BaselineVisitorMethodResult<ResultType>
  | MapToForm<ResultType>
  | OmitForm
  | ReplaceForm<PlusType>;

/**
 * Possible results from `visitingFabricArrayGap()`.
 */
export type VisitingGapResult<PlusType, ResultType> =
  BaselineVisitorMethodResult<ResultType>;

/**
 * Possible results from `visitingFabricInstanceState()`. See `VisitingResult`
 * for additional details about the forms it covers.
 */
export type VisitingStateResult<PlusType, ResultType> =
  | BaselineVisitorMethodResult<ResultType>
  | MapToForm<ResultType>
  | ReplaceForm<PlusType>;

/**
 * Possible results from `visitingFabricPlainObjectEntry()`. See
 * `VisitingResult` for additional details about the forms it covers;
 * `MapToEntryForm` parallels `MapToForm`.
 */
export type VisitingEntryResult<PlusType, ResultType> =
  | BaselineVisitorMethodResult<ResultType>
  | MapToEntryForm<ResultType>
  | OmitForm
  | ReplaceEntryForm<PlusType>;

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
   * `FabricValuePlus<PlusType>` -- is to be treated as always assignable to the
   * `ResultType` defined by the visitor. This is called at some point before
   * the would-be first call to `isResultType()` (generally, at most once per
   * visitor engine instantiation), to determine whether or not the visitor
   * engine ever needs to use `isResultType()`.
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
   *
   * **Note:** When `isDomainAssignableToResultType()` returns `true` for a
   * visitor, the engine will not call this method.
   */
  isResultType(
    value: FabricValuePlus<PlusType> | FabricValuePlus<ResultType>,
  ): value is ResultType;

  /**
   * Indicates that an array element was just mapped. This method is called as a
   * result of the visitor returning a `recurse` result for a visited array
   * while doing a structural-map operation, and it is called _after_ the
   * element itself was directly visited.
   *
   * `value` is the element as it stands in `array`, even where its visit
   * returned a `replace`, and `resultValue` is what it mapped to.
   */
  mappedFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<PlusType>,
    resultValue: FabricValuePlus<ResultType>,
  ): MappedResult<ResultType>;

  /**
   * Indicates that the instance state of a `FabricInstance` was just mapped.
   * This method is called as a result of the visitor returning a `recurse`
   * result for a visited `FabricInstance` while doing a structural-map
   * operation, and it is called _after_ the instance's state was directly
   * visited.
   *
   * `state` is the state as the instance's codec encoded it, and `resultState`
   * is what it mapped to.
   */
  mappedFabricInstanceState(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<PlusType>,
    resultState: FabricValuePlus<ResultType>,
  ): MappedResult<ResultType>;

  /**
   * Indicates that `FabricPlainObject` entry was just mapped. This method is
   * called as a result of the visitor returning a `recurse` result for a
   * visited `FabricPlainObject` while doing a structural-map operation, and it
   * is called _after_ the entry's key and/or value were directly visited.
   *
   * `key` and `value` are the entry as it stands in `container`, and
   * `resultKey` and `resultValue` are what they mapped to. Where keys are not
   * visited, `resultKey` is `key`.
   */
  mappedFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: string,
    value: FabricValuePlus<PlusType>,
    resultKey: string,
    resultValue: FabricValuePlus<ResultType>,
  ): MappedResult<ResultType>;

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
   * Indicates that an array element is about to be visited. This method is
   * called as a result of the visitor returning a `recurse` result for a
   * visited array, and it is called _just before_ the element itself is
   * visited, a visit its result may settle or redirect; see `VisitingResult`.
   */
  visitingFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<PlusType>,
  ): VisitingResult<PlusType, ResultType>;

  /**
   * Indicates that an array gap (one or more holes) is about to be nominally
   * visited. This method is called as a result of the visitor returning a
   * `recurse` result for a visited array, and it is called during iteration as
   * gaps are encountered. The sequencing of this call is meant to mirror
   * `visitingFabricArrayElement()`, but since there is nothing to recurse on
   * (it's a gap, not any actual values), there is no regular `visitValue()`
   * call which immediately follows it, nor is there a post-visit `mapped*()`
   * call (hence the visit was "nominal"). `start` is the start index of the gap
   * (integer `>= 0`), and `count` is the number of holes in the gap (integer
   * `>= 1`).
   */
  visitingFabricArrayGap(
    array: FabricArrayPlus<PlusType>,
    start: number,
    count: number,
  ): VisitingGapResult<PlusType, ResultType>;

  /**
   * Indicates that the instance state of a `FabricInstance` is about to be
   * visited. This method is called as a result of the visitor returning a
   * `recurse` result for a visited `FabricInstance`, and it is called _just
   * before_ the instance state itself is visited, a visit its result may settle
   * or redirect; see `VisitingResult`.
   */
  visitingFabricInstanceState(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<PlusType>,
  ): VisitingStateResult<PlusType, ResultType>;

  /**
   * Indicates that `FabricPlainObject` entry is about to be visited. This
   * method is called as a result of the visitor returning a `recurse` result
   * for a visited `FabricPlainObject`, and it is called _just before_ the key
   * and/or value of the entry are visited (as indicated by the `recurse` result
   * that caused iteration to happen), a visit its result may settle or
   * redirect; see `VisitingEntryResult`.
   */
  visitingFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: string,
    value: FabricValuePlus<PlusType>,
  ): VisitingEntryResult<PlusType, ResultType>;
}
