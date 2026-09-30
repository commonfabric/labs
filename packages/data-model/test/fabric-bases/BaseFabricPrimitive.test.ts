/**
 * The primitive base class's own behavior, which comes down to one invariant:
 * every `FabricPrimitive` is a genuine instance of a class the `data-model`
 * blessed.
 *
 * The constructor enforces that for construction, by refusing any class that
 * was not blessed, and the type guard enforces it for everything else, by
 * throwing for a value that is a `FabricPrimitive` without having been built
 * that way instead of quietly returning `false` and letting the forgery
 * travel.
 *
 * The genuine instances here are of a production class, since a test cannot
 * bless a class of its own. `FabricEpochDay` has the shape every concrete
 * primitive has, a private field assigned after `super()`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricPrimitive } from "@";
import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { FabricEpochDay } from "@/fabric-primitives";

/**
 * A `BaseFabricPrimitive` subclass that nothing blessed, as is true of any
 * class defined outside the `data-model`.
 */
class UnblessedPrimitive extends BaseFabricPrimitive {
  get [VALUE_TAG](): never {
    throw new Error("Unimplemented.");
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/** A subclass of a blessed class, which is not itself blessed. */
class SubEpochDay extends FabricEpochDay {}

/**
 * A rogue direct subclass of `FabricPrimitive` that bypasses
 * `BaseFabricPrimitive` -- the shape the invariant forbids. Used only to
 * witness `isInstance()`'s enforcement throw; no production class is built this
 * way.
 */
class RoguePrimitive extends FabricPrimitive {
  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

describe("BaseFabricPrimitive", () => {
  describe("inheritance", () => {
    it("is a subclass of `FabricPrimitive`", () => {
      const day = new FabricEpochDay(1n);
      expect(day instanceof BaseFabricPrimitive).toBe(true);
      expect(day instanceof FabricPrimitive).toBe(true);
    });
  });

  describe("constructor()", () => {
    it("leaves the instance frozen and non-extensible", () => {
      const day = new FabricEpochDay(1n);
      expect(Object.isFrozen(day)).toBe(true);
      expect(Object.isExtensible(day)).toBe(false);
    });

    it("refuses a new property, whichever way it is added", () => {
      // Every path here is strict-mode, which is what a module is. Sloppy-mode
      // assignment is the one path that fails silently instead of throwing.
      const day = new FabricEpochDay(1n) as unknown as Record<string, unknown>;

      expect(() => {
        day.extra = 42;
      }).toThrow(TypeError);
      expect(() => Object.defineProperty(day, "extra", { value: 42 }))
        .toThrow(TypeError);
      expect(Reflect.set(day, "extra", 42)).toBe(false);
    });

    it("freezes without disturbing a subclass's private fields", () => {
      // The freeze lands before a subclass's own assignments. Private fields
      // are not properties and so are unaffected, which is what makes freezing
      // here rather than in each concrete constructor sound.
      const day = new FabricEpochDay(7n);
      expect(Object.isFrozen(day)).toBe(true);
      expect(day.value).toBe(7n);
    });

    it("throws for a class that was not blessed", () => {
      expect(() => new UnblessedPrimitive()).toThrow("unblessed");
    });

    it("throws for a subclass of a blessed class", () => {
      expect(() => new SubEpochDay(1n)).toThrow("unblessed");
    });

    it("throws for a blessed class constructed on behalf of another", () => {
      // The prototype of what `Reflect.construct()` builds comes from its third
      // argument, which here inherits from the blessed class's prototype and
      // claims its constructor. Checking the class that was asked for, rather
      // than whatever the prototype says, is what refuses it.
      function Forger() {}
      Forger.prototype = Object.create(FabricEpochDay.prototype, {
        constructor: { value: FabricEpochDay },
      });

      expect(() => Reflect.construct(FabricEpochDay, [1n], Forger))
        .toThrow("unblessed");
    });
  });

  describe("static members", () => {
    describe("isInstance()", () => {
      it("is `true` for a `BaseFabricPrimitive`", () => {
        expect(BaseFabricPrimitive.isInstance(new FabricEpochDay(1n))).toBe(
          true,
        );
      });

      it("is `false` for a `FabricValue` that is not a `BaseFabricPrimitive`", () => {
        expect(BaseFabricPrimitive.isInstance(null)).toBe(false);
        expect(BaseFabricPrimitive.isInstance(42)).toBe(false);
        expect(BaseFabricPrimitive.isInstance("x")).toBe(false);
        expect(BaseFabricPrimitive.isInstance({})).toBe(false);
        expect(BaseFabricPrimitive.isInstance([])).toBe(false);
      });

      it("throws for a `FabricPrimitive` that is not a `BaseFabricPrimitive`", () => {
        expect(() => BaseFabricPrimitive.isInstance(new RoguePrimitive()))
          .toThrow("counterfeit");
      });

      it("throws for an object on a blessed prototype that no constructor built", () => {
        const fake = Object.create(FabricEpochDay.prototype);

        expect(() => BaseFabricPrimitive.isInstance(fake))
          .toThrow("counterfeit");
      });

      it("throws for a proxy over a genuine instance", () => {
        const proxy = new Proxy(new FabricEpochDay(1n), {});

        expect(() => BaseFabricPrimitive.isInstance(proxy))
          .toThrow("counterfeit");
      });
    });
  });

  describe("blessFabricPrimitiveClass()", () => {
    it("leaves a blessed class's prototype frozen", () => {
      expect(Object.isFrozen(FabricEpochDay.prototype)).toBe(true);
    });

    it("cannot be bypassed by calling the hook it uses without its key", () => {
      // The hook is keyed by a symbol the module keeps to itself, but a
      // symbol-keyed static is an own property of the class, so any caller can
      // find it. What refuses that caller is the key, which is never exposed.
      // The class is local to this test, so that a hook which failed to refuse
      // could not bless a class any other test relies on being unblessed.

      class Hopeful extends UnblessedPrimitive {}
      const hook = Object.getOwnPropertySymbols(BaseFabricPrimitive)
        .find((symbol) => symbol.description === "data-model.bless");

      expect(hook).not.toBe(undefined);
      expect(() =>
        Reflect.apply(
          Reflect.get(BaseFabricPrimitive, hook!),
          BaseFabricPrimitive,
          [Hopeful, Symbol("data-model.FabricPrimitiveBlessing")],
        )
      ).toThrow("Invalid attempt to bless");
      expect(() => new Hopeful()).toThrow("unblessed");
    });
  });
});
