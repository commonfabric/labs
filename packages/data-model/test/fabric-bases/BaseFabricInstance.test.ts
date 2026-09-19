/**
 * The clone template methods, and exactly when one may return the instance it
 * was given rather than a new one.
 *
 * Identity comes back only where it is indistinguishable from a fresh copy,
 * which is a narrower condition than it first looks. A shallow clone may
 * return `this` for an already-frozen instance; a deep clone may not, unless
 * the instance is deep-frozen -- a merely-shallowly-frozen one still has a
 * mutable interior, and is the case separating the two rules. Asking for a
 * mutable result allocates regardless of what the original was.
 *
 * The cases count core invocations rather than only comparing results, since
 * producing a correct value and producing it without allocating are different
 * claims and only one of them shows up in the output.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases/index.ts";
import {
  deepFreeze,
  FabricInstance,
  type FabricValue,
  isDeepFrozen,
} from "@/index.ts";

/**
 * Minimal `BaseFabricInstance` subclass used to exercise the template-method
 * behavior in isolation, independent of any production concrete subclass.
 * Counts clone-core invocations (`[SHALLOW_UNFROZEN_CLONE]()` and
 * `[DEEP_CLONE_CORE]()`) via a constructor-supplied counter (kept off the
 * instance so freezing doesn't block bookkeeping).
 */
class Probe extends BaseFabricInstance {
  readonly #tag;

  readonly #counter: { calls: number };

  constructor(
    tag: string,
    counter: { calls: number } = { calls: 0 },
  ) {
    super();

    this.#tag = tag;
    this.#counter = counter;
  }

  get counter(): { calls: number } {
    return this.#counter;
  }

  get wireTypeTag(): string {
    return this.#tag;
  }

  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    Object.freeze(this);
    return this;
  }

  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this);
  }

  protected [DEEP_CLONE_CORE](_frozen: boolean): Probe {
    this.counter.calls += 1;
    return new Probe(this.#tag, this.counter);
  }

  protected [SHALLOW_UNFROZEN_CLONE](): Probe {
    this.counter.calls += 1;
    return new Probe(this.#tag, this.counter);
  }
}

/**
 * A `Probe` variant carrying a nested mutable record, for the deep-clone
 * cases that need the shallow-frozen / deep-frozen distinction and nested
 * independence (which the payload-less `Probe` cannot express).
 */
class DeepProbe extends BaseFabricInstance {
  readonly #state: { n: number };
  readonly #counter: { calls: number };

  constructor(state: { n: number }, counter = { calls: 0 }) {
    super();

    this.#state = state;
    this.#counter = counter;
  }

  get counter(): { calls: number } {
    return this.#counter;
  }

  get state(): { n: number } {
    return this.#state;
  }

  get wireTypeTag(): string {
    return "DeepProbe@1";
  }

  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.state);
    Object.freeze(this);
    return this;
  }

  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) &&
      subIsDeepFrozen(this.state);
  }

  protected [DEEP_CLONE_CORE](_frozen: boolean): DeepProbe {
    this.counter.calls += 1;
    return new DeepProbe({ ...this.state }, this.counter);
  }

  protected [SHALLOW_UNFROZEN_CLONE](): DeepProbe {
    return new DeepProbe(this.state, this.counter);
  }
}

/**
 * A rogue direct subclass of `FabricInstance` that bypasses
 * `BaseFabricInstance` -- the shape the invariant forbids. Used only to witness
 * `isInstance()`'s enforcement throw; no production class is built this way.
 */
class RogueInstance extends FabricInstance {
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error("not exercised here");
  }

  shallowClone(_frozen: boolean): FabricInstance {
    throw new Error("not exercised here");
  }
}

describe("BaseFabricInstance", () => {
  describe("inheritance", () => {
    it("is a subclass of `FabricInstance`", () => {
      const probe = new Probe("t");
      expect(probe instanceof BaseFabricInstance).toBe(true);
      expect(probe instanceof FabricInstance).toBe(true);
    });
  });

  describe("constructor()", () => {
    it("leaves the instance sealed and non-extensible", () => {
      const probe = new Probe("t");
      expect(Object.isSealed(probe)).toBe(true);
      expect(Object.isExtensible(probe)).toBe(false);
    });

    it("refuses a new property, whichever way it is added", () => {
      // Every path here is strict-mode, which is what a module is. Sloppy-mode
      // assignment is the one path that fails silently instead of throwing.
      const probe = new Probe("t") as unknown as Record<string, unknown>;

      expect(() => {
        probe.extra = 42;
      }).toThrow(TypeError);
      expect(() => Object.defineProperty(probe, "extra", { value: 42 }))
        .toThrow(TypeError);
      expect(() => Object.assign(probe, { extra: 42 })).toThrow(TypeError);
      expect(Reflect.set(probe, "extra", 42)).toBe(false);
      expect(Object.getOwnPropertyNames(probe)).toEqual([]);
    });

    it("reports an unfrozen instance as not frozen", () => {
      // Sealing an object that has no own properties would make this `true`,
      // and every thaw would then short-circuit to identity.
      const probe = new Probe("t");
      expect(Object.isFrozen(probe)).toBe(false);
    });

    it("reports a frozen instance as frozen", () => {
      const probe = new Probe("t");
      expect(Object.isFrozen(Object.freeze(probe))).toBe(true);
    });

    it("keeps the instance absent from every structural view", () => {
      const probe = new Probe("t");
      expect(Object.getOwnPropertyNames(probe)).toEqual([]);
      expect(Object.keys(probe)).toEqual([]);
      expect({ ...probe }).toEqual({});
      expect(JSON.stringify(probe)).toBe("{}");
    });
  });

  describe("instance members", () => {
    describe("shallowClone()", () => {
      describe("when `frozen` is `true`", () => {
        it("returns `this` for an already-frozen instance (no clone call)", () => {
          const probe = new Probe("t");
          Object.freeze(probe);

          const result = probe.shallowClone(true);

          expect(result).toBe(probe);
          expect(probe.counter.calls).toBe(0);
        });

        it("returns a new frozen instance for an unfrozen one", () => {
          const probe = new Probe("t");

          const result = probe.shallowClone(true);

          expect(result).not.toBe(probe);
          expect(result instanceof Probe).toBe(true);
          expect((result as Probe).wireTypeTag).toBe("t");
          expect(Object.isFrozen(result)).toBe(true);
          // Original is left unfrozen.
          expect(Object.isFrozen(probe)).toBe(false);
          expect(probe.counter.calls).toBe(1);
        });
      });

      describe("when `frozen` is `false`", () => {
        it("returns a new unfrozen instance from a frozen original", () => {
          const probe = new Probe("t");
          Object.freeze(probe);

          const result = probe.shallowClone(false);

          expect(result).not.toBe(probe);
          expect(result instanceof Probe).toBe(true);
          expect((result as Probe).wireTypeTag).toBe("t");
          expect(Object.isFrozen(result)).toBe(false);
          // The identity-when-frozen optimization is `frozen===true` only;
          // a `frozen===false` call always allocates.
        });

        it("returns a new unfrozen instance from an unfrozen original", () => {
          const probe = new Probe("t");

          const result = probe.shallowClone(false);

          expect(result).not.toBe(probe);
          expect(Object.isFrozen(result)).toBe(false);
          expect(probe.counter.calls).toBe(1);
        });
      });
    });

    describe("deepClone()", () => {
      describe("when `frozen` is `true`", () => {
        it("returns `this` for an already-deep-frozen instance (no core call)", () => {
          const probe = deepFreeze(new DeepProbe({ n: 1 }));

          const result = probe.deepClone(true);

          expect(result).toBe(probe);
          expect(probe.counter.calls).toBe(0);
        });

        it("does NOT identity-return a merely-shallowly-frozen instance", () => {
          // Frozen instance slot, still-mutable nested state: not deep-frozen,
          // so the deep identity gate (`isDeepFrozen`, not `Object.isFrozen`)
          // must allocate rather than alias.
          const probe = new DeepProbe({ n: 1 });
          Object.freeze(probe);

          expect(Object.isFrozen(probe)).toBe(true);
          expect(isDeepFrozen(probe)).toBe(false);
          expect(probe.deepClone(true)).not.toBe(probe);
          expect(probe.counter.calls).toBe(1);
        });

        it("returns a new deep-frozen instance for an unfrozen one", () => {
          const probe = new DeepProbe({ n: 1 });

          const result = probe.deepClone(true);

          expect(result).not.toBe(probe);
          expect(isDeepFrozen(result)).toBe(true);
          // Original is left unfrozen.
          expect(Object.isFrozen(probe)).toBe(false);
          expect(probe.counter.calls).toBe(1);
        });
      });

      describe("when `frozen` is `false`", () => {
        it("returns a fresh mutable clone with independent nested state", () => {
          const probe = new DeepProbe({ n: 1 });

          const result = probe.deepClone(false) as DeepProbe;

          expect(result).not.toBe(probe);
          expect(Object.isFrozen(result)).toBe(false);
          expect(result.state).not.toBe(probe.state);
          result.state.n = 2;
          expect(probe.state.n).toBe(1);
        });

        it("allocates even from a deep-frozen original (identity gate is `frozen===true` only)", () => {
          const probe = deepFreeze(new DeepProbe({ n: 1 }));

          const result = probe.deepClone(false);

          expect(result).not.toBe(probe);
          expect(Object.isFrozen(result)).toBe(false);
          expect(probe.counter.calls).toBe(1);
        });
      });
    });
  });

  describe("static members", () => {
    describe("isInstance()", () => {
      it("is `true` for a `BaseFabricInstance`", () => {
        expect(BaseFabricInstance.isInstance(new Probe("t"))).toBe(true);
      });

      it("is `false` for a `FabricValue` that is not a `BaseFabricInstance`", () => {
        expect(BaseFabricInstance.isInstance(null)).toBe(false);
        expect(BaseFabricInstance.isInstance(42)).toBe(false);
        expect(BaseFabricInstance.isInstance("x")).toBe(false);
        expect(BaseFabricInstance.isInstance({})).toBe(false);
        expect(BaseFabricInstance.isInstance([])).toBe(false);
      });

      it("throws for a `FabricInstance` that is not a `BaseFabricInstance`", () => {
        expect(() => BaseFabricInstance.isInstance(new RogueInstance()))
          .toThrow(
            "Shouldn't happen",
          );
      });
    });
  });
});
