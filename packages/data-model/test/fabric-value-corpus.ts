/**
 * The shared population the value-dispatch cross-checks run over.
 *
 * `tagOfConvertibleJsValueElseNull()` names what a value already is,
 * `isValidFabricConvertibleJsObject()` decides a subset of that answer by a
 * narrower route, `isValidFabricValueLayer()` decides membership,
 * `assertValidFabricValueLayer()` answers that last question in the form that
 * carries a reason, and `shallowFabricFromConvertibleJsValue()` asks
 * `shallowFabricFromConvertibleJsObjectElseUndefined()` and then that vet in
 * turn -- so each is worth checking against the others rather than only against
 * a hand-picked case. This carries one entry per arm of the dispatch those
 * functions make, plus the shapes each arm accepts and refuses; an entry
 * dropped from here is an arm the cross-checks stop reaching.
 */

import { FabricError } from "@/fabric-instances";
import { FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY } from "@/for-testing-only.ts";

/** A class with no fabric representation, wanted here by name. */
export class PlainClass {}

/**
 * Returns a `PlainClass` instance carrying an own `constructor` property that
 * names a different class, so that reading the class off the value and reading
 * it off the prototype give different answers.
 */
function forgedConstructorInstance(): unknown {
  const instance = new PlainClass();
  Object.defineProperty(instance, "constructor", { value: Date });
  return instance;
}

/**
 * An `Array` subclass, whose instances are live code rather than inert data.
 */
export class ArraySubclass extends Array {}

/**
 * An `Error` subclass reached by the class lookup's `prototype instanceof
 * Error` fallback rather than by an identity case.
 */
export class WeirdError extends RangeError {}

/**
 * Returns a non-array whose prototype is `Array.prototype`, so that its class
 * reads as `Array` while `Array.isArray()` says otherwise.
 */
function nonArrayWithArrayPrototype(): unknown {
  const value = Object.create(Array.prototype) as Record<string, unknown>;
  value[0] = "a";
  value.length = 1;
  return value;
}

/**
 * Returns an array whose prototype has been re-pointed at `Date.prototype`, so
 * that its class reads as `Date` and only the array rule still sees an array.
 */
function arrayWithDatePrototype(): unknown {
  return Object.setPrototypeOf([1], Date.prototype);
}

/**
 * Returns an `Error` whose prototype has been severed, so that it names no
 * class and only the internal-slot test still sees it as an error.
 */
function severedError(): Error {
  const error = new Error("severed");
  Object.setPrototypeOf(error, null);
  return error;
}

/**
 * One entry per dispatch arm, labeled. The labels reach test names, so they
 * read as noun phrases.
 */
export const LAYER_CORPUS: ReadonlyArray<[string, unknown]> = [
  ["a boolean", true],
  ["a string", "hello"],
  ["a number", 42],
  ["a `bigint`", 42n],
  ["`null`", null],
  ["`undefined`", undefined],
  ["a registry-interned symbol", Symbol.for("fabric-value-corpus")],
  ["a unique symbol", Symbol("nope")],
  ["a function", () => {}],
  ["an inert array", [1, 2, 3]],
  ["an inert plain object", { a: 1 }],
  ["an array carrying a named property", Object.assign([1], { z: 1 })],
  ["an `Array` subclass instance", ArraySubclass.from([1, 2])],
  [
    "a non-array whose `prototype` is `Array.prototype`",
    nonArrayWithArrayPrototype(),
  ],
  [
    "an array whose `prototype` is `Date.prototype`",
    arrayWithDatePrototype(),
  ],
  ["an object carrying a symbol key", { a: 1, [Symbol.for("k")]: 2 }],
  ["an object carrying a reserved property name", { ["__proto__"]: 1 }],
  ["a null-prototype object", Object.assign(Object.create(null), { a: 1 })],
  ["a class instance", new PlainClass()],
  ["a class instance with a forged `constructor`", forgedConstructorInstance()],
  // One entry per concrete primitive class, from the examples the classes'
  // own package keeps complete, so that no class goes uncarried here.
  ...Object.entries(FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY).map((
    [name, [example]],
  ): [string, unknown] => [`a \`${name}\``, example]),
  ["a `FabricError`", FabricError.fromNativeError(new Error("x"))],
  ["a `Date`", new Date(1234)],
  ["a `Uint8Array`", new Uint8Array([1, 2, 3])],
  ["a `RegExp`", /abc/gi],
  ["an `Error`", new Error("boom")],
  ["a custom `Error` subclass instance", new WeirdError("weird")],
  ["an `Error` whose prototype was severed", severedError()],
  ["a `Map`", new Map()],
  ["a `Set`", new Set()],
];
