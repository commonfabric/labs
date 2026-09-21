import {
  type FabricArrayPlus,
  type FabricContainerValuePlus,
  type FabricInstancePlus,
  type FabricPlainObjectPlus,
  type FabricValue,
  type FabricValuePlus,
} from "@/interface.ts";
import { type FabricContainerValueTag, type FabricValuePlusTag } from "@/types";
import { debugStr } from "@/value-debug";

import {
  type BaselineVisitResult,
  type LeafVisitorResult,
  ValueVisitor,
} from "./interface.ts";

/**
 * Base implementation of `ValueVisitor`, which leaves most `ValueVisitor`
 * methods `abstract`, while providing reasonable defaults for just a couple
 * methods (see which for details).
 */
export abstract class BaseValueVisitor<
  PlusType = never,
  ResultType = FabricValue,
> implements ValueVisitor<PlusType, ResultType> {
  //
  // Subclass contract
  //

  /** @inheritDoc */
  abstract visitValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricValuePlusTag | null,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitedFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricArrayGap(
    array: FabricArrayPlus<PlusType>,
    start: number,
    count: number,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricInstance(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: FabricValuePlus<PlusType>,
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType>;

  //
  // Instance methods
  //

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `false`, thereby corresponding with the
   * default binding for the `PlusType` parameter to `never`.
   */
  isPlusType(_value: unknown): _value is PlusType {
    return false;
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
  ): LeafVisitorResult<PlusType, ResultType> {
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
