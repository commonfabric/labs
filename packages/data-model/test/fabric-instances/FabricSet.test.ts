/**
 * A `Set` as a `FabricInstance`, which is at present only half a value.
 *
 * Convertible-JS conversion is the part that works: a frozen form is produced
 * on request, an already-frozen one is passed through rather than rebuilt, and
 * a mutable form is copied only when what it holds is frozen.
 *
 * The freeze protocols and the codec throw as unimplemented stubs, and these
 * cases assert that throwing on purpose. A gap that is asserted is recorded; a
 * gap that is merely untested is invisible.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC,
  CODEC_TYPE_TAGS,
  NULL_LIVE_ENVIRONMENT,
} from "@/codec-common/index.ts";
import { DEEP_FREEZE, IS_DEEP_FROZEN } from "@/fabric-bases/index.ts";
import { FabricSet } from "@/fabric-instances/index.ts";
import { FrozenSet } from "@/frozen-builtins.ts";
import {
  deepFreeze,
  FabricInstance,
  type FabricValue,
  isValidDeepFrozenFabricValue,
} from "@/index.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricSet", () => {
  it("implements `FabricInstance`", () => {
    // Pure type-identity / supertype check: cross-cutting carve-out per the
    // rule (doesn't fit a single member, isn't construction mechanics).

    const ss = new FabricSet(new Set());
    expect(ss instanceof FabricInstance).toBe(true);
  });

  describe("instance members", () => {
    describe("toNativeValue()", () => {
      it("returns a `FrozenSet` when `frozen` is `true`", () => {
        const set = new Set<FabricValue>([1, 2]);
        const ss = new FabricSet(set);
        const result = ss.toNativeValue(true);
        expect(result).toBeInstanceOf(FrozenSet);
        expect((result as FrozenSet<number>).has(1)).toBe(true);
      });

      it("returns the original `Set` when `frozen` is `false`", () => {
        const set = new Set<FabricValue>([1, 2]);
        const ss = new FabricSet(set);
        const result = ss.toNativeValue(false);
        expect(result).toBe(set); // same reference
        expect(result).toBeInstanceOf(Set);
        expect(result).not.toBeInstanceOf(FrozenSet);
      });

      it("returns the same `FrozenSet` if already frozen (`frozen=true`)", () => {
        const fs = new FrozenSet<FabricValue>([1, 2]);
        const ss = new FabricSet(fs);
        const result = ss.toNativeValue(true);
        expect(result).toBe(fs); // same reference
      });

      it("copies a `FrozenSet` to a mutable `Set` (`frozen=false`)", () => {
        const fs = new FrozenSet<FabricValue>([1, 2]);
        const ss = new FabricSet(fs);
        const result = ss.toNativeValue(false);
        expect(result).not.toBe(fs);
        expect(result).toBeInstanceOf(Set);
        expect(result).not.toBeInstanceOf(FrozenSet);
        expect(result.has(1)).toBe(true);
      });
    });

    describe("[DEEP_FREEZE]", () => {
      describe("via dispatch", () => {
        it("throws not-yet-implemented", () => {
          const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
          expect(() => deepFreeze(fs)).toThrow(
            "`FabricSet`: not yet implemented",
          );
        });
      });

      describe("via direct member invocation", () => {
        it("throws not-yet-implemented", () => {
          const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
          expect(() => fs[DEEP_FREEZE](subFreeze)).toThrow(
            "`FabricSet`: not yet implemented",
          );
        });
      });
    });

    describe("[IS_DEEP_FROZEN]", () => {
      describe("via dispatch", () => {
        it("throws not-yet-implemented (via type guard)", () => {
          const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
          Object.freeze(fs);
          expect(() => isValidDeepFrozenFabricValue(fs)).toThrow(
            "`FabricSet`: not yet implemented",
          );
        });
      });

      describe("via direct member invocation", () => {
        it("throws not-yet-implemented", () => {
          const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
          Object.freeze(fs);
          expect(() => fs[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
            "`FabricSet`: not yet implemented",
          );
        });
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      // Nominal coverage: the codec exists and reports its wire tag and claims
      // its instances, but `encode()` / `decode()` are throwing stubs until
      // `Set` support is implemented.

      const codec = FabricSet[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Set;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Set` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricSet`, rejecting other values", () => {
          expect(codec.canEncode(new FabricSet(new Set()))).toBe(true);
          expect(codec.canEncode("not a set")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("throws (stub)", () => {
          expect(() => codec.encode(new FabricSet(new Set()), env)).toThrow(
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
