import {
  type FabricArrayPlus,
  type FabricContainerValuePlus,
  type FabricInstancePlus,
  type FabricPlainObjectPlus,
  type FabricValuePlus,
} from "@/interface.ts";
import { type FabricContainerValueTag, type FabricValuePlusTag } from "@/types";
import { debugStr } from "@/value-debug";

import {
  ValueVisitor,
  type VisitedResult,
  type VisitingResult,
  type VisitResult,
} from "./interface.ts";

/**
 * Base implementation of `ValueVisitor`, which leaves most `ValueVisitor`
 * methods `abstract`, while providing reasonable defaults for just a couple
 * methods (see which for details).
 */
export abstract class BaseValueVisitor<
  PlusType = never,
  ResultType = FabricValuePlus<PlusType>,
> implements ValueVisitor<PlusType, ResultType> {
  //
  // Subclass contract
  //

  /** @inheritDoc */
  abstract visitValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricValuePlusTag | null,
  ): VisitResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitedFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<ResultType>,
  ): VisitedResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricInstanceState(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<ResultType>,
  ): VisitedResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: string,
    value: FabricValuePlus<ResultType>,
  ): VisitedResult<ResultType>;

  /** @inheritDoc */
  abstract visitingFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<PlusType>,
  ): VisitingResult<ResultType>;

  /** @inheritDoc */
  abstract visitingFabricArrayGap(
    array: FabricArrayPlus<PlusType>,
    start: number,
    count: number,
  ): VisitingResult<ResultType>;

  /** @inheritDoc */
  abstract visitingFabricInstanceState(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<PlusType>,
  ): VisitingResult<ResultType>;

  /** @inheritDoc */
  abstract visitingFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: string,
    value: FabricValuePlus<PlusType>,
  ): VisitingResult<ResultType>;

  //
  // Instance methods
  //

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `true`, thereby corresponding with the
   * default binding for the result type to `FabricValuePlus<PlusType>`.
   *
   * Any visitor with a non-default `PlusType` or `ResultType` _must_ override
   * this method if the default could cause the engine to return a type-lying
   * value _and_ the calling client cares about avoiding type lies.
   */
  isDomainAssignableToResultType(): boolean {
    return true;
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `false`, thereby corresponding with the
   * default binding for the `PlusType` parameter to `never`.
   *
   * Any visitor with a non-default `PlusType` must override this method if it
   * is to ever receive `PlusType` values.
   */
  isPlusType(_value: unknown): _value is PlusType {
    return false;
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `true`, thereby corresponding with the
   * default binding for the result type to `FabricValuePlus<PlusType>`.
   *
   * Any visitor with a non-default `PlusType` or `ResultType` _must_ override
   * this method if the default could cause the engine to return a type-lying
   * value _and_ the calling client cares about avoiding type lies.
   */
  isResultType(
    _value: FabricValuePlus<PlusType> | FabricValuePlus<ResultType>,
  ): _value is ResultType {
    return true;
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this throws an error indicating that visiting cycles is
   * not supported. Rationale: This is the safe choice.
   */
  visitCycle(
    value: FabricContainerValuePlus<PlusType>,
    _tag: FabricContainerValueTag,
    _originalDepth: number,
    _thisDepth: number,
  ): VisitResult<PlusType, ResultType> {
    this.throwNoCycles(value);
  }

  /**
   * Throws an error indicating that this visitor does not handle cycles.
   */
  protected throwNoCycles(value: FabricValuePlus<PlusType>): never {
    throw new Error(debugStr`Cannot visit cyclic value: $quote${value}`);
  }

  /**
   * Throws a "shouldn't happen" error, indicating a particular method should
   * not have been called.
   */
  protected throwShouldntCall(methodName: string): never {
    throw new Error(
      debugStr`Shouldn't happen: \`${methodName}()\` called on $quote${this}`,
    );
  }
}
