/**
 * The primitive base class's own behavior, which comes down to one invariant.
 *
 * Every concrete primitive is required to extend this class rather than the
 * contract above it, and the type guard enforces that rather than merely
 * reporting on it: a value that is a `FabricPrimitive` but not a
 * `BaseFabricPrimitive` is a broken subclass, so the guard throws instead of
 * quietly returning `false` and letting the mistake travel.
 *
 * The placeholder member is here in order to be a member at all -- an instance
 * type with nothing in it would make an ordinary `value is` guard collapse --
 * and its only observable behavior is refusing to be called.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricPrimitive } from "@";
import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";

/**
 * Minimal `BaseFabricPrimitive` subclass for exercising the static guard in
 * isolation, independent of any production primitive.
 */
class ProbePrimitive extends BaseFabricPrimitive {
  get [VALUE_TAG](): never {
    throw new Error("Called VALUE_TAG on probe.");
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/**
 * A `BaseFabricPrimitive` subclass that assigns a private field after
 * `super()`, which is the shape every concrete primitive has.
 */
class StatefulProbe extends BaseFabricPrimitive {
  readonly #value: bigint;

  constructor(value: bigint) {
    super();

    this.#value = value;
  }

  get [VALUE_TAG](): never {
    throw new Error("Unimplemented.");
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }

  get value(): bigint {
    return this.#value;
  }
}

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
      const probe = new ProbePrimitive();
      expect(probe instanceof BaseFabricPrimitive).toBe(true);
      expect(probe instanceof FabricPrimitive).toBe(true);
    });
  });

  describe("constructor()", () => {
    it("leaves the instance frozen and non-extensible", () => {
      const probe = new ProbePrimitive();
      expect(Object.isFrozen(probe)).toBe(true);
      expect(Object.isExtensible(probe)).toBe(false);
    });

    it("refuses a new property, whichever way it is added", () => {
      // Every path here is strict-mode, which is what a module is. Sloppy-mode
      // assignment is the one path that fails silently instead of throwing.
      const probe = new ProbePrimitive() as unknown as Record<string, unknown>;

      expect(() => {
        probe.extra = 42;
      }).toThrow(TypeError);
      expect(() => Object.defineProperty(probe, "extra", { value: 42 }))
        .toThrow(TypeError);
      expect(Reflect.set(probe, "extra", 42)).toBe(false);
    });

    it("freezes without disturbing a subclass's private fields", () => {
      // The freeze lands before a subclass's own assignments. Private fields
      // are not properties and so are unaffected, which is what makes freezing
      // here rather than in each concrete constructor sound.
      const probe = new StatefulProbe(7n);
      expect(Object.isFrozen(probe)).toBe(true);
      expect(probe.value).toBe(7n);
    });
  });

  describe("static members", () => {
    describe("isInstance()", () => {
      it("is `true` for a `BaseFabricPrimitive`", () => {
        expect(BaseFabricPrimitive.isInstance(new ProbePrimitive())).toBe(true);
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
          .toThrow(
            "Shouldn't happen",
          );
      });
    });
  });
});
