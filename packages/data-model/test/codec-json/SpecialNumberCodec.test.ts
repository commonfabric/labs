/**
 * The numeric values JSON cannot carry -- negative zero, `NaN`, and the two
 * infinities -- written as literal strings.
 *
 * Round-tripping them is the point, and the sign of zero is what makes that
 * more than a formality: `-0` has to come back as `-0` rather than as `0`,
 * which ordinary equality would not notice either way. Every `NaN` bit pattern
 * encodes to the same literal, the distinctions among them not being ones this
 * format carries.
 *
 * A state that is not a recognized literal decodes to a `ProblematicValue`
 * rather than throwing.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC_TYPE_TAGS,
  NULL_LIVE_ENVIRONMENT,
} from "@/codec-common/index.ts";
import { SpecialNumberCodec } from "@/codec-json/SpecialNumberCodec.ts";

describe("SpecialNumberCodec", () => {
  const codec = new SpecialNumberCodec();
  const expectedTag = CODEC_TYPE_TAGS.SpecialNumber;
  const env = NULL_LIVE_ENVIRONMENT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `SpecialNumber` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("claims the four special numeric values, rejects ordinary ones", () => {
        expect(codec.canEncode(-0)).toBe(true);
        expect(codec.canEncode(NaN)).toBe(true);
        expect(codec.canEncode(Infinity)).toBe(true);
        expect(codec.canEncode(-Infinity)).toBe(true);
        // Ordinary finite numbers (and `+0`) are not claimed.
        expect(codec.canEncode(42)).toBe(false);
        expect(codec.canEncode(0)).toBe(false);
      });
    });

    describe("encode()", () => {
      it('encodes `-0` to the literal `"-0"`', () => {
        expect(codec.encode(-0, env)).toBe("-0");
      });

      it('encodes `NaN` to the literal `"NaN"`', () => {
        expect(codec.encode(NaN, env)).toBe("NaN");
      });

      it('encodes `+Infinity` to the literal `"+Infinity"`', () => {
        expect(codec.encode(Infinity, env)).toBe("+Infinity");
      });

      it('encodes `-Infinity` to the literal `"-Infinity"`', () => {
        expect(codec.encode(-Infinity, env)).toBe("-Infinity");
      });

      it('any `NaN` bit pattern encodes as the literal `"NaN"`', () => {
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, 0x7ff8000000000001n, false);
        const nonCanonicalNaN = view.getFloat64(0, false);
        expect(Number.isNaN(nonCanonicalNaN)).toBe(true);
        expect(codec.encode(nonCanonicalNaN, env)).toBe("NaN");
      });
    });

    describe("canDecode()", () => {
      it("returns `true` for each of the four literals", () => {
        for (const literal of ["-0", "+Infinity", "-Infinity", "NaN"]) {
          expect(codec.canDecode(literal)).toBe(true);
        }
      });

      it("returns `false` for state that is not a string", () => {
        expect(codec.canDecode(0)).toBe(false);
      });

      it("returns `false` for a string that is not one of the literals", () => {
        // "Infinity" (missing leading +) is not a recognized literal.
        expect(codec.canDecode("Infinity")).toBe(false);
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips `-0` (preserves sign of zero)", () => {
        const result = codec.decode(expectedTag, codec.encode(-0, env), env);
        expect(Object.is(result, -0)).toBe(true);
      });

      it("round-trips `NaN`", () => {
        const result = codec.decode(expectedTag, codec.encode(NaN, env), env);
        expect(Number.isNaN(result)).toBe(true);
      });

      it("round-trips `+Infinity`", () => {
        const result = codec.decode(
          expectedTag,
          codec.encode(Infinity, env),
          env,
        );
        expect(result).toBe(Infinity);
      });

      it("round-trips `-Infinity`", () => {
        const result = codec.decode(
          expectedTag,
          codec.encode(-Infinity, env),
          env,
        );
        expect(result).toBe(-Infinity);
      });
    });
  });
});
