/**
 * A nanosecond timestamp as a `FabricPrimitive`: always frozen, wrapping a
 * `bigint`, and encoded to a flat base64 string.
 *
 * Holding a `bigint` rather than a number is the reason the class exists, so
 * the cases reach for magnitudes past where a double stops being exact -- a
 * far-future timestamp as well as pre-epoch ones -- rather than staying near
 * zero, where any representation would look correct.
 *
 * Malformed state decodes to a `ProblematicValue` rather than throwing, and
 * conversion leaves an instance alone even when asked for something mutable.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common/index.ts";
import { FabricEpochNsec } from "@/fabric-primitives/index.ts";
import {
  FabricInstance,
  FabricPrimitive,
  shallowFabricFromConvertibleJsValue,
} from "@/index.ts";

describe("FabricEpochNsec", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).

  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricEpochNsec(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    const sn = new FabricEpochNsec(0n);
    expect(sn instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricEpochNsec(42n))).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricEpochNsec`", () => {
        expect(new FabricEpochNsec(0n).schemaType).toBe("FabricEpochNsec");
      });
    });

    describe(".value", () => {
      it("wraps a `bigint` value", () => {
        const sn = new FabricEpochNsec(1234567890000000000n);
        expect(sn.value).toBe(1234567890000000000n);
      });

      it("wraps zero", () => {
        const sn = new FabricEpochNsec(0n);
        expect(sn.value).toBe(0n);
      });

      it("wraps negative values (pre-epoch)", () => {
        const sn = new FabricEpochNsec(-1000000000n);
        expect(sn.value).toBe(-1000000000n);
      });

      it("returns the value it was given for a year-3000 timestamp", () => {
        const nsec = 32503680000000000000n;
        const sn = new FabricEpochNsec(nsec);
        expect(sn.value).toBe(nsec);
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricEpochNsec[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.EpochNsec;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `EpochNsec` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricEpochNsec`, rejecting other values", () => {
          expect(codec.canEncode(new FabricEpochNsec(0n))).toBe(true);
          expect(codec.canEncode("not an epoch")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a flat base64 string (epoch zero)", () => {
          const sn = new FabricEpochNsec(0n);
          // Flat format: base64 string directly, not nested {"/BigInt@1": ...}.
          expect(codec.encode(sn, env)).toBe("AA");
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
          ) as unknown as FabricEpochNsec;
          expect(decoded).toBeInstanceOf(FabricEpochNsec);
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
          const sn = new FabricEpochNsec(0n);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn, env),
            env,
          ) as unknown as FabricEpochNsec;
          expect(decoded).toBeInstanceOf(FabricEpochNsec);
          expect(decoded.value).toBe(0n);
        });

        it("round-trips positive nanosecond timestamp", () => {
          // 2024-01-01T00:00:00Z is 1704067200 seconds, so
          // 1704067200000000000 nsec.
          const nsec = 1704067200000000000n;
          const sn = new FabricEpochNsec(nsec);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn, env),
            env,
          ) as unknown as FabricEpochNsec;
          expect(decoded).toBeInstanceOf(FabricEpochNsec);
          expect(decoded.value).toBe(nsec);
        });

        it("round-trips negative nanosecond timestamp (pre-epoch)", () => {
          const nsec = -86400000000000n; // -1 day in nanoseconds
          const sn = new FabricEpochNsec(nsec);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn, env),
            env,
          ) as unknown as FabricEpochNsec;
          expect(decoded).toBeInstanceOf(FabricEpochNsec);
          expect(decoded.value).toBe(nsec);
        });

        it("round-trips large future date", () => {
          // Year 3000-ish
          const nsec = 32503680000000000000n;
          const sn = new FabricEpochNsec(nsec);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn, env),
            env,
          ) as unknown as FabricEpochNsec;
          expect(decoded.value).toBe(nsec);
        });
      });
    });
  });

  describe("`shallowFabricFromConvertibleJsValue()` integration", () => {
    // Exercises the free `shallowFabricFromConvertibleJsValue()` rather than a
    // member of the class, so it lives directly under the class `describe()`.

    it("passes through unchanged even with `freeze=false`", () => {
      const nsec = new FabricEpochNsec(123n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromConvertibleJsValue(nsec, false)).toBe(nsec);
    });
  });
});
