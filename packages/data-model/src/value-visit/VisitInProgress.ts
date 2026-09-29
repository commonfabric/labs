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
  type MainResultForm,
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
 * Configuration for `VisitInProgress`
 */
export type VisitInProgressConfig =
  | { mode: "visit" }
  | { mode: "map"; freeze: boolean };

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

  /** Whether mapping results are to be collected. */
  readonly #mapMode: boolean;

  /** When in mapping mode, whether to freeze mapped containers. */
  readonly #freezeMappedContainers: boolean;

  /** Bound method call to `#visitor.isPlusType()`. */
  readonly #isPlusType: PlusTypePredicate<PlusType>;

  /** Container stack of the visit currently in progress. */
  readonly #stack = new IndexTrackingStack<FabricValuePlus<PlusType>>();

  /** Indicates if a visit is now actually in-progress. */
  #inProgress = false;

  /**
   * Cached result of a call to `#visitor.isDomainAssignableToResultType()`, if
   * ever called.
   */
  #isDomainAssignableToResultType: boolean | undefined = undefined;

  /**
   * Constructs an instance.
   */
  constructor(
    visitor: ValueVisitor<PlusType, ResultType>,
    config: VisitInProgressConfig,
  ) {
    this.#visitor = visitor;
    this.#mapMode = config.mode === "map";
    this.#freezeMappedContainers = (config.mode === "map")
      ? config.freeze
      : false;

    this.#isPlusType = visitor.isPlusType.bind(visitor);
  }

  //
  // Public instance members
  //

  /**
   * Performs a visit over the indicated value, as a top-level operation. This
   * does either a plain visit or a map, depending on how this instance was
   * configured.
   */
  visit(
    value: FabricValuePlus<PlusType>,
  ): ResultType {
    this.#assertNoConcurrentUse();

    this.#inProgress = true;
    try {
      const result = this.#visitValue(value);
      switch (result?.type) {
        case undefined: {
          if (this.#mapMode) {
            return this.#assertResultType(value);
          } else {
            // `ResultType` might or might not include `undefined`, so we have to
            // check.
            return this.#assertResultType(undefined);
          }
        }

        case "mainResult":
        case "mapTo": {
          // At the top level (where we are), the most sensible thing to do with
          // a `mapTo` is treat it just like a `mainResult`, so we do.
          return result.value;
        }

        default: {
          // deno-coverage-ignore-start
          this.#throwShouldntHappenResultType(result);
        }
          // deno-coverage-ignore-stop
      }
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
        const { container, containerTag } = result;
        let recurseResult: MainVisitResult<PlusType, ResultType>;

        switch (containerTag) {
          case VALUE_TAGS.Array: {
            recurseResult = this.#recurseFabricArray(result);
            break;
          }

          case VALUE_TAGS.FabricInstance: {
            recurseResult = this.#recurseFabricInstance(result);
            break;
          }

          case VALUE_TAGS.Object: {
            recurseResult = this.#recurseFabricPlainObject(result);
            break;
          }

          default: {
            // deno-coverage-ignore-start

            // This is a defense-in-depth protection against bugs in this
            // submodule: `containerTag` is typed as exactly the three cases
            // above, so nothing else can reach here.
            throw new Error(
              `Shouldn't happen: Got unrecognized \`containerTag\`: \`${containerTag}\``,
            );
          }
            // deno-coverage-ignore-stop
        }

        if (
          (recurseResult === undefined) && this.#mapMode &&
          !Object.is(container, value)
        ) {
          // The recursion found no changes, but it was a recursion into a
          // `replace`ment, which stands in place of the original value.
          return { type: "mapTo", value: this.#assertResultType(container) };
        }

        return recurseResult;
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
   * the visitor returns something other than a `replace` result. An
   * `undefined` result for a container is treated exactly as a `replace` whose
   * replacement is `undefined`. When doing a structural-map operation, an
   * `undefined` ("no change") result for a non-container replacement becomes a
   * `mapTo` of the replacement.
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
    const original = value;

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
          if (result === undefined) {
            if (isFabricContainerValueTag(tag)) {
              // For a container, `undefined` means `replace(undefined)`.
              value = undefined;
              tag = this.#tagOfValueElseNull(value);
              continue;
            } else if (this.#mapMode && !Object.is(value, original)) {
              // "No change" to a `replace`ment means that the replacement
              // stands in place of the original value.
              return { type: "mapTo", value: this.#assertResultType(value) };
            }
          }

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
    const { container } = result;

    const array = container as FabricArrayPlus<PlusType>;
    const vis = this.#visitor;
    const mapResult: MutableFabricArrayPlusLayer<ResultType> | undefined =
      this.#mapMode ? new Array(array.length) : undefined;
    let anyChanges = false;

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
            anyChanges ||= !Object.is(element, mappedTo);

            const result = vis.mappedFabricArrayElement(
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

          default: {
            // deno-coverage-ignore-start
            this.#throwShouldntHappenResultType(elemResult);
          }
            // deno-coverage-ignore-stop
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
        ? this.#makeRecurseResult(array, mapResult, anyChanges)
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
    const { container } = result;

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

        case "mapTo": {
          // We are doing a structural-map operation. (The `mapTo` might have
          // been transformed from a "no change" `undefined`.) Handled below.
          break;
        }

        default: {
          // deno-coverage-ignore-start
          this.#throwShouldntHappenResultType(stateResult);
        }
          // deno-coverage-ignore-stop
      }

      const mappedTo = stateResult.value;
      const result = vis.mappedFabricInstanceState(instance, mappedTo);
      if (result?.type === "mainResult") {
        return result;
      }

      // Under freezing, a frozen instance whose state came back as itself is
      // the result as it stands. Anything else is rebuilt from the mapped
      // state, as given: a container the walk recursed into has already been
      // built with the frozenness this operation calls for, and a value a
      // visitor supplied is the visitor's, so neither is the walk's to freeze.
      // The rebuilt instance is left as its codec's `decode()` returned it,
      // having been asked for the frozenness this operation calls for.
      if (
        this.#freezeMappedContainers && Object.isFrozen(instance) &&
        Object.is(mappedTo, state)
      ) {
        return undefined;
      }

      const instanceResult = this.#reconstructFabricInstance(
        instance,
        codec,
        mappedTo,
      );

      return { type: "mapTo", value: this.#assertResultType(instanceResult) };
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
    const { container, doKeys } = result;

    const plainObj = container as FabricPlainObjectPlus<PlusType>;
    const entries = Object.entries(plainObj);
    const vis = this.#visitor;
    const mapResult: MutableFabricPlainObjectPlusLayer<ResultType> | undefined =
      this.#mapMode ? {} : undefined;
    let anyChanges = false;

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

        const keyResult = this.#handlePlainObjectKeyMappingAsAppropriate(
          key,
          doKeys ? this.#visitValue(key) : undefined,
        );
        let keyMappedTo: string | undefined;

        switch (keyResult?.type) {
          case "mainResult": {
            return keyResult;
          }

          case "mapTo": {
            keyMappedTo = keyResult.value;
            if (Object.hasOwn(mapResult!, keyMappedTo)) {
              throw new Error(
                debugStr`Visit of key $quote${key} mapped to already-mapped key: $quote${keyMappedTo}`,
              );
            }
            break;
          }

          case undefined: {
            keyMappedTo = undefined;
            break;
          }

          default: {
            // deno-coverage-ignore-start
            this.#throwShouldntHappenResultType(keyResult);
          }
            // deno-coverage-ignore-stop
        }

        const valueResult = this.#handleMappingAsAppropriate(
          value,
          this.#visitValue(value),
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

          default: {
            // deno-coverage-ignore-start
            this.#throwShouldntHappenResultType(valueResult);
          }
            // deno-coverage-ignore-stop
        }

        if (mapResult) {
          // `keyMappedTo!` is safe, because if we made it here, it necessarily
          // got set to a `string`.
          const finalKey: string = keyMappedTo!;
          const result = vis.mappedFabricPlainObjectEntry(
            plainObj,
            finalKey,
            valueMappedTo,
          );

          if (result?.type === "mainResult") {
            return result;
          }

          mapResult[finalKey] = valueMappedTo;
          anyChanges ||= !Object.is(key, finalKey) ||
            !Object.is(value, valueMappedTo);
        }
      }

      return mapResult
        ? this.#makeRecurseResult(plainObj, mapResult, anyChanges)
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
   * Converts a `#visitValue()` result from a `recurse`-induced sub-value
   * iteration as appropriate, based on `#mapMode`. Specifically, a
   * `mainResult` is always returned as-is. Other than that, this always returns
   * a `mapTo` result when mapping (furthermore validating the result as
   * necessary), and always returns `undefined` when _not_ mapping.
   */
  #handleMappingAsAppropriate(
    original: FabricValuePlus<PlusType>,
    visitResult: MainVisitResult<PlusType, ResultType>,
  ): MainVisitResult<PlusType, ResultType> {
    if (!this.#mapMode) {
      return (visitResult?.type === "mainResult") ? visitResult : undefined;
    }

    switch (visitResult?.type) {
      case "mainResult":
      case "mapTo": {
        return visitResult;
      }

      case undefined: {
        return { type: "mapTo", value: this.#assertResultType(original) };
      }

      default: {
        // deno-coverage-ignore-start
        this.#throwShouldntHappenResultType(visitResult);
      }
        // deno-coverage-ignore-stop
    }
  }

  /**
   * Converts a `#visitValue()` result being used as a plain object key, from a
   * `recurse`-induced sub-value iteration, as appropriate, based on `#mapMode`.
   */
  #handlePlainObjectKeyMappingAsAppropriate(
    original: string,
    visitResult: MainVisitResult<PlusType, ResultType>,
  ): MainResultForm<ResultType> | MapToForm<string> | undefined {
    if (!this.#mapMode) {
      return (visitResult?.type === "mainResult") ? visitResult : undefined;
    }

    switch (visitResult?.type) {
      case "mainResult": {
        return visitResult;
      }

      case "mapTo": {
        this.#assertValidPlainObjectKey(original, visitResult.value);
        return visitResult as MapToForm<string>;
      }

      case undefined: {
        return {
          type: "mapTo",
          value: this.#assertValidPlainObjectKey(original, original),
        };
      }

      default: {
        // deno-coverage-ignore-start
        this.#throwShouldntHappenResultType(visitResult);
      }
        // deno-coverage-ignore-stop
    }
  }

  /**
   * Makes the result value for one of the `recurse*()` methods, when performing
   * a structural-map operation. See the main docs for `mapValue()` and
   * `mutableMapValue()` in re when `undefined` can be returned and when copies
   * of containers must be made.
   */
  #makeRecurseResult(
    originalValue: FabricValuePlus<PlusType>,
    resultValue: FabricValuePlus<ResultType>,
    anyChanges: boolean,
  ): MapToForm<ResultType> | undefined {
    if (this.#freezeMappedContainers) {
      if (!anyChanges && Object.isFrozen(originalValue)) {
        return undefined;
      }

      Object.freeze(resultValue);
      // ...and continue below.
    }

    return { type: "mapTo", value: this.#assertResultType(resultValue) };
  }

  /**
   * Helper for `#recurseFabricInstance`, which uses the original instance's
   * codec to reconstruct a result from the original's encoded state, with lots
   * of error checking to help produce nice messages.
   */
  #reconstructFabricInstance(
    originalInstance: FabricInstancePlus<PlusType>,
    originalCodec: NonterminalCodec<PlusType>,
    resultState: FabricValuePlus<ResultType>,
  ): FabricInstancePlus<ResultType> {
    // This cast is sound because `FabricInstance` implementations aren't
    // supposed to care about what their `PlusType` is. What we're saying here
    // is that whatever codec was used to encode the instance as
    // `FabricInstancePlus<PlusType>` is fine to use as a
    // `FabricInstancePlus<ResultType>` on state of type
    // `FabricValuePlus<ResultType>` to decode back into an instance.
    const resultCodec = originalCodec as NonterminalCodec<
      unknown
    > as NonterminalCodec<ResultType>;

    let canDecode;
    try {
      canDecode = resultCodec.canDecode(resultState);
    } catch (cause) {
      throw new Error(
        debugStr`Codec of $quote${originalInstance} failed while checking replacement state $quote${resultState}`,
        { cause },
      );
    }

    if (!canDecode) {
      throw new Error(
        debugStr`Codec of $quote${originalInstance} refused replacement state $quote${resultState}`,
      );
    }

    let codecTag;
    try {
      codecTag = originalCodec.tagForValue(originalInstance);
    } catch (cause) {
      throw new Error(
        debugStr`Codec of $quote${originalInstance} failed when asked for a tag.`,
        { cause },
      );
    }

    try {
      return resultCodec.decode(
        codecTag,
        resultState,
        NULL_LIVE_ENVIRONMENT,
        !this.#freezeMappedContainers,
      ) as FabricInstancePlus<ResultType>;
    } catch (cause) {
      throw new Error(
        debugStr`Codec of $quote${originalInstance} accepted but then failed to decode replacement state $quote${resultState}`,
        { cause },
      );
    }
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

  // deno-coverage-ignore-start
  /**
   * Throws a "shouldn't happen" error, used in `default` cases of `switch`
   * statements that should never end up called by virtue of all the possible
   * result types being handled. `result` is typed `never` so that a `switch`
   * which fails to handle one of its result types is a compile-time error at
   * the call site.
   */
  #throwShouldntHappenResultType(result: never): never {
    const type = (result as { type: string }).type;
    throw new Error(`Shouldn't happen: Got result type \`${type}\`.`);
  }
  // deno-coverage-ignore-stop
}
