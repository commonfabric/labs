/**
 * A `Map` as a `FabricInstance`, which is at present only half a value.
 *
 * Convertible-JS conversion is the part that works: a frozen form is produced
 * on request, an already-frozen one is handed back rather than rebuilt, and a
 * mutable form is copied only when what it holds is frozen.
 *
 * The freeze protocols and the codec are stubs that throw, and these cases
 * assert the throwing deliberately. An unimplemented member asserted to throw
 * is a recorded gap; one that is merely never called is a gap nobody can see.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC,
  CODEC_TYPE_TAGS,
  NULL_LIVE_ENVIRONMENT,
} from "@/codec-common/index.ts";
import { DEEP_FREEZE, IS_DEEP_FROZEN } from "@/fabric-bases/index.ts";
import { FabricMap, FabricNativeWrapper } from "@/fabric-instances/index.ts";
import { FrozenMap } from "@/frozen-builtins.ts";
import {
  deepFreeze,
  FabricInstance,
  type FabricValue,
  isValidDeepFrozenFabricValue,
} from "@/index.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricMap", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (they don't fit a single member, aren't construction mechanics).

  it("implements `FabricInstance`", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricInstance).toBe(true);
  });

  it("is an instance of `FabricNativeWrapper`", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricNativeWrapper).toBe(true);
  });

  describe("instance members", () => {
    describe("toNativeValue()", () => {
      it("returns a `FrozenMap` when `frozen` is `true`", () => {
        const map = new Map<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(map);
        const result = sm.toNativeValue(true);
        expect(result).toBeInstanceOf(FrozenMap);
        expect((result as FrozenMap<string, number>).get("a")).toBe(1);
      });

      it("returns the original `Map` when `frozen` is `false`", () => {
        const map = new Map<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(map);
        const result = sm.toNativeValue(false);
        expect(result).toBe(map); // same reference
        expect(result).toBeInstanceOf(Map);
        expect(result).not.toBeInstanceOf(FrozenMap);
      });

      it("returns the same `FrozenMap` if already frozen (`frozen=true`)", () => {
        const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(fm);
        const result = sm.toNativeValue(true);
        expect(result).toBe(fm); // same reference
      });

      it("copies a `FrozenMap` to a mutable `Map` (`frozen=false`)", () => {
        const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(fm);
        const result = sm.toNativeValue(false);
        expect(result).not.toBe(fm);
        expect(result).toBeInstanceOf(Map);
        expect(result).not.toBeInstanceOf(FrozenMap);
        expect(result.get("a")).toBe(1);
      });
    });

    describe("[DEEP_FREEZE]", () => {
      // The protocol methods are unimplemented stubs that throw, which these
      // cases pin at both entry points: dispatch and direct invocation.

      describe("via dispatch", () => {
        it("throws not-yet-implemented", () => {
          const fm = new FabricMap(
            new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
          );
          expect(() => deepFreeze(fm)).toThrow(
            "`FabricMap`: not yet implemented",
          );
        });
      });

      describe("via direct member invocation", () => {
        it("throws not-yet-implemented", () => {
          const fm = new FabricMap(
            new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
          );
          expect(() => fm[DEEP_FREEZE](subFreeze)).toThrow(
            "`FabricMap`: not yet implemented",
          );
        });
      });
    });

    describe("[IS_DEEP_FROZEN]", () => {
      describe("via dispatch", () => {
        it("throws not-yet-implemented (via type guard)", () => {
          const fm = new FabricMap(
            new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
          );
          Object.freeze(fm);
          expect(() => isValidDeepFrozenFabricValue(fm)).toThrow(
            "`FabricMap`: not yet implemented",
          );
        });
      });

      describe("via direct member invocation", () => {
        it("throws not-yet-implemented", () => {
          const fm = new FabricMap(
            new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
          );
          Object.freeze(fm);
          expect(() => fm[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
            "`FabricMap`: not yet implemented",
          );
        });
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      // Nominal coverage: the codec exists and reports its wire tag and claims
      // its instances, but `encode()` / `decode()` are throwing stubs until
      // `Map` support is implemented.

      const codec = FabricMap[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Map;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Map` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricMap`, rejecting other values", () => {
          expect(codec.canEncode(new FabricMap(new Map()))).toBe(true);
          expect(codec.canEncode("not a map")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("throws (stub)", () => {
          expect(() => codec.encode(new FabricMap(new Map()), env)).toThrow(
            "not yet implemented",
          );
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for any state (stub)", () => {
          // Accepting is what leaves the refusal to `decode()`, where "not
          // yet implemented" is the honest account of it. A stub that refused
          // here would report the payload as the thing at fault.
          expect(codec.canDecode(null)).toBe(true);
          expect(codec.canDecode([["k", "v"]])).toBe(true);
        });
      });

      describe("decode()", () => {
        it("throws (stub)", () => {
          expect(() => codec.decode(expectedTag, null, env)).toThrow(
            "not yet implemented",
          );
        });
      });
    });
  });
});
