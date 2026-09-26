/**
 * Shared doubles for the `value-visit` tests: a visitor that records every
 * call it receives, and builders for the result forms a test hands back.
 *
 * The recorder dispatches every value by tag and recurses into containers the
 * way `DefaultValueVisitor` does, so a test that wants the default walk sets
 * nothing, and one that wants a different decision at one hook assigns the
 * matching `on*` property.
 */

import type {
  FabricArrayPlus,
  FabricContainerValuePlus,
  FabricContainerValueTag,
  FabricInstancePlus,
  FabricPlainObjectPlus,
  FabricValuePlusTag,
  PrimitiveValueTag,
} from "@";
import {
  DefaultValueVisitor,
  type VisitedResult,
  type VisitingResult,
  type VisitResult,
} from "@/value-visit";

/**
 * What an `onValue` hook returns to have the recorder dispatch the value by
 * tag, which is what the recorder does when no hook is set. It is a value of
 * its own because `undefined` is already a result, the one that ends the visit
 * of a value.
 */
export const DO_DISPATCH = Symbol("DO_DISPATCH");

/** One recorded call into a `Recorder`. */
export type Event = [name: string, ...args: unknown[]];

/**
 * Visitor that dispatches every value by tag, recurses into containers the way
 * `DefaultValueVisitor` does, and records each call it receives. Each hook can
 * be overridden per test by assigning the matching `on*` property.
 */
export class Recorder extends DefaultValueVisitor<unknown, unknown> {
  readonly events: Event[] = [];

  /**
   * The values handed to `isPlusType()`, in order. Kept apart from `events` so
   * that the recorded dispatch sequence is the visit alone.
   */
  readonly plusTypeChecks: unknown[] = [];

  /**
   * The values handed to `isResultType()`, in order. Kept apart from `events`
   * for the same reason as `plusTypeChecks`.
   */
  readonly resultTypeChecks: unknown[] = [];

  /** How many times `isDomainAssignableToResultType()` has been called. */
  domainAssignableChecks = 0;

  onIsDomainAssignableToResultType?: () => boolean;
  onIsPlusType?: (value: unknown) => boolean;
  onIsResultType?: (value: unknown) => boolean;
  onValue?: (
    value: unknown,
    tag: FabricValuePlusTag | null,
  ) => VisitResult<unknown, unknown> | typeof DO_DISPATCH;
  onCycle?: (
    value: FabricContainerValuePlus<unknown>,
    tag: FabricContainerValueTag,
    originalDepth: number,
    thisDepth: number,
  ) => VisitResult<unknown, unknown>;
  onArray?: (
    value: FabricArrayPlus<unknown>,
  ) => VisitResult<unknown, unknown>;
  onPlainObject?: (
    value: FabricPlainObjectPlus<unknown>,
  ) => VisitResult<unknown, unknown>;
  onInstance?: (
    value: FabricInstancePlus<unknown>,
  ) => VisitResult<unknown, unknown>;
  onPrimitive?: (
    value: unknown,
    tag: PrimitiveValueTag,
  ) => VisitResult<unknown, unknown>;
  onPlusType?: (value: unknown) => VisitResult<unknown, unknown>;
  onVisitedFabricArrayElement?: (
    index: number,
    value: unknown,
  ) => VisitedResult<unknown>;
  onVisitedFabricInstanceState?: (
    instance: FabricInstancePlus<unknown>,
    state: unknown,
  ) => VisitedResult<unknown>;
  onVisitedFabricPlainObjectEntry?: (
    key: unknown,
    value: unknown,
  ) => VisitedResult<unknown>;
  onVisitingFabricArrayElement?: (
    index: number,
    value: unknown,
  ) => VisitingResult<unknown>;
  onVisitingFabricArrayGap?: (
    start: number,
    count: number,
  ) => VisitingResult<unknown>;
  onVisitingFabricInstanceState?: (
    instance: FabricInstancePlus<unknown>,
    state: unknown,
  ) => VisitingResult<unknown>;
  onVisitingFabricPlainObjectEntry?: (
    key: unknown,
    value: unknown,
  ) => VisitingResult<unknown>;

  /** The names of the recorded calls, in order. */
  get names(): string[] {
    return this.events.map((e) => e[0]);
  }

  override isDomainAssignableToResultType(): boolean {
    this.domainAssignableChecks++;
    return this.onIsDomainAssignableToResultType
      ? this.onIsDomainAssignableToResultType()
      : super.isDomainAssignableToResultType();
  }

  override isPlusType(value: unknown): value is unknown {
    // The domain is `unknown`, so everything outside `FabricValue` is in it.
    this.plusTypeChecks.push(value);
    return this.onIsPlusType ? this.onIsPlusType(value) : true;
  }

  override isResultType(value: unknown): value is unknown {
    // The result type is `unknown`, so every value is in it.
    this.resultTypeChecks.push(value);
    return this.onIsResultType ? this.onIsResultType(value) : true;
  }

  override visitValue(
    value: unknown,
    tag: FabricValuePlusTag | null,
  ): VisitResult<unknown, unknown> {
    this.events.push(["value", value, tag]);

    const result = this.onValue ? this.onValue(value, tag) : DO_DISPATCH;

    return (result === DO_DISPATCH) ? super.visitValue(value, tag) : result;
  }

  override visitCycle(
    value: FabricContainerValuePlus<unknown>,
    tag: FabricContainerValueTag,
    originalDepth: number,
    thisDepth: number,
  ): VisitResult<unknown, unknown> {
    this.events.push(["cycle", value, tag, originalDepth, thisDepth]);
    return this.onCycle
      ? this.onCycle(value, tag, originalDepth, thisDepth)
      : undefined;
  }

  override visitFabricArray(
    value: FabricArrayPlus<unknown>,
  ): VisitResult<unknown, unknown> {
    this.events.push(["array", value]);
    return this.onArray ? this.onArray(value) : super.visitFabricArray(value);
  }

  override visitFabricPlainObject(
    value: FabricPlainObjectPlus<unknown>,
  ): VisitResult<unknown, unknown> {
    this.events.push(["object", value]);
    return this.onPlainObject
      ? this.onPlainObject(value)
      : super.visitFabricPlainObject(value);
  }

  override visitFabricInstance(
    value: FabricInstancePlus<unknown>,
  ): VisitResult<unknown, unknown> {
    this.events.push(["instance", value]);
    return this.onInstance
      ? this.onInstance(value)
      : super.visitFabricInstance(value);
  }

  override visitPrimitiveValue(
    value: unknown,
    tag: PrimitiveValueTag,
  ): VisitResult<unknown, unknown> {
    this.events.push(["primitive", value, tag]);
    return this.onPrimitive ? this.onPrimitive(value, tag) : undefined;
  }

  override visitPlusType(
    value: unknown,
  ): VisitResult<unknown, unknown> {
    this.events.push(["plusType", value]);
    return this.onPlusType ? this.onPlusType(value) : undefined;
  }

  override visitedFabricArrayElement(
    array: FabricArrayPlus<unknown>,
    index: number,
    value: unknown,
  ): VisitedResult<unknown> {
    this.events.push(["visitedFabricArrayElement", array, index, value]);
    return this.onVisitedFabricArrayElement
      ? this.onVisitedFabricArrayElement(index, value)
      : undefined;
  }

  override visitedFabricInstanceState(
    instance: FabricInstancePlus<unknown>,
    state: unknown,
  ): VisitedResult<unknown> {
    this.events.push(["visitedFabricInstanceState", instance, state]);
    return this.onVisitedFabricInstanceState
      ? this.onVisitedFabricInstanceState(instance, state)
      : undefined;
  }

  override visitedFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<unknown>,
    key: unknown,
    value: unknown,
  ): VisitedResult<unknown> {
    this.events.push(["visitedFabricPlainObjectEntry", container, key, value]);
    return this.onVisitedFabricPlainObjectEntry
      ? this.onVisitedFabricPlainObjectEntry(key, value)
      : undefined;
  }

  override visitingFabricArrayElement(
    array: FabricArrayPlus<unknown>,
    index: number,
    value: unknown,
  ): VisitingResult<unknown> {
    this.events.push(["visitingFabricArrayElement", array, index, value]);
    return this.onVisitingFabricArrayElement
      ? this.onVisitingFabricArrayElement(index, value)
      : undefined;
  }

  override visitingFabricArrayGap(
    array: FabricArrayPlus<unknown>,
    start: number,
    count: number,
  ): VisitingResult<unknown> {
    this.events.push(["visitingFabricArrayGap", array, start, count]);
    return this.onVisitingFabricArrayGap
      ? this.onVisitingFabricArrayGap(start, count)
      : undefined;
  }

  override visitingFabricInstanceState(
    instance: FabricInstancePlus<unknown>,
    state: unknown,
  ): VisitingResult<unknown> {
    this.events.push(["visitingFabricInstanceState", instance, state]);
    return this.onVisitingFabricInstanceState
      ? this.onVisitingFabricInstanceState(instance, state)
      : undefined;
  }

  override visitingFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<unknown>,
    key: unknown,
    value: unknown,
  ): VisitingResult<unknown> {
    this.events.push(["visitingFabricPlainObjectEntry", container, key, value]);
    return this.onVisitingFabricPlainObjectEntry
      ? this.onVisitingFabricPlainObjectEntry(key, value)
      : undefined;
  }
}

/** Returns a `mainResult` form carrying the given value. */
export function mainResult<T>(value: T): { type: "mainResult"; value: T } {
  return { type: "mainResult", value };
}

/** Returns a `mapTo` form carrying the given value. */
export function mapTo<T>(value: T): { type: "mapTo"; value: T } {
  return { type: "mapTo", value };
}

/** Returns a `replace` form carrying the given value. */
export function replace<T>(value: T): { type: "replace"; value: T } {
  return { type: "replace", value };
}
