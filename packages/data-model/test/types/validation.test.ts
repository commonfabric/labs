/**
 * Membership in the `FabricValue` type, asked one level deep and asked all the
 * way down, plus the plain-record question asked as membership. The one-level
 * question also has a throwing form, whose group is mostly about the reasons it
 * gives, what it accepts being what the predicate accepts -- and which is
 * cross-checked, value for value, against the refusal
 * `shallowFabricFromConvertibleJsValue()` performs today, that being the
 * refusal it is there to stand in for.
 *
 * The two depths ask the same question at different scopes, and the cases are
 * arranged around where that difference tells.
 *
 * Frozen-ness is deliberately not part of membership, and a group here says so
 * outright -- the two are easy to conflate when nearly every `FabricValue`
 * in circulation happens to be frozen. Cycles are handled rather than refused.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import type { FabricValue } from "@/interface.ts";
import { shallowFabricFromConvertibleJsValue } from "@/convertible-js.ts";
import {
  assertValidFabricValueLayer,
  isFabricPlainObject,
  isValidFabricConvertibleJsObject,
  isValidFabricPlainObject,
  isValidFabricValue,
  isValidFabricValueLayer,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@/types";
import { LAYER_CORPUS, PlainClass } from "../fabric-value-corpus.ts";

describe("validation", () => {
  describe("isValidFabricValueLayer()", () => {
    describe("given a scalar `FabricValue`", () => {
      it("returns `true` for a boolean", () => {
        expect(isValidFabricValueLayer(true)).toBe(true);
        expect(isValidFabricValueLayer(false)).toBe(true);
      });

      it("returns `true` for a string", () => {
        expect(isValidFabricValueLayer("")).toBe(true);
        expect(isValidFabricValueLayer("hello")).toBe(true);
        expect(isValidFabricValueLayer("with\nnewlines")).toBe(true);
      });

      it("returns `true` for a finite number (including `-0`)", () => {
        expect(isValidFabricValueLayer(0)).toBe(true);
        expect(isValidFabricValueLayer(-0)).toBe(true);
        expect(isValidFabricValueLayer(1)).toBe(true);
        expect(isValidFabricValueLayer(-1)).toBe(true);
        expect(isValidFabricValueLayer(3.14159)).toBe(true);
        expect(isValidFabricValueLayer(Number.MAX_VALUE)).toBe(true);
        expect(isValidFabricValueLayer(Number.MIN_VALUE)).toBe(true);
      });

      it("returns `true` for a non-finite number", () => {
        expect(isValidFabricValueLayer(NaN)).toBe(true);
        expect(isValidFabricValueLayer(Infinity)).toBe(true);
        expect(isValidFabricValueLayer(-Infinity)).toBe(true);
      });

      it("returns `true` for a `bigint`", () => {
        expect(isValidFabricValueLayer(0n)).toBe(true);
        expect(isValidFabricValueLayer(123n)).toBe(true);
      });

      it("returns `true` for an interned symbol", () => {
        expect(isValidFabricValueLayer(Symbol.for("k"))).toBe(true);
      });

      it("returns `true` for `null`", () => {
        expect(isValidFabricValueLayer(null)).toBe(true);
      });

      it("returns `true` for `undefined`", () => {
        expect(isValidFabricValueLayer(undefined)).toBe(true);
      });
    });

    describe("given a container or `FabricSpecialObject`", () => {
      it("returns `true` for a plain object", () => {
        expect(isValidFabricValueLayer({})).toBe(true);
        expect(isValidFabricValueLayer({ a: 1 })).toBe(true);
        expect(isValidFabricValueLayer({ nested: { object: true } })).toBe(
          true,
        );
      });

      it("returns `true` for a dense array", () => {
        expect(isValidFabricValueLayer([])).toBe(true);
        expect(isValidFabricValueLayer([1, 2, 3])).toBe(true);
        expect(isValidFabricValueLayer([{ a: 1 }, { b: 2 }])).toBe(true);
        expect(isValidFabricValueLayer([null, "test", null])).toBe(true);
      });

      it("returns `true` for an array with `undefined` elements", () => {
        expect(isValidFabricValueLayer([1, undefined, 3])).toBe(true);
        expect(isValidFabricValueLayer([undefined])).toBe(true);
      });

      it("returns `true` for a sparse array (with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isValidFabricValueLayer(sparse)).toBe(true);
      });

      it("returns `true` for a `FabricInstance`", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(isValidFabricValueLayer(fe)).toBe(true);
      });

      it("returns `true` for a `FabricPrimitive`", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(isValidFabricValueLayer(bytes)).toBe(true);
      });

      it("returns `true` without recursively validating contents", () => {
        // `isValidFabricValueLayer()` is a shallow, per-se check; deep
        // validation is `isValidFabricConvertibleJsValue()`'s job. A nested
        // value that is not a `FabricValue` does not make the container itself
        // fail the per-se check.

        expect(isValidFabricValueLayer({ a: Symbol("x") })).toBe(true);
        expect(isValidFabricValueLayer([Symbol("x")])).toBe(true);
      });
    });

    describe("given a plain object with unrepresentable keys", () => {
      // A symbol is a valid `FabricValue` but not a valid property *name*:
      // `FabricPlainObject` is keyed by `string`. A non-enumerable string key
      // has no representation either, being dropped by every encoding.

      it("returns `false` for a symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isValidFabricValueLayer(obj)).toBe(false);
      });

      it("returns `false` for a registered symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol.for("s")] = 2;
        expect(isValidFabricValueLayer(obj)).toBe(false);
      });

      it("returns `false` for a non-enumerable string-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isValidFabricValueLayer(obj)).toBe(false);
      });

      it("returns `false` for an accessor-backed property", () => {
        // An accessor is live code, not inert data: a read executes it and can
        // return a different value every time. Freezing does not change that.

        const obj = { a: 1 };
        Object.defineProperty(obj, "g", { get: () => 2, enumerable: true });
        expect(isValidFabricValueLayer(obj)).toBe(false);
        expect(isValidFabricValueLayer(Object.freeze(obj))).toBe(false);
      });

      it("returns `false` for a setter-only property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "s", { set: () => {}, enumerable: true });
        expect(isValidFabricValueLayer(obj)).toBe(false);
      });

      it("returns `true` for an object whose keys are all enumerable strings", () => {
        expect(isValidFabricValueLayer({ a: 1, b: 2 })).toBe(true);
        expect(isValidFabricValueLayer({})).toBe(true);
      });

      it("returns `false` for a property name this runtime reserves", () => {
        // Not a statement about the data model: such an object is perfectly
        // inert, and a runtime that does not route assignment through a
        // prototype chain would carry it fine. It is refused because in this
        // host the name cannot survive the copy that every boundary performs.

        expect(isValidFabricValueLayer({ ["__proto__"]: 1, other: 2 })).toBe(
          false,
        );
        expect(isValidFabricValueLayer({ ["constructor"]: 1 })).toBe(false);
      });

      it("returns `false` for a null-prototype object", () => {
        // A record has one shape here: `Object.prototype`-rooted. A prototype
        // is not part of what a value says as data and would not survive
        // encoding, so a value carrying a different one is refused rather than
        // accepted and quietly changed.

        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isValidFabricValueLayer(obj)).toBe(false);
        expect(isValidFabricValueLayer(Object.create(null))).toBe(false);
      });
    });

    describe("given a non-`FabricValue`", () => {
      it("returns `false` for an array with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isValidFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for an array with a symbol-keyed property", () => {
        const arr = [1, 2, 3];
        (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
        expect(isValidFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for an array with an accessor-backed index", () => {
        // An accessor is live code, not inert data: a read executes it and can
        // return a different value every time. Freezing does not change that.

        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          get: () => 22,
          enumerable: true,
          configurable: false,
        });
        expect(isValidFabricValueLayer(arr)).toBe(false);
        expect(isValidFabricValueLayer(Object.freeze(arr))).toBe(false);
      });

      it("returns `false` for an array with a setter-only index", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 2, { set: () => {}, enumerable: true });
        expect(isValidFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for an `Array` subclass instance", () => {
        // A subclass prototype is live code just as an accessor is, and
        // freezing the instance does not change that.

        class Sub extends Array {}
        const sub = new Sub();
        sub.push(1, 2);
        expect(isValidFabricValueLayer(sub)).toBe(false);
        expect(isValidFabricValueLayer(Object.freeze(sub))).toBe(false);
      });

      it("returns `false` for an array whose prototype was severed", () => {
        const severed: unknown[] = [1, 2];
        Object.setPrototypeOf(severed, null);
        expect(isValidFabricValueLayer(severed)).toBe(false);
      });

      it("returns `false` for a sparse array with extra named properties", () => {
        // Length 3, hole at index 1, plus a named property "foo": still
        // `false` because the named property isn't a valid array index.

        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(isValidFabricValueLayer(sparse)).toBe(false);
      });

      it("returns `false` for a function", () => {
        expect(isValidFabricValueLayer(() => {})).toBe(false);
        expect(isValidFabricValueLayer(function () {})).toBe(false);
        expect(isValidFabricValueLayer(async () => {})).toBe(false);
      });

      it("returns `false` for a class instance", () => {
        expect(isValidFabricValueLayer(new Date())).toBe(false);
        expect(isValidFabricValueLayer(new Map())).toBe(false);
        expect(isValidFabricValueLayer(new Set())).toBe(false);
        expect(isValidFabricValueLayer(/regex/)).toBe(false);
      });

      it("returns `false` for a unique (uninterned) symbol", () => {
        expect(isValidFabricValueLayer(Symbol("k"))).toBe(false);
      });
    });
  });

  describe("isValidFabricValue()", () => {
    it("returns `true` for a schema using the `if` / `then` / `else` keywords", () => {
      // This system's schemas are themselves `FabricValue`s, and JSON Schema
      // spells conditional subschemas with those three keywords. So `then` is
      // a data key a schema routinely carries, and reserving it -- as a
      // defense against promise resolution adopting a callable `then` -- would
      // stop an ordinary schema being a `FabricValue` at all. That hazard is
      // handled where a property can become callable, in the value proxies,
      // rather than by refusing the name here.

      expect(isValidFabricValue({
        type: "object",
        if: { properties: { kind: { const: "a" } } },
        then: { required: ["aField"] },
        else: { required: ["bField"] },
      })).toBe(true);
    });

    describe("given a scalar `FabricValue`", () => {
      it("returns `true` for a boolean", () => {
        expect(isValidFabricValue(true)).toBe(true);
        expect(isValidFabricValue(false)).toBe(true);
      });

      it("returns `true` for a string", () => {
        expect(isValidFabricValue("")).toBe(true);
        expect(isValidFabricValue("hello")).toBe(true);
      });

      it("returns `true` for a finite number (including `-0`)", () => {
        expect(isValidFabricValue(0)).toBe(true);
        expect(isValidFabricValue(-0)).toBe(true);
        expect(isValidFabricValue(3.14159)).toBe(true);
        expect(isValidFabricValue(Number.MAX_VALUE)).toBe(true);
      });

      it("returns `true` for a non-finite number (`NaN`, `±Infinity`)", () => {
        expect(isValidFabricValue(NaN)).toBe(true);
        expect(isValidFabricValue(Infinity)).toBe(true);
        expect(isValidFabricValue(-Infinity)).toBe(true);
      });

      it("returns `true` for a `bigint`", () => {
        expect(isValidFabricValue(0n)).toBe(true);
        expect(isValidFabricValue(123n)).toBe(true);
      });

      it("returns `true` for an interned symbol", () => {
        // Registry-interned symbols are portable and are members, matching
        // `isValidFabricValueLayer()`.

        expect(isValidFabricValue(Symbol.for("k"))).toBe(true);
      });

      it("returns `true` for `null`", () => {
        expect(isValidFabricValue(null)).toBe(true);
      });

      it("returns `true` for `undefined`", () => {
        expect(isValidFabricValue(undefined)).toBe(true);
      });
    });

    describe("given a nested container", () => {
      it("returns `true` for a plain object of `FabricValue`s", () => {
        expect(isValidFabricValue({})).toBe(true);
        expect(isValidFabricValue({ a: 1, b: "two", c: null })).toBe(true);
        expect(isValidFabricValue({ nested: { deeply: { value: 1 } } })).toBe(
          true,
        );
      });

      it("returns `false` for a reserved property name, at any depth", () => {
        const unsafe = { ["__proto__"]: 1 };
        expect(isValidFabricValue(unsafe)).toBe(false);
        expect(isValidFabricValue({ nested: unsafe })).toBe(false);
        expect(isValidFabricValue([unsafe])).toBe(false);
        expect(isValidFabricValue({ ["constructor"]: 1 })).toBe(false);
      });

      it("returns `false` for a null-prototype object, at any depth", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isValidFabricValue(obj)).toBe(false);
        expect(isValidFabricValue({ nested: obj })).toBe(false);
        expect(isValidFabricValue([obj])).toBe(false);
      });

      it("returns `false` for an object with a symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isValidFabricValue(obj)).toBe(false);
      });

      it("returns `false` for an object with a non-enumerable string key", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isValidFabricValue(obj)).toBe(false);
      });

      it("returns `false` for a symbol-keyed object nested in the graph", () => {
        const inner = { a: 1 } as Record<string | symbol, unknown>;
        inner[Symbol("s")] = 2;
        expect(isValidFabricValue({ outer: [inner] })).toBe(false);
      });

      it("returns `true` for an array of `FabricValue`s", () => {
        expect(isValidFabricValue([])).toBe(true);
        expect(isValidFabricValue([1, 2, 3])).toBe(true);
        expect(isValidFabricValue([{ a: 1 }, [2, 3], "x"])).toBe(true);
      });

      it("returns `true` for an array with `undefined` elements and sparse holes", () => {
        expect(isValidFabricValue([1, undefined, 3])).toBe(true);
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isValidFabricValue(sparse)).toBe(true);
      });

      it("returns `true` for a `FabricPrimitive` (`FabricBytes`, `FabricEpochNsec`)", () => {
        expect(isValidFabricValue(new FabricBytes(new Uint8Array([1, 2, 3]))))
          .toBe(true);
        expect(isValidFabricValue(new FabricEpochNsec(0n))).toBe(true);
      });

      it("returns `true` for a `FabricInstance` (`FabricError`)", () => {
        expect(isValidFabricValue(FabricError.fromNativeError(new Error("x"))))
          .toBe(true);
      });

      it("returns `true` for a `FabricInstance` nested in a tree", () => {
        const fe = FabricError.fromNativeError(new Error("nested"));
        expect(isValidFabricValue({ a: 1, e: fe, list: [fe] })).toBe(true);
      });
    });

    describe("given an unfrozen value (membership ignores frozen-ness)", () => {
      it("returns `true` for an unfrozen plain object and array", () => {
        // Structurally valid but not frozen: still a `FabricValue`. This is the
        // deliberate difference from `isValidDeepFrozenFabricValue()`.

        const obj = { a: 1, nested: { b: 2 } };
        expect(Object.isFrozen(obj)).toBe(false);
        expect(isValidFabricValue(obj)).toBe(true);
        expect(isValidFabricValue([1, [2, 3]])).toBe(true);
      });

      it("returns `true` for an unfrozen `FabricInstance` (member by type)", () => {
        // A `FabricInstance` is a member by type. Membership does not require
        // it to be deep-frozen, and does not recurse into its private
        // interior.

        const fe = FabricError.fromNativeError(new Error("test"));
        expect(Object.isFrozen(fe)).toBe(false);
        expect(isValidFabricValue(fe)).toBe(true);
      });
    });

    describe("given a non-`FabricValue`", () => {
      it("returns `false` for a function at the top level", () => {
        expect(isValidFabricValue(() => {})).toBe(false);
        expect(isValidFabricValue(function () {})).toBe(false);
        expect(isValidFabricValue(async () => {})).toBe(false);
      });

      it("returns `false` for a function reached anywhere within the graph", () => {
        expect(isValidFabricValue({ a: 1, fn: () => {} })).toBe(false);
        expect(isValidFabricValue([1, [2, () => {}]])).toBe(false);
        expect(isValidFabricValue({ deep: { nested: { fn: () => {} } } }))
          .toBe(false);
      });

      it("returns `false` for a non-`FabricValue` class instance (`Date`, `Map`, `Set`, `RegExp`)", () => {
        expect(isValidFabricValue(new Date())).toBe(false);
        expect(isValidFabricValue(new Map())).toBe(false);
        expect(isValidFabricValue(new Set())).toBe(false);
        expect(isValidFabricValue(/regex/)).toBe(false);
      });

      it("returns `false` for a non-`FabricValue` class instance nested in the graph", () => {
        expect(isValidFabricValue({ a: 1, d: new Date() })).toBe(false);
        expect(isValidFabricValue([1, [2, new Map()]])).toBe(false);
      });

      it("returns `false` for an accessor-backed property, at any depth", () => {
        // An accessor is live code, not inert data: a read executes it and can
        // return a different value every time. Freezing does not change that.

        const top = { a: 1 };
        Object.defineProperty(top, "g", { get: () => 2, enumerable: true });
        expect(isValidFabricValue(top)).toBe(false);
        expect(isValidFabricValue(Object.freeze(top))).toBe(false);

        const inner = { b: 3 };
        Object.defineProperty(inner, "g", { get: () => 4, enumerable: true });
        expect(isValidFabricValue({ outer: inner })).toBe(false);
        expect(isValidFabricValue([1, [inner]])).toBe(false);
      });

      it("returns `false` for an array with enumerable named (non-index) properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isValidFabricValue(arr)).toBe(false);
      });

      it("returns `false` for a named-property array nested in the graph", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(isValidFabricValue({ data: arr })).toBe(false);
      });

      it("returns `false` for an array with a symbol-keyed property", () => {
        const arr = [1, 2, 3];
        (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
        expect(isValidFabricValue(arr)).toBe(false);
      });

      it("returns `false` for an array with a non-enumerable named property", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });
        expect(isValidFabricValue(arr)).toBe(false);
      });

      it("returns `false` for an accessor-backed array index, at any depth", () => {
        // An accessor is live code, not inert data, no matter the container:
        // an array index reaches it just as a plain-object key does.

        const top = [1, 2, 3];
        Object.defineProperty(top, 1, {
          get: () => 22,
          enumerable: true,
          configurable: false,
        });
        expect(isValidFabricValue(top)).toBe(false);
        expect(isValidFabricValue(Object.freeze(top))).toBe(false);

        const inner = [4, 5];
        Object.defineProperty(inner, 0, { set: () => {}, enumerable: true });
        expect(isValidFabricValue({ data: inner })).toBe(false);
        expect(isValidFabricValue([1, [inner]])).toBe(false);
      });

      it("returns `false` for a symbol-keyed-property array nested in the graph", () => {
        const arr = [1, 2];
        (arr as unknown as Record<symbol, unknown>)[Symbol.for("extra")] = 42;
        expect(isValidFabricValue({ data: arr })).toBe(false);
      });

      it("returns `false` for an indirect `Array` instance, at any depth", () => {
        // A subclass prototype is live code no matter the container: an
        // overridden `Symbol.iterator` makes iteration yield content the
        // indices never show, and freezing does not reach the prototype.

        class Sub extends Array {}
        const top = new Sub();
        top.push(1, 2);
        expect(isValidFabricValue(top)).toBe(false);
        expect(isValidFabricValue(Object.freeze(top))).toBe(false);
        expect(isValidFabricValue({ data: top })).toBe(false);
        expect(isValidFabricValue([1, [top]])).toBe(false);

        const severed: unknown[] = [3, 4];
        Object.setPrototypeOf(severed, null);
        expect(isValidFabricValue(severed)).toBe(false);
        expect(isValidFabricValue({ data: severed })).toBe(false);
      });

      it("returns `false` for a unique (uninterned) symbol", () => {
        expect(isValidFabricValue(Symbol("k"))).toBe(false);
      });

      it("returns `false` for a unique (uninterned) symbol reached within the graph", () => {
        expect(isValidFabricValue({ a: 1, s: Symbol("nope") })).toBe(false);
        expect(isValidFabricValue([Symbol("nope")])).toBe(false);
      });
    });

    describe("given a circular reference", () => {
      it("returns `true` (terminates) for a self-referential plain object", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(() => isValidFabricValue(a)).not.toThrow();
        expect(isValidFabricValue(a)).toBe(true);
      });

      it("returns `true` (terminates) for a two-node cycle (a -> b -> a)", () => {
        const a: Record<string, unknown> = { tag: "a" };
        const b: Record<string, unknown> = { tag: "b" };
        a.next = b;
        b.next = a;
        expect(() => isValidFabricValue(a)).not.toThrow();
        expect(isValidFabricValue(a)).toBe(true);
      });

      it("returns `true` (terminates) for a self-referential array", () => {
        const arr: unknown[] = [1, 2];
        arr.push(arr);
        expect(() => isValidFabricValue(arr)).not.toThrow();
        expect(isValidFabricValue(arr)).toBe(true);
      });

      it("returns `false` for a non-member reached past a cycle", () => {
        const a: Record<string, unknown> = { tag: "a" };
        a.self = a;
        a.bad = () => {};
        expect(isValidFabricValue(a)).toBe(false);
      });
    });
  });

  describe("isValidFabricPlainObject()", () => {
    describe("given a plain object of `FabricValue`s", () => {
      it("returns `true` for an empty object", () => {
        expect(isValidFabricPlainObject({})).toBe(true);
      });

      it("returns `true` for a nested record", () => {
        expect(isValidFabricPlainObject({ a: 1, b: { c: ["x", 2n] } }))
          .toBe(true);
      });

      it("returns `true` for an unfrozen object", () => {
        const obj = { a: 1 };

        expect(Object.isFrozen(obj)).toBe(false);
        expect(isValidFabricPlainObject(obj)).toBe(true);
      });
    });

    describe("given a record membership refuses", () => {
      it("returns `false` for a null-prototype object", () => {
        // The narrowing `isFabricPlainObject()` accepts this one; membership
        // requires an `Object.prototype`-rooted record.

        const obj = Object.create(null) as Record<string, never>;

        expect(isFabricPlainObject(obj as FabricValue)).toBe(true);
        expect(isValidFabricPlainObject(obj)).toBe(false);
      });

      it("returns `false` for a record holding a nested function", () => {
        expect(isValidFabricPlainObject({ a: { b: () => {} } })).toBe(false);
      });

      it("returns `false` for a record holding a nested class instance", () => {
        expect(isValidFabricPlainObject({ a: [new Date()] })).toBe(false);
      });
    });

    describe("given a non-record value", () => {
      it("returns `false` for an array", () => {
        expect(isValidFabricPlainObject([])).toBe(false);
        expect(isValidFabricPlainObject([1, 2, 3])).toBe(false);
      });

      it("returns `false` for `null` and `undefined`", () => {
        expect(isValidFabricPlainObject(null)).toBe(false);
        expect(isValidFabricPlainObject(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isValidFabricPlainObject(1)).toBe(false);
        expect(isValidFabricPlainObject("a")).toBe(false);
        expect(isValidFabricPlainObject(42n)).toBe(false);
      });

      it("returns `false` for a `FabricSpecialObject`", () => {
        expect(isValidFabricPlainObject(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
      });
    });
  });

  describe("isValidFabricConvertibleJsObject()", () => {
    it("returns `true` for all convertible types", () => {
      expect(isValidFabricConvertibleJsObject(new Error("e"))).toBe(true);
      expect(isValidFabricConvertibleJsObject(new TypeError("e"))).toBe(true);
      expect(isValidFabricConvertibleJsObject(new Map())).toBe(true);
      expect(isValidFabricConvertibleJsObject(new Set())).toBe(true);
      expect(isValidFabricConvertibleJsObject(new Date())).toBe(true);
      expect(isValidFabricConvertibleJsObject(new Uint8Array())).toBe(true);
    });

    it("returns `true` for exotic `Error` subclass", () => {
      class WeirdError extends RangeError {}
      expect(isValidFabricConvertibleJsObject(new WeirdError("weird"))).toBe(
        true,
      );
    });

    it("returns `true` for `RegExp`", () => {
      expect(isValidFabricConvertibleJsObject(/abc/)).toBe(true);
    });

    it("returns `false` for non-convertible types", () => {
      expect(isValidFabricConvertibleJsObject({})).toBe(false);
      expect(isValidFabricConvertibleJsObject([])).toBe(false);
      expect(isValidFabricConvertibleJsObject(new WeakMap())).toBe(false);
    });

    it("returns `false` for a plain object carrying `toJSON()`", () => {
      // `toJSON()` is not consulted, and carrying one decides nothing: what
      // rejects this value is being a plain object. The `Date` below carries
      // one too and is accepted, which is what holds the two apart.

      expect(isValidFabricConvertibleJsObject({ toJSON: () => "x" })).toBe(
        false,
      );
      expect(typeof Date.prototype.toJSON).toBe("function");
      expect(isValidFabricConvertibleJsObject(new Date())).toBe(true);
    });

    it("returns `false` for a non-object", () => {
      expect(isValidFabricConvertibleJsObject(null)).toBe(false);
      expect(isValidFabricConvertibleJsObject(undefined)).toBe(false);
      expect(isValidFabricConvertibleJsObject(1)).toBe(false);
      expect(isValidFabricConvertibleJsObject("a")).toBe(false);
      expect(isValidFabricConvertibleJsObject(() => {})).toBe(false);
    });
  });

  describe("`isValidFabricConvertibleJsObject()` over the corpus", () => {
    // The predicate answers by a narrow route -- the array rule, the builtin
    // class lookup, and an `Error` test -- while the full dispatch reaches the
    // same values through the fabric classes as well. Deciding a subset of one
    // answer by a different road is only correct if the two agree on every arm,
    // which is what the corpus is for.

    const nativeObjectTags: ReadonlyArray<string> = [
      VALUE_TAGS.JsError,
      VALUE_TAGS.JsMap,
      VALUE_TAGS.JsSet,
      VALUE_TAGS.JsDate,
      VALUE_TAGS.JsUint8Array,
      VALUE_TAGS.JsRegExp,
    ];

    for (const [label, value] of LAYER_CORPUS) {
      it(`agrees with the full dispatch about ${label}`, () => {
        const tag = tagOfConvertibleJsValueElseNull(value);
        const viaDispatch = (tag !== null) && nativeObjectTags.includes(tag);
        expect(isValidFabricConvertibleJsObject(value)).toBe(viaDispatch);
      });
    }

    it("is checked against both answers", () => {
      // Agreement is free for a predicate that has drifted to one side, so that
      // the corpus lands on both answers is asserted rather than assumed.

      const answers = LAYER_CORPUS.map(([, value]) =>
        isValidFabricConvertibleJsObject(value)
      );
      expect(answers).toContain(true);
      expect(answers).toContain(false);
    });
  });

  describe("assertValidFabricValueLayer()", () => {
    /** Whether the vet refuses the given value. */
    function refuses(value: unknown): boolean {
      try {
        assertValidFabricValueLayer(value);
        return false;
      } catch {
        return true;
      }
    }

    /** The message the vet refuses the given value with, or `null`. */
    function refusalOf(value: unknown): string | null {
      try {
        assertValidFabricValueLayer(value);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    }

    /** The message the shallow conversion refuses the value with, or `null`. */
    function conversionRefusalOf(value: unknown): string | null {
      try {
        shallowFabricFromConvertibleJsValue(value);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    }

    describe("agrees with `isValidFabricValueLayer()`", () => {
      // The vet decides exactly what the predicate decides. That the corpus
      // lands on both answers is asserted rather than assumed, agreement being
      // free for one that has drifted to a side.

      const accepted: string[] = [];
      const refused: string[] = [];

      for (const [label, value] of LAYER_CORPUS) {
        (isValidFabricValueLayer(value) ? accepted : refused).push(label);
        it(`treats ${label} the same way`, () => {
          expect(refuses(value)).toBe(!isValidFabricValueLayer(value));
        });
      }

      it("is checked against both answers", () => {
        expect(accepted.length).toBeGreaterThan(0);
        expect(refused.length).toBeGreaterThan(0);
      });
    });

    describe("says what the shallow conversion says", () => {
      // What this vet is FOR: standing in for the refusal that
      // `shallowFabricFromConvertibleJsValue()` performs today, so that a
      // caller can vet without converting. Its verdict and its wording
      // therefore have to be that function's, value for value -- which is what
      // this pins, over the whole corpus rather than over a chosen case.
      //
      // The agreement is bounded to values whose class can be read at all. A
      // value whose prototype has a throwing `constructor` accessor cannot be
      // classified, so conversion fails on it outright, while the vet still
      // names a reason -- its outcome having been settled before the probe
      // that fails. The corpus carries no such value, and that bound is why.
      //
      // Bounded the same way to a class that reads the SAME each time. Each of
      // these two reads the constructor for itself, so a `constructor`
      // accessor answering differently on successive reads can be named
      // differently by each. Neither contradicts itself -- one refusal reads
      // once -- and a value that answers differently each time it is asked is
      // not one this agreement is for.
      //
      // The exception is a `FabricConvertibleJsObject`, and it is the whole of
      // the exception: conversion has a say over one, and either mints its
      // fabric form or refuses it there. The vet has no say and does not
      // pretend to, which its own group below covers.

      for (const [label, value] of LAYER_CORPUS) {
        if (isValidFabricConvertibleJsObject(value)) continue;
        it(`gives ${label} the same verdict, in the same words`, () => {
          expect(refusalOf(value)).toBe(conversionRefusalOf(value));
        });
      }

      it("is checked against both verdicts", () => {
        const outcomes = LAYER_CORPUS
          .filter(([, value]) => !isValidFabricConvertibleJsObject(value))
          .map(([, value]) => refusalOf(value) === null);
        expect(outcomes).toContain(true);
        expect(outcomes).toContain(false);
      });
    });

    describe("refusals", () => {
      it("names an array that is not inert", () => {
        expect(() => assertValidFabricValueLayer(Object.assign([1], { z: 1 })))
          .toThrow(
            "Not representable as a `FabricValue`: array that is not an " +
              "inert array",
          );
      });

      it("names an object that is not an inert plain object", () => {
        expect(() =>
          assertValidFabricValueLayer({ a: 1, [Symbol.for("k")]: 2 })
        ).toThrow(
          "Not representable as a `FabricValue`: object that is not an " +
            "inert plain object",
        );
      });

      it("names the property name this runtime reserves", () => {
        expect(() => assertValidFabricValueLayer({ ["__proto__"]: 1 })).toThrow(
          "Not representable as a `FabricValue`: object with a property " +
            "name this runtime reserves (`__proto__`)",
        );
      });

      it("names a function", () => {
        expect(() => assertValidFabricValueLayer(() => {})).toThrow(
          "Not representable as a `FabricValue`: function",
        );
      });

      it("names a unique symbol", () => {
        expect(() => assertValidFabricValueLayer(Symbol("nope"))).toThrow(
          "Not representable as a `FabricValue`: unique (uninterned) symbol",
        );
      });

      describe("names the class from the prototype, not from the value", () => {
        // The refusal message is built from the class name, and an own
        // `constructor` property is ordinary data -- so reading it off the
        // value would let a value choose the name it is refused under, and
        // would let it make the refusal fail instead of report. Each case
        // below is refused as `Widget`, which is what its prototype says.

        class Widget {}

        function widgetWith(descriptor: PropertyDescriptor): unknown {
          const widget = new Widget();
          Object.defineProperty(widget, "constructor", descriptor);
          return widget;
        }

        for (
          const [label, value] of [
            [
              "an own `constructor` naming another class",
              widgetWith({ value: Date }),
            ],
            [
              "a `constructor.name` that is not a string",
              widgetWith({ value: { name: 123 } }),
            ],
            [
              "a `constructor` whose getter throws",
              widgetWith({
                get() {
                  throw new Error("the diagnostic must not propagate this");
                },
              }),
            ],
            ["a `constructor` of `null`", widgetWith({ value: null })],
          ] as ReadonlyArray<[string, unknown]>
        ) {
          it(`refuses ${label} as \`Widget\``, () => {
            expect(() => assertValidFabricValueLayer(value)).toThrow(
              "Not representable as a `FabricValue`: `Widget` (not a " +
                "recognized fabric type)",
            );
          });
        }

        it("refuses a value whose class will not say its name", () => {
          // `name` is an accessor too, so guarding the constructor read alone
          // leaves the next read out in the open.

          class NameThrows {}
          Object.defineProperty(NameThrows.prototype, "constructor", {
            value: Object.defineProperty(function () {}, "name", {
              get() {
                throw new Error("this must not reach the caller");
              },
            }),
          });

          expect(() => assertValidFabricValueLayer(new NameThrows())).toThrow(
            "Not representable as a `FabricValue`: `object` (not a " +
              "recognized fabric type)",
          );
        });

        it("refuses a value whose constructor traps `prototype`", () => {
          // A callable `Proxy` can throw from any read, `.prototype` included,
          // which is what the class lookup would otherwise ask it for.

          const trapped = new Proxy(function () {}, {
            get(target, key) {
              if (key === "prototype") {
                throw new Error("this must not reach the caller");
              }
              return Reflect.get(target, key);
            },
          });
          class ProxyCtor {}
          Object.defineProperty(ProxyCtor.prototype, "constructor", {
            value: trapped,
          });

          expect(() => assertValidFabricValueLayer(new ProxyCtor())).toThrow(
            "Not representable as a `FabricValue`: `object` (not a " +
              "recognized fabric type)",
          );
        });

        it("refuses a value whose class cannot be read, without propagating", () => {
          // The one shape that defeats the prototype read as well. Both the
          // reason-picking probe and the name lookup fail on it, and the
          // refusal has to survive each: an error raised while explaining a
          // refusal would arrive in place of the refusal.

          class Unreadable {}
          Object.defineProperty(Unreadable.prototype, "constructor", {
            get() {
              throw new Error("this must not reach the caller");
            },
          });

          expect(() => assertValidFabricValueLayer(new Unreadable())).toThrow(
            "Not representable as a `FabricValue`: `object` (not a " +
              "recognized fabric type)",
          );
        });
      });

      it("names a class instance as an unrecognized type", () => {
        expect(() => assertValidFabricValueLayer(new PlainClass())).toThrow(
          "Not representable as a `FabricValue`: `PlainClass` (not a " +
            "recognized fabric type)",
        );
      });

      // A `FabricConvertibleJsObject` is in a different position from a value
      // with no fabric form at all: conversion is what settles it, and settles
      // it either way -- a `Date` gets a fabric form, a `Map` is refused there
      // too, its form not being built. Both are told to go and ask.
      for (
        const [label, value] of [
          ["a `Date`", new Date(0)],
          ["a `Uint8Array`", new Uint8Array([1])],
          ["a `RegExp`", /x/],
          ["an `Error`", new Error("x")],
          ["a `Map`", new Map()],
          ["a `Set`", new Set()],
        ] as ReadonlyArray<[string, unknown]>
      ) {
        it(`sends ${label} to the conversion`, () => {
          expect(() => assertValidFabricValueLayer(value)).toThrow(
            "(a `FabricConvertibleJsObject`, so conversion is what decides it)",
          );
        });
      }
    });
  });
});
