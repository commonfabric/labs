import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type Constructor,
  type Equal,
  isBoolean,
  isFiniteNumber,
  isFunction,
  isInstance,
  isNumber,
  isObjectNotArray,
  isObjectOrArray,
  isPlainContainer,
  isPlainObject,
  isPrimitive,
  isReadonlyObjectOrArray,
  isString,
  type IsUnion,
  isUnsafeObjectKey,
  type JsTypeTagIncludingNull,
  type MustBeTrue,
  Mutable,
  type Same,
  typeOfIncludingNull,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";

type ImmutableObj<T> = {
  readonly prop: T;
};

function mutate<T>(value: T, callback: (v: Mutable<T>) => void) {
  callback(value as Mutable<T>);
}

/**
 * Labeled sample values with the tag `typeOfIncludingNull()` returns for
 * each: at least one of every JS type `typeof` decides, and `null`.
 */
const JS_TYPE_SAMPLES: ReadonlyArray<
  [string, unknown, JsTypeTagIncludingNull]
> = [
  ["a bigint", 42n, "bigint"],
  ["a boolean", true, "boolean"],
  ["a function", () => {}, "function"],
  ["a class", class {}, "function"],
  ["`null`", null, "null"],
  ["a number", 42, "number"],
  ["`NaN`", NaN, "number"],
  ["a string", "", "string"],
  ["a unique symbol", Symbol("s"), "symbol"],
  ["an interned symbol", Symbol.for("s"), "symbol"],
  ["`undefined`", undefined, "undefined"],
];

describe("types", () => {
  describe("Mutable", () => {
    it("enables mutation on nested `{ readonly prop: T }`", () => {
      const schema: ImmutableObj<ImmutableObj<number>> = { prop: { prop: 5 } };
      mutate(schema, (schema) => {
        schema.prop.prop = 10;
      });
    });
    it("enables mutation on nested `Readonly<T>`", () => {
      const schema: Readonly<{
        prop: Readonly<{
          prop: number;
        }>;
      }> = { prop: { prop: 5 } };
      mutate(schema, (schema) => {
        schema.prop.prop = 10;
      });
    });
    it("enables mutation on `ReadonlyArray`", () => {
      const schema: ReadonlyArray<number> = [1, 2, 3];
      mutate(schema, (schema) => {
        schema[1] = 100;
      });
    });
    it("enables mutation on `readonly T[]`", () => {
      const schema: readonly number[] = [1, 2, 3];
      mutate(schema, (schema) => {
        schema[1] = 100;
      });
    });
    it("enables mutation on `ReadonlyArray` nested in `Readonly<T>`", () => {
      const schema: Readonly<{
        prop: ReadonlyArray<number>;
      }> = { prop: [1, 2, 3] };
      mutate(schema, (schema) => {
        schema.prop[1] = 100;
      });
    });
    it("passes through for primitive types", () => {
      const _: Mutable<null> = null;
      const __: Mutable<number> = 5;
      const ___: Mutable<string> = "hi";
    });
  });

  describe("Constructor", () => {
    class Donut {
      readonly glaze = "plain";
    }

    abstract class Fryer {
      abstract fry(): void;
    }

    it("admits a concrete class and an abstract one", () => {
      const concrete: Constructor<Donut> = Donut;
      const abstractOne: Constructor<Fryer> = Fryer;
      expect(concrete).toBe(Donut);
      expect(abstractOne).toBe(Fryer);
    });

    it("types `.prototype` as the instance type", () => {
      const ctor: Constructor<Donut> = Donut;
      const proto: Donut = ctor.prototype;
      expect(proto).toBe(Donut.prototype);
    });

    it("types `.prototype` as `unknown` given no instance type", () => {
      const ctor: Constructor = Donut;
      // @ts-expect-error `unknown` is not assignable to `Donut`.
      const proto: Donut = ctor.prototype;
      expect(proto).toBe(Donut.prototype);
    });

    it("refuses a class whose instances are not `T`", () => {
      // @ts-expect-error a `Fryer` is not a `Donut`.
      const ctor: Constructor<Donut> = Fryer;
      expect(ctor).toBe(Fryer);
    });
  });

  describe("isObjectOrArray()", () => {
    it("returns `true` for plain objects", () => {
      expect(isObjectOrArray({})).toBe(true);
      expect(isObjectOrArray({ a: 1 })).toBe(true);
    });

    it("returns `true` for arrays", () => {
      expect(isObjectOrArray([])).toBe(true);
      expect(isObjectOrArray([1, 2, 3])).toBe(true);
    });

    it("returns `true` for class instances", () => {
      expect(isObjectOrArray(new Date())).toBe(true);
      expect(isObjectOrArray(new Map())).toBe(true);
    });

    it("returns `false` for `null`", () => {
      expect(isObjectOrArray(null)).toBe(false);
    });

    it("returns `false` for primitives", () => {
      expect(isObjectOrArray(undefined)).toBe(false);
      expect(isObjectOrArray(42)).toBe(false);
      expect(isObjectOrArray("string")).toBe(false);
      expect(isObjectOrArray(true)).toBe(false);
      expect(isObjectOrArray(Symbol("test"))).toBe(false);
    });

    it("returns `false` for functions", () => {
      expect(isObjectOrArray(() => {})).toBe(false);
    });
  });

  describe("isReadonlyObjectOrArray()", () => {
    it("returns `true` for frozen records", () => {
      expect(isReadonlyObjectOrArray(Object.freeze({ a: 1 }))).toBe(true);
    });

    it("has the same runtime domain as `isObjectOrArray()`", () => {
      for (
        const value of [
          {},
          [],
          new Date(),
          null,
          undefined,
          42,
          "string",
          true,
          Symbol("test"),
          () => {},
        ]
      ) {
        expect(isReadonlyObjectOrArray(value)).toBe(isObjectOrArray(value));
      }
    });
  });

  describe("isFunction()", () => {
    it("returns `true` for arrow functions", () => {
      expect(isFunction(() => {})).toBe(true);
      expect(isFunction((x: number) => x * 2)).toBe(true);
    });

    it("returns `true` for function declarations", () => {
      expect(isFunction(function () {})).toBe(true);
      expect(isFunction(function named() {})).toBe(true);
    });

    it("returns `true` for async functions", () => {
      expect(isFunction(async () => {})).toBe(true);
    });

    it("returns `true` for class constructors", () => {
      expect(isFunction(class {})).toBe(true);
    });

    it("returns `false` for non-functions", () => {
      expect(isFunction({})).toBe(false);
      expect(isFunction([])).toBe(false);
      expect(isFunction(null)).toBe(false);
      expect(isFunction(undefined)).toBe(false);
      expect(isFunction(42)).toBe(false);
      expect(isFunction("string")).toBe(false);
    });
  });

  describe("isInstance()", () => {
    it("returns `true` for class instances", () => {
      expect(isInstance(new Date())).toBe(true);
      expect(isInstance(new Map())).toBe(true);
      expect(isInstance(new Set())).toBe(true);
      expect(isInstance(/regex/)).toBe(true);
    });

    it("returns `true` for custom class instances", () => {
      class MyClass {}
      expect(isInstance(new MyClass())).toBe(true);
    });

    it("returns `false` for plain objects", () => {
      expect(isInstance({})).toBe(false);
      expect(isInstance({ a: 1 })).toBe(false);
    });

    it("returns `false` for arrays", () => {
      expect(isInstance([])).toBe(false);
      expect(isInstance([1, 2, 3])).toBe(false);
    });

    it("returns `false` for `null`", () => {
      expect(isInstance(null)).toBe(false);
    });

    it("returns `false` for primitives", () => {
      expect(isInstance(undefined)).toBe(false);
      expect(isInstance(42)).toBe(false);
      expect(isInstance("string")).toBe(false);
      expect(isInstance(true)).toBe(false);
    });

    it("returns `false` for `Object.create(null)`", () => {
      expect(isInstance(Object.create(null))).toBe(false);
    });
  });

  describe("isObjectNotArray()", () => {
    it("returns `true` for plain objects", () => {
      expect(isObjectNotArray({})).toBe(true);
      expect(isObjectNotArray({ a: 1 })).toBe(true);
    });

    it("returns `true` for class instances", () => {
      expect(isObjectNotArray(new Date())).toBe(true);
      expect(isObjectNotArray(new Map())).toBe(true);
    });

    it("returns `false` for arrays", () => {
      expect(isObjectNotArray([])).toBe(false);
      expect(isObjectNotArray([1, 2, 3])).toBe(false);
    });

    it("returns `false` for `null`", () => {
      expect(isObjectNotArray(null)).toBe(false);
    });

    it("returns `false` for primitives", () => {
      expect(isObjectNotArray(undefined)).toBe(false);
      expect(isObjectNotArray(42)).toBe(false);
      expect(isObjectNotArray("string")).toBe(false);
      expect(isObjectNotArray(true)).toBe(false);
    });

    it("returns `false` for functions", () => {
      expect(isObjectNotArray(() => {})).toBe(false);
    });
  });

  describe("isPlainObject()", () => {
    it("returns `true` for object literals", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject(new Object())).toBe(true);
    });

    it("returns `true` for null-prototype objects", () => {
      expect(isPlainObject(Object.create(null))).toBe(true);
    });

    it("excludes `null`-prototype objects when asked to", () => {
      // The narrower question -- "is this rooted at `Object.prototype`?" --
      // for a caller to which a null-prototype object is not merely a
      // different shape but something it must not treat as a record.
      expect(isPlainObject(Object.create(null), false)).toBe(false);
      expect(isPlainObject(Object.create(null), true)).toBe(true);
    });

    it("returns the same either way for everything else", () => {
      class MyClass {}
      for (const value of [{}, { a: 1 }, [], new Date(), new MyClass(), null]) {
        expect(isPlainObject(value, false)).toBe(isPlainObject(value, true));
      }
    });

    it("returns `false` for arrays and class instances", () => {
      class MyClass {}
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(new Map())).toBe(false);
      expect(isPlainObject(/regex/)).toBe(false);
      expect(isPlainObject(new MyClass())).toBe(false);
      expect(isPlainObject(Object.create({}))).toBe(false);
    });

    it("returns `false` for `null`, primitives, and functions", () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject(42)).toBe(false);
      expect(isPlainObject("string")).toBe(false);
      expect(isPlainObject(true)).toBe(false);
      expect(isPlainObject(Symbol("test"))).toBe(false);
      expect(isPlainObject(() => {})).toBe(false);
    });
  });

  describe("isPlainContainer()", () => {
    it("returns `true` for plain objects", () => {
      expect(isPlainContainer({})).toBe(true);
      expect(isPlainContainer({ a: 1 })).toBe(true);
      expect(isPlainContainer(new Object())).toBe(true);
    });

    it("returns `true` for null-prototype objects", () => {
      expect(isPlainContainer(Object.create(null))).toBe(true);
    });

    it("returns `true` for arrays", () => {
      expect(isPlainContainer([])).toBe(true);
      expect(isPlainContainer([1, 2, 3])).toBe(true);
      // Sparse arrays.
      // deno-lint-ignore no-sparse-arrays
      expect(isPlainContainer([1, , 3])).toBe(true);
      // Frozen arrays.
      expect(isPlainContainer(Object.freeze([]))).toBe(true);
    });

    it("returns `true` for frozen plain objects", () => {
      expect(isPlainContainer(Object.freeze({}))).toBe(true);
      expect(isPlainContainer(Object.freeze({ a: 1 }))).toBe(true);
    });

    it("returns `false` for class instances", () => {
      class MyClass {}
      expect(isPlainContainer(new MyClass())).toBe(false);
      expect(isPlainContainer(new Date())).toBe(false);
      expect(isPlainContainer(new Map())).toBe(false);
      expect(isPlainContainer(new Set())).toBe(false);
      expect(isPlainContainer(new Error("x"))).toBe(false);
      expect(isPlainContainer(/regex/)).toBe(false);
    });

    it("returns `false` for objects with a non-Object/non-null prototype", () => {
      // `Object.create({})` produces an object whose prototype is another
      // plain object, which puts it outside the "plain" definition.
      expect(isPlainContainer(Object.create({}))).toBe(false);
    });

    it("returns `false` for `null`, primitives, and functions", () => {
      expect(isPlainContainer(null)).toBe(false);
      expect(isPlainContainer(undefined)).toBe(false);
      expect(isPlainContainer(42)).toBe(false);
      expect(isPlainContainer(42n)).toBe(false);
      expect(isPlainContainer("string")).toBe(false);
      expect(isPlainContainer(true)).toBe(false);
      expect(isPlainContainer(Symbol("test"))).toBe(false);
      expect(isPlainContainer(() => {})).toBe(false);
    });
  });

  describe("isNumber()", () => {
    it("returns `true` for finite numbers", () => {
      expect(isNumber(0)).toBe(true);
      expect(isNumber(42)).toBe(true);
      expect(isNumber(-3.14)).toBe(true);
      expect(isNumber(Number.MAX_VALUE)).toBe(true);
    });

    it("returns `false` for `Infinity`", () => {
      expect(isFiniteNumber(Infinity)).toBe(false);
      expect(isFiniteNumber(-Infinity)).toBe(false);
    });

    it("returns `false` for `NaN`", () => {
      expect(isFiniteNumber(NaN)).toBe(false);
    });

    it("returns `false` for non-numbers", () => {
      expect(isNumber("42")).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(undefined)).toBe(false);
      expect(isNumber({})).toBe(false);
    });
  });

  describe("isString()", () => {
    it("returns `true` for strings", () => {
      expect(isString("")).toBe(true);
      expect(isString("hello")).toBe(true);
      expect(isString(`template`)).toBe(true);
    });

    it("returns `false` for non-strings", () => {
      expect(isString(42)).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString([])).toBe(false);
    });
  });

  describe("isBoolean()", () => {
    it("returns `true` for booleans", () => {
      expect(isBoolean(true)).toBe(true);
      expect(isBoolean(false)).toBe(true);
    });

    it("returns `false` for non-booleans", () => {
      expect(isBoolean(0)).toBe(false);
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean("true")).toBe(false);
      expect(isBoolean(null)).toBe(false);
      expect(isBoolean(undefined)).toBe(false);
    });
  });

  describe("isPrimitive()", () => {
    it("returns `true` for each primitive kind", () => {
      expect(isPrimitive(42n)).toBe(true);
      expect(isPrimitive(true)).toBe(true);
      expect(isPrimitive(null)).toBe(true);
      expect(isPrimitive(42)).toBe(true);
      expect(isPrimitive(NaN)).toBe(true);
      expect(isPrimitive("")).toBe(true);
      expect(isPrimitive(Symbol("s"))).toBe(true);
      expect(isPrimitive(Symbol.for("s"))).toBe(true);
      expect(isPrimitive(undefined)).toBe(true);
    });

    it("returns `false` for an object, an array, and a function", () => {
      expect(isPrimitive({})).toBe(false);
      expect(isPrimitive(Object.create(null))).toBe(false);
      expect(isPrimitive([])).toBe(false);
      expect(isPrimitive(new Date())).toBe(false);
      expect(isPrimitive(() => {})).toBe(false);
      expect(isPrimitive(class {})).toBe(false);
    });
  });

  describe("JsTypeTagIncludingNull", () => {
    it("is the result type of `typeof`, plus `null`", () => {
      // The `typeof` result type has no name of its own, so it is read off a
      // function that returns one.

      const typeOf = (value: unknown) => typeof value;
      type TypeOfTag = ReturnType<typeof typeOf>;

      const _same: Same<TypeOfTag | "null", JsTypeTagIncludingNull> = true;
    });
  });

  describe("Same", () => {
    // Each case pairs the claim with its control: a comparison that reads the
    // other way, so that `true` is the comparison's verdict rather than the
    // only thing it can say.

    it("is `true` for a type and itself, and `false` for two unrelated types", () => {
      const _same: Same<string, string> = true;
      const _unrelated: Same<string, number> = false;
    });

    it("is `true` across `any` in a type argument", () => {
      const _any: Same<Map<any, any>, Map<string, number>> = true;
      const _concrete: Same<Map<string, string>, Map<string, number>> = false;
    });

    it("is `true` across a `readonly` modifier on a property", () => {
      const _property: Same<{ readonly a: number }, { a: number }> = true;
      const _array: Same<readonly number[], number[]> = false;
    });

    it("is `true` for a union and a type each of its members is assignable to", () => {
      const _subtype: Same<Error | TypeError, Error> = true;
      const _disjoint: Same<Error | Date, Error> = false;
    });
  });

  describe("Equal", () => {
    it("is `true` for a type and itself, and `false` for two unrelated types", () => {
      const _same: Equal<string, string> = true;
      const _unrelated: Equal<string, number> = false;
    });

    it("is `false` across `any` in a type argument", () => {
      const _any: Equal<Map<any, any>, Map<string, number>> = false;
      const _written: Equal<Map<any, any>, Map<any, any>> = true;
    });

    it("is `false` across a `readonly` modifier on a property", () => {
      const _property: Equal<{ readonly a: number }, { a: number }> = false;
      const _written: Equal<{ readonly a: number }, { readonly a: number }> =
        true;
    });

    it("is `false` for a union and a type each of its members is assignable to", () => {
      const _subtype: Equal<Error | TypeError, Error> = false;
      const _written: Equal<Error | TypeError, Error | TypeError> = true;
    });
  });

  describe("IsUnion", () => {
    // Each result is compared through `Equal`, which tells `true` from
    // `boolean` where a bare assignment of `true` would accept either.

    it("is `true` for a union of unrelated types, and `false` for a single type", () => {
      const _union: Equal<IsUnion<string | number>, true> = true;
      const _single: Equal<IsUnion<string>, false> = true;
    });

    it("is `false` for a single object type, however many members it has", () => {
      const _object: Equal<IsUnion<{ a: string; b: number }>, false> = true;
    });

    it("is `true` for `boolean`, which is the union of `true` and `false`", () => {
      const _boolean: Equal<IsUnion<boolean>, true> = true;
      const _literal: Equal<IsUnion<true>, false> = true;
    });

    it("is `boolean` for a union with a member every other member is assignable to", () => {
      type Wide = { a: 1 };
      type Narrow = { a: 1; b: 2 };
      const _covered: Equal<IsUnion<Wide | Narrow>, boolean> = true;
      const _disjoint: Equal<IsUnion<Error | Date>, true> = true;
    });

    it("is `false` for a union whose members are mutually assignable", () => {
      const _mutual: Equal<IsUnion<Error | TypeError>, false> = true;
    });

    it("is `false` for a union the compiler reduces to one member", () => {
      const _absorbed: Equal<IsUnion<string | "x">, false> = true;
    });

    it("is `never` for `never`", () => {
      const _never: Equal<IsUnion<never>, never> = true;
    });
  });

  describe("MustBeTrue", () => {
    it("compiles for `true` and for nothing else `Same` or `Equal` can yield", () => {
      type _True = MustBeTrue<true>;
      // @ts-expect-error `false` does not satisfy the constraint
      type _False = MustBeTrue<false>;
      // @ts-expect-error `boolean` does not satisfy the constraint
      type _Boolean = MustBeTrue<boolean>;
    });

    it("compiles for `never`, which a comparison yielding it on mismatch passes vacuously", () => {
      type _Never = MustBeTrue<never>;
    });
  });

  describe("typeOfIncludingNull()", () => {
    for (const [label, value, tag] of JS_TYPE_SAMPLES) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(typeOfIncludingNull(value)).toBe(tag);
      });
    }

    it("returns `object` for an object of any kind", () => {
      // The value `null` has a tag and every other object has none, whatever
      // its class or prototype.

      expect(typeOfIncludingNull({})).toBe("object");
      expect(typeOfIncludingNull(Object.create(null))).toBe("object");
      expect(typeOfIncludingNull([])).toBe("object");
      expect(typeOfIncludingNull(new Date())).toBe("object");
      expect(typeOfIncludingNull(new (class {})())).toBe("object");
    });
  });

  describe("isUnsafeObjectKey()", () => {
    it("returns `true` for prototype-pollution keys", () => {
      expect(isUnsafeObjectKey("__proto__")).toBe(true);
      expect(isUnsafeObjectKey("constructor")).toBe(true);
    });

    it("returns `false` for ordinary keys", () => {
      expect(isUnsafeObjectKey("id")).toBe(false);
      expect(isUnsafeObjectKey("space")).toBe(false);
      expect(isUnsafeObjectKey("path")).toBe(false);
      expect(isUnsafeObjectKey("")).toBe(false);
    });

    it("returns `false` for near-miss keys that are not in the set", () => {
      // Only `__proto__` and `constructor` are unsafe -- not every
      // prototype-adjacent name, and not `then`, which a schema may carry as
      // a JSON Schema keyword.
      expect(isUnsafeObjectKey("prototype")).toBe(false);
      expect(isUnsafeObjectKey("proto")).toBe(false);
      expect(isUnsafeObjectKey("toString")).toBe(false);
      expect(isUnsafeObjectKey("hasOwnProperty")).toBe(false);
      expect(isUnsafeObjectKey("then")).toBe(false);
    });

    it("is backstopped by the runtime keeping `__proto__` inert", () => {
      // Deno neutralises `__proto__`: assigning it lands a plain own property
      // and leaves the prototype alone. That is the layer beneath
      // isUnsafeObjectKey(), which filters the key at trust boundaries.
      const target: Record<string, unknown> = {};
      const untrustedKey = "__proto__";
      try {
        target[untrustedKey] = { polluted: true };
        expect(Object.hasOwn(target, untrustedKey)).toBe(true);
        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
      } catch (e) {
        console.error(
          "This runtime lets a `__proto__` assignment reach the prototype " +
            "chain. Whoever rolled the Deno version that changed this must " +
            "investigate the security implications: every place that copies " +
            "untrusted keys onto an object without filtering them through " +
            "isUnsafeObjectKey() is now open to prototype pollution.",
        );
        throw e;
      }
    });
  });

  describe("unsafeObjectKeyIn()", () => {
    it("returns the offending name for a reserved own key", () => {
      const withProto = { other: 1 } as Record<string, unknown>;
      Object.defineProperty(withProto, "__proto__", {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(unsafeObjectKeyIn(withProto)).toBe("__proto__");
      expect(unsafeObjectKeyIn({ ["constructor"]: 1 })).toBe("constructor");
    });

    it("returns `undefined` for ordinary objects", () => {
      expect(unsafeObjectKeyIn({})).toBe(undefined);
      expect(unsafeObjectKeyIn({ a: 1, prototype: 2, toString: 3 })).toBe(
        undefined,
      );
    });

    it("returns `undefined` for an inherited reserved name", () => {
      // Every object inherits `constructor`, and most inherit `__proto__`.
      // Only an OWN property is the value's own data, and only that can fail
      // to survive a copy.
      expect(unsafeObjectKeyIn(Object.create({ constructor: 1 }))).toBe(
        undefined,
      );
    });

    it("is needed because assignment loses the key where the accessor is standard", () => {
      // The companion to the `__proto__`-is-inert test above, from the other
      // side. Deno neutralises the accessor, so a copy loop there is safe and
      // no test can see the hazard. A realm that keeps the accessor -- every
      // browser, and this repo ships `data-model` to browsers -- loses the
      // property and mutates the copy instead. That is what makes these names
      // uncarryable HERE, and the day no realm behaves this way is the day the
      // restriction can go.
      const saved = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "__proto__",
      );
      try {
        Object.defineProperty(Object.prototype, "__proto__", {
          configurable: true,
          get(this: object) {
            return Object.getPrototypeOf(this);
          },
          set(this: object, v: unknown) {
            // Spec-faithful: the setter is a no-op unless the value is an
            // object or `null`. A primitive-valued `__proto__` assignment
            // silently does nothing at all -- the key is still lost, but the
            // prototype is untouched.
            if ((typeof v === "object") || (typeof v === "function")) {
              Object.setPrototypeOf(this, v as object | null);
            }
          },
        });

        const copy: Record<string, unknown> = {};
        copy["__proto__"] = { marker: true };

        expect(Object.hasOwn(copy, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(copy)).not.toBe(Object.prototype);

        // A primitive value loses the key without touching the prototype:
        // the same data loss, a quieter failure.
        const primitive: Record<string, unknown> = {};
        primitive["__proto__"] = "payload";
        expect(Object.hasOwn(primitive, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(primitive)).toBe(Object.prototype);
      } finally {
        if (saved === undefined) {
          delete (Object.prototype as Record<string, unknown>)["__proto__"];
        } else {
          Object.defineProperty(Object.prototype, "__proto__", saved);
        }
      }
    });
  });
});
