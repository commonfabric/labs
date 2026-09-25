import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isUnsafeObjectKey } from "@commonfabric/utils/types";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";

import {
  codecOf,
  NonterminalCodec,
  NULL_LIVE_ENVIRONMENT,
} from "@/codec-common";
import type {
  FabricArrayPlus,
  FabricContainerValuePlus,
  FabricInstancePlus,
  FabricPlainObjectPlus,
  FabricValuePlus,
  MutableFabricArrayPlusLayer,
  MutableFabricPlainObjectPlusLayer,
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
  type MapToForm,
  type RecurseForm,
  type ReplaceForm,
  type ValueVisitor,
  type VisitResult,
} from "./interface.ts";

/**
 * Special result form used to expand on `recurse`, such that it also conveys
 * the type tag of the container. This form is always used internally instead of
 * `recurse`, exactly so that a given value's tag need only be derived once
 * during visit dispatch.
 */
type RecurseOfForm<PlusType> = {
  readonly type: "recurseOf";
  readonly containerTag: FabricContainerValueTag;
  readonly container: FabricContainerValuePlus<PlusType>;
  readonly doKeys: boolean;
  readonly doValues: boolean;
};

/**
 * Possible results from the top `#visitValue()` method, and some of the
 * methods that effectively feed into it.
 */
type MainVisitResult<PlusType, ResultType> = Exclude<
  VisitResult<PlusType, ResultType>,
  RecurseForm | ReplaceForm<PlusType>
>;

/**
 * State of a visit currently in progress, along with most of the visit
 * execution machinery.
 *
 * This class is _intentionally_ omitted from the barrel `export` file for the
 * submodule.
 */
export class VisitInProgress<
  PlusType = never,
  ResultType = FabricValuePlus<PlusType>,
> {
  /** Concrete visitor implementation. */
  readonly #visitor: ValueVisitor<PlusType, ResultType>;

  /** Bound method call to `#visitor.isPlusType()`. */
  readonly #isPlusType: PlusTypePredicate<PlusType>;

  /** Container stack of the visit currently in progress. */
  readonly #stack = new IndexTrackingStack<FabricValuePlus<PlusType>>();

  /** Indicates if a visit is now actually in-progress. */
  #inProgress = false;

  /** Whether mapping results are to be collected. */
  #doMap = false;

  /**
   * Cached result of a call to `#visitor.isDomainAssignableToResultType()`, if
   * ever called.
   */
  #isDomainAssignableToResultType: boolean | undefined = undefined;

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
   * Performs a structural-map over the indicated value, as a top-level
   * operation.
   */
  map(
    value: FabricValuePlus<PlusType>,
  ): ResultType {
    return this.#topVisit(value, true);
  }

  /**
   * Visits the indicated value as a top-level operation.
   */
  visit(
    value: FabricValuePlus<PlusType>,
  ): ResultType {
    return this.#topVisit(value, false);
  }

  //
  // Visitor engine implementation
  //
  // This is arranged in approximately top-down fashion, to aid in readability.
  //

  /**
   * Performs a top-level visit or structural-map operation.
   */
  #topVisit(
    value: FabricValuePlus<PlusType>,
    doMap: boolean,
  ): ResultType {
    this.#assertNoConcurrentUse();

    this.#inProgress = true;
    this.#doMap = doMap;
    try {
      const result = this.#visitValue(value);
      switch (result?.type) {
        case undefined: {
          // `ResultType` might or might not include `undefined`, so we have to
          // check.
          return this.#assertResultType(undefined);
        }

        case "mainResult":
        case "mapTo": {
          // At the top level (where we are), the most sensible thing to do with
          // a `mapTo` is treat it just like a `mainResult`, so we do.
          return result.value;
        }

        default: {
          // deno-coverage-ignore-start

          // This is a defense-in-depth protection against bugs in this file.
          // Binding `result` as `never` also makes a result form which
          // `#visitValue()` can return, but which isn't handled above, a
          // compile-time error right here.
          const unhandled: never = result;
          const type = (unhandled as { type: string }).type;
          throw new Error(
            `Shouldn't happen: Got result type \`${type}\` at the top level of a visit.`,
          );
        }
          // deno-coverage-ignore-stop
      }
    } finally {
      this.#inProgress = false;
    }
  }

  /**
   * Visits a top-level value or contained sub-value.
   */
  #visitValue(
    value: FabricValuePlus<PlusType>,
  ): MainVisitResult<PlusType, ResultType> {
    const tag = this.#tagOfValueElseNull(value);
    const result = this.#visitResolvingCyclesAndReplacement(value, tag);

    switch (result?.type) {
      case "mainResult":
      case "mapTo":
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
   * Iteratively calls `visitValue()` and `visitCycle()` on the visitor, until
   * the visitor returns something other than a `replace` result.
   */
  #visitResolvingCyclesAndReplacement(
    value: FabricValuePlus<PlusType>,
    tag: FabricValuePlusTag | null,
  ):
    | RecurseOfForm<PlusType>
    | Exclude<
      VisitResult<PlusType, ResultType>,
      ReplaceForm<PlusType> | RecurseForm
    > {
    const vis = this.#visitor;

    for (;;) {
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
          tag = this.#tagOfValueElseNull(value);
          break;
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
  ): MainVisitResult<PlusType, ResultType> {
    const { container, doValues } = result;

    if (!doValues) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const array = container as FabricArrayPlus<PlusType>;
    const vis = this.#visitor;
    const mapResult: MutableFabricArrayPlusLayer<ResultType> | undefined =
      this.#doMap ? new Array(array.length) : undefined;

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
          const result = vis.visitingFabricArrayGap(
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
        const visitingResult = vis.visitingFabricArrayElement(
          array,
          idxNumber,
          element,
        );

        if (visitingResult?.type === "mainResult") {
          return visitingResult;
        }

        const elemResult = this.#handleMappingAsAppropriate(
          element,
          this.#visitValue(element),
        );

        switch (elemResult?.type) {
          case "mainResult": {
            return elemResult;
          }

          case "mapTo": {
            const mappedTo = elemResult.value;

            // `!` is valid, because we'll only see `mapTo` when we're actually
            // mapping.
            mapResult![idxNumber] = mappedTo;

            const result = vis.visitedFabricArrayElement(
              array,
              idxNumber,
              mappedTo,
            );

            if (result?.type === "mainResult") {
              return result;
            }

            break;
          }

          case undefined: {
            break;
          }
        }
      }

      if (array.length !== (lastIdx + 1)) {
        // There's a gap at the end of the array.
        const result = vis.visitingFabricArrayGap(
          array,
          lastIdx + 1,
          array.length - lastIdx - 1,
        );

        if (result?.type === "mainResult") {
          return result;
        }
      }

      return mapResult
        ? { type: "mapTo", value: this.#assertResultType(mapResult) }
        : undefined;
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
  ): MainVisitResult<PlusType, ResultType> {
    const { container, doValues } = result;

    if (!doValues) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const instance = container as FabricInstancePlus<PlusType>;
    const vis = this.#visitor;
    const codec = codecOf(instance);
    const state = codec.encode(instance, NULL_LIVE_ENVIRONMENT);

    this.#stack.push(instance);

    try {
      const visitingResult = vis.visitingFabricInstanceState(
        instance,
        state,
      );

      if (visitingResult?.type === "mainResult") {
        return visitingResult;
      }

      const stateResult = this.#handleMappingAsAppropriate(
        state,
        this.#visitValue(state),
      );

      switch (stateResult?.type) {
        case "mainResult": {
          return stateResult;
        }

        case undefined: {
          // Not mapping.
          return undefined;
        }
      }

      // We are doing a structural-map operation, and `stateResult` is
      // necessarily a `mapTo` (which might have been transformed from an "no
      // change" `undefined`).

      const mappedTo = (stateResult as MapToForm<ResultType>).value;
      const result = vis.visitedFabricInstanceState(instance, mappedTo);
      if (result?.type === "mainResult") {
        return result;
      }

      if (mappedTo === state) {
        // The state visit returned the original state value, so we in turn
        // return the original `FabricInstance`.
        return undefined;
      }

      // This cast is sound because `FabricInstance` implementations aren't
      // supposed to care about what their `PlusType` is. What we're saying
      // here is that whatever codec was used to encode the instance as
      // `FabricInstancePlus<PlusType>` is fine to use as a
      // `FabricInstancePlus<ResultType>` on state of type
      // `FabricValuePlus<ResultType>` to decode back into an instance.
      const codecForResultType = codec as NonterminalCodec<
        unknown
      > as NonterminalCodec<ResultType>;

      try {
        if (!codecForResultType.canDecode(mappedTo)) {
          throw new Error(
            debugStr`Codec of $quote${instance} refused replacement state $quote${mappedTo}`,
          );
        }
      } catch (cause) {
        throw new Error(
          debugStr`Codec of $quote${instance} failed while checking replacement state $quote${mappedTo}`,
          { cause },
        );
      }

      let codecTag;
      try {
        codecTag = codec.tagForValue(instance);
      } catch (cause) {
        throw new Error(
          debugStr`Codec of $quote${instance} failed when asked for a tag.`,
          { cause },
        );
      }

      try {
        return {
          type: "mapTo",
          value: this.#assertResultType(
            codecForResultType.decode(
              codecTag,
              mappedTo,
              NULL_LIVE_ENVIRONMENT,
            ),
          ),
        };
      } catch (cause) {
        throw new Error(
          debugStr`Codec of $quote${instance} accepted but then failed to decode replacement state $quote${mappedTo}`,
          { cause },
        );
      }
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
  ): MainVisitResult<PlusType, ResultType> {
    const { container, doKeys, doValues } = result;

    if (!(doKeys || doValues)) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const plainObj = container as FabricPlainObjectPlus<PlusType>;
    const entries = Object.entries(plainObj);
    const vis = this.#visitor;
    const mapResult: MutableFabricPlainObjectPlusLayer<ResultType> | undefined =
      this.#doMap ? {} : undefined;

    this.#stack.push(plainObj);

    try {
      for (const [key, value] of entries) {
        const visitingResult = vis.visitingFabricPlainObjectEntry(
          plainObj,
          key,
          value,
        );

        if (visitingResult?.type === "mainResult") {
          return visitingResult;
        }

        const keyResult = this.#handleMappingAsAppropriate(
          key,
          doKeys ? this.#visitValue(key) : undefined,
        );
        let keyMappedTo: string | undefined;

        switch (keyResult?.type) {
          case "mainResult": {
            return keyResult;
          }

          case "mapTo": {
            keyMappedTo = this.#assertValidPlainObjectKey(key, keyResult.value);
            break;
          }

          case undefined: {
            keyMappedTo = undefined;
            break;
          }
        }

        const valueResult = this.#handleMappingAsAppropriate(
          value,
          doValues ? this.#visitValue(value) : undefined,
        );
        let valueMappedTo: ResultType | undefined;

        switch (valueResult?.type) {
          case "mainResult": {
            return valueResult;
          }

          case "mapTo": {
            valueMappedTo = valueResult.value;
            break;
          }

          case undefined: {
            valueMappedTo = undefined;
            break;
          }
        }

        if (mapResult) {
          // `keyMappedTo!` is safe, because if we made it here, it necessarily
          // got set to a `string`.
          const finalKey: string = keyMappedTo!;
          const result = vis.visitedFabricPlainObjectEntry(
            plainObj,
            finalKey,
            valueMappedTo,
          );

          if (result?.type === "mainResult") {
            return result;
          }

          mapResult[finalKey] = valueMappedTo;
        }
      }

      return mapResult
        ? { type: "mapTo", value: this.#assertResultType(mapResult) }
        : undefined;
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
    finalValueTag: FabricValuePlusTag | null,
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
   * Throws a "no concurrent use" error, if this instance is currently in the
   * middle of a top-level operation. This is called both as defense-in-depth
   * protection against bugs in this submodule, and to serve as documentation
   * for the intended use of this class.
   */
  #assertNoConcurrentUse() {
    if (this.#inProgress) {
      throw new Error(
        "Shouldn't happen: Cannot use `VisitInProgress` for multiple concurrent top-level visits.",
      );
    }
  }

  /**
   * Asserts that the given value is a member of the visitor's `ResultType`,
   * returning it or `throw`ing if the assertion doesn't hold.
   */
  #assertResultType(
    value: FabricValuePlus<PlusType> | FabricValuePlus<ResultType>,
  ): ResultType {
    if (this.#isDomainAssignableToResultType === undefined) {
      this.#isDomainAssignableToResultType = this.#visitor
        .isDomainAssignableToResultType();
    }

    if (this.#isDomainAssignableToResultType) {
      // This cast is based on the assurance of `#visitor` that the cast is
      // correct, as far as the visitor is concerned.
      return value as ResultType;
    } else if (this.#visitor.isResultType(value)) {
      return value;
    }

    throw new Error(
      debugStr`Not a \`ResultType\` value: $quote${value}`,
    );
  }

  /**
   * Asserts that the given value is a valid `FabricPlainObject` property key.
   */
  #assertValidPlainObjectKey(
    original: string,
    value: FabricValuePlus<PlusType> | FabricValuePlus<ResultType>,
  ): string {
    if (typeof value !== "string") {
      throw new Error(
        debugStr`Visit of key $quote${original} mapped to non-string: $quote${value}`,
      );
    } else if (isUnsafeObjectKey(value)) {
      if (original === value) {
        throw new Error(
          debugStr`Visit of unsafe key $quote${original} mapped to itself.`,
        );
      } else {
        throw new Error(
          debugStr`Visit of key $quote${original} mapped to unsafe key: $quote${value}`,
        );
      }
    }

    return value;
  }

  /**
   * Gets the tag for the given value, consulting the visitor's `isPlusType()`
   * only where the value cannot be a `FabricValue`.
   */
  #tagOfValueElseNull(
    value: FabricValuePlus<PlusType>,
  ): FabricValuePlusTag | null {
    return tagOfFabricValueElseNull(value, this.#isPlusType);
  }

  /**
   * Converts a `#visitValue()` result from a `recurse`-induced sub-value
   * iteration as appropriate, based on the `#doMap` mode. Specifically, this
   * always returns a `mapTo` result when mapping (furthermore validating the
   * result as necessary), and always returns `undefined` when _not_ mapping.
   */
  #handleMappingAsAppropriate(
    original: FabricValuePlus<PlusType>,
    visitResult: MainVisitResult<PlusType, ResultType>,
  ): MainVisitResult<PlusType, ResultType> | undefined {
    if (!this.#doMap) {
      return undefined;
    }

    switch (visitResult?.type) {
      case "mainResult":
      case "mapTo": {
        return visitResult;
      }

      case undefined: {
        return { type: "mapTo", value: this.#assertResultType(original) };
      }
    }
  }
}
