/**
 * What a decode produces when it recognized the tag but could not make sense
 * of the state: the tag, the state as it arrived, and the error explaining the
 * refusal.
 *
 * Keeping all three is what lets a bad encoding survive a round trip without
 * being either lost or believed. Encoding one writes all three under this
 * class's own `Problematic@1`, the preserved tag included, because that tag
 * need not be a tag at all -- reporting one that is not is among the things
 * this class is for.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, isValidDeepFrozenFabricValue } from "@";
import { CODEC, NULL_LIVE_ENVIRONMENT, ProblematicValue } from "@/codec-common";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-bases";
import { subFreeze, subIsDeepFrozen } from "../fabric-instances/fixtures.ts";

describe("ProblematicValue", () => {
  it("is an instance of `BaseFabricInstance`", () => {
    // Subclass-checking-superclass identity: lives directly under the class
    // describe (the rule's cross-cutting carve-out).

    const value = new ProblematicValue("Test@1", "state", "oops");
    expect(value instanceof BaseFabricInstance).toBe(true);
  });

  describe("constructor()", () => {
    it("preserves `wireTypeTag`, `state`, and `error`", () => {
      const ps = new ProblematicValue("BadType@1", { x: 1 }, "boom");
      expect(ps.wireTypeTag).toBe("BadType@1");
      expect(ps.state).toEqual({ x: 1 });
      expect(ps.error).toBe("boom");
    });

    it("keeps a `FabricValue` state by identity", () => {
      const state = { x: 1, nested: [2, 3] };

      expect(new ProblematicValue("T@1", state, "boom").state).toBe(state);
    });

    it("renders a non-`FabricValue` state as a debug string", () => {
      const ps = new ProblematicValue("T@1", new Uint8Array([1, 2]), "boom");

      expect(typeof ps.state).toBe("string");
      // A description of the value, not a conversion of it: nothing here
      // should read as though the wire carried a `FabricBytes`.
      expect(ps.state).toMatch(/Uint8Array/);
    });

    it("survives a state that cannot be frozen", () => {
      // The reason coercion belongs in the constructor rather than at each
      // call site: `Object.freeze()` throws on a typed array with elements,
      // and this class deep-freezes its state. Reporting a failure must not
      // itself fail.

      const ps = new ProblematicValue("T@1", new Uint8Array([1, 2, 3]), "b");

      expect(() => deepFreeze(ps)).not.toThrow();
    });

    it("survives a state whose own membership check throws", () => {
      // Prophylaxis rather than a proxy guard: this path must not fail even if
      // `isValidFabricValue()` itself has a defect, since throwing here would
      // replace the failure being reported rather than add to it. A hostile
      // proxy is the only way to provoke that from outside.

      const hostile = new Proxy({}, {
        get() {
          throw new Error("hostile");
        },
        getPrototypeOf() {
          throw new Error("hostile");
        },
        ownKeys() {
          throw new Error("hostile");
        },
      });

      const ps = new ProblematicValue("T@1", hostile, "boom");

      expect(typeof ps.state).toBe("string");
      expect(ps.error).toBe("boom");
    });

    it("renders values with no fabric representation at all", () => {
      for (const state of [new Map([["a", 1]]), new Set([1]), () => 1]) {
        expect(typeof new ProblematicValue("T@1", state, "b").state)
          .toBe("string");
      }
    });
  });

  describe("instance members", () => {
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      describe("via dispatch", () => {
        it("recurses state, freezes in place", () => {
          const child = { x: 1 };
          const pv = new ProblematicValue(
            "Bad@1",
            child,
            "oops",
          );
          const result = deepFreeze(pv);
          expect(result).toBe(pv);
          expect(Object.isFrozen(pv)).toBe(true);
          expect(Object.isFrozen(child)).toBe(true);
          expect(isValidDeepFrozenFabricValue(pv)).toBe(true);
        });
      });

      describe("via direct member invocation", () => {
        it("recurses state, freezes in place", () => {
          const child = { x: 1 };
          const pv = new ProblematicValue(
            "Bad@1",
            child,
            "oops",
          );
          const result = pv[DEEP_FREEZE](subFreeze);
          expect(result).toBe(pv);
          expect(Object.isFrozen(pv)).toBe(true);
          expect(Object.isFrozen(child)).toBe(true);
          expect(pv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });
      });
    });

    describe("equals()", () => {
      it("returns `true` for an instance reporting the same fault", () => {
        const state = { x: 1 };

        expect(new ProblematicValue("T@1", state, "boom").equals(
          new ProblematicValue("T@1", state, "boom"),
        )).toBe(true);
      });

      it("returns `false` when any of the three facts differs", () => {
        const state = { x: 1 };
        const pv = new ProblematicValue("T@1", state, "boom");

        expect(pv.equals(new ProblematicValue("Other@1", state, "boom")))
          .toBe(false);
        expect(pv.equals(new ProblematicValue("T@1", { x: 1 }, "boom")))
          .toBe(false);
        expect(pv.equals(new ProblematicValue("T@1", state, "different")))
          .toBe(false);
      });

      it("returns `false` for anything that is not a `ProblematicValue`", () => {
        const pv = new ProblematicValue("T@1", "s", "boom");

        expect(pv.equals(undefined)).toBe(false);
        expect(pv.equals(null)).toBe(false);
        expect(pv.equals("T@1")).toBe(false);
        expect(pv.equals({ wireTypeTag: "T@1", state: "s", error: "boom" }))
          .toBe(false);
      });

      it("compares a non-string tag by the rendering it kept", () => {
        // The tag is normalized on the way in, so two instances built from the
        // same unusable tag agree.

        expect(new ProblematicValue(42, "s", "boom").equals(
          new ProblematicValue(42, "s", "boom"),
        )).toBe(true);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      describe("tagForValue()", () => {
        it("returns `Problematic@1` whatever tag the value preserved", () => {
          // A preserved tag need not be a tag, so it cannot be the tag this
          // encodes under; `UnknownValue` is the class that round-trips to
          // what it preserved.

          const preserved = new ProblematicValue("Weird@7", "s", "oops");
          const malformed = new ProblematicValue("hole", "s", "oops");

          expect(ProblematicValue[CODEC].tagForValue(preserved))
            .toBe("Problematic@1");
          expect(ProblematicValue[CODEC].tagForValue(malformed))
            .toBe("Problematic@1");
        });
      });

      describe("encode()", () => {
        it("returns the tag, state, and error together", () => {
          const pv = new ProblematicValue("Weird@7", { x: 1 }, "oops");

          expect(ProblematicValue[CODEC].encode(pv, NULL_LIVE_ENVIRONMENT))
            .toEqual({
              tag: "Weird@7",
              state: { x: 1 },
              error: "oops",
            });
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record of the three fields", () => {
          expect(ProblematicValue[CODEC].canDecode(
            { tag: "Weird@7", state: { x: 1 }, error: "oops" },
          )).toBe(true);
        });

        it("returns `true` for a `state` present and `undefined`", () => {
          // Every `FabricValue` is a valid state, `undefined` among them.

          expect(ProblematicValue[CODEC].canDecode(
            { tag: "Weird@7", state: undefined, error: "oops" },
          )).toBe(true);
        });

        it("returns `false` for a record with no `state` property at all", () => {
          // An absent property is the only thing that marks a record this
          // codec did not write. Filling it in would put a reshaped record
          // back on the wire rather than reporting the one that arrived.

          expect(ProblematicValue[CODEC].canDecode(
            { tag: "Weird@7", error: "oops" },
          )).toBe(false);
        });

        it("returns `false` for a non-string `tag` or `error`", () => {
          expect(ProblematicValue[CODEC].canDecode(
            { tag: 7, state: 1, error: "oops" },
          )).toBe(false);
          expect(ProblematicValue[CODEC].canDecode(
            { tag: "Weird@7", state: 1, error: 7 },
          )).toBe(false);
        });

        it("returns `false` for state that is not an object", () => {
          expect(ProblematicValue[CODEC].canDecode("nope")).toBe(false);
        });
      });

      describe("decode()", () => {
        const ENV = NULL_LIVE_ENVIRONMENT;

        it("decodes the tag, state, and error", () => {
          const result = ProblematicValue[CODEC].decode(
            "Problematic@1",
            { tag: "Weird@7", state: { x: 1 }, error: "oops" },
            ENV,
          ) as ProblematicValue;

          expect(result.wireTypeTag).toBe("Weird@7");
          expect(result.state).toEqual({ x: 1 });
          expect(result.error).toBe("oops");
        });

        it("keeps a `state` that is present and `undefined`", () => {
          const result = ProblematicValue[CODEC].decode(
            "Problematic@1",
            { tag: "Weird@7", state: undefined, error: "oops" },
            ENV,
          ) as ProblematicValue;

          expect(result.wireTypeTag).toBe("Weird@7");
          expect(result.state).toBe(undefined);
        });
      });
    });
  });
});
