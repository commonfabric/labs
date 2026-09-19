/**
 * `bigint` over a wire that has no such type, encoded as two's-complement
 * bytes in unpadded base64url.
 *
 * Two's complement is what gives the boundary values their weight: a magnitude
 * that would otherwise set the top bit needs a sign-extension byte in front of
 * it, so the round trips step across that point in both signs as well as
 * covering zero and the large cases.
 *
 * Malformed state decodes to a `ProblematicValue` rather than throwing. The
 * wire is not trusted, and a decode that cannot make sense of what it was
 * handed still has to produce a value.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC_TYPE_TAGS,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common/index.ts";
import { BigIntCodec } from "@/codec-json/BigIntCodec.ts";

describe("BigIntCodec", () => {
  const codec = new BigIntCodec();
  const expectedTag = CODEC_TYPE_TAGS.BigInt;
  const env = NULL_LIVE_ENVIRONMENT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `BigInt` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("only claims `bigint` values", () => {
        // `bigint` encodes to `BigInt@1`, whereas `number` does not -- the
        // two produce distinct wire forms.
        expect(codec.canEncode(42n)).toBe(true);
        expect(codec.canEncode(42)).toBe(false);
      });
    });

    describe("encode()", () => {
      it("encodes `42n` to base64url of two's complement bytes", () => {
        // 42n -> [0x2a] -> base64 "Kg"
        expect(codec.encode(42n, env)).toBe("Kg");
      });

      it('encodes `0n` to base64 `"AA"`', () => {
        // 0n -> [0x00] -> base64 "AA"
        expect(codec.encode(0n, env)).toBe("AA");
      });

      it('encodes `-1n` to base64url `"_w"`', () => {
        // -1n -> [0xFF] -> base64url "_w"
        expect(codec.encode(-1n, env)).toBe("_w");
      });

      it('encodes `1n` to base64 `"AQ"`', () => {
        // 1n -> [0x01] -> base64 "AQ"
        expect(codec.encode(1n, env)).toBe("AQ");
      });

      it("encodes `128n` with sign-extension byte", () => {
        // 128n -> [0x00, 0x80] -> base64 "AIA"
        expect(codec.encode(128n, env)).toBe("AIA");
      });

      it("produces unpadded base64 output (no trailing `=`)", () => {
        // 42n produces 1 byte -> 2 base64 chars (would be "Kg==" with padding)
        const b64 = codec.encode(42n, env) as string;
        expect(b64).toBe("Kg");
        expect(b64).not.toContain("=");
      });
    });

    describe("canDecode()", () => {
      it("returns `true` for string state", () => {
        expect(codec.canDecode("Kg")).toBe(true);
      });

      it("returns `false` for state that is not a string", () => {
        expect(codec.canDecode(42)).toBe(false);
        expect(codec.canDecode(null)).toBe(false);
        expect(codec.canDecode({ bad: true })).toBe(false);
      });

      it("returns `true` for a string that is not valid base64", () => {
        // Validity of the contents is `decode()`'s question, that being the
        // same work as the decoding.
        expect(codec.canDecode("")).toBe(true);
      });
    });

    describe("decode()", () => {
      it("decodes unpadded base64url input", () => {
        // "Kg" is the standard unpadded base64url encoding of 42n.
        const result = codec.decode(expectedTag, "Kg", env);
        expect(result).toBe(42n);
      });

      it("decodes padded base64 input", () => {
        // "Kg==" is the padded form of "Kg" (42n) -- padding is accepted by the
        // web-standard Uint8Array.fromBase64.
        const result = codec.decode(expectedTag, "Kg==", env);
        expect(result).toBe(42n);
      });

      it("decodes empty base64 string to `ProblematicValue`", () => {
        const result = codec.decode(expectedTag, "", env);
        expect(result).toBeInstanceOf(ProblematicValue);
        const prob = result as unknown as ProblematicValue;
        expect(prob.wireTypeTag).toBe("BigInt@1");
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips at top level", () => {
        const decoded = codec.decode(expectedTag, codec.encode(42n, env), env);
        expect(decoded).toBe(42n);
      });

      it("round-trips a negative `bigint`", () => {
        const decoded = codec.decode(
          expectedTag,
          codec.encode(-999n, env),
          env,
        );
        expect(decoded).toBe(-999n);
      });

      it("round-trips a zero `bigint`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(0n, env), env);
        expect(decoded).toBe(0n);
      });

      it("round-trips `1n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(1n, env), env);
        expect(decoded).toBe(1n);
      });

      it("round-trips `-1n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(-1n, env), env);
        expect(decoded).toBe(-1n);
      });

      it("round-trips a large `bigint`", () => {
        const big = 2n ** 64n;
        const decoded = codec.decode(expectedTag, codec.encode(big, env), env);
        expect(decoded).toBe(big);
      });

      it("round-trips a large negative `bigint`", () => {
        const big = -(2n ** 64n);
        const decoded = codec.decode(expectedTag, codec.encode(big, env), env);
        expect(decoded).toBe(big);
      });

      it("round-trips boundary value `127n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(127n, env), env);
        expect(decoded).toBe(127n);
      });

      it("round-trips boundary value `128n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(128n, env), env);
        expect(decoded).toBe(128n);
      });

      it("round-trips boundary value `-128n`", () => {
        const decoded = codec.decode(
          expectedTag,
          codec.encode(-128n, env),
          env,
        );
        expect(decoded).toBe(-128n);
      });

      it("round-trips boundary value `-129n`", () => {
        const decoded = codec.decode(
          expectedTag,
          codec.encode(-129n, env),
          env,
        );
        expect(decoded).toBe(-129n);
      });
    });
  });
});
