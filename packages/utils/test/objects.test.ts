/**
 * Asking what an object is: the shape of its property keys, and the class it
 * is an instance of.
 *
 * The second question has one case that carries the whole point -- an own
 * `constructor` property must not answer it -- and the rest are the shapes
 * where there is no answer to give.
 *
 * For the first: what `isInertPlainObject()` accepts, and the accepting cases
 * are the surprising ones. A frozen object qualifies, and so does a key whose value is
 * `undefined` and one whose name is index-shaped -- none of those disturbs the
 * property that the predicate is actually about.
 *
 * Inertness is about how the properties are defined rather than what they
 * hold, which is the distinction a caller has to get right before trusting the
 * answer to bound anything.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  constructorOfObject,
  constructorOfPrototype,
  isInertPlainObject,
} from "@commonfabric/utils/objects";

describe("objects", () => {
  describe("isInertPlainObject()", () => {
    describe("returns `true` for a plain object with only enumerable string keys", () => {
      it("accepts an empty object", () => {
        expect(isInertPlainObject({})).toBe(true);
      });

      it("accepts an object with string-keyed values", () => {
        expect(isInertPlainObject({ a: 1, b: "two" }))
          .toBe(true);
      });

      it("accepts a key whose value is `undefined`", () => {
        // A present key holding `undefined` is still an enumerable string key.

        expect(isInertPlainObject({ a: undefined }))
          .toBe(true);
      });

      it("accepts an index-shaped string key", () => {
        // Unlike an array, an object has no notion of an index key; `"0"` is
        // just a string name here.

        expect(isInertPlainObject({ 0: "a", 1: "b" }))
          .toBe(true);
      });

      it("accepts a frozen object", () => {
        expect(
          isInertPlainObject(Object.freeze({ a: 1 })),
        )
          .toBe(true);
      });
    });

    describe("returns `false` for unrepresentable keys", () => {
      it("rejects an enumerable symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a non-enumerable symbol-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, Symbol("s"), {
          value: 2,
          enumerable: false,
        });
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a registry-interned symbol-keyed property", () => {
        // Such a symbol is a valid fabric *value*, but still not a property
        // *name*.

        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol.for("s")] = 2;
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a well-known symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol.toStringTag] = "Nope";
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a non-enumerable string-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a non-enumerable string key whose value is `undefined`", () => {
        // The key's presence is what disqualifies it, not what it holds.

        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", {
          value: undefined,
          enumerable: false,
        });
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects an accessor property, enumerable or not", () => {
        const enumerable = {};
        Object.defineProperty(enumerable, "g", {
          get: () => 1,
          enumerable: true,
        });
        const hidden = {};
        Object.defineProperty(hidden, "g", { get: () => 1, enumerable: false });

        // A "plain object" in this system is an INERT one, so an accessor is
        // disqualifying regardless of its key's visibility: it is live code,
        // not data. This pins that the check covers data-versus-accessor in
        // addition to key visibility.
        expect(isInertPlainObject(enumerable)).toBe(
          false,
        );
        expect(isInertPlainObject(hidden)).toBe(false);
      });

      it("rejects a setter-only property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "s", { set: () => {}, enumerable: true });
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a getter/setter pair", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "gs", {
          get: () => 2,
          set: () => {},
          enumerable: true,
        });
        expect(isInertPlainObject(obj)).toBe(false);
      });

      it("rejects a frozen object with a getter", () => {
        // Freezing does not make an accessor inert: reads still execute it.

        const obj = { a: 1 };
        Object.defineProperty(obj, "g", { get: () => 2, enumerable: true });
        expect(isInertPlainObject(Object.freeze(obj)))
          .toBe(false);
      });
    });

    describe("returns `false` for anything that is not a plain object", () => {
      it("rejects an array, empty or not", () => {
        expect(isInertPlainObject([])).toBe(false);
        expect(isInertPlainObject([1, 2])).toBe(false);
      });

      it("rejects a class instance", () => {
        class Thing {
          a = 1;
        }
        expect(isInertPlainObject(new Thing()))
          .toBe(false);
      });

      it("rejects built-in instances", () => {
        expect(isInertPlainObject(new Date())).toBe(
          false,
        );
        expect(isInertPlainObject(new Map())).toBe(
          false,
        );
        expect(isInertPlainObject(/re/)).toBe(false);
        expect(isInertPlainObject(new Uint8Array([1])))
          .toBe(false);
      });

      it("rejects an object whose prototype is `Array.prototype`", () => {
        const fake = Object.create(Array.prototype) as Record<string, unknown>;
        fake.a = 1;
        expect(isInertPlainObject(fake)).toBe(false);
      });

      it("rejects a `null`-prototype object", () => {
        // A record has one shape here, the one the natural syntax produces. A
        // prototype has no representation in any encoding, so accepting this
        // would mean carrying a distinction that stops existing at the first
        // storage boundary. `shallowCleanPlainObject()` is how a caller says
        // it means to shed one.

        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isInertPlainObject(obj)).toBe(false);
        expect(isInertPlainObject(Object.create(null))).toBe(false);
      });

      it("returns rather than throwing for `null` and `undefined`", () => {
        expect(isInertPlainObject(null)).toBe(false);
        expect(isInertPlainObject(undefined)).toBe(
          false,
        );
      });

      it("returns rather than throwing for primitives", () => {
        expect(isInertPlainObject("abc")).toBe(false);
        expect(isInertPlainObject(42)).toBe(false);
        expect(isInertPlainObject(true)).toBe(false);
        expect(isInertPlainObject(1n)).toBe(false);
        expect(isInertPlainObject(Symbol("s")))
          .toBe(false);
      });

      it("rejects a function", () => {
        expect(isInertPlainObject(() => 1)).toBe(false);
      });
    });

    it("sees through a `Proxy` to its target's shape", () => {
      // `Object.getPrototypeOf` and the key traps forward to the target, so a
      // pass-through proxy over a plain object is judged on the target.

      expect(
        isInertPlainObject(new Proxy({ a: 1 }, {})),
      ).toBe(true);

      const withSymbol = { a: 1 } as Record<string | symbol, unknown>;
      withSymbol[Symbol("s")] = 2;
      expect(
        isInertPlainObject(new Proxy(withSymbol, {})),
      ).toBe(false);
    });

    it("returns `false` for a `Proxy` that disowns a key it reported", () => {
      // A proxy whose `ownKeys()` names a key its `getOwnPropertyDescriptor()`
      // then returns `undefined` for. Inertness cannot be established, so the
      // answer is `false`; only a trap that throws on its own account takes
      // this check off its "answers rather than throws" contract.

      const ghosted = new Proxy({ a: 1 }, {
        ownKeys: () => ["a", "ghost"],
        getOwnPropertyDescriptor: (target, key) =>
          key === "ghost"
            ? undefined
            : Object.getOwnPropertyDescriptor(target, key),
      });
      expect(isInertPlainObject(ghosted)).toBe(false);
    });
  });

  describe("constructorOfPrototype()", () => {
    // The form for a caller holding the prototype already, which the value-tag
    // dispatch is: it needs the prototype for its own null test, so asking it
    // to hand the object over and have the prototype read again would be one
    // read too many and a second answer to disagree with.

    it("returns the constructor a prototype names", () => {
      expect(constructorOfPrototype(Object.prototype)).toBe(Object);
      expect(constructorOfPrototype(Map.prototype)).toBe(Map);
      expect(constructorOfPrototype(Object.getPrototypeOf(new Date())))
        .toBe(Date);
    });

    it("returns `undefined` for a `null` prototype", () => {
      expect(constructorOfPrototype(null)).toBe(undefined);
    });

    it("returns `undefined` when the constructor is not callable", () => {
      const proto = Object.create(null) as { constructor?: unknown };
      proto.constructor = "not a function";
      expect(constructorOfPrototype(proto)).toBe(undefined);
    });

    it("returns `undefined` when the constructor names a different prototype", () => {
      // This one only inherits its `constructor`, from `Map.prototype`, and
      // `Map` is not the class whose instances have it as their prototype.

      const proto = Object.create(Map.prototype);
      expect(constructorOfPrototype(proto)).toBe(undefined);
    });

    it("returns `undefined` when the constructor has no `prototype`", () => {
      for (const ctor of [() => {}, function () {}.bind(null)]) {
        const proto = Object.create(null) as { constructor?: unknown };
        proto.constructor = ctor;
        expect(constructorOfPrototype(proto)).toBe(undefined);
      }
    });

    it("agrees with `constructorOfObject()` on the same object", () => {
      // The two are one question asked from two places, so an object's answer
      // must not depend on which of them was asked.

      for (
        const value of [{}, [], new Map(), new Date(), Object.create(null)]
      ) {
        expect(constructorOfPrototype(Object.getPrototypeOf(value)))
          .toBe(constructorOfObject(value));
      }
    });
  });

  describe("constructorOfObject()", () => {
    it("returns the class an ordinary instance was built from", () => {
      expect(constructorOfObject({})).toBe(Object);
      expect(constructorOfObject([])).toBe(Array);
      expect(constructorOfObject(new Map())).toBe(Map);
      expect(constructorOfObject(new Date())).toBe(Date);
      expect(constructorOfObject(/x/)).toBe(RegExp);
    });

    it("returns the subclass, not the base", () => {
      class Sub extends Map {}
      expect(constructorOfObject(new Sub())).toBe(Sub);
    });

    it("returns the class of an instance whose prototype was replaced", () => {
      // The prototype is the whole of the answer, so re-pointing it re-points
      // the answer -- which is the property, not a wrinkle in it.

      const value = Object.setPrototypeOf({}, Map.prototype);
      expect(constructorOfObject(value)).toBe(Map);
    });

    describe("an own `constructor` property does not answer", () => {
      // The case the function exists for. An own `constructor` is ordinary data
      // that happens to share a name with the thing that decides a class, and a
      // caller dispatching on the answer would otherwise let a plain record pass
      // for whatever it named.

      for (
        const [label, forged] of [
          ["`Error`", Error],
          ["`Map`", Map],
          ["`Date`", Date],
        ] as ReadonlyArray<[string, unknown]>
      ) {
        it(`returns \`Object\` for a record claiming ${label}`, () => {
          expect(constructorOfObject({ constructor: forged, a: 1 }))
            .toBe(Object);
        });
      }

      it("is not fooled by one that shadows the real class either", () => {
        const value = Object.assign(new Map(), { constructor: Error });
        expect(constructorOfObject(value)).toBe(Map);
      });
    });

    describe("returns `undefined` where there is no class to read", () => {
      it("returns `undefined` for a null-prototype object", () => {
        expect(constructorOfObject(Object.create(null))).toBe(undefined);
      });

      it("returns `undefined` for an object whose prototype was severed", () => {
        const value = Object.setPrototypeOf({ a: 1 }, null);
        expect(constructorOfObject(value)).toBe(undefined);
      });

      it("returns `undefined` when the constructor is not callable", () => {
        const proto = Object.create(null) as { constructor?: unknown };
        proto.constructor = "not a function";
        expect(constructorOfObject(Object.create(proto))).toBe(undefined);
      });

      it("returns `undefined` when the prototype only inherits its `constructor`", () => {
        const value = Object.create(Object.create(Map.prototype));
        expect(constructorOfObject(value)).toBe(undefined);
      });
    });
  });
});
