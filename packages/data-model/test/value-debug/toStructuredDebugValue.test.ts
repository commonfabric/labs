/**
 * Converting an arbitrary value into a `FabricValue` that stands in for it,
 * including the values that resist being converted at all.
 *
 * The conversion is called on whatever is at hand, usually while something is
 * already wrong, so the two properties that matter most are pinned throughout:
 * the result is always a valid `FabricValue`, and a subvalue that cannot be
 * converted costs only itself rather than the whole result. The cases here are
 * arranged by what the input is, and then by the limit options, whose
 * defaults and caps are pinned here while the conversions under other limits
 * are recorded as case files under `value-debug-cases/`, each file's
 * `/options` binding naming the limits its cases convert under.
 *
 * The marker vocabulary (`/circle`, `/...`, `/function`, `/uniqueSymbol`,
 * `/unconvertible`, and the leading-slash key escape) is deliberately not
 * specified in the source doc comment, so this file is where it is written
 * down.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricError, FabricLink } from "@/fabric-instances/index.ts";
import { FabricEpochNsec } from "@/fabric-primitives/index.ts";
import {
  type DebugValueOptions,
  isValidFabricValue,
  toStructuredDebugValue,
} from "@/index.ts";

/**
 * Makes a plain object carrying a genuine own `__proto__` property. An object
 * literal cannot: `__proto__:` in source repoints the prototype instead of
 * creating a property.
 */
function withOwnProto(): Record<string, unknown> {
  return JSON.parse('{"__proto__": 1, "ok": 2}');
}

describe("toStructuredDebugValue()", () => {
  describe("scalars", () => {
    it("returns a boolean, number, or string unchanged", () => {
      expect(toStructuredDebugValue(true)).toBe(true);
      expect(toStructuredDebugValue(42)).toBe(42);
      expect(toStructuredDebugValue("hello")).toBe("hello");
    });

    it("returns `null` and `undefined` unchanged", () => {
      expect(toStructuredDebugValue(null)).toBe(null);
      expect(toStructuredDebugValue(undefined)).toBe(undefined);
    });

    it("returns a `bigint` unchanged", () => {
      expect(toStructuredDebugValue(42n)).toBe(42n);
      expect(toStructuredDebugValue(-7n)).toBe(-7n);
    });

    it("returns `-0` as `-0` and not as `0`", () => {
      // `toBe` is `Object.is`, which is the only matcher that can tell the two
      // apart; `toEqual` would pass either way.

      expect(toStructuredDebugValue(-0)).toBe(-0);
    });

    it("returns `NaN` and the infinities unchanged", () => {
      const nan = toStructuredDebugValue(NaN);
      expect(typeof nan).toBe("number");
      expect(Number.isNaN(nan)).toBe(true);
      expect(toStructuredDebugValue(Infinity)).toBe(Infinity);
      expect(toStructuredDebugValue(-Infinity)).toBe(-Infinity);
    });
  });

  describe("symbols", () => {
    it("returns a registry-interned symbol unchanged", () => {
      const sym = Symbol.for("a-key");
      expect(toStructuredDebugValue(sym)).toBe(sym);
    });

    it("returns a unique symbol's description under `/uniqueSymbol`", () => {
      expect(toStructuredDebugValue(Symbol("desc")))
        .toEqual({ "/uniqueSymbol": "desc" });
    });

    it("returns `undefined` under `/uniqueSymbol` for an undescribed one", () => {
      const result = toStructuredDebugValue(Symbol());
      expect(Object.keys(result as object)).toEqual(["/uniqueSymbol"]);
      expect((result as Record<string, unknown>)["/uniqueSymbol"])
        .toBe(undefined);
    });
  });

  describe("functions", () => {
    it("returns a named function's name under `/function`", () => {
      expect(toStructuredDebugValue(function foo() {}))
        .toEqual({ "/function": "foo(...)" });
    });

    it("returns `<anonymous>(...)` for a function with no name", () => {
      // A bare arrow assigned to nothing has an empty `name`.

      expect(toStructuredDebugValue((() => () => {})()))
        .toEqual({ "/function": "<anonymous>(...)" });
    });

    it("returns a class under `/function`, classes being functions", () => {
      expect(toStructuredDebugValue(class Foo {}))
        .toEqual({ "/function": "Foo(...)" });
    });

    it("returns the failure inside `/function` when `name` cannot be read", () => {
      // The failure is reported within the wrapper rather than in place of
      // it, so the result still says a function was here, and the sibling
      // properties are unaffected.

      const value = new Proxy(function real() {}, {
        get(target, key, receiver) {
          if (key === "name") throw new Error("name trap");
          return Reflect.get(target, key, receiver);
        },
      });

      expect(toStructuredDebugValue({ a: 1, fn: value, z: 2 })).toEqual({
        a: 1,
        fn: { "/function": { "/unconvertible": "name trap" } },
        z: 2,
      });
    });
  });

  describe("containers", () => {
    // Every case here holds at least one value that does not survive conversion
    // unchanged, so that a walk which returned its input untouched would be
    // caught. A container of scalars alone cannot tell the two apart.

    it("returns a plain object with its values converted", () => {
      expect(
        toStructuredDebugValue({ a: 1, fn: function foo() {}, m: new Map() }),
      )
        .toEqual({
          a: 1,
          fn: { "/function": "foo(...)" },
          m: { "/Map": "/..." },
        });
    });

    it("returns an array with its elements converted", () => {
      expect(toStructuredDebugValue([1, function foo() {}, new Map()]))
        .toEqual([1, { "/function": "foo(...)" }, { "/Map": "/..." }]);
    });

    it("returns nested containers converted all the way down", () => {
      // The converting value sits at the bottom of an object-array-object
      // chain, so reaching it at all is the assertion.

      expect(toStructuredDebugValue({ a: [{ b: Symbol("deep") }] }))
        .toEqual({ a: [{ b: { "/uniqueSymbol": "deep" } }] });
    });

    it("returns a present-`undefined` property as present", () => {
      const result = toStructuredDebugValue({
        a: undefined,
        m: new Map(),
      }) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["a", "m"]);
      expect(result.a).toBe(undefined);
      expect(result.m).toEqual({ "/Map": "/..." });
    });

    it("returns a sparse array with its holes still holes", () => {
      const result = toStructuredDebugValue([1, , new Map()]) as unknown[];
      expect(result.length).toBe(3);
      expect(1 in result).toBe(false);
      expect(result[2]).toEqual({ "/Map": "/..." });
    });

    it("returns a sparse array without visiting the indices it has no element at", () => {
      // A very sparse array has to cost its element count and not its
      // `length`, which is what visiting only the keys it has buys.

      const probed: string[] = [];
      const target: unknown[] = [];
      target.length = 1000;
      target[0] = 1;
      target[999] = new Map();
      const counted = new Proxy(target, {
        has(t, key) {
          probed.push(String(key));
          return Reflect.has(t, key);
        },
      });

      const result = toStructuredDebugValue(
        counted,
        { maxArrayLength: 1000 },
      ) as unknown[];
      expect(result.length).toBe(1000);
      expect(Object.keys(result)).toEqual(["0", "999"]);
      expect(result[999]).toEqual({ "/Map": "/..." });
      expect(probed).toEqual([]);
    });

    it("returns an array without the named properties hung on it", () => {
      const value: unknown[] = [1, new Map()];
      (value as unknown as Record<string, unknown>).extra = new Map();
      const result = toStructuredDebugValue(value) as unknown[];
      expect(Object.keys(result)).toEqual(["0", "1"]);
      expect(result[1]).toEqual({ "/Map": "/..." });
    });

    it("returns a null-prototype object as an ordinary plain object", () => {
      // Were it treated as a general instance instead, the result would carry
      // a class-name tag rather than the object's own keys.

      const value = Object.assign(Object.create(null), { m: new Map() });
      expect(toStructuredDebugValue(value)).toEqual({ m: { "/Map": "/..." } });
    });
  });

  describe("plain-object keys", () => {
    it("returns a `/`-prefixed key with one more `/` prepended", () => {
      // Without the escape, a key of `/circle` would be indistinguishable
      // from the cycle marker this module writes.

      expect(toStructuredDebugValue({ "/circle": 3 }))
        .toEqual({ "//circle": 3 });
    });

    it("returns an already-escaped-looking key escaped once more", () => {
      expect(toStructuredDebugValue({ "//circle": 3 }))
        .toEqual({ "///circle": 3 });
    });

    it("returns a reserved key escaped the same way", () => {
      expect(toStructuredDebugValue({ constructor: 1 }))
        .toEqual({ "/constructor": 1 });
      expect(toStructuredDebugValue(withOwnProto()))
        .toEqual({ "/__proto__": 1, ok: 2 });
    });

    it("returns an unreserved key untouched", () => {
      expect(toStructuredDebugValue({ proto: 1, circle: 2 }))
        .toEqual({ proto: 1, circle: 2 });
    });
  });

  describe("fabric values", () => {
    it("returns a `FabricPrimitive` as the very same object", () => {
      const value = new FabricEpochNsec(123n);
      expect(toStructuredDebugValue(value)).toBe(value);
      expect((toStructuredDebugValue({ t: value }) as { t: unknown }).t)
        .toBe(value);
    });

    it("returns a `FabricInstance`'s state under its own tag", () => {
      const value = FabricError.fromNativeError(new Error("boom"));
      const result = toStructuredDebugValue(value) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["/Error@1"]);
      expect(result["/Error@1"]).toMatchObject({
        type: "Error",
        message: "boom",
      });
    });

    it("returns each `FabricInstance` under the tag of its own class", () => {
      // The tag comes from the value's codec, so a second class must not
      // arrive under the first one's tag.

      const value = new FabricLink({
        id: "of:fid1:abc",
        path: ["x"],
        space: "did:key:z",
      });
      expect(toStructuredDebugValue(value)).toEqual({
        "/Link@1": { id: "of:fid1:abc", path: ["x"], space: "did:key:z" },
      });
    });
  });

  describe("general instances", () => {
    it("returns an informative `toString()` under the class name", () => {
      const date = new Date(0);
      expect(toStructuredDebugValue(date))
        .toEqual({ "/Date": date.toString() });
      expect(toStructuredDebugValue(/ab+c/gi)).toEqual({
        "/RegExp": "/ab+c/gi",
      });
      expect(toStructuredDebugValue(new Error("boom")))
        .toEqual({ "/Error": "Error: boom" });
    });

    it("returns own properties when `toString()` says nothing", () => {
      class Data {
        x = 1;
        y = "two";
      }
      expect(toStructuredDebugValue(new Data()))
        .toEqual({ "/Data": { x: 1, y: "two" } });
    });

    it("returns the result of `toJSON()` in preference to properties", () => {
      class HasJson {
        ignored = "no";
        toJSON() {
          return { j: 1 };
        }
      }
      expect(toStructuredDebugValue(new HasJson()))
        .toEqual({ "/HasJson": { j: 1 } });
    });

    it("returns `/...` rather than `{}` when there is nothing to show", () => {
      // Claiming an empty object about a `Map` would be a lie; `/...` says
      // "contents not represented", which is true.

      expect(toStructuredDebugValue(new Map([["a", 1]])))
        .toEqual({ "/Map": "/..." });
      expect(toStructuredDebugValue(new Set([1, 2])))
        .toEqual({ "/Set": "/..." });
      expect(toStructuredDebugValue(new (class Empty {})()))
        .toEqual({ "/Empty": "/..." });
    });
  });

  describe("with circular references", () => {
    it("returns `/circle` naming the depth of the repeated object", () => {
      const value: Record<string, unknown> = { name: "root" };
      value.self = value;
      expect(toStructuredDebugValue(value))
        .toEqual({ name: "root", self: { "/circle": 0 } });
    });

    it("returns the depth of the ancestor the cycle closes on", () => {
      const inner: Record<string, unknown> = {};
      const middle: Record<string, unknown> = { b: inner };
      inner.up = middle;
      expect(toStructuredDebugValue({ a: middle }))
        .toEqual({ a: { b: { up: { "/circle": 1 } } } });
    });

    it("returns two siblings holding one object as two conversions", () => {
      // Only ancestors count as a cycle. A value reached twice by different
      // paths is shown at both, since identical siblings are an ordinary
      // shape and calling the second one circular would misdescribe it.

      const shared = { s: 1 };
      expect(toStructuredDebugValue({ x: shared, y: shared }))
        .toEqual({ x: { s: 1 }, y: { s: 1 } });
    });
  });

  describe("with `maxDepth`", () => {
    it("returns a result as deep as the conversion allows given `Infinity`", () => {
      let value: unknown = 1;
      for (let i = 0; i < 300; i++) value = { o: value };

      let at = toStructuredDebugValue(value, { maxDepth: Infinity }) as Record<
        string,
        unknown
      >;
      let levels = 0;
      while (at && (typeof at === "object") && ("o" in at)) {
        at = at.o as Record<string, unknown>;
        levels++;
      }
      expect(levels).toBe(99);
    });

    it("throws given a `maxDepth` that is not a positive integer", () => {
      for (const bad of [0, -1, 1.5, -Infinity, NaN]) {
        expect(() => toStructuredDebugValue({}, { maxDepth: bad }))
          .toThrow("`maxDepth` must be a positive integer, `Infinity`, or");
      }
    });

    it("throws given a `maxDepth` that is not a number", () => {
      for (const bad of ["3", null, {}]) {
        const options = { maxDepth: bad as unknown as number };
        expect(() => toStructuredDebugValue({}, options))
          .toThrow("`maxDepth` must be a positive integer, `Infinity`, or");
      }
    });
  });

  describe("with `maxArrayLength`", () => {
    it("returns no more than 10000 elements given a larger limit", () => {
      const value = Array.from({ length: 20000 }, (_, i) => i);
      for (const limit of [50000, Infinity]) {
        const result = toStructuredDebugValue(
          value,
          { maxArrayLength: limit },
        ) as unknown[];
        expect(result.length).toBe(10001);
        expect(result[9999]).toBe(9999);
        expect(result[10000]).toEqual({ "/...": { length: 20000 } });
      }
    });

    it("throws given a `maxArrayLength` that is not a positive integer", () => {
      for (const bad of [0, -1, 1.5, -Infinity, NaN, "3", null, {}]) {
        const options = { maxArrayLength: bad as unknown as number };
        expect(() => toStructuredDebugValue([], options)).toThrow(
          "`maxArrayLength` must be a positive integer, `Infinity`, or",
        );
      }
    });
  });

  describe("with `maxProperties`", () => {
    it("returns no more than 10000 properties given a larger limit", () => {
      const value = Object.fromEntries(
        Array.from({ length: 10500 }, (_, i) => [`k${i}`, i]),
      );
      for (const limit of [20000, Infinity]) {
        const result = toStructuredDebugValue(
          value,
          { maxProperties: limit },
        ) as Record<string, unknown>;
        expect(Object.keys(result).length).toBe(10001);
        expect(result["/..."]).toEqual({ count: 10500 });
      }
    });

    it("throws given a `maxProperties` that is not a positive integer", () => {
      for (const bad of [0, -1, 1.5, -Infinity, NaN, "3", null, {}]) {
        const options = { maxProperties: bad as unknown as number };
        expect(() => toStructuredDebugValue({}, options)).toThrow(
          "`maxProperties` must be a positive integer, `Infinity`, or",
        );
      }
    });
  });

  describe("with `maxStringLength`", () => {
    it("returns no more than 100000 characters given a larger limit", () => {
      const value = "x".repeat(150000);
      for (const limit of [200000, Infinity]) {
        const result = toStructuredDebugValue(
          value,
          { maxStringLength: limit },
        ) as { "/partialString": { length: number; excerpt: string } };
        expect(result["/partialString"].length).toBe(150000);
        expect(result["/partialString"].excerpt.length).toBe(100000);
      }
    });

    it("throws given a `maxStringLength` that is not a positive integer", () => {
      for (const bad of [0, -1, 1.5, -Infinity, NaN, "3", null, {}]) {
        const options = { maxStringLength: bad as unknown as number };
        expect(() => toStructuredDebugValue("", options)).toThrow(
          "`maxStringLength` must be a positive integer, `Infinity`, or",
        );
      }
    });
  });

  describe("with `maxStringLines`", () => {
    it("returns no more than 1000 lines given a larger limit", () => {
      const value = "x\n".repeat(1500) + "x";
      for (const limit of [2000, Infinity]) {
        const result = toStructuredDebugValue(
          value,
          { maxStringLines: limit },
        ) as { "/partialString": { length: number; excerpt: string } };
        expect(result["/partialString"].length).toBe(3001);
        expect(result["/partialString"].excerpt).toBe("x\n".repeat(1000));
      }
    });

    it("throws given a `maxStringLines` that is not a positive integer", () => {
      for (const bad of [0, -1, 1.5, -Infinity, NaN, "3", null, {}]) {
        const options = { maxStringLines: bad as unknown as number };
        expect(() => toStructuredDebugValue("", options)).toThrow(
          "`maxStringLines` must be a positive integer, `Infinity`, or",
        );
      }
    });
  });

  describe("with `options` that are not a plain object", () => {
    it("throws, naming the offending value", () => {
      for (const bad of [100, "3", null, [], new Map()]) {
        expect(() =>
          toStructuredDebugValue({}, bad as unknown as DebugValueOptions)
        ).toThrow("`options` must be a plain object or `undefined`; got `");
      }
    });
  });

  describe("with values that resist conversion", () => {
    it("returns `/unconvertible` carrying the error message", () => {
      const value = {
        get boom(): number {
          throw new Error("getter blew up");
        },
      };
      expect(toStructuredDebugValue(value))
        .toEqual({ boom: { "/unconvertible": "getter blew up" } });
    });

    it("returns the failure in place, leaving siblings converted", () => {
      const value = {
        before: "kept",
        bad: {
          get boom(): number {
            throw new Error("getter blew up");
          },
        },
        after: [1, 2],
      };
      expect(toStructuredDebugValue(value)).toEqual({
        before: "kept",
        bad: { boom: { "/unconvertible": "getter blew up" } },
        after: [1, 2],
      });
    });

    it("returns the failure at the property whose read threw", () => {
      // The read of a property is part of converting it, so a getter that
      // throws costs its own property and no other.

      const value = {
        before: "kept",
        get boom(): number {
          throw new Error("getter blew up");
        },
        after: 2,
      };
      expect(toStructuredDebugValue(value)).toEqual({
        before: "kept",
        boom: { "/unconvertible": "getter blew up" },
        after: 2,
      });
    });

    it("returns the failure at the element whose read threw", () => {
      const value: unknown[] = [1, 3];
      Object.defineProperty(value, 1, {
        enumerable: true,
        configurable: true,
        get(): never {
          throw new Error("element read failed");
        },
      });
      expect(toStructuredDebugValue(value)).toEqual([
        1,
        { "/unconvertible": "element read failed" },
      ]);
    });

    it("returns the failure in place for a throwing proxy trap", () => {
      // These traps are reached before any single property is, so each costs
      // the whole proxy. The `get` trap, reached per-property, is below.

      const traps: ProxyHandler<object>[] = [
        {
          getPrototypeOf() {
            throw new Error("nope");
          },
        },
        {
          ownKeys() {
            throw new Error("nope");
          },
        },
      ];

      for (const trap of traps) {
        const value = { a: 1, bad: new Proxy({ k: 1 }, trap), z: 2 };
        expect(toStructuredDebugValue(value)).toEqual({
          a: 1,
          bad: { "/unconvertible": "nope" },
          z: 2,
        });
      }
    });

    it("returns the failure per key for a throwing `get` trap", () => {
      const bad = new Proxy({ k: 1, j: 2 }, {
        get() {
          throw new Error("nope");
        },
      });
      expect(toStructuredDebugValue({ a: 1, bad, z: 2 })).toEqual({
        a: 1,
        bad: {
          k: { "/unconvertible": "nope" },
          j: { "/unconvertible": "nope" },
        },
        z: 2,
      });
    });

    it("returns the failure in place for a non-callable `toString`", () => {
      const value = Object.assign(new (class Odd {})(), { toString: 5 });
      const result = toStructuredDebugValue({ bad: value, z: 2 }) as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(result.bad!)).toEqual(["/unconvertible"]);
      expect(result.z).toBe(2);
    });

    describe("the `/unconvertible` message", () => {
      // What lands in the `/unconvertible` payload depends on what was thrown,
      // and anything at all can be thrown.

      /** Converts a value whose sole property throws `thrown` when read. */
      function messageFor(thrown: unknown): unknown {
        const value = {
          get boom(): number {
            throw thrown;
          },
        };
        const result = toStructuredDebugValue(value) as Record<
          string,
          Record<string, unknown>
        >;
        return result.boom!["/unconvertible"];
      }

      it("returns an `Error`'s message, subclasses included", () => {
        class MyError extends Error {}
        expect(messageFor(new Error("plain"))).toBe("plain");
        expect(messageFor(new MyError("custom"))).toBe("custom");
      });

      it("returns the stringification of a thrown non-`Error`", () => {
        expect(messageFor("just a string")).toBe("just a string");
        expect(messageFor(42)).toBe("42");
      });

      it("returns the stringification when a message is not a string", () => {
        // An `Error` may carry a non-string `message`, in which case the
        // whole value is stringified rather than the message read out.

        const error = new Error("ignored");
        (error as unknown as Record<string, unknown>).message = 5;
        expect(messageFor(error)).toBe("Error: 5");
      });

      it("returns a fixed token when the thrown value resists stringifying", () => {
        // A null-prototype object has no `toString` to reach, so `String()`
        // throws on it; the message derivation must not throw in turn.

        expect(messageFor(Object.create(null))).toBe("/unconvertibleError");
      });

      it("returns a fixed token when an `Error`'s message cannot be read", () => {
        // Nothing is lost by not falling back to stringifying this one:
        // `Error.prototype.toString()` reads `message` too, so `String()`
        // throws on it just the same.

        const error = new Error("ignored");
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("message trap");
          },
          configurable: true,
        });
        expect(messageFor(error)).toBe("/unconvertibleError");
      });

      it("returns a fixed token when the `instanceof` check itself throws", () => {
        // A thrown value can refuse even to be asked what it is.

        const thrown = new Proxy({}, {
          getPrototypeOf() {
            throw new Error("proto trap");
          },
        });
        expect(messageFor(thrown)).toBe("/unconvertibleError");
      });
    });
  });

  describe("the `FabricValue` result contract", () => {
    it("returns a valid `FabricValue` for every shape it handles", () => {
      // The contract is what the two shipped bugs broke: a unique symbol's
      // payload and a reserved key each produced a result the membership
      // check refuses.

      const cyclic: Record<string, unknown> = { name: "root" };
      cyclic.self = cyclic;

      const values: unknown[] = [
        undefined,
        null,
        -0,
        NaN,
        42n,
        Symbol("desc"),
        Symbol(),
        Symbol.for("interned"),
        () => {},
        [1, , 3],
        Array.from({ length: 101 }, (_, i) => i),
        "x".repeat(201),
        withOwnProto(),
        { "/circle": 1 },
        cyclic,
        new Date(0),
        new Map([["a", 1]]),
        new Set([1]),
        new FabricEpochNsec(123n),
        FabricError.fromNativeError(new Error("boom")),
        {
          bad: new Proxy({}, {
            ownKeys: () => {
              throw new Error("x");
            },
          }),
        },
        new Proxy(function real() {}, {
          get: (target, key, receiver) => {
            if (key === "name") throw new Error("x");
            return Reflect.get(target, key, receiver);
          },
        }),
        {
          get bad(): number {
            throw Object.create(null);
          },
        },
        {
          get bad(): number {
            throw new Proxy({}, {
              getPrototypeOf() {
                throw new Error("x");
              },
            });
          },
        },
        { deep: { deeper: { deepest: [1, { s: Symbol("x") }] } } },
      ];

      for (const value of values) {
        expect(isValidFabricValue(toStructuredDebugValue(value))).toBe(true);
      }
    });
  });
});
