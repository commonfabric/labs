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
  type FabricValuePlusTag,
} from "@/types";
import { debugStr } from "@/value-debug";

import {
  type BaselineVisitResult,
  type LeafVisitorResult,
  ValueVisitor,
} from "./interface.ts";

/**
 * Base implementation of `ValueVisitor`, which implements most visitor methods
 * as `throw`ing a "shouldn't call" error, with a handful of exceptions. The
 * point of this arrangement is that many concrete visitors won't need to
 * implement every visitor method, and TypeScript doesn't let one just implement
 * _part_ of an abstract class's contract and try to call the result concrete.
 * Subclasses of this class _do_ get to avoid a lot of the boilerplate, but as a
 * result there may be cases where an implementer forgot about a method and only
 * discovers it through testing or at runtime and not because of the type
 * checker.
 *
 * The methods that don't just `throw` a "shouldn't call" error:
 *
 * * `isPlusType()` -- Implemented to return `false`, which is consistent with
 *   this class's default binding of `PlusType = never`.
 *
 * * `visitCycle()` -- Implemented to `throw` a "cycles not handled" error.
 *
 * * `visitFabricContainer()`, `visitValue()` -- Implemented to return
 *   `DO_VISIT_SUBTYPE`, so that concrete classes get subtype dispatched
 *   visiting by default (which is easy enough to override back to
 *   non-dispatched).
 *
 * **Note:** This class is marked `abstract` not because it has `abstract`
 * members but instead because it's simply not useful if directly instantiated.
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

  //
  // Instance methods
  //

  /** @inheritDoc */
  isPlusType(_value: unknown): _value is PlusType {
    return false;
  }

  /** @inheritDoc */
  visitCycle(
    value: FabricContainerValuePlus<PlusType>,
    _tag: FabricContainerValueTag,
    _originalDepth: number,
    _thisDepth: number,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwNoCycles(value);
  }

  /** @inheritDoc */
  visitedFabricArrayElement(
    _array: FabricArrayPlus<PlusType>,
    _index: number,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricArrayElement");
  }

  /** @inheritDoc */
  visitedFabricArrayGap(
    _array: FabricArrayPlus<PlusType>,
    _start: number,
    _count: number,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricArrayGap");
  }

  /** @inheritDoc */
  visitedFabricInstance(
    _instance: FabricInstancePlus<PlusType>,
    _state: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricInstance");
  }

  /** @inheritDoc */
  visitedFabricPlainObjectEntry(
    _container: FabricPlainObjectPlus<PlusType>,
    _key: FabricValuePlus<PlusType>,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricPlainObjectEntry");
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
