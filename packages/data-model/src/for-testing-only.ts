/**
 * What this package offers to tests alone: examples of every concrete
 * `FabricPrimitive` and `FabricInstance` class, for a test that ranges over
 * the classes to take its values from, so that it holds no table of its own
 * to fall out of step. Each table's type is what holds it complete: a class
 * with no entry, or an entry of some other class, stops this module compiling.
 *
 * The examples of a class are written once, as makers. Every table of makers
 * here keeps one contract, which a test may rest on:
 *
 * - Each call of a maker returns a new object.
 * - Every object one maker returns is equal to every other it returns, so two
 *   calls give an equal-but-distinct pair.
 * - No object one maker returns is equal to one another maker of that class
 *   returns, and every class has at least two makers, so a class's first two
 *   makers give a pair that differs.
 *
 * This has its own entry in the package's export map and no place in any
 * barrel, so that loading the classes constructs none of it.
 */

// Loaded for its effect, and before anything else here: it installs the debug
// renderers, which the package's modules reach through
// `value-debug-internal.ts`.
import "@/value-debug/index.ts";

import { ProblematicValue, UnknownValue } from "@/codec-common";
import {
  FabricError,
  type FabricInstanceClassesByName,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  type FabricPrimitiveClassesByName,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";

/** At least two makers of one kind of value. */
type Makers<Value> = readonly [() => Value, () => Value, ...(() => Value)[]];

/** What each maker in `Tuple` returns, as a tuple of the same length. */
// Mapped over a type parameter, which is what keeps the result a tuple; the
// same mapping written over an indexed access yields an object type.
type MadeByEach<Tuple extends Makers<unknown>> = {
  readonly [Index in keyof Tuple]: Tuple[Index] extends () => infer Value
    ? Value
    : never;
};

/** What each maker in a record of `Makers` returns, in the record's shape. */
type MadeBy<Table extends Readonly<Record<string, Makers<unknown>>>> = {
  readonly [Name in keyof Table]: MadeByEach<Table[Name]>;
};

/**
 * Makers of instances of every concrete primitive class, keyed the way
 * `fabricPrimitiveClassesByName()` keys the classes, under the contract the
 * file header states.
 */
export const FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY: {
  readonly [Name in keyof FabricPrimitiveClassesByName]: Makers<
    FabricPrimitiveClassesByName[Name]["prototype"]
  >;
} = Object.freeze({
  FabricBytes: Object.freeze(
    [
      () => new FabricBytes(new Uint8Array([1, 2, 3])),
      () => new FabricBytes(new Uint8Array()),
    ] as const,
  ),

  FabricEpochDay: Object.freeze(
    [
      () => new FabricEpochDay(20_000n),
      () => new FabricEpochDay(0n),
      () => new FabricEpochDay(-1n),
    ] as const,
  ),

  FabricEpochNsec: Object.freeze(
    [
      () => new FabricEpochNsec(1_700n),
      () => new FabricEpochNsec(0n),
      () => new FabricEpochNsec(-1n),
    ] as const,
  ),

  FabricHash: Object.freeze(
    [
      () => new FabricHash(new Uint8Array(32), "fid1"),
      () => new FabricHash(new Uint8Array(32).fill(9), "fid1"),
    ] as const,
  ),

  // Pairs holding material, that being the arm constructible without a
  // `CryptoKey`. The algorithm name is arbitrary; a real one would mislead a
  // `grep`.
  FabricKeyPair: Object.freeze(
    [
      () =>
        new FabricKeyPair(
          "ExampleAlgorithm",
          new Uint8Array([1, 2]),
          new Uint8Array([3, 4]),
        ),
      () =>
        new FabricKeyPair(
          "ExampleAlgorithm",
          new Uint8Array([5, 6]),
          new Uint8Array([7, 8]),
        ),
    ] as const,
  ),

  FabricRegExp: Object.freeze(
    [
      () => new FabricRegExp(/a+/g),
      () => new FabricRegExp("es2025", "^x$", ""),
    ] as const,
  ),

  FabricUnavailable: Object.freeze(
    [
      () => new FabricUnavailable("error", "general", "boom"),
      () => new FabricUnavailable("pending"),
      () => new FabricUnavailable("syncing"),
    ] as const,
  ),
});

/**
 * One instance from each maker in
 * `FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY`, in that table's shape.
 * The first example of a class is the one to reach for where a test wants one
 * value per class. A primitive is immutable, so these are shared; a test that
 * needs a distinct object calls a maker.
 */
export const FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY: MadeBy<
  typeof FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY
> = madeBy(FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY);

/**
 * Makers of instances of every concrete instance class, keyed the way
 * `fabricInstanceClassesByName()` keys the classes, under the contract the
 * file header states.
 *
 * There is no table of shared instances beside this one: an instance can be
 * mutable, and an operation under test may freeze the one it is given in
 * place, so a test takes one of its own from a maker.
 */
export const FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY: {
  readonly [Name in keyof FabricInstanceClassesByName]: Makers<
    FabricInstanceClassesByName[Name]["prototype"]
  >;
} = Object.freeze({
  FabricError: Object.freeze(
    [
      () =>
        new FabricError({
          type: "Error",
          name: "Error",
          message: "boom",
          stack: undefined,
          cause: undefined,
        }),
      () =>
        new FabricError({
          type: "TypeError",
          name: "TypeError",
          message: "not a donut",
          stack: undefined,
          cause: undefined,
        }),
    ] as const,
  ),

  FabricLink: Object.freeze(
    [
      () => new FabricLink({ id: "of:fid1:aaa" }),
      () => new FabricLink({ id: "of:fid1:bbb" }),
    ] as const,
  ),

  FabricMap: Object.freeze(
    [
      () => new FabricMap(new Map([["a", 1]])),
      () => new FabricMap(new Map()),
    ] as const,
  ),

  FabricSet: Object.freeze(
    [
      () => new FabricSet(new Set([1, 2])),
      () => new FabricSet(new Set()),
    ] as const,
  ),

  ProblematicValue: Object.freeze(
    [
      () => new ProblematicValue("Example@1", "state-data", "boom"),
      () => new ProblematicValue("Example@1", "other-data", "bang"),
    ] as const,
  ),

  UnknownValue: Object.freeze(
    [
      () => new UnknownValue("Example@1", "state-data"),
      () => new UnknownValue("Example@1", "other-data"),
    ] as const,
  ),
});

/**
 * Helper for `FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY`, which calls every
 * maker in `table` once and returns the results in the table's shape, frozen
 * at both levels.
 */
function madeBy<Table extends Readonly<Record<string, Makers<unknown>>>>(
  table: Table,
): MadeBy<Table> {
  const result = Object.fromEntries(
    Object.entries(table).map((
      [name, makers],
    ) => [name, Object.freeze(makers.map((make) => make()))]),
  );

  // `Object.fromEntries()` returns a record of one value type, where the
  // result here has the shape of its argument, entry for entry.
  return Object.freeze(result) as MadeBy<Table>;
}
