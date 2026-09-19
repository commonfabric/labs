/**
 * A day count as a `FabricPrimitive`: always frozen, wrapping a `bigint`, and
 * encoded to a flat base64 string.
 *
 * Days before the epoch are the case worth keeping, a negative count being
 * where an encoding stops round-tripping if it was only ever tried on
 * positive ones. Conversion leaves an instance alone even when asked for
 * something mutable, the value being immutable by construction rather than by
 * request.
 *
 * Malformed state decodes to a `ProblematicValue` rather than throwing.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common/index.ts";
import { FabricEpochDay } from "@/fabric-primitives/index.ts";
import {
  FabricInstance,
  FabricPrimitive,
  shallowFabricFromConvertibleJsValue,
} from "@/index.ts";

describe("FabricEpochDay", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).

  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricEpochDay(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    const sd = new FabricEpochDay(0n);
    expect(sd instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricEpochDay(100n))).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricEpochDay`", () => {
        expect(new FabricEpochDay(0n).schemaType).toBe("FabricEpochDay");
      });
    });

    describe(".value", () => {
      it("wraps a `bigint` value", () => {
        const sd = new FabricEpochDay(19723n);
        expect(sd.value).toBe(19723n);
      });

      it("wraps zero (epoch day)", () => {
        const sd = new FabricEpochDay(0n);
        expect(sd.value).toBe(0n);
      });

      it("wraps negative values (pre-epoch)", () => {
        const sd = new FabricEpochDay(-365n);
        expect(sd.value).toBe(-365n);
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricEpochDay[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.EpochDay;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `EpochDay` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricEpochDay`, rejecting other values", () => {
          expect(codec.canEncode(new FabricEpochDay(0n))).toBe(true);
          expect(codec.canEncode("not an epoch")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a flat base64 string (epoch zero)", () => {
          const sd = new FabricEpochDay(0n);
          // Flat format: base64 string directly, not nested {"/BigInt@1": ...}.
          expect(codec.encode(sd, env)).toBe("AA");
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for string state", () => {
          expect(codec.canDecode("AA")).toBe(true);
        });

        it("returns `false` for state that is not a string", () => {
          expect(codec.canDecode(42)).toBe(false);
        });
      });

      describe("decode()", () => {
        it("decodes a flat base64 string (epoch zero)", () => {
          const decoded = codec.decode(
            expectedTag,
            "AA",
            env,
          ) as unknown as FabricEpochDay;
          expect(decoded).toBeInstanceOf(FabricEpochDay);
          expect(decoded.value).toBe(0n);
        });

        it("decodes malformed base64 to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            "not valid base64!!",
            env,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips at top level (epoch zero)", () => {
          const sd = new FabricEpochDay(0n);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sd, env),
            env,
          ) as unknown as FabricEpochDay;
          expect(decoded).toBeInstanceOf(FabricEpochDay);
          expect(decoded.value).toBe(0n);
        });

        it("round-trips positive day count", () => {
          const days = 19723n; // ~2024-01-01
          const sd = new FabricEpochDay(days);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sd, env),
            env,
          ) as unknown as FabricEpochDay;
          expect(decoded).toBeInstanceOf(FabricEpochDay);
          expect(decoded.value).toBe(days);
        });

        it("round-trips negative day count (pre-epoch)", () => {
          const days = -365n;
          const sd = new FabricEpochDay(days);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sd, env),
            env,
          ) as unknown as FabricEpochDay;
          expect(decoded).toBeInstanceOf(FabricEpochDay);
          expect(decoded.value).toBe(days);
        });
      });
    });
  });

  describe("`shallowFabricFromConvertibleJsValue()` integration", () => {
    // Exercises the free `shallowFabricFromConvertibleJsValue()` rather than a
    // member of the class, so it lives directly under the class `describe()`.

    it("passes through unchanged even with `freeze=false`", () => {
      const days = new FabricEpochDay(456n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromConvertibleJsValue(days, false)).toBe(days);
    });
  });
});
