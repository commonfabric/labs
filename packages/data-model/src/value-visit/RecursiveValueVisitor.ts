import {
  type FabricArrayPlus,
  type FabricInstancePlus,
  type FabricPlainObjectPlus,
  type FabricValue,
  type FabricValuePlus,
} from "@/interface.ts";
import {
  type FabricContainerValueTag,
  type FabricValuePlusTag,
  VALUE_TAGS,
} from "@/types";

import { BaseValueVisitor } from "./BaseValueVisitor.ts";
import {
  type BaselineVisitResult,
  DO_RECURSE_VALUES,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * Visitor which handles all containers by requesting that the engine iterate
 * over their contents. This includes a subclass contract method for visiting
 * atomic (non-container) values, along with no-op implementations of all the
 * `visited*()` methods. `recurse` results from container visits always request
 * value recursion only (not keys).
 */
export abstract class RecursiveValueVisitor<
  PlusType = never,
  ResultType = FabricValue,
> extends BaseValueVisitor<PlusType, ResultType> {
  //
  // Subclass contract
  //

  /**
   * Visits an atomic value (that is, a non-container value).
   */
  abstract visitAtomicValue(
    value: FabricValuePlus<PlusType>,
    tag: Exclude<FabricValuePlusTag, FabricContainerValueTag> | null,
  ): LeafVisitorResult<PlusType, ResultType>;

  //
  // Instance methods
  //

  /**
   * Returns a `recurse` result requesting value recursion (`DO_RECURSE_VALUES`)
   * when `value` is a container. Calls `visitAtomicValue()` for all other value
   * types.
   */
  override visitValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricValuePlusTag | null,
  ): LeafVisitorResult<PlusType, ResultType> {
    switch (tag) {
      case VALUE_TAGS.Array:
      case VALUE_TAGS.FabricInstance:
      case VALUE_TAGS.Object: {
        return DO_RECURSE_VALUES;
      }

      default: {
        return this.visitAtomicValue(value, tag);
      }
    }
  }

  /** @inheritDoc */
  override visitedFabricArrayElement(
    _array: FabricArrayPlus<PlusType>,
    _index: number,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  override visitedFabricArrayGap(
    _array: FabricArrayPlus<PlusType>,
    _start: number,
    _count: number,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  override visitedFabricInstance(
    _instance: FabricInstancePlus<PlusType>,
    _state: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  override visitedFabricPlainObjectEntry(
    _container: FabricPlainObjectPlus<PlusType>,
    _key: FabricValuePlus<PlusType>,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }
}
