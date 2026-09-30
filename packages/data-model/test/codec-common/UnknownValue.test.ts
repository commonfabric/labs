/**
 * What a decode produces for a tag it does not recognize: that tag, and the
 * state untouched.
 *
 * Nothing here can interpret the state, so nothing tries. Encoding one writes
 * the bare state back under the tag it came with, which is what lets a value
 * this runtime has no codec for pass through unharmed rather than being
 * dropped or rewritten into something it was not.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, isValidDeepFrozenFabricValue } from "@";
import {
  CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicStateError,
  UnknownValue,
} from "@/codec-common";
import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-bases";
import { subFreeze, subIsDeepFrozen } from "../fabric-instances/fixtures.ts";

describe("UnknownValue", () => {
  it("is an instance of `BaseFabricInstance`", () => {
    // Subclass-checking-superclass identity: lives directly under the class
    // describe (the rule's cross-cutting carve-out).

    const value = new UnknownValue("Test@1", "state");
    expect(value instanceof BaseFabricInstance).toBe(true);
  });

  describe("constructor()", () => {
    it("preserves `wireTypeTag` and `state`", () => {
      const us = new UnknownValue("FancyType@3", { data: [1, 2, 3] });
      expect(us.wireTypeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });

    it("throws given a tag that is not a codec type tag", () => {
      // This class encodes back to the tag it holds, so a tag a decoder would
      // refuse would make an instance that encodes and cannot be read back.
      for (const tag of ["", "hole", "Bytes"]) {
        expect(() => new UnknownValue(tag, "state")).toThrow(
          /Not a codec type tag/,
        );
      }
    });

    it("throws a `ProblematicStateError` carrying the tag and state", () => {
      // The same vocabulary a strict decode fails in, so a caller gets the
      // offending tag and state structurally rather than out of prose.
      try {
        new UnknownValue("hole", "state");
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("hole");
        expect((e as ProblematicStateError).state).toBe("state");
      }
    });

    it("throws given a tag that is not a string", () => {
      // The thrown error renders what it was handed, so building the report
      // cannot itself fail on a tag that is not a string.
      try {
        new UnknownValue(42 as never, "state");
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("42");
      }
    });
  });

  describe("instance members", () => {
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      describe("via dispatch", () => {
        it("recurses state, freezes in place", () => {
          const child = { y: 2 };
          const uv = new UnknownValue(
            "Fancy@3",
            child,
          );
          const result = deepFreeze(uv);
          expect(result).toBe(uv);
          expect(Object.isFrozen(uv)).toBe(true);
          expect(Object.isFrozen(child)).toBe(true);
          expect(isValidDeepFrozenFabricValue(uv)).toBe(true);
        });
      });

      describe("via direct member invocation", () => {
        it("recurses state, freezes in place", () => {
          const child = { y: 2 };
          const uv = new UnknownValue(
            "Fancy@3",
            child,
          );
          const result = uv[DEEP_FREEZE](subFreeze);
          expect(result).toBe(uv);
          expect(Object.isFrozen(uv)).toBe(true);
          expect(Object.isFrozen(child)).toBe(true);
          expect(uv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      describe("tagForValue()", () => {
        it("returns the value's own (per-instance) wire type tag", () => {
          const uv = new UnknownValue("Weird@7", "s");
          expect(UnknownValue[CODEC].tagForValue(uv)).toBe("Weird@7");
        });
      });

      describe("encode()", () => {
        it("returns the bare `state` (the tag is carried separately)", () => {
          const uv = new UnknownValue("Weird@7", { data: [1, 2, 3] });
          expect(UnknownValue[CODEC].encode(uv, NULL_LIVE_ENVIRONMENT)).toEqual(
            { data: [1, 2, 3] },
          );
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a state of any shape", () => {
          // What arrives under a tag no registry claims is preserved rather
          // than interpreted, so there is no shape this codec could refuse.
          // A codec that refused one would drop the payload of exactly the
          // value whose purpose is to carry it through untouched.
          for (
            const state of [
              null,
              undefined,
              42,
              "s",
              [1, 2, 3],
              { data: { nested: true } },
            ]
          ) {
            expect(UnknownValue[CODEC].canDecode(state)).toBe(true);
          }
        });
      });
    });
  });
});
