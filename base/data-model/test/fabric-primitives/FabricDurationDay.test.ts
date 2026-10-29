/**
 * A span of time in days as a `FabricPrimitive`: always frozen, wrapping a
 * `bigint`, and encoded to a flat base64 string.
 *
 * Negative spans are the case worth keeping, a negative count being where an
 * encoding stops round-tripping if it was only ever tried on positive ones. So
 * is a count past where a double stops being exact, since a `bigint` puts no
 * bound on the span.
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
import {
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
} from "@/fabric-primitives";

describe("FabricDurationDay", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).

  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricDurationDay(0n) instanceof FabricPrimitive).toBe(true);
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    const span = new FabricDurationDay(0n);
    expect(span instanceof FabricInstance).toBe(false);
  });

  it("is not a `FabricEpochDay`, even with the same `bigint`", () => {
    expect(new FabricDurationDay(42n) instanceof FabricEpochDay).toBe(false);
  });

  it("is not a `FabricDurationNsec`, even with the same `bigint`", () => {
    expect(new FabricDurationDay(42n) instanceof FabricDurationNsec).toBe(
      false,
    );
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricDurationDay(42n))).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricDurationDay`", () => {
        expect(new FabricDurationDay(0n).schemaType).toBe(
          "FabricDurationDay",
        );
      });
    });

    describe(".value", () => {
      it("wraps a `bigint` value", () => {
        const span = new FabricDurationDay(30n);
        expect(span.value).toBe(30n);
      });

      it("wraps zero", () => {
        const span = new FabricDurationDay(0n);
        expect(span.value).toBe(0n);
      });

      it("wraps a negative span", () => {
        const span = new FabricDurationDay(-7n);
        expect(span.value).toBe(-7n);
      });

      it("returns the value it was given for a span past 2^53 days", () => {
        const days = 9_007_199_254_740_993n;
        const span = new FabricDurationDay(days);
        expect(span.value).toBe(days);
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricDurationDay[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.DurationDay;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `DurationDay` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricDurationDay`, rejecting other values", () => {
          expect(codec.canEncode(new FabricDurationDay(0n))).toBe(true);
          expect(codec.canEncode(new FabricEpochDay(0n))).toBe(false);
          expect(codec.canEncode("not a duration")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a flat base64 string (zero)", () => {
          const span = new FabricDurationDay(0n);
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
          ) as unknown as FabricDurationDay;
          expect(decoded).toBeInstanceOf(FabricDurationDay);
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
          const [title, days] of [
            ["zero", 0n],
            ["one day", 1n],
            ["a negative week", -7n],
            ["a span past 2^53 days", 9_007_199_254_740_993n],
          ] as const
        ) {
          it(`round-trips ${title}`, () => {
            const span = new FabricDurationDay(days);
            const decoded = codec.decode(
              expectedTag,
              codec.encode(span, env),
              env,
            ) as unknown as FabricDurationDay;
            expect(decoded).toBeInstanceOf(FabricDurationDay);
            expect(decoded.value).toBe(days);
          });
        }
      });
    });
  });

  describe("`shallowFabricFromConvertibleJsValue()` integration", () => {
    // Exercises the free `shallowFabricFromConvertibleJsValue()` rather than a
    // member of the class, so it lives directly under the class `describe()`.

    it("passes through unchanged even with `freeze=false`", () => {
      const span = new FabricDurationDay(123n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromConvertibleJsValue(span, false)).toBe(span);
    });
  });
});
