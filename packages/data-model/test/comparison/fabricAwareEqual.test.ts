/**
 * The comparison for an operand that is allowed to hold a `FabricValue`
 * without being known to be one.
 *
 * Two things are being pinned, and they pull in opposite directions. Every
 * fabric special object must be decided by content, wherever it sits, because
 * a property walk sees no content on one and calls every two of the same class
 * equal. And every value the data model does not own must still be decided the
 * way `deepEqual()` decides it, because these operands carry those too and
 * `valueEqual()` refuses them.
 *
 * The nesting cases are the ones that matter most: a comparison that only
 * checked its arguments would pass a fabric value hidden one key down straight
 * to the property walk that conflates it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricAwareEqual } from "@/index.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import {
  FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
} from "@/for-testing-only.ts";

/** Fixed `FabricError` state, so two built the same way agree in every slot. */
const errorState = (message: string) => ({
  type: "Error",
  name: "Error",
  message,
  stack: undefined,
  cause: undefined,
});

/**
 * The classes whose codecs are stubs. Two of one cannot be compared, the
 * comparison hashing them, so they take no part in the content cases; the
 * stub-codec cases in this file are theirs.
 */
const STUB_CODEC_CLASSES: ReadonlySet<string> = new Set([
  "FabricMap",
  "FabricSet",
]);

/**
 * A distinct-but-equal pair of each special-object kind, plus a third value of
 * the same kind that differs, from the data model's own makers: two calls of a
 * class's first maker are the pair, and its second maker gives the value that
 * differs. The values are built fresh per case so no case can pass on
 * reference identity.
 */
const SPECIAL_OBJECT_KINDS: readonly {
  name: string;
  make: () => unknown;
  makeEqual: () => unknown;
  makeDifferent: () => unknown;
}[] = [
  ...Object.entries(FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY),
  ...Object.entries(FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY),
].filter(([name]) => !STUB_CODEC_CLASSES.has(name)).map((
  [name, [make, makeDifferent]],
) => ({ name, make, makeEqual: make, makeDifferent }));

describe("fabricAwareEqual()", () => {
  describe("given a bare special object of each kind", () => {
    for (const kind of SPECIAL_OBJECT_KINDS) {
      it(`compares a \`${kind.name}\` by content`, () => {
        expect(fabricAwareEqual(kind.make(), kind.makeEqual())).toBe(true);
        expect(fabricAwareEqual(kind.make(), kind.makeDifferent()))
          .toBe(false);
      });
    }
  });

  describe("given a special object nested inside a container", () => {
    for (const kind of SPECIAL_OBJECT_KINDS) {
      it(`compares a \`${kind.name}\` under a record key by content`, () => {
        expect(
          fabricAwareEqual({ v: kind.make() }, { v: kind.makeEqual() }),
        ).toBe(true);
        expect(
          fabricAwareEqual({ v: kind.make() }, { v: kind.makeDifferent() }),
        ).toBe(false);
      });

      it(`compares a \`${kind.name}\` at an array index by content`, () => {
        expect(fabricAwareEqual([kind.make()], [kind.makeEqual()]))
          .toBe(true);
        expect(fabricAwareEqual([kind.make()], [kind.makeDifferent()]))
          .toBe(false);
      });

      it(`compares a \`${kind.name}\` several levels down by content`, () => {
        const nest = (leaf: unknown) => ({ a: [{ b: { c: leaf } }] });
        expect(fabricAwareEqual(nest(kind.make()), nest(kind.makeEqual())))
          .toBe(true);
        expect(
          fabricAwareEqual(nest(kind.make()), nest(kind.makeDifferent())),
        ).toBe(false);
      });
    }
  });

  describe("given a special object whose codec is still a stub", () => {
    // `FabricMap` and `FabricSet` cannot be hashed, so their content equality
    // has no answer to give and `valueEqual()` says so by throwing. Reaching
    // that throw is the point: it names the class that owes the work, where
    // the property walk would have called every two of them equal and said
    // nothing. Do not soften this to a `catch`.

    it("throws for two `FabricMap`s rather than calling them equal", () => {
      expect(() =>
        fabricAwareEqual(
          new FabricMap(new Map([["a", 1]])),
          new FabricMap(new Map([["a", 2]])),
        )
      ).toThrow("not yet implemented");
    });

    it("throws for two `FabricSet`s rather than calling them equal", () => {
      expect(() =>
        fabricAwareEqual(
          new FabricSet(new Set([1])),
          new FabricSet(new Set([2])),
        )
      ).toThrow("not yet implemented");
    });

    it("throws for one nested under a record key too", () => {
      expect(() =>
        fabricAwareEqual(
          { v: new FabricSet(new Set([1])) },
          { v: new FabricSet(new Set([2])) },
        )
      ).toThrow("not yet implemented");
    });

    it("returns `false` for one against a scalar without hashing it", () => {
      // The limit of the throw, and the reason the walk is the frame. The
      // answer here does not depend on what the map holds, and the walk
      // reaches the pair that says so without hashing the record above it.

      expect(
        fabricAwareEqual({ v: new FabricMap(new Map([["a", 1]])) }, { v: 5 }),
      ).toBe(false);
      expect(fabricAwareEqual([new FabricSet(new Set([1]))], [5])).toBe(false);
    });
  });

  describe("given a container the model would refuse to hash", () => {
    it("returns for a cycle the two operands reach at one reference", () => {
      // The walk stops at the shared reference. Separate cyclic graphs still
      // need the pair tracking provided by `valueEqual()`.

      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;

      expect(fabricAwareEqual({ v: cyclic }, { v: cyclic })).toBe(true);
      expect(fabricAwareEqual({ v: cyclic, x: 1 }, { v: cyclic, x: 2 }))
        .toBe(false);
    });
  });

  describe("given a special object beside a value the model does not own", () => {
    // A record holding an ordinary class instance is outside the
    // `FabricValue` type, and a special object sitting beside that instance
    // must still not be conflated with another of its class.

    class Point {
      constructor(readonly x: number) {}
    }

    const withBytes = (x: number, byte: number) => ({
      point: new Point(x),
      bytes: new FabricBytes(new Uint8Array([byte])),
    });

    it("compares a nested special object by content", () => {
      expect(fabricAwareEqual(withBytes(1, 7), withBytes(1, 7))).toBe(true);
      expect(fabricAwareEqual(withBytes(1, 7), withBytes(1, 8))).toBe(false);
    });

    it("returns `false` where only one side's nested value is special", () => {
      expect(
        fabricAwareEqual(withBytes(1, 7), { point: new Point(1), bytes: {} }),
      ).toBe(false);
    });
  });

  describe("given a special object against something else", () => {
    it("returns `false` against a plain record", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, {})).toBe(false);
      expect(fabricAwareEqual({}, bytes)).toBe(false);
    });

    it("returns `false` against an array", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, [])).toBe(false);
      expect(fabricAwareEqual([], bytes)).toBe(false);
    });

    it("returns `false` against a special object of another class", () => {
      expect(
        fabricAwareEqual(
          new FabricBytes(new Uint8Array([1])),
          new FabricEpochNsec(1n),
        ),
      ).toBe(false);
    });

    it("returns `false` against another class whether or not it is frozen", () => {
      // Two classes settle the pair, so neither operand's contents are
      // consulted and no codec is asked about either, even when the outer
      // objects are frozen and one class carries a stub codec.

      const bytes = () => new FabricBytes(new Uint8Array([1]));
      const map = () => new FabricMap(new Map([["a", 1]]));

      expect(fabricAwareEqual(bytes(), map())).toBe(false);
      expect(fabricAwareEqual(map(), bytes())).toBe(false);
      expect(
        fabricAwareEqual(Object.freeze(bytes()), Object.freeze(map())),
      ).toBe(false);
    });

    it("returns `false` against a scalar", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, 1)).toBe(false);
      expect(fabricAwareEqual(bytes, null)).toBe(false);
      expect(fabricAwareEqual(bytes, undefined)).toBe(false);
    });

    it("returns `false` against a non-fabric class instance, without throwing", () => {
      const bytes = new FabricBytes(new Uint8Array([1]));
      expect(fabricAwareEqual(bytes, new Date(0))).toBe(false);
      expect(fabricAwareEqual(new Date(0), bytes)).toBe(false);
    });
  });

  describe("given a special object behind a proxy", () => {
    // The boundary the doc comment states: operands arrive unwrapped. A
    // special object is recognized by `instanceof`, which a proxy decides
    // rather than the value behind it, and `data-model` sits below whatever
    // built the proxy and cannot unwrap one. Both answers here are wrong about
    // the values; what they pin is that the wrongness is the proxy's, so a
    // change that starts unwrapping will fail these rather than pass silently.

    const distinct = () =>
      [
        new FabricBytes(new Uint8Array([1])),
        new FabricBytes(new Uint8Array([2])),
      ] as const;

    /** Wraps a value so that `instanceof` no longer reaches its class. */
    const hide = (value: object) =>
      new Proxy({} as Record<string, unknown>, {
        get: (_target, key) => (value as Record<string | symbol, unknown>)[key],
      });

    it("throws where the proxy forwards `instanceof`", () => {
      const [a, b] = distinct();

      expect(() => fabricAwareEqual(new Proxy(a, {}), new Proxy(b, {})))
        .toThrow(TypeError);
    });

    it("returns `true` for two distinct ones where it does not", () => {
      // A proxy over a stub target hides the class, so the pair falls to the
      // property walk, which finds no properties on either side.

      const [a, b] = distinct();

      expect(fabricAwareEqual(hide(a), hide(b))).toBe(true);
    });

    it("returns `true` for two distinct instances hidden the same way", () => {
      // The arm a runtime proxy actually reaches. Two errors carrying
      // different messages are unequal in the open and equal behind the
      // proxy, so the hiding inverts the answer rather than merely coarsening
      // it.

      const errorWith = (message: string) =>
        new FabricError(errorState(message));

      expect(fabricAwareEqual(errorWith("AAA"), errorWith("ZZZ"))).toBe(false);
      expect(fabricAwareEqual(hide(errorWith("AAA")), hide(errorWith("ZZZ"))))
        .toBe(true);
    });
  });

  describe("given values the data model does not own", () => {
    it("compares scalars the way `deepEqual()` does", () => {
      expect(fabricAwareEqual(1, 1)).toBe(true);
      expect(fabricAwareEqual("a", "a")).toBe(true);
      expect(fabricAwareEqual(NaN, NaN)).toBe(true);
      expect(fabricAwareEqual(0, -0)).toBe(false);
      expect(fabricAwareEqual(1, "1")).toBe(false);
    });

    it("compares plain containers structurally", () => {
      expect(fabricAwareEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }))
        .toBe(true);
      expect(fabricAwareEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }))
        .toBe(false);
      expect(fabricAwareEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it("compares a non-fabric class instance by its own properties", () => {
      class Point {
        constructor(readonly x: number) {}
      }
      expect(fabricAwareEqual(new Point(1), new Point(1))).toBe(true);
      expect(fabricAwareEqual(new Point(1), new Point(2))).toBe(false);
    });

    it("returns `false` for a null-prototype record against a plain one", () => {
      // This walk separates records by constructor even when their contents
      // agree; `valueEqual()` treats both prototypes as plain records.

      const nullProto = Object.create(null) as Record<string, unknown>;
      nullProto.a = 1;

      expect(fabricAwareEqual(nullProto, { a: 1 })).toBe(false);
      expect(fabricAwareEqual({ a: 1 }, nullProto)).toBe(false);
    });

    it("compares two null-prototype records structurally", () => {
      const make = () => {
        const record = Object.create(null) as Record<string, unknown>;
        record.a = 1;
        return record;
      };

      expect(fabricAwareEqual(make(), make())).toBe(true);
    });

    it("compares a `Date` the way `deepEqual()` does, not by its time", () => {
      // A `Date` carries no own properties, so the property walk calls any two
      // equal. `fabricAwareEqual()` widens `deepEqual()` for fabric values
      // only, and this pins that it does not quietly widen further.
      expect(fabricAwareEqual(new Date(0), new Date(1))).toBe(true);
    });
  });
});
