import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  FabricUnavailable,
  type FabricPrimitiveValueTag,
} from "@/fabric-primitives";
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
  type JsPrimitiveTypeValueTag,
  type PrimitiveValueTag,
  VALUE_TAGS,
} from "@/types";
import { debugStr } from "@/value-debug";

import { BaseValueVisitor } from "./BaseValueVisitor.ts";
import {
  type BaselineVisitResult,
  DO_RECURSE_VALUES,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * `BaseValueVisitor` subclass which provides a convenient structure and default
 * implementation, with the aim of making it easy to define concrete subclasses
 * for a particular purpose, via minimal method overriding.
 *
 * The class provides tag-based dispatch to visitor methods for each recognized
 * tag along with one for unrecognized values, along with (for most of them)
 * default implementations which "roll up" to category-specific methods. See the
 * documentation on each method for information about default implementations
 * and category structure.
 *
 * This class also provides a default no-op implementation for all the
 * `visited*()` methods.
 *
 * **Note:** This class is marked `abstract` not because it has `abstract`
 * members but instead because it's simply not useful if directly instantiated.
 */
export abstract class DefaultValueVisitor<
  PlusType = never,
  ResultType = FabricValue,
> extends BaseValueVisitor<PlusType, ResultType> {
  //
  // Instance methods: Specific type tags
  //

  /**
   * Visits a value of type `bigint`. If not overridden, this calls
   * `visitJsPrimitiveValue()`.
   */
  visitBigint(value: bigint): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(value, VALUE_TAGS.bigint);
  }

  /**
   * Visits a value of type `boolean`. If not overridden, this calls
   * `visitJsPrimitiveValue()`.
   */
  visitBoolean(value: boolean): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(value, VALUE_TAGS.boolean);
  }

  /**
   * Visits a value of type `FabricArray`. If not overridden, this calls
   * `visitFabricContainerValue()`.
   */
  visitFabricArray(value: FabricArrayPlus<PlusType>): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricContainerValue(value, VALUE_TAGS.Array);
  }

  /**
   * Visits a value of type `FabricBytes`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricBytes(value: FabricBytes): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricBytes);
  }

  /**
   * Visits a value of type `FabricEpochDay`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricEpochDay(value: FabricEpochDay): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricEpochDay);
  }

  /**
   * Visits a value of type `FabricEpochNsec`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricEpochNsec(value: FabricEpochNsec): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricEpochNsec);
  }

  /**
   * Visits a value of type `FabricHash`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricHash(value: FabricHash): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricHash);
  }

  /**
   * Visits a value of type `FabricInstance`. If not overridden, this calls
   * `visitFabricContainerValue()`.
   */
  visitFabricInstance(value: FabricInstancePlus<PlusType>): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricContainerValue(value, VALUE_TAGS.FabricInstance);
  }

  /**
   * Visits a value of type `FabricKeyPair`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricKeyPair(value: FabricKeyPair): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricKeyPair);
  }

  /**
   * Visits a value of type `FabricPlainObject`. If not overridden, this calls
   * `visitFabricContainerValue()`.
   */
  visitFabricPlainObject(value: FabricPlainObjectPlus<PlusType>): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricContainerValue(value, VALUE_TAGS.Array);
  }

  /**
   * Visits a value of type `FabricRegExp`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricRegExp(value: FabricRegExp): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricRegExp);
  }

  /**
   * Visits a value of type `FabricUnavailable`. If not overridden, this calls
   * `visitFabricPrimitiveValue()`.
   */
  visitFabricUnavailable(value: FabricUnavailable): LeafVisitorResult<PlusType, ResultType> {
    return this.visitFabricPrimitiveValue(value, VALUE_TAGS.FabricUnavailable);
  }

  /**
   * Visits a value of type `null` (that is, the value `null` per se). If not
   * overridden, this calls `visitJsPrimitiveValue()`.
   */
  visitNull(): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(null, VALUE_TAGS.null);
  }

  /**
   * Visits a value of type `number`. If not overridden, this calls
   * `visitJsPrimitiveValue()`.
   */
  visitNumber(value: number): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(value, VALUE_TAGS.number);
  }

  /**
   * Visits a value determined to be the `PlusType` by virtue of the visitor
   * engine having called `isPlusType()` on it and gotten a truthy return value.
   * If not overridden, this calls `visitAnyValue()`.
   */
  visitPlusType(
    value: PlusType,
  ): LeafVisitorResult<PlusType, ResultType> {
    return this.visitAnyValue(value, VALUE_TAGS.PlusType);
  }

  /**
   * Visits a value of type `string`. If not overridden, this calls
   * `visitJsPrimitiveValue()`.
   */
  visitString(value: string): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(value, VALUE_TAGS.string);
  }

  /**
   * Visits a value of type `symbol`. If not overridden, this calls
   * `visitJsPrimitiveValue()`.
   */
  visitSymbol(value: symbol): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(value, VALUE_TAGS.symbol);
  }

  /**
   * Visits a value of type `undefined` (that is, the value `undefined` per se).
   * If not overridden, this calls `visitJsPrimitiveValue()`.
   */
  visitUndefined(): LeafVisitorResult<PlusType, ResultType> {
    return this.visitJsPrimitiveValue(undefined, VALUE_TAGS.undefined);
  }

  /**
   * Visits a value which was not recognized to be any known value, including
   * the `PlusType`. If not overridden, this throws an error, indicating the
   * situation.
   */
  visitUnrecognizedValue(
    value: unknown,
  ): LeafVisitorResult<PlusType, ResultType> {
    const msg = debugStr`Cannot visit unrecognized value: $quote${value}`;
    throw new Error(msg);
  }

  //
  // Instance methods: Type/tag categories
  //

  /**
   * Visits an arbitrary value. This is the method that gets called for any
   * value which didn't end up handled by a non-default specific-tag or
   * category-covering `visit*()` method. If not overridden, this returns
   * `undefined`.
   */
  visitAnyValue(_value: FabricValuePlus<PlusType>, _tag: FabricValuePlusTag | null): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /**
   * Visits a container value. If not overridden, this returns a `recurse`
   * result (`DO_RECURSE_VALUES`), thereby requesting value recursion of the
   * engine.
   *
   * **Note:** This implementation intentionally does _not_ default to calling
   * `visitAnyValue()`, because it is expected that most useful visitors will in
   * fact want to recurse into containers. Subclasses that don't want this can
   * of course just override this implementation.
   */
  visitFabricContainerValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricContainerValueTag,
  ): LeafVisitorResult<PlusType, ResultType> {
    return DO_RECURSE_VALUES;
  }

  /**
   * Visits a `FabricPrimitive` value. If not overridden, this calls
   * `visitPrimitiveValue()`.
   */
  visitFabricPrimitiveValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricPrimitiveValueTag,
  ): LeafVisitorResult<PlusType, ResultType> {
    return this.visitPrimitiveValue(value, tag);
  }

  /**
   * Visits a JS primitive value. If not overridden, this calls
   * `visitPrimitiveValue()`.
   */
  visitJsPrimitiveValue(
    value: FabricValuePlus<PlusType>,
    tag: JsPrimitiveTypeValueTag,
  ): LeafVisitorResult<PlusType, ResultType> {
    return this.visitPrimitiveValue(value, tag);
  }

  /**
   * Visits a primitive value, including both regular JS primitives _and_
   * `FabricPrimitive`s. If not overridden, this calls `visitAnyValue()`.
   */
  visitPrimitiveValue(
    value: FabricValuePlus<PlusType>,
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<PlusType, ResultType> {
    return this.visitAnyValue(value, tag);
  }

  //
  // Instance methods
  //

  /**
   * Calls through to the most type-specific `visit*()` method, returning
   * whatever that method returns.
   */
  override visitValue(
    value: FabricValuePlus<PlusType>,
    tag: FabricValuePlusTag | null,
  ): LeafVisitorResult<PlusType, ResultType> {
    // The casts in the following are all safe, assuming the visitor was called
    // with an honestly-derived `tag`.

    switch (tag) {
      case VALUE_TAGS.Array: {
        return this.visitFabricArray(value as FabricArrayPlus<PlusType>);
      }

      case VALUE_TAGS.bigint: {
        return this.visitBigint(value as bigint);
      }

      case VALUE_TAGS.boolean: {
        return this.visitBoolean(value as boolean);
      }

      case VALUE_TAGS.null: {
        return this.visitNull();
      }

      case VALUE_TAGS.number: {
        return this.visitNumber(value as number);
      }

      case VALUE_TAGS.string: {
        return this.visitString(value as string);
      }

      case VALUE_TAGS.symbol: {
        return this.visitSymbol(value as symbol);
      }

      case VALUE_TAGS.undefined: {
        return this.visitUndefined();
      }

      case VALUE_TAGS.FabricBytes: {
        return this.visitFabricBytes(value as FabricBytes);
      }

      case VALUE_TAGS.FabricEpochDay: {
        return this.visitFabricEpochDay(value as FabricEpochDay);
      }

      case VALUE_TAGS.FabricEpochNsec: {
        return this.visitFabricEpochNsec(value as FabricEpochNsec);
      }

      case VALUE_TAGS.FabricHash: {
        return this.visitFabricHash(value as FabricHash);
      }

      case VALUE_TAGS.FabricInstance: {
        return this.visitFabricInstance(value as FabricInstancePlus<PlusType>);
      }

      case VALUE_TAGS.FabricKeyPair: {
        return this.visitFabricKeyPair(value as FabricKeyPair);
      }

      case VALUE_TAGS.FabricRegExp: {
        return this.visitFabricRegExp(value as FabricRegExp);
      }

      case VALUE_TAGS.FabricUnavailable: {
        return this.visitFabricUnavailable(value as FabricUnavailable);
      }

      case VALUE_TAGS.Object: {
        return this.visitFabricPlainObject(value as FabricPlainObjectPlus<PlusType>);
      }

      case null: {
        return this.visitUnrecognizedValue(value);
      }
    }
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `undefined`.
   */
  override visitedFabricArrayElement(
    _array: FabricArrayPlus<PlusType>,
    _index: number,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `undefined`.
   */
  override visitedFabricArrayGap(
    _array: FabricArrayPlus<PlusType>,
    _start: number,
    _count: number,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `undefined`.
   */
  override visitedFabricInstance(
    _instance: FabricInstancePlus<PlusType>,
    _state: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /**
   * @inheritDoc
   *
   * If not overridden, this returns `undefined`.
   */
  override visitedFabricPlainObjectEntry(
    _container: FabricPlainObjectPlus<PlusType>,
    _key: FabricValuePlus<PlusType>,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }
}
