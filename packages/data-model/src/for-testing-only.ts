/**
 * What this package offers to tests alone. There are three kinds of thing
 * here: examples of every concrete class, the conformance cases for the
 * `fvj1:` JSON encoding and for the content hash, and internals of the package
 * that a test reaches directly: steps it calls, and counts it reads.
 *
 * The examples are of every concrete `FabricPrimitive` and `FabricInstance`
 * class, for a test that ranges over the classes to take its values from, so
 * that it holds no table of its own to fall out of step. Each table's type is
 * what holds it complete: a class with no entry, or an entry of some other
 * class, stops this module compiling.
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
 * The conformance cases are built from the examples, so that every class is
 * among them. They are what `test/fixtures/fvj1-conformance.json` and
 * `test/fixtures/hash-conformance.json` are generated from: language-neutral
 * records of what this package's JSON codec and hasher do, against which an
 * implementation of either elsewhere tests itself. Their values are written in
 * the notation `test/fixtures/value-descriptors.md` defines.
 *
 * An internal is here when a test of the package's public surface cannot reach
 * it dependably. Each one's doc comment says why that is.
 *
 * This has its own entry in the package's export map and no place in any
 * barrel, so that loading the classes constructs none of it.
 */

import type { FabricValue } from "@/interface.ts";
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
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  type FabricPrimitiveClassesByName,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";
import {
  descriptorOf,
  fabricValueOfDescriptor,
  type ValueDescriptor,
} from "./conformance-fixtures.ts";
import {
  type Fvj1ConformanceCase,
  fvj1ConformanceCases,
  fvj1ConformanceFixtureText,
  type Fvj1DecodeOutcome,
  fvj1DecodeOutcomeOf,
  type Fvj1EncodeOutcome,
  fvj1EncodeOutcomeOf,
} from "./fvj1-conformance.ts";
import {
  type HashConformanceCase,
  hashConformanceCases,
  hashConformanceFixtureText,
  type HashOutcome,
  hashOutcomeOf,
} from "./hash-conformance.ts";
import { getFrozenObjectHashCacheHits } from "./value-hash/caching.ts";
import { float64BytesOf } from "./value-hash/float64BytesOf.ts";
import { getContainersHashed } from "./value-hash/ValueHasher.ts";

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

  FabricDurationDay: Object.freeze(
    [
      () => new FabricDurationDay(7n),
      () => new FabricDurationDay(0n),
      () => new FabricDurationDay(-1n),
    ] as const,
  ),

  FabricDurationNsec: Object.freeze(
    [
      () => new FabricDurationNsec(1_000_000_000n),
      () => new FabricDurationNsec(0n),
      () => new FabricDurationNsec(-1n),
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

export type {
  Fvj1ConformanceCase,
  Fvj1DecodeOutcome,
  Fvj1EncodeOutcome,
  HashConformanceCase,
  HashOutcome,
  ValueDescriptor,
};

/**
 * `descriptorOf()` from `conformance-fixtures.ts`, which returns a value's
 * descriptor in the notation `test/fixtures/value-descriptors.md` defines.
 */
export const descriptorOfForTestingOnly: (
  value: FabricValue,
) => ValueDescriptor = descriptorOf;

/**
 * `fabricValueOfDescriptor()` from `conformance-fixtures.ts`, the inverse of
 * {@link descriptorOfForTestingOnly}.
 */
export const fabricValueOfDescriptorForTestingOnly: (
  descriptor: ValueDescriptor,
) => FabricValue = fabricValueOfDescriptor;

/**
 * The conformance cases for the `fvj1:` JSON encoding, those in
 * `fvj1-conformance.ts` and one for each example the tables above make.
 */
export const FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY:
  readonly Fvj1ConformanceCase[] = fvj1ConformanceCases(
    FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
    FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  );

/**
 * `fvj1ConformanceFixtureText()` from `fvj1-conformance.ts`, which returns the
 * text of the fixture for some conformance cases, running each through this
 * package's default JSON codec. Given
 * {@link FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY}, the result is what
 * `test/fixtures/fvj1-conformance.json` holds.
 */
export const fvj1ConformanceFixtureTextForTestingOnly: (
  cases: readonly Fvj1ConformanceCase[],
) => string = fvj1ConformanceFixtureText;

/**
 * `fvj1EncodeOutcomeOf()` from `fvj1-conformance.ts`, which returns what
 * encoding a value with this package's default JSON codec does, in the shape a
 * fixture entry's `encode` holds.
 */
export const fvj1EncodeOutcomeOfForTestingOnly: (
  value: FabricValue,
) => Fvj1EncodeOutcome = fvj1EncodeOutcomeOf;

/**
 * `fvj1DecodeOutcomeOf()` from `fvj1-conformance.ts`, which returns what
 * decoding a text with this package's default JSON codec does, in the shape a
 * fixture entry's `decode` holds.
 */
export const fvj1DecodeOutcomeOfForTestingOnly: (
  text: string,
) => Fvj1DecodeOutcome = fvj1DecodeOutcomeOf;

/**
 * The conformance cases for the content hash, those in `hash-conformance.ts`
 * and one for each example the tables above make.
 */
export const HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY:
  readonly HashConformanceCase[] = hashConformanceCases(
    FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
    FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  );

/**
 * `hashConformanceFixtureText()` from `hash-conformance.ts`, which returns the
 * text of the fixture for some conformance cases, hashing each value with this
 * package's hasher. Given {@link HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY}, the
 * result is what `test/fixtures/hash-conformance.json` holds.
 */
export const hashConformanceFixtureTextForTestingOnly: (
  cases: readonly HashConformanceCase[],
) => string = hashConformanceFixtureText;

/**
 * `hashOutcomeOf()` from `hash-conformance.ts`, which returns what hashing a
 * value with this package's hasher does, in the shape a fixture entry's `hash`
 * holds.
 */
export const hashOutcomeOfForTestingOnly: (value: FabricValue) => HashOutcome =
  hashOutcomeOf;

/**
 * `float64BytesOf()` from `value-hash/float64BytesOf.ts`, which returns the
 * eight bytes that represent a number in a hash. The result is good until the
 * next call.
 *
 * It is here because a test of `hashOf()` cannot reach the function's `NaN`
 * arm dependably. That arm makes a difference for a `NaN` whose bits are not
 * the canonical ones, and whether such a `NaN` keeps its bits on the way into
 * `hashOf()` varies by engine and platform. A test of this function can check
 * instead that the result for a `NaN` is not the buffer which holds the result
 * for every other number, and that check comes out the same everywhere.
 */
export const float64BytesOfForTestingOnly: (value: number) => Uint8Array =
  float64BytesOf;

/**
 * `getFrozenObjectHashCacheHits()` from `value-hash/caching.ts`, which counts
 * the hashes served by the deep-frozen-object cache.
 *
 * It is here because nothing on the package's public surface can tell a hash
 * the cache served from one computed afresh: the two are equal. A test or a
 * benchmark that is about the cache reads the count before and after.
 */
export const getFrozenObjectHashCacheHitsForTestingOnly: () => number =
  getFrozenObjectHashCacheHits;

/**
 * `getContainersHashed()` from `value-hash/ValueHasher.ts`, which counts the
 * arrays and plain objects fed to a hasher.
 *
 * It is here because a hash is the same however much work went into it, so
 * nothing on the package's public surface says how wide a value was hashed. A
 * test that holds some code to hashing only part of a value — or none of it —
 * reads the count before and after.
 */
export const getContainersHashedForTestingOnly: () => number =
  getContainersHashed;

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
