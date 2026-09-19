import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type FabricValue,
  isFabricArray,
  isFabricContainerValue,
  isFabricObjectOrArray,
  isFabricPlainContainer,
  isFabricPlainObject,
  isFabricSpecialObject,
  isKeyableObjectNotArray,
  isKeyableObjectOrArray,
  isWalkableObjectNotArray,
  isWalkableObjectOrArray,
  toCompactDebugString,
} from "@";
import { BaseFabricSpecialObject } from "@/fabric-bases";
import {
  FabricError,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";

describe("narrowing", () => {
  describe("isFabricSpecialObject()", () => {
    it("returns `true` for a `FabricPrimitive` and for a `FabricInstance`", () => {
      expect(isFabricSpecialObject(new FabricBytes(new Uint8Array([1])))).toBe(
        true,
      );
      expect(isFabricSpecialObject(FabricError.fromNativeError(new Error("x"))))
        .toBe(true);
    });

    it("returns `false` for a plain object, an array, `null`, and a function", () => {
      expect(isFabricSpecialObject({})).toBe(false);
      expect(isFabricSpecialObject([])).toBe(false);
      expect(isFabricSpecialObject(null)).toBe(false);
      expect(isFabricSpecialObject(() => 1)).toBe(false);
    });

    it("narrows an `unknown` to a `FabricValue`", () => {
      // What this pins is the narrowed type: a value that passes is typed as
      // one of the two subclasses, which is a `FabricValue`, where the class
      // itself narrows only to the abstract base.
      const value: unknown = new FabricBytes(new Uint8Array([1]));
      if (isFabricSpecialObject(value)) {
        const asValue: FabricValue = value;
        expect(asValue).toBe(value);
      } else {
        throw new Error("Expected a special object.");
      }
    });
  });

  describe("isFabricContainerValue()", () => {
    describe("given a container arm of `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricContainerValue({})).toBe(true);
        expect(isFabricContainerValue({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for an array", () => {
        expect(isFabricContainerValue([])).toBe(true);
        expect(isFabricContainerValue([1, 2, 3])).toBe(true);
      });

      it("returns `true` for a `FabricInstance`", () => {
        expect(
          isFabricContainerValue(FabricError.fromNativeError(new Error("x"))),
        )
          .toBe(true);
      });
    });

    describe("given a non-container `FabricValue`", () => {
      it("returns `false` for a `FabricPrimitive`", () => {
        // The whole of the difference from `isFabricObjectOrArray()`, which
        // accepts these: a `FabricPrimitive` self-freezes at construction and
        // exposes no `FabricValue` for a walk to descend into, whatever it
        // holds privately.

        expect(isFabricContainerValue(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricContainerValue(new FabricEpochNsec(1n))).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isFabricContainerValue(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricContainerValue(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isFabricContainerValue(1)).toBe(false);
        expect(isFabricContainerValue("a")).toBe(false);
        expect(isFabricContainerValue(true)).toBe(false);
        expect(isFabricContainerValue(42n)).toBe(false);
      });
    });
  });

  describe("isFabricPlainContainer()", () => {
    describe("given a plain container arm of `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricPlainContainer({})).toBe(true);
        expect(isFabricPlainContainer({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, never>;
        expect(isFabricPlainContainer(obj)).toBe(true);
      });

      it("returns `true` for an array", () => {
        expect(isFabricPlainContainer([])).toBe(true);
        expect(isFabricPlainContainer([1, 2, 3])).toBe(true);
      });
    });

    describe("given a `FabricValue` a key means nothing against", () => {
      it("returns `false` for a `FabricInstance`", () => {
        // The whole of the difference from `isFabricContainerValue()`, which
        // accepts one: an instance holds its contents privately.

        expect(
          isFabricPlainContainer(FabricError.fromNativeError(new Error("x"))),
        ).toBe(false);
      });

      it("returns `false` for a `FabricPrimitive`", () => {
        expect(isFabricPlainContainer(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricPlainContainer(new FabricEpochNsec(1n))).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isFabricPlainContainer(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricPlainContainer(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isFabricPlainContainer(1)).toBe(false);
        expect(isFabricPlainContainer("a")).toBe(false);
        expect(isFabricPlainContainer(true)).toBe(false);
        expect(isFabricPlainContainer(42n)).toBe(false);
      });
    });
  });

  describe("isFabricArray()", () => {
    it("returns `true` given a `FabricArray`", () => {
      expect(isFabricArray([])).toBe(true);
      expect(isFabricArray([1])).toBe(true);
      expect(isFabricArray([{ a: "foo" }])).toBe(true);
    });

    it("returns `true` given an `Array` subclass instance", () => {
      // The narrowing asks a shape question, not the membership one, and so
      // is looser than `isValidFabricValue()`, which refuses this value.

      class Sub extends Array {}
      expect(isFabricArray(new Sub() as unknown as FabricValue)).toBe(true);
    });

    it("returns `false` given a type-lie value", () => {
      const wrongTypeValue = new Set() as unknown as FabricValue;
      expect(isFabricArray(wrongTypeValue)).toBe(false);
    });

    for (
      const value of [
        123,
        "boop",
        { z: "zorp" },
        new FabricEpochNsec(12345n),
        new FabricBytes(new Uint8Array([1, 2, 3, 4, 5])),
      ]
    ) {
      const desc = toCompactDebugString(value);
      it(`returns \`false\` given ${desc}`, () => {
        expect(isFabricArray(value)).toBe(false);
      });
    }
  });

  describe("isFabricObjectOrArray()", () => {
    describe("given an object-typed `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricObjectOrArray({})).toBe(true);
        expect(isFabricObjectOrArray({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for an array", () => {
        expect(isFabricObjectOrArray([])).toBe(true);
        expect(isFabricObjectOrArray([1, 2, 3])).toBe(true);
      });

      it("returns `true` for a `FabricSpecialObject`", () => {
        // The whole of the difference from `isFabricContainerValue()` and
        // `isFabricPlainContainer()`, each of which rejects at least the
        // `FabricPrimitive`: this asks only what `typeof` would say.

        expect(isFabricObjectOrArray(new FabricBytes(new Uint8Array([1]))))
          .toBe(true);
        expect(isFabricObjectOrArray(new FabricEpochNsec(1n))).toBe(true);
        expect(
          isFabricObjectOrArray(FabricError.fromNativeError(new Error("x"))),
        ).toBe(true);
      });
    });

    describe("given a non-object `FabricValue`", () => {
      it("returns `false` for `null`", () => {
        expect(isFabricObjectOrArray(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricObjectOrArray(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isFabricObjectOrArray(1)).toBe(false);
        expect(isFabricObjectOrArray("a")).toBe(false);
        expect(isFabricObjectOrArray(true)).toBe(false);
        expect(isFabricObjectOrArray(42n)).toBe(false);
      });
    });
  });

  describe("isFabricPlainObject()", () => {
    describe("given the plain-record arm of `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricPlainObject({})).toBe(true);
        expect(isFabricPlainObject({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, never>;
        expect(isFabricPlainObject(obj)).toBe(true);
      });
    });

    describe("given a non-record `FabricValue`", () => {
      it("returns `false` for an array", () => {
        expect(isFabricPlainObject([])).toBe(false);
        expect(isFabricPlainObject([1, 2, 3])).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isFabricPlainObject(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricPlainObject(undefined)).toBe(false);
      });

      it("returns `false` for a primitive", () => {
        expect(isFabricPlainObject(1)).toBe(false);
        expect(isFabricPlainObject("a")).toBe(false);
        expect(isFabricPlainObject(true)).toBe(false);
        expect(isFabricPlainObject(42n)).toBe(false);
      });

      it("returns `false` for a `FabricSpecialObject`", () => {
        expect(isFabricPlainObject(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricPlainObject(FabricError.fromNativeError(new Error("x"))))
          .toBe(false);
      });

      it("returns `false` for a non-plain class instance (`Date`, `Map`, …)", () => {
        // Not representable as a `FabricPlainObject`, and reachable only via
        // an unsound cast, so the guard is fed them as `unknown`.

        expect(isFabricPlainObject(new Date() as unknown as FabricValue))
          .toBe(false);
        expect(isFabricPlainObject(new Map() as unknown as FabricValue))
          .toBe(false);
        expect(isFabricPlainObject(/regex/ as unknown as FabricValue))
          .toBe(false);
      });
    });
  });

  describe("isKeyableObjectOrArray()", () => {
    describe("given a container a walk may read by property name", () => {
      it("returns `true` for a plain object", () => {
        expect(isKeyableObjectOrArray({})).toBe(true);
        expect(isKeyableObjectOrArray({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        expect(isKeyableObjectOrArray(Object.create(null))).toBe(true);
      });

      it("returns `true` for an array", () => {
        expect(isKeyableObjectOrArray([])).toBe(true);
        expect(isKeyableObjectOrArray([1, 2, 3])).toBe(true);
      });

      it("returns `true` for a non-fabric class instance", () => {
        // The predicate subtracts exactly the fabric special objects from
        // `isObjectOrArray()`; it is not the narrower plain-container question.

        expect(isKeyableObjectOrArray(new Date())).toBe(true);
        expect(isKeyableObjectOrArray(new Map())).toBe(true);
        expect(isKeyableObjectOrArray(/regex/)).toBe(true);
      });
    });

    describe("given a `FabricSpecialObject`", () => {
      it("returns `false` for each `FabricPrimitive` kind", () => {
        expect(isKeyableObjectOrArray(new FabricBytes(new Uint8Array([1, 2]))))
          .toBe(false);
        expect(isKeyableObjectOrArray(new FabricEpochNsec(1n))).toBe(false);
        expect(isKeyableObjectOrArray(new FabricEpochDay(1n))).toBe(false);
        expect(isKeyableObjectOrArray(new FabricUnavailable("pending")))
          .toBe(false);
        expect(isKeyableObjectOrArray(new FabricRegExp("es2025", "a+", "g")))
          .toBe(false);
        expect(
          isKeyableObjectOrArray(
            new FabricHash(new Uint8Array([1, 2]), "fid1"),
          ),
        ).toBe(false);
      });

      it("returns `false` for a direct `FabricSpecialObject` subclass", () => {
        class DirectSpecialObject extends BaseFabricSpecialObject {}

        expect(isKeyableObjectOrArray(new DirectSpecialObject())).toBe(false);
      });

      it("returns `false` for each `FabricInstance` kind, without throwing", () => {
        // The whole of the difference from `isWalkableObjectOrArray()`, which
        // refuses these. `false` reports that this walk cannot reach what an
        // instance holds, which is the honest answer where a walk decides
        // what a path finds rather than what a rebuild carries forward.

        for (
          const instance of [
            FabricError.fromNativeError(new Error("x")),
            new FabricMap(new Map([["a", 1]])),
            new FabricSet(new Set([1])),
            new FabricLink({ id: "of:fid1:abc" }),
          ]
        ) {
          expect(isKeyableObjectOrArray(instance)).toBe(false);
        }
      });
    });

    describe("given a value with no contents to walk", () => {
      it("returns `false` for `null` and `undefined`", () => {
        expect(isKeyableObjectOrArray(null)).toBe(false);
        expect(isKeyableObjectOrArray(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isKeyableObjectOrArray(1)).toBe(false);
        expect(isKeyableObjectOrArray("a")).toBe(false);
        expect(isKeyableObjectOrArray(true)).toBe(false);
        expect(isKeyableObjectOrArray(42n)).toBe(false);
        expect(isKeyableObjectOrArray(Symbol.for("s"))).toBe(false);
      });

      it("returns `false` for a function", () => {
        expect(isKeyableObjectOrArray(() => {})).toBe(false);
      });
    });
  });

  describe("isKeyableObjectNotArray()", () => {
    it("returns `true` for a plain object", () => {
      expect(isKeyableObjectNotArray({})).toBe(true);
      expect(isKeyableObjectNotArray({ a: 1 })).toBe(true);
    });

    it("returns `false` for an array", () => {
      expect(isKeyableObjectNotArray([])).toBe(false);
      expect(isKeyableObjectNotArray([1, 2, 3])).toBe(false);
    });

    it("returns `true` for a non-fabric class instance", () => {
      // The whole of the difference from the plain-object question: this
      // subtracts the fabric special objects from `isObjectNotArray()` and
      // nothing else.

      expect(isKeyableObjectNotArray(new Date())).toBe(true);
      expect(isKeyableObjectNotArray(new Map())).toBe(true);
    });

    it("returns `false` for a `FabricPrimitive`", () => {
      expect(isKeyableObjectNotArray(new FabricBytes(new Uint8Array([1]))))
        .toBe(false);
    });

    it("returns `false` for a direct `FabricSpecialObject` subclass", () => {
      class DirectSpecialObject extends BaseFabricSpecialObject {}

      expect(isKeyableObjectNotArray(new DirectSpecialObject())).toBe(false);
    });

    it("returns `false` for a `FabricInstance`, without throwing", () => {
      expect(isKeyableObjectNotArray(new FabricMap(new Map([["a", 1]]))))
        .toBe(false);
    });

    it("returns `false` for a value with no contents to walk", () => {
      expect(isKeyableObjectNotArray(null)).toBe(false);
      expect(isKeyableObjectNotArray(undefined)).toBe(false);
      expect(isKeyableObjectNotArray(1)).toBe(false);
    });
  });

  describe("isWalkableObjectOrArray()", () => {
    describe("given a container a walk may read by property name", () => {
      it("returns `true` for a plain object", () => {
        expect(isWalkableObjectOrArray({})).toBe(true);
        expect(isWalkableObjectOrArray({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        expect(isWalkableObjectOrArray(Object.create(null))).toBe(true);
      });

      it("returns `true` for an array", () => {
        expect(isWalkableObjectOrArray([])).toBe(true);
        expect(isWalkableObjectOrArray([1, 2, 3])).toBe(true);
      });

      it("returns `true` for a non-fabric class instance", () => {
        // The predicate subtracts exactly the fabric special objects from
        // `isObjectOrArray()`; it is not the narrower plain-container question.
        expect(isWalkableObjectOrArray(new Date())).toBe(true);
        expect(isWalkableObjectOrArray(new Map())).toBe(true);
        expect(isWalkableObjectOrArray(/regex/)).toBe(true);
      });
    });

    describe("given a `FabricSpecialObject`", () => {
      it("returns `false` for each `FabricPrimitive` kind", () => {
        expect(isWalkableObjectOrArray(new FabricBytes(new Uint8Array([1, 2]))))
          .toBe(false);
        expect(isWalkableObjectOrArray(new FabricEpochNsec(1n))).toBe(false);
        expect(isWalkableObjectOrArray(new FabricEpochDay(1n))).toBe(false);
        expect(isWalkableObjectOrArray(new FabricUnavailable("pending")))
          .toBe(false);
        expect(isWalkableObjectOrArray(new FabricRegExp("es2025", "a+", "g")))
          .toBe(false);
        expect(
          isWalkableObjectOrArray(
            new FabricHash(new Uint8Array([1, 2]), "fid1"),
          ),
        ).toBe(false);
      });

      it("returns `false` for a direct `FabricSpecialObject` subclass", () => {
        // Every special object the refusal above does not claim is carried
        // whole, decided by class rather than by what the subclass declares.

        class DirectSpecialObject extends BaseFabricSpecialObject {}

        expect(isWalkableObjectOrArray(new DirectSpecialObject())).toBe(false);
      });

      it("throws for each `FabricInstance` kind", () => {
        // An instance is a container, so neither answer is available yet:
        // `false` claims it holds nothing, and `true` sends the caller into a
        // property surface its codec does not speak for.

        for (
          const instance of [
            FabricError.fromNativeError(new Error("x")),
            new FabricMap(new Map([["a", 1]])),
            new FabricSet(new Set([1])),
            new FabricLink({ id: "of:fid1:abc" }),
          ]
        ) {
          expect(() => isWalkableObjectOrArray(instance)).toThrow(
            "`FabricInstance`) in a structural walk",
          );
        }
      });
    });

    describe("given a value with no contents to walk", () => {
      it("returns `false` for `null` and `undefined`", () => {
        expect(isWalkableObjectOrArray(null)).toBe(false);
        expect(isWalkableObjectOrArray(undefined)).toBe(false);
      });

      it("returns `false` for a scalar", () => {
        expect(isWalkableObjectOrArray(1)).toBe(false);
        expect(isWalkableObjectOrArray("a")).toBe(false);
        expect(isWalkableObjectOrArray(true)).toBe(false);
        expect(isWalkableObjectOrArray(42n)).toBe(false);
        expect(isWalkableObjectOrArray(Symbol.for("s"))).toBe(false);
      });

      it("returns `false` for a function", () => {
        expect(isWalkableObjectOrArray(() => {})).toBe(false);
      });
    });
  });

  describe("isWalkableObjectNotArray()", () => {
    it("returns `true` for a plain object", () => {
      expect(isWalkableObjectNotArray({})).toBe(true);
      expect(isWalkableObjectNotArray({ a: 1 })).toBe(true);
    });

    it("returns `false` for an array", () => {
      expect(isWalkableObjectNotArray([])).toBe(false);
      expect(isWalkableObjectNotArray([1, 2, 3])).toBe(false);
    });

    it("returns `true` for a non-fabric class instance", () => {
      // The whole of the difference from the plain-object question: this
      // subtracts the fabric special objects from `isObjectNotArray()` and
      // nothing else.

      expect(isWalkableObjectNotArray(new Date())).toBe(true);
      expect(isWalkableObjectNotArray(new Map())).toBe(true);
    });

    it("returns `false` for a `FabricPrimitive`", () => {
      expect(isWalkableObjectNotArray(new FabricBytes(new Uint8Array([1]))))
        .toBe(false);
    });

    it("returns `false` for a direct `FabricSpecialObject` subclass", () => {
      class DirectSpecialObject extends BaseFabricSpecialObject {}

      expect(isWalkableObjectNotArray(new DirectSpecialObject())).toBe(false);
    });

    it("throws for a `FabricInstance`", () => {
      expect(() => isWalkableObjectNotArray(new FabricMap(new Map([["a", 1]]))))
        .toThrow("`FabricInstance`) in a structural walk");
    });

    it("returns `false` for a value with no contents to walk", () => {
      expect(isWalkableObjectNotArray(null)).toBe(false);
      expect(isWalkableObjectNotArray(undefined)).toBe(false);
      expect(isWalkableObjectNotArray(1)).toBe(false);
    });
  });
});
