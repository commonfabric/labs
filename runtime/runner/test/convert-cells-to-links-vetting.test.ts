/**
 * What the conversion refuses, and why it has to refuse rather than carry on.
 *
 * The walk rebuilds every container it descends out of that container's own
 * entries, so a container that is not inert has to be turned away before it
 * reaches the rebuild. Rebuilding one drops a named property, a symbol key or
 * a non-enumerable string key, and evaluates an accessor-backed slot into a
 * data property -- each yielding a container that satisfies
 * `isValidFabricValue()` while meaning less than the input did, which nothing
 * downstream can catch because what it produces is genuinely valid.
 *
 * The refusals are asserted at a nested position as well as at the top,
 * because the vetting is per-position: the walk reaches each member as a
 * conversion input in its own right.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { convertCellsToLinks } from "../src/cell.ts";

/** A class with no fabric representation. */
class PlainClass {}

/**
 * An `Array` subclass, whose instances are live code rather than inert data.
 */
class ArraySubclass extends Array {}

/** Returns an array carrying an accessor-backed index. */
function arrayWithAccessorIndex(): unknown[] {
  const result: unknown[] = [];
  Object.defineProperty(result, "0", { get: () => 1, enumerable: true });
  return result;
}

/** Returns an object carrying a non-enumerable string key. */
function objectWithHiddenKey(): object {
  return Object.defineProperty({ a: 1 }, "b", {
    value: 2,
    enumerable: false,
  });
}

describe("convert-cells-to-links-vetting", () => {
  describe("refuses a container that is not inert", () => {
    const cases: ReadonlyArray<[string, unknown, string]> = [
      [
        "an array carrying a named property",
        Object.assign([1], { z: 1 }),
        "array that is not an inert array",
      ],
      [
        "an array with an accessor-backed index",
        arrayWithAccessorIndex(),
        "array that is not an inert array",
      ],
      [
        "an `Array` subclass instance",
        ArraySubclass.from([1, 2]),
        "array that is not an inert array",
      ],
      [
        "an object carrying a symbol key",
        { a: 1, [Symbol.for("convert-cells-to-links-vetting")]: 2 },
        "object that is not an inert plain object",
      ],
      [
        "an object carrying a non-enumerable string key",
        objectWithHiddenKey(),
        "object that is not an inert plain object",
      ],
      [
        "a null-prototype object",
        Object.assign(Object.create(null), { a: 1 }),
        "object that is not an inert plain object",
      ],
      [
        "an object whose property name this runtime reserves",
        { ["__proto__"]: 1 },
        "property name this runtime reserves (`__proto__`)",
      ],
    ];

    for (const [label, value, message] of cases) {
      it(`throws for ${label}`, () => {
        expect(() => convertCellsToLinks(value as never)).toThrow(message);
      });

      it(`throws for ${label} nested in a record`, () => {
        expect(() => convertCellsToLinks({ x: value } as never))
          .toThrow(message);
      });
    }
  });

  describe("refuses a value with no fabric representation", () => {
    it("throws for a function", () => {
      expect(() => convertCellsToLinks({ x: () => {} } as never)).toThrow(
        "Not representable as a `FabricValue`: function",
      );
    });

    it("throws for a class instance", () => {
      expect(() => convertCellsToLinks({ x: new PlainClass() } as never))
        .toThrow("`PlainClass` (not a recognized fabric type)");
    });
  });

  it("throws for a `Map`", () => {
    // A `Map` mints nothing, so what refuses it is the vet, the same as for
    // anything else with no fabric form. Letting one through would land it in
    // the record branch, which would rebuild it -- a `Map` having no enumerable
    // own properties -- as a bare `{}`.

    expect(() => convertCellsToLinks({ x: new Map() } as never)).toThrow(
      "`Map` (a `FabricConvertibleJsObject`, so conversion is what decides it)",
    );
  });
});
