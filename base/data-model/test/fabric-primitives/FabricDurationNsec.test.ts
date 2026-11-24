/**
 * A span of time in nanoseconds as a `FabricPrimitive`: always frozen,
 * wrapping a `bigint`, and encoded to a flat base64 string.
 *
 * Holding a `bigint` rather than a number is the reason the class exists, so
 * the cases reach for magnitudes past where a double stops being exact -- a
 * span of centuries as well as negative ones -- rather than staying near zero,
 * where any representation would look correct.
 *
 * Malformed state decodes to a `ProblematicValue` rather than throwing, and
 * conversion leaves an instance alone even when asked for something mutable.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  FabricInstance,
  FabricPrimitive,
  shallowFabricFromConvertibleJsValue,
} from "@";
import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common";
import { FabricDurationNsec, FabricEpochNsec } from "@/fabric-primitives";

describe("FabricDurationNsec", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).

  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricDurationNsec(0n) instanceof FabricPrimitive).toBe(true);
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    const span = new FabricDurationNsec(0n);
    expect(span instanceof FabricInstance).toBe(false);
  });

  it("is not a `FabricEpochNsec`, even with the same `bigint`", () => {
    expect(new FabricDurationNsec(42n) instanceof FabricEpochNsec).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricDurationNsec(42n))).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricDurationNsec`", () => {
        expect(new FabricDurationNsec(0n).schemaType).toBe(
          "FabricDurationNsec",
        );
      });
    });

    describe(".value", () => {
      it("wraps a `bigint` value", () => {
        const span = new FabricDurationNsec(1_500_000_000n);
        expect(span.value).toBe(1_500_000_000n);
      });

      it("wraps zero", () => {
        const span = new FabricDurationNsec(0n);
        expect(span.value).toBe(0n);
      });

      it("wraps a negative span", () => {
        const span = new FabricDurationNsec(-1_000_000_000n);
        expect(span.value).toBe(-1_000_000_000n);
      });

      it("returns the value it was given for a span past 2^53 nanoseconds", () => {
        // A thousand years, far past where a double counts nanoseconds exactly.
        const nsec = 31_556_952_000_000_000_001n;
        const span = new FabricDurationNsec(nsec);
        expect(span.value).toBe(nsec);
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricDurationNsec[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.DurationNsec;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `DurationNsec` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricDurationNsec`, rejecting other values", () => {
          expect(codec.canEncode(new FabricDurationNsec(0n))).toBe(true);
          expect(codec.canEncode(new FabricEpochNsec(0n))).toBe(false);
          expect(codec.canEncode("not a duration")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a flat base64 string (zero)", () => {
          const span = new FabricDurationNsec(0n);
          // Flat format: base64 string directly, not nested {"/BigInt@1": ...}.
          expect(codec.encode(span, env)).toBe("AA");
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
        it("decodes a flat base64 string (zero)", () => {
          const decoded = codec.decode(
            expectedTag,
            "AA",
            env,
          ) as unknown as FabricDurationNsec;
          expect(decoded).toBeInstanceOf(FabricDurationNsec);
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
        for (
          const [title, nsec] of [
            ["zero", 0n],
            ["one second", 1_000_000_000n],
            ["a negative day", -86_400_000_000_000n],
            ["a thousand years", 31_556_952_000_000_000_001n],
          ] as const
        ) {
          it(`round-trips ${title}`, () => {
            const span = new FabricDurationNsec(nsec);
            const decoded = codec.decode(
              expectedTag,
              codec.encode(span, env),
              env,
            ) as unknown as FabricDurationNsec;
            expect(decoded).toBeInstanceOf(FabricDurationNsec);
            expect(decoded.value).toBe(nsec);
          });
        }
      });
    });
  });

  describe("`shallowFabricFromConvertibleJsValue()` integration", () => {
    // Exercises the free `shallowFabricFromConvertibleJsValue()` rather than a
    // member of the class, so it lives directly under the class `describe()`.

    it("passes through unchanged even with `freeze=false`", () => {
      const span = new FabricDurationNsec(123n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromConvertibleJsValue(span, false)).toBe(span);
    });
  });
});
