import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { type Primitive } from "@commonfabric/utils/types";

import { codecOf, NULL_LIVE_ENVIRONMENT } from "@/codec-common";
import type {
  FabricArrayPlus,
  FabricContainerValuePlus,
  FabricInstancePlus,
  FabricPlainObjectPlus,
  FabricPrimitive,
  FabricValue,
  FabricValuePlus,
} from "@/interface.ts";
import {
  type FabricContainerValueTag,
  type FabricValuePlusTag,
  isFabricContainerValueTag,
  type PlusTypePredicate,
  tagOfFabricValueElseNull,
  VALUE_TAGS,
} from "@/types";
import { debugStr } from "@/value-debug";

import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  DO_VISIT_SUBTYPE,
  type LeafVisitorResult,
  type RecurseForm,
  type ReplaceForm,
  type ValueVisitor,
  type VisitSubtypeForm,
} from "./interface.ts";

/**
 * Special result form used to indicate what actual value to use as the target
 * of a `visitSubtype`, based on following the `replace` chain. This is used
 * _only_ when a replacement has been made (expected to be uncommon), thereby
 * avoiding allocation for the common un-replaced `visitSubtype` cases.
 */
type VisitSubtypeOfForm<PlusType> = {
  readonly type: "visitSubtypeOf";
  readonly value: FabricValuePlus<PlusType>;
};

/**
 * Similar to `VisitSubtypeOfForm`, but for `recurse`. Unlike that one, though,
 * this one is _always_ propagated in the engine after getting a plain `recurse`
 * result, on the theory that if we're going to recurse -- a relatively
 * heavyweight operation -- the one extra allocation is small potatoes, and it
 * keeps the code a wee bit simpler.
 */
type RecurseOfForm<PlusType> = {
  readonly type: "recurseOf";
  readonly containerTag: FabricContainerValueTag;
  readonly container: FabricContainerValuePlus<PlusType>;
  readonly doKeys: boolean;
  readonly doValues: boolean;
};

/**
 * State of a visit currently in progress, along with most of the visit
 * execution machinery.
 *
 * This class is _intentionally_ omitted from the barrel `export` file for the
 * submodule.
 */
export class VisitInProgress<PlusType = never, ResultType = FabricValue> {
  /** Concrete visitor implementation. */
  #visitor: ValueVisitor<PlusType, ResultType>;

  /** Bound method call to `#visitor.isPlusType()`. */
  #isPlusType: PlusTypePredicate<PlusType>;

  /** Container stack of the visit currently in progress. */
  #stack = new IndexTrackingStack<FabricValuePlus<PlusType>>();

  /** Indicates if a visit is now actually in-progress. */
  #inProgress = false;

  /**
   * Constructs an instance.
   */
  constructor(visitor: ValueVisitor<PlusType, ResultType>) {
    this.#visitor = visitor;
    this.#isPlusType = visitor.isPlusType.bind(visitor);
  }

  //
  // Public instance members
  //

  /**
   * Visits the indicated value as a top-level operation. See the top-level
   * `visitValue()` for the extent to which encountered values are inspected.
   */
  visit(value: FabricValuePlus<PlusType>): BaselineVisitResult<ResultType> {
    if (this.#inProgress) {
      // This is a defense-in-depth protection against bugs in this submodule,
      // and also serves as documentation for the intended use of this class.
      throw new Error(
        "Shouldn't happen: Cannot use `VisitInProgress` for multiple concurrent top-level visits.",
      );
    }

    this.#inProgress = true;
    try {
      return this.#visitValue(value);
    } finally {
      this.#inProgress = false;
    }
  }

  //
  // Visitor engine implementation
  //
  // This is arranged in approximately top-down fashion, to aid in readability.
  //

  /**
   * Visits a top-level value or contained sub-value.
   */
  #visitValue(
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    const result = this.#visitResolvingSubtype(value);

    switch (result?.type) {
      case "mainResult":
      case undefined: {
        return result;
      }

      case "recurseOf": {
        switch (result.containerTag) {
          case VALUE_TAGS.Array: {
            return this.#recurseFabricArray(result);
          }

          case VALUE_TAGS.FabricInstance: {
            return this.#recurseFabricInstance(result);
          }

          case VALUE_TAGS.Object: {
            return this.#recurseFabricPlainObject(result);
          }

          default: {
            // deno-coverage-ignore-start

            // This is a defense-in-depth protection against bugs in this
            // submodule: `containerTag` is typed as exactly the three cases
            // above, so nothing else can reach here.
            throw new Error(
              `Shouldn't happen: Got unrecognized \`containerTag\`: \`${result.containerTag}\``,
            );
          }
            // deno-coverage-ignore-stop
        }
      }

      default: {
        // deno-coverage-ignore-start

        // This is a defense-in-depth protection against bugs in this file. The
        // above is meant to cover all declared result types, so anything else
        // is a bug, either in this method or in result production.
        const type = (result as { type: string }).type;
        throw new Error(
          `Shouldn't happen: Got result type \`${type}\` from dispatched visitor method.`,
        );
      }
        // deno-coverage-ignore-stop
    }
  }

  /**
   * Iteratively calls `visitValue()`, `visitCycle()`, and the subtype-specific
   * visitor methods, until the visitor returns something other than a `replace`
   * or `visitSubtype` result.
   *
   * **Note:** We always transform `recurse` to `recurseOf` for returning from
   * this method. See comment on the definition of `RecurseOfForm` for details.
   */
  #visitResolvingSubtype(
    value: FabricValuePlus<PlusType>,
  ):
    | RecurseOfForm<PlusType>
    | Exclude<
      LeafVisitorResult<PlusType, ResultType>,
      ReplaceForm<PlusType>
    > {
    const vis = this.#visitor;

    for (;;) {
      const resolvedResult = this.#visitResolvingCyclesAndReplacement(value);

      switch (resolvedResult?.type) {
        case "visitSubtype": {
          // Need dispatch. `value` _has not_ been replaced.
          break;
        }

        case "visitSubtypeOf": {
          // Need dispatch. `value` _has_ been replaced.
          value = resolvedResult.value;
          break;
        }

        default: {
          // No dispatch required.
          return resolvedResult;
        }
      }

      const tag = this.#tagOfValueElseNull(value);
      let result: DispatchingVisitorResult<PlusType, ResultType>;

      switch (tag) {
        case VALUE_TAGS.Array: {
          const array = value as FabricArrayPlus<PlusType>;
          result = vis.visitFabricContainer(array, tag);
          if (result?.type === "visitSubtype") {
            result = vis.visitFabricArray(array);
          }
          break;
        }

        case VALUE_TAGS.FabricInstance: {
          const instance = value as FabricInstancePlus<PlusType>;
          result = vis.visitFabricContainer(instance, tag);
          if (result?.type === "visitSubtype") {
            result = vis.visitFabricInstance(instance);
          }
          break;
        }

        case VALUE_TAGS.Object: {
          const object = value as FabricPlainObjectPlus<PlusType>;
          result = vis.visitFabricContainer(object, tag);
          if (result?.type === "visitSubtype") {
            result = vis.visitFabricPlainObject(object);
          }
          break;
        }

        case VALUE_TAGS.PlusType: {
          result = vis.visitPlusType(value as PlusType);
          break;
        }

        case null: {
          // `null` means that `value` has no fabric shape and `isPlusType()`
          // did not claim it.
          throw new Error(
            debugStr`Encountered a value outside of the visitor's domain: $quote${value}`,
          );
        }

        default: {
          const prim = value as Primitive | FabricPrimitive;
          result = vis.visitPrimitive(prim, tag);
          break;
        }
      }

      switch (result?.type) {
        case "recurse": {
          return this.#adjustRecurseForm(result, value, tag);
        }

        case "replace": {
          value = result.value;
          break; // ...and continue to iterate.
        }

        default: {
          return result;
        }
      }
    }
  }

  /**
   * Iteratively calls `visitValue()` and `visitCycle()` on the visitor, until
   * the visitor returns something other than a `replace` result.
   */
  #visitResolvingCyclesAndReplacement(
    value: FabricValuePlus<PlusType>,
  ):
    | RecurseOfForm<PlusType>
    | VisitSubtypeOfForm<PlusType>
    | Exclude<
      DispatchingVisitorResult<PlusType, ResultType>,
      ReplaceForm<PlusType> | RecurseForm
    > {
    const vis = this.#visitor;
    const origValue = value;

    for (;;) {
      const tag = this.#tagOfValueElseNull(value);
      let result;

      if (isFabricContainerValueTag(tag)) {
        // We've narrowed on `tag`, but TypeScript can't tell that this
        // necessarily means that `value` is a container value. Hence this cast,
        // which is safe by construction.
        const container = value as FabricContainerValuePlus<PlusType>;

        const cycleAt = this.#stack.indexOf(container);
        result = (cycleAt === -1)
          ? vis.visitValue(container, tag)
          : vis.visitCycle(container, tag, cycleAt, this.#stack.depth);
      } else {
        result = vis.visitValue(value, tag);
      }

      switch (result?.type) {
        case "recurse": {
          return this.#adjustRecurseForm(result, value, tag);
        }

        case "replace": {
          value = result.value;
          break;
        }

        case "visitSubtype": {
          return this.#visitSubtypeFormFor(origValue, value);
        }

        default: {
          return result;
        }
      }
    }
  }

  /**
   * Recurses into a `FabricArray`, iterating over all its elements, in response
   * to a `recurse` result.
   */
  #recurseFabricArray(
    result: RecurseOfForm<PlusType>,
  ): BaselineVisitResult<ResultType> {
    const { container, doValues } = result;
    const array = container as FabricArrayPlus<PlusType>;
    const vis = this.#visitor;

    if (!doValues) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    this.#stack.push(array);

    let lastIdx = -1;
    try {
      for (const idx in array) {
        if (!isArrayIndexPropertyName(idx)) {
          throw new Error(
            `Non-index property in alleged \`FabricArray\`: \`${idx}\``,
          );
        }

        const idxNumber = Number(idx);

        if (idxNumber !== (lastIdx + 1)) {
          // There's a gap just before this element.
          const result = vis.visitedFabricArrayGap(
            array,
            lastIdx + 1,
            idxNumber - lastIdx - 1,
          );
          if (result?.type === "mainResult") {
            return result;
          }
        }

        lastIdx = idxNumber;

        const element = array[idxNumber]!;
        const elemResult = this.#visitValue(element);
        if (elemResult?.type === "mainResult") {
          return elemResult;
        }

        // TODO(danfuzz): When we have a non-`mainResult` visit-result type,
        // we'll want to pass the result value from `elemResult` into
        // `visitedFabricArrayElement()` and not the original `element`.
        const result = vis.visitedFabricArrayElement(array, idxNumber, element);
        if (result?.type === "mainResult") {
          return result;
        }
      }

      if (array.length !== (lastIdx + 1)) {
        // There's a gap at the end of the array.
        const result = vis.visitedFabricArrayGap(
          array,
          lastIdx + 1,
          array.length - lastIdx - 1,
        );
        if (result?.type === "mainResult") {
          return result;
        }
      }

      return undefined;
    } finally {
      this.#stack.popExpect(array);
    }
  }

  /**
   * Recurses into a `FabricInstance`, in response to a `recurse` result. The
   * recursion consists of a single sub-value visit, of the instance's state,
   * per its normal codec.
   */
  #recurseFabricInstance(
    result: RecurseOfForm<PlusType>,
  ): BaselineVisitResult<ResultType> {
    const { container, doValues } = result;
    const instance = container as FabricInstancePlus<PlusType>;
    const vis = this.#visitor;

    if (!doValues) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const state = codecOf(instance).encode(instance, NULL_LIVE_ENVIRONMENT);
    this.#stack.push(instance);

    try {
      const stateResult = this.#visitValue(state);
      if (stateResult?.type === "mainResult") {
        return stateResult;
      }

      // TODO(danfuzz): When we have a non-`mainResult` visit-result type, we'll
      // want to pass the result value from the visits immediately above instead
      // of the original `state`.
      const result = vis.visitedFabricInstance(instance, state);
      if (result?.type === "mainResult") {
        return result;
      }

      return undefined;
    } finally {
      this.#stack.popExpect(instance);
    }
  }

  /**
   * Recurses into a `FabricPlainObject`, iterating over all its entries, in
   * response to a `recurse` result.
   */
  #recurseFabricPlainObject(
    result: RecurseOfForm<PlusType>,
  ): BaselineVisitResult<ResultType> {
    const { container, doKeys, doValues } = result;
    const plainObj = container as FabricPlainObjectPlus<PlusType>;
    const vis = this.#visitor;

    if (!(doKeys || doValues)) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const entries = Object.entries(plainObj);

    this.#stack.push(plainObj);

    try {
      for (const [key, value] of entries) {
        if (doKeys) {
          const keyResult = this.#visitValue(key);
          if (keyResult?.type === "mainResult") {
            return keyResult;
          }
        }

        if (doValues) {
          const valueResult = this.#visitValue(value);
          if (valueResult?.type === "mainResult") {
            return valueResult;
          }
        }

        // TODO(danfuzz): When we have a non-`mainResult` visit-result type,
        // we'll want to pass the result value(s) from the visits immediately
        // above instead of the original `key` and `value`.
        const result = vis.visitedFabricPlainObjectEntry(plainObj, key, value);
        if (result?.type === "mainResult") {
          return result;
        }
      }

      return undefined;
    } finally {
      this.#stack.popExpect(plainObj);
    }
  }

  //
  // Utility methods
  //

  /**
   * Validates and rewrites a `recurse` form as a `recurseOf` form.
   */
  #adjustRecurseForm(
    result: RecurseForm,
    finalValue: FabricValuePlus<PlusType>,
    finalValueTag: FabricValuePlusTag,
  ): RecurseOfForm<PlusType> {
    switch (finalValueTag) {
      case VALUE_TAGS.Array:
      case VALUE_TAGS.FabricInstance:
      case VALUE_TAGS.Object: {
        return {
          type: "recurseOf",
          containerTag: finalValueTag,
          container: finalValue as FabricContainerValuePlus<PlusType>,
          doKeys: result.doKeys,
          doValues: result.doValues,
        };
      }
    }

    throw new Error(
      debugStr`Cannot use \`recurse\` result with non-container: $quote${finalValue}`,
    );
  }

  /**
   * Returns either a `visitSubtype` or `visitSubtypeOf` form as necessary,
   * based on whether the visited value is a replacement.
   */
  #visitSubtypeFormFor(
    origValue: FabricValuePlus<PlusType>,
    finalValue: FabricValuePlus<PlusType>,
  ):
    | VisitSubtypeForm
    | VisitSubtypeOfForm<PlusType> {
    if (Object.is(origValue, finalValue)) {
      return DO_VISIT_SUBTYPE;
    }

    return {
      type: "visitSubtypeOf",
      value: finalValue,
    };
  }

  /**
   * Gets the tag for the given value, consulting the visitor's `isPlusType()`
   * only where the value's shape is not a fabric one.
   */
  #tagOfValueElseNull(
    value: FabricValuePlus<PlusType>,
  ): FabricValuePlusTag | null {
    return tagOfFabricValueElseNull(value, this.#isPlusType);
  }
}
