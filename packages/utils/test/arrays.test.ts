/**
 * Three predicates that form a ladder, tested together because what matters
 * about each is where it stops. `isArrayIndexPropertyName()` judges a single
 * key, `isArrayWithOnlyIndexProperties()` judges an array's key shape, and
 * `isInertArray()` adds a per-index descriptor walk on top of that.
 *
 * The last rung is the expensive one, and the cases here are what say whether
 * a caller needs it: a value can have nothing but index keys and still not be
 * inert, because a key's descriptor can make it something other than a plain
 * element.
 *
 * `spliceAll()` is tested alongside them because it lives in the same module.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
  isInertArray,
  spliceAll,
} from "@commonfabric/utils/arrays";

describe("arrays", () => {
  describe("isArrayIndexPropertyName()", () => {
    describe("returns `true` for valid array indices", () => {
      it("accepts `0`", () => {
        expect(isArrayIndexPropertyName("0")).toBe(true);
      });

      it("accepts single-digit indices `1` through `9`", () => {
        for (let i = 1; i <= 9; i++) {
          expect(isArrayIndexPropertyName(String(i))).toBe(true);
        }
      });

      it("accepts multi-digit indices", () => {
        expect(isArrayIndexPropertyName("10")).toBe(true);
        expect(isArrayIndexPropertyName("99")).toBe(true);
        expect(isArrayIndexPropertyName("123")).toBe(true);
        expect(isArrayIndexPropertyName("999999999")).toBe(true);
      });

      it("accepts values from `2**31` up to the `2**32 - 2` maximum", () => {
        expect(isArrayIndexPropertyName("2147483647")).toBe(true); // `2**31 - 1`
        expect(isArrayIndexPropertyName("2147483648")).toBe(true); // `2**31`
        expect(isArrayIndexPropertyName("4294967294")).toBe(true); // `2**32 - 2`
      });

      it("accepts 10-digit numbers below `2**32 - 1`", () => {
        expect(isArrayIndexPropertyName("1000000000")).toBe(true);
        expect(isArrayIndexPropertyName("2147483646")).toBe(true); // `2**31 - 2`
      });
    });

    describe("returns `false` for invalid indices", () => {
      it("rejects the empty string", () => {
        expect(isArrayIndexPropertyName("")).toBe(false);
      });

      it("rejects leading zeros", () => {
        expect(isArrayIndexPropertyName("00")).toBe(false);
        expect(isArrayIndexPropertyName("01")).toBe(false);
        expect(isArrayIndexPropertyName("007")).toBe(false);
      });

      it("rejects negative numbers", () => {
        expect(isArrayIndexPropertyName("-1")).toBe(false);
        expect(isArrayIndexPropertyName("-0")).toBe(false);
        expect(isArrayIndexPropertyName("-100")).toBe(false);
      });

      it("rejects decimals", () => {
        expect(isArrayIndexPropertyName("1.5")).toBe(false);
        expect(isArrayIndexPropertyName("0.0")).toBe(false);
        expect(isArrayIndexPropertyName("1.0")).toBe(false);
      });

      it("rejects scientific notation", () => {
        expect(isArrayIndexPropertyName("1e5")).toBe(false);
        expect(isArrayIndexPropertyName("1E5")).toBe(false);
        expect(isArrayIndexPropertyName("1e+5")).toBe(false);
      });

      it("rejects surrounding whitespace", () => {
        expect(isArrayIndexPropertyName(" 1")).toBe(false);
        expect(isArrayIndexPropertyName("1 ")).toBe(false);
        expect(isArrayIndexPropertyName(" 1 ")).toBe(false);
      });

      it("rejects non-numeric strings", () => {
        expect(isArrayIndexPropertyName("NaN")).toBe(false);
        expect(isArrayIndexPropertyName("Infinity")).toBe(false);
        expect(isArrayIndexPropertyName("abc")).toBe(false);
        expect(isArrayIndexPropertyName("1a")).toBe(false);
        expect(isArrayIndexPropertyName("a1")).toBe(false);
      });

      it("rejects a leading plus sign", () => {
        expect(isArrayIndexPropertyName("+1")).toBe(false);
        expect(isArrayIndexPropertyName("+0")).toBe(false);
      });

      it("rejects values at or above `2**32 - 1`", () => {
        expect(isArrayIndexPropertyName("4294967295")).toBe(false); // `2**32 - 1`, reserved for `.length`
        expect(isArrayIndexPropertyName("4294967296")).toBe(false); // `2**32`
        expect(isArrayIndexPropertyName("9999999999")).toBe(false); // way past `2**32`
        expect(isArrayIndexPropertyName("10000000000")).toBe(false); // 11 digits
      });
    });
  });

  describe("isArrayWithOnlyIndexProperties()", () => {
    it("returns `true` for an empty array", () => {
      expect(isArrayWithOnlyIndexProperties([])).toBe(true);
    });

    it("returns `true` for a dense array", () => {
      expect(isArrayWithOnlyIndexProperties([1, 2, 3])).toBe(true);
    });

    it("returns `true` for a sparse array (holes are not named properties)", () => {
      const sparse: unknown[] = [];
      sparse[0] = 1;
      sparse[2] = 3; // hole at index `1`
      expect(isArrayWithOnlyIndexProperties(sparse)).toBe(true);
    });

    it("returns `false` for an array with a named property", () => {
      const arr = [1, 2, 3] as unknown[] & { foo?: string };
      arr.foo = "bar";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for a sparse array whose extra key is a named property", () => {
      // `length` is `3`, hole at index `1`, plus a named `foo` -- so the own
      // keys are `["0", "2", "length", "foo"]`, a count that matches a dense
      // index-only array of the same `length` but still has a non-index key.
      const sparse = [] as unknown[] & { foo?: string };
      sparse[0] = 1;
      sparse[2] = 3;
      sparse.foo = "bar";
      expect(isArrayWithOnlyIndexProperties(sparse)).toBe(false);
    });

    it("returns `false` when a named property was added before any indices", () => {
      // Own-key order puts indices first and `length` ahead of any later-added
      // named key, so the keys are `["0", "1", "length", "foo"]`. Pins the
      // last-key check's reliance on that ordering rather than on the order in
      // which the properties were assigned.
      const arr = [] as unknown[] & { foo?: string };
      arr.foo = "bar";
      arr[0] = 1;
      arr[1] = 2;
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with an enumerable symbol-keyed property", () => {
      const arr = [1, 2, 3];
      (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a non-enumerable symbol-keyed property", () => {
      // A symbol key is not expressible as a property name at all, so unlike a
      // non-enumerable string key it is rejected.
      const arr = [1, 2, 3];
      Object.defineProperty(arr, Symbol("foo"), {
        value: "bar",
        enumerable: false,
      });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a registered symbol-keyed property", () => {
      // Registry-interned symbols are portable across realms -- and so are
      // valid fabric *values* -- but they are still not property *names*.
      const arr = [1, 2, 3];
      (arr as unknown as Record<symbol, unknown>)[Symbol.for("foo")] = "bar";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a well-known symbol-keyed property", () => {
      const arr = [1, 2, 3];
      (arr as unknown as Record<symbol, unknown>)[Symbol.toStringTag] = "Nope";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a non-enumerable string-keyed property", () => {
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a non-enumerable index-shaped named key", () => {
      // `"01"` is a named property, not an index, so it is rejected on the same
      // footing as any other non-enumerable named key.
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "01", { value: "bar", enumerable: false });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `true` for an array whose only non-index key is `length`", () => {
      // `length` is intrinsic to every array, so it can never be disqualifying.
      const arr = [1, 2, 3];
      expect(Object.getOwnPropertyNames(arr)).toContain("length");
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(true);
    });

    it("returns `true` after `length` is redefined", () => {
      // Redefining does not re-create the property, so it keeps its original
      // position in own-key order.
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "length", { value: 3, writable: true });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(true);
    });

    it("returns `false` when a named property outlives a deleted sibling", () => {
      // Deleting one named property must not restore index-only-ness while
      // another remains.
      const arr = [1, 2, 3] as unknown[] & { foo?: string; bar?: string };
      arr.foo = "a";
      arr.bar = "b";
      delete arr.foo;
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `true` for an `Array` subclass instance with only indices", () => {
      class Sub extends Array {}
      const sub = new Sub();
      sub.push(1, 2);
      expect(isArrayWithOnlyIndexProperties(sub)).toBe(true);
    });

    describe("returns `false` for anything that isn't an array", () => {
      // Each of these can name `length` as its final own key, which is what the
      // implementation keys on for real arrays -- so without an explicit
      // array check they would be misreported as index-only.

      it("rejects an array-like object", () => {
        const arrayLike = { 0: "a", 1: "b", length: 2 };
        expect(
          isArrayWithOnlyIndexProperties(arrayLike),
        )
          .toBe(false);
      });

      it("rejects a non-array whose prototype is `Array.prototype`", () => {
        // `constructor` is `Array` here, so type-tag dispatch that keys on the
        // constructor can route such a value to array handling.
        const fake = Object.create(Array.prototype) as Record<string, unknown>;
        fake[0] = "a";
        fake.length = 1;
        expect(isArrayWithOnlyIndexProperties(fake))
          .toBe(false);
      });

      it("rejects a plain object whose last own key is `length`", () => {
        const obj = { a: 1, length: 3 };
        expect(isArrayWithOnlyIndexProperties(obj))
          .toBe(false);
      });

      it("returns rather than throwing for `null` and `undefined`", () => {
        expect(isArrayWithOnlyIndexProperties(null))
          .toBe(false);
        expect(
          isArrayWithOnlyIndexProperties(undefined),
        )
          .toBe(false);
      });

      it("returns rather than throwing for a primitive", () => {
        expect(isArrayWithOnlyIndexProperties("abc"))
          .toBe(false);
        expect(isArrayWithOnlyIndexProperties(42))
          .toBe(false);
      });

      it("rejects a `Uint8Array`", () => {
        const bytes = new Uint8Array([1, 2, 3]);
        expect(isArrayWithOnlyIndexProperties(bytes))
          .toBe(false);
      });
    });

    it("returns `true` for a `Proxy` over an index-only array", () => {
      // `Array.isArray()` sees through to the target, so the array check
      // doesn't reject proxied arrays.
      const proxied = new Proxy([1, 2, 3], {});
      expect(isArrayWithOnlyIndexProperties(proxied)).toBe(true);
    });

    describe("returns `false` for non-canonical index-shaped named keys", () => {
      // These keys are named properties, not array indices, but each has a
      // `Number(key)` that is an in-range non-negative integer -- so a naive
      // numeric coercion would misclassify the array as index-only.
      for (const key of ["01", " 1", "1.0", "1e1", "-0", ""]) {
        it(`rejects the named key ${JSON.stringify(key)}`, () => {
          // A roomy all-holes array, so the key is numerically in range for
          // this `length` -- denying an implementation any excuse to reject it
          // on size alone rather than on the key not being an index.
          const arr: unknown[] = [];
          arr.length = 1000;
          (arr as unknown as Record<string, unknown>)[key] = "x";
          expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
        });
      }
    });
  });

  describe("isInertArray()", () => {
    describe("returns `true` for inert arrays", () => {
      it("accepts a compact array", () => {
        expect(isInertArray([1, 2, 3])).toBe(true);
        expect(isInertArray([])).toBe(true);
      });

      it("accepts a sparse array", () => {
        const arr: unknown[] = [];
        arr[0] = 1;
        arr[5] = 2;
        expect(isInertArray(arr)).toBe(true);
      });

      it("accepts a frozen array", () => {
        expect(isInertArray(Object.freeze([1, 2, 3]))).toBe(true);
      });

      it("accepts a non-enumerable data-backed index", () => {
        // Unlike the plain-object check, index enumerability is not required:
        // the check is about inertness (data-ness), and array contents are
        // reached by index, not by enumeration-driven copying.
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          value: 22,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        expect(isInertArray(arr)).toBe(true);
      });
    });

    describe("subsumes the index-only check", () => {
      // `isInertArray()` includes everything
      // `isArrayWithOnlyIndexProperties()` checks; callers never need both.

      it("rejects a named property", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isInertArray(arr)).toBe(false);
      });

      it("rejects a symbol-keyed property", () => {
        const arr = [1, 2, 3];
        (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
        expect(isInertArray(arr)).toBe(false);
      });

      it("rejects anything that isn't an array", () => {
        expect(isInertArray({ 0: "a", length: 1 })).toBe(false);
        expect(isInertArray(null)).toBe(false);
        expect(isInertArray(undefined)).toBe(false);
        expect(isInertArray("abc")).toBe(false);
      });
    });

    describe("`Proxy` handling", () => {
      it("accepts a pass-through proxy over an inert array", () => {
        // `Array.isArray()` sees through to the target, and the prototype
        // question forwards to it as well, so a proxied inert array is still
        // recognized as one.
        expect(isInertArray(new Proxy([1, 2, 3], {}))).toBe(true);
      });

      it("rejects a pass-through proxy over a getter-indexed array", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          get: () => 22,
          enumerable: true,
          configurable: true,
        });
        expect(isInertArray(new Proxy(arr, {}))).toBe(false);
      });
    });

    describe("returns `false` for accessor-backed indices", () => {
      it("rejects a getter-backed index", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          get: () => 22,
          enumerable: true,
          configurable: true,
        });
        expect(isInertArray(arr)).toBe(false);
      });

      it("rejects a setter-only index", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 2, {
          set: () => {},
          enumerable: true,
          configurable: true,
        });
        expect(isInertArray(arr)).toBe(false);
      });

      it("rejects a getter-backed index even on a frozen array", () => {
        // Freezing prevents reconfiguration but does not convert an accessor
        // into data: its reads still execute code.
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 0, {
          get: () => "still live",
          enumerable: true,
          configurable: false,
        });
        Object.freeze(arr);
        expect(isInertArray(arr)).toBe(false);
      });

      it("rejects a getter-backed final index", () => {
        // The final index is the last key before `length`; this pins that the
        // descriptor walk covers the whole index range, not just a prefix.
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 2, {
          get: () => 33,
          enumerable: true,
          configurable: true,
        });
        expect(isInertArray(arr)).toBe(false);
      });
    });

    describe("returns `false` for indirect `Array` instances", () => {
      it("rejects an `Array` subclass instance", () => {
        class Sub extends Array {}
        const sub = new Sub();
        sub.push(1, 2);

        // Index-only and data-backed, so only the prototype separates it from
        // an inert array.
        expect(isArrayWithOnlyIndexProperties(sub)).toBe(true);
        expect(isInertArray(sub)).toBe(false);
      });

      it("rejects a subclass instance whose prototype rewrites iteration", () => {
        // The concrete hazard the prototype requirement addresses: iteration
        // and index reads answer different content, and freezing the instance
        // does not touch the prototype that does it.
        class Smuggler extends Array {
          override *[Symbol.iterator](): Generator<unknown> {
            yield "smuggled";
          }
        }
        const smuggler = new Smuggler();
        smuggler.push("benign");
        Object.freeze(smuggler);

        expect([...smuggler]).toEqual(["smuggled"]);
        expect(smuggler[0]).toBe("benign");
        expect(isInertArray(smuggler)).toBe(false);
      });

      it("rejects an array whose prototype was severed", () => {
        const severed: unknown[] = [1, 2];
        Object.setPrototypeOf(severed, null);
        expect(isInertArray(severed)).toBe(false);
      });

      it("rejects an array reparented onto another prototype", () => {
        const reparented: unknown[] = [1, 2];
        Object.setPrototypeOf(reparented, Object.prototype);
        expect(isInertArray(reparented)).toBe(false);
      });

      it("rejects a proxy that answers a non-`Array` prototype", () => {
        // `Array.isArray()` sees the array target, so the prototype answer is
        // the only thing that can catch this one.
        const lying = new Proxy([1, 2], { getPrototypeOf: () => null });
        expect(Array.isArray(lying)).toBe(true);
        expect(isInertArray(lying)).toBe(false);
      });
    });
  });

  describe("spliceAll()", () => {
    it("replaces a range and returns what it removed, like splice()", () => {
      const array = [1, 2, 3, 4, 5];
      expect(spliceAll(array, 1, 2, [7, 8, 9])).toEqual([2, 3]);
      expect(array).toEqual([1, 7, 8, 9, 4, 5]);
    });

    it("counts a negative start from the end, like splice()", () => {
      const array = [1, 2, 3, 4];
      expect(spliceAll(array, -2, 1, [9])).toEqual([3]);
      expect(array).toEqual([1, 2, 9, 4]);
    });

    it("clamps a range that runs past the end, like splice()", () => {
      const array = [1, 2, 3];
      expect(spliceAll(array, 2, 10, [8, 9])).toEqual([3]);
      expect(array).toEqual([1, 2, 8, 9]);
    });

    it("inserts without removing when the count is zero", () => {
      const array = [1, 2];
      expect(spliceAll(array, 1, 0, new Set([5, 6]))).toEqual([]);
      expect(array).toEqual([1, 5, 6, 2]);
    });

    it("keeps the holes of a sparse array, like splice()", () => {
      // deno-lint-ignore no-sparse-arrays
      const array = [1, , 3, , 5];
      // deno-lint-ignore no-sparse-arrays
      const native = [1, , 3, , 5];
      expect(spliceAll(array, 1, 1, [7, 8])).toEqual(native.splice(1, 1, 7, 8));
      expect(array.length).toBe(native.length);
      expect(Object.keys(array)).toEqual(Object.keys(native));
      expect(Object.keys(array)).toEqual(["0", "1", "2", "3", "5"]);
    });

    it("reads all of the items before changing the array, like splice()", () => {
      const array = [1, 2, 3];
      spliceAll(array, 1, 0, array);
      expect(array).toEqual([1, 1, 2, 3, 2, 3]);

      function* failing() {
        yield 9;
        throw new Error("stop");
      }
      const untouched = [1, 2, 3];
      expect(() => spliceAll(untouched, 1, 1, failing())).toThrow("stop");
      expect(untouched).toEqual([1, 2, 3]);
    });

    it("handles more items than fit in a call's argument list", () => {
      const items = Array.from({ length: 1_000_000 }, (_, i) => i);
      // deno-lint-ignore cf-spread/no-spread-arguments -- shows that the spread overflows
      expect(() => [0, 0].splice(1, 0, ...items)).toThrow(RangeError);
      const array = [-1, -2];
      spliceAll(array, 1, 0, items);
      expect(array.length).toBe(1_000_002);
      expect(array[1]).toBe(0);
      expect(array.at(-1)).toBe(-2);
    });
  });
});
