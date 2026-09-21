import {
  type FabricArrayPlus,
  type FabricContainerValuePlus,
  type FabricInstancePlus,
  type FabricPlainObjectPlus,
  type FabricValue,
  type FabricValuePlus,
} from "@/interface.ts";
import {
  type FabricContainerValueTag,
  type PrimitiveValueTag,
} from "@/types";

import { BaseValueVisitor } from "./BaseValueVisitor.ts";
import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  DO_RECURSE_VALUES,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * Visitor which handles all containers by requesting that the engine iterate
 * over their contents. Recursion is as follows:
 *
 * * `FabricArray` -- all elements (values).
 * * `FabricInstance` -- _the_ state value (it only has the one).
 * * `FabricPlainObject`s -- values only.
 *
 * The implementation includes a definition for all container-specific
 * `visit*()` methods, which all return `DO_RECURSE_VALUES` (per the above
 * description), and also implements no-op (empty) `visited*()` methods. Every
 * other method of the interface is left as defined by `BaseValueVisitor`. The
 * `visit*()` method implementations are intended to make it easy to override
 * implementations selectively, by overriding `visitFabricContainer()` to return
 * `DO_VISIT_SUBTYPE` and then whatever specific subtypes need to be altered.
 */
export abstract class RecursiveValueVisitor<
  PlusType = never,
  ResultType = FabricValue,
> extends BaseValueVisitor<PlusType, ResultType> {
  //
  // Instance members
  //

  /** @inheritDoc */
  override visitFabricArray(
    _value: FabricArrayPlus<PlusType>,
  ): LeafVisitorResult<PlusType, ResultType> {
    return DO_RECURSE_VALUES;
  }

  /** @inheritDoc */
  override visitFabricInstance(
    _value: FabricInstancePlus<PlusType>,
  ): LeafVisitorResult<PlusType, ResultType> {
    return DO_RECURSE_VALUES;
  }

  /** @inheritDoc */
  override visitFabricPlainObject(
    _value: FabricPlainObjectPlus<PlusType>,
  ): LeafVisitorResult<PlusType, ResultType> {
    return DO_RECURSE_VALUES;
  }

  /** @inheritDoc */
  override visitFabricContainer(
    _value: FabricContainerValuePlus<PlusType>,
    _tag: FabricContainerValueTag,
  ): DispatchingVisitorResult<PlusType, ResultType> {
    return DO_RECURSE_VALUES;
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
