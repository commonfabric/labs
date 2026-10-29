import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  decodeSLEB128,
  decodeULEB128,
  encodeSLEB128,
  encodeULEB128,
} from "@/index.ts";

describe("leb128", () => {
  describe("encodeULEB128()", () => {
    it("encodes `0`", () => {
      expect(encodeULEB128(0)).toEqual(new Uint8Array([0x00]));
    });

    it("encodes `1`", () => {
      expect(encodeULEB128(1)).toEqual(new Uint8Array([0x01]));
    });

    it("encodes `127` (max single byte)", () => {
      expect(encodeULEB128(127)).toEqual(new Uint8Array([0x7f]));
    });

    it("encodes `128` (first two-byte value)", () => {
      expect(encodeULEB128(128)).toEqual(new Uint8Array([0x80, 0x01]));
    });

    it("encodes `624485` (Wikipedia example)", () => {
      // 624485 = 0x98765 -> LEB128: [0xe5, 0x8e, 0x26]
      expect(encodeULEB128(624485)).toEqual(new Uint8Array([0xe5, 0x8e, 0x26]));
    });

    it("encodes `255`", () => {
      expect(encodeULEB128(255)).toEqual(new Uint8Array([0xff, 0x01]));
    });

    it("encodes `16383` (max two-byte value)", () => {
      expect(encodeULEB128(16383)).toEqual(new Uint8Array([0xff, 0x7f]));
    });

    it("encodes `16384` (first three-byte value)", () => {
      expect(encodeULEB128(16384)).toEqual(new Uint8Array([0x80, 0x80, 0x01]));
    });

    it("encodes `0xffffffff` (max 32-bit unsigned)", () => {
      expect(encodeULEB128(0xffffffff)).toEqual(
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]),
      );
    });

    it("throws on a negative value", () => {
      expect(() => encodeULEB128(-1)).toThrow("non-negative");
    });

    it("throws on a non-integer value", () => {
      expect(() => encodeULEB128(1.5)).toThrow("non-negative integer");
    });

    it("throws on a value exceeding the 32-bit range", () => {
      expect(() => encodeULEB128(0x100000000)).toThrow("exceeds 32-bit range");
    });

    it("throws on a value beyond the safe-integer range", () => {
      expect(() => encodeULEB128(Number.MAX_SAFE_INTEGER)).toThrow(
        "exceeds 32-bit range",
      );
    });
  });

  describe("decodeULEB128()", () => {
    it("decodes `0`", () => {
      expect(decodeULEB128(new Uint8Array([0x00]))).toEqual({
        value: 0,
        nextIndex: 1,
      });
    });

    it("decodes `127`", () => {
      expect(decodeULEB128(new Uint8Array([0x7f]))).toEqual({
        value: 127,
        nextIndex: 1,
      });
    });

    it("decodes `128`", () => {
      expect(decodeULEB128(new Uint8Array([0x80, 0x01]))).toEqual({
        value: 128,
        nextIndex: 2,
      });
    });

    it("decodes `624485` (Wikipedia example)", () => {
      expect(decodeULEB128(new Uint8Array([0xe5, 0x8e, 0x26]))).toEqual({
        value: 624485,
        nextIndex: 3,
      });
    });

    it("decodes starting at a given offset", () => {
      // Prefix bytes [0xff, 0xff], then encoded 128 = [0x80, 0x01].
      expect(decodeULEB128(new Uint8Array([0xff, 0xff, 0x80, 0x01]), 2))
        .toEqual({ value: 128, nextIndex: 4 });
    });

    it("decodes `0xffffffff` (max 32-bit unsigned)", () => {
      expect(decodeULEB128(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f])))
        .toEqual({ value: 0xffffffff, nextIndex: 5 });
    });

    it("throws on truncated input", () => {
      expect(() => decodeULEB128(new Uint8Array([0x80]))).toThrow(
        "unexpected end",
      );
    });

    it("throws when the 5th byte overflows the 32-bit range", () => {
      // 5th byte at shift=28 with payload 0x10 (16) would need 33 bits.
      expect(() =>
        decodeULEB128(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10]))
      )
        .toThrow("exceeds 32-bit range");
    });

    it("throws when continuation runs past the 32-bit range", () => {
      // 6 continuation bytes = shift reaches 35, which exceeds 32 bits.
      expect(() =>
        decodeULEB128(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))
      ).toThrow("exceeds 32-bit range");
    });

    describe("round-tripping", () => {
      const values = [
        0,
        1,
        5,
        63,
        64,
        127,
        128,
        255,
        256,
        16383,
        16384,
        65535,
        0xffffffff,
      ];
      for (const v of values) {
        it(`recovers \`${v}\``, () => {
          const encoded = encodeULEB128(v);
          const decoded = decodeULEB128(encoded);
          expect(decoded.value).toBe(v);
          expect(decoded.nextIndex).toBe(encoded.length);
        });
      }
    });
  });

  describe("encodeSLEB128()", () => {
    it("encodes `0`", () => {
      expect(encodeSLEB128(0)).toEqual(new Uint8Array([0x00]));
    });

    it("encodes `-1`", () => {
      expect(encodeSLEB128(-1)).toEqual(new Uint8Array([0x7f]));
    });

    it("encodes `1`", () => {
      expect(encodeSLEB128(1)).toEqual(new Uint8Array([0x01]));
    });

    it("encodes `63` (max positive single byte)", () => {
      expect(encodeSLEB128(63)).toEqual(new Uint8Array([0x3f]));
    });

    it("encodes `64` (first positive two-byte)", () => {
      expect(encodeSLEB128(64)).toEqual(new Uint8Array([0xc0, 0x00]));
    });

    it("encodes `-64` (min negative single byte)", () => {
      expect(encodeSLEB128(-64)).toEqual(new Uint8Array([0x40]));
    });

    it("encodes `-65` (first negative two-byte)", () => {
      expect(encodeSLEB128(-65)).toEqual(new Uint8Array([0xbf, 0x7f]));
    });

    it("encodes `-123456` (Wikipedia example)", () => {
      // -123456 -> signed LEB128: [0xc0, 0xbb, 0x78]
      expect(encodeSLEB128(-123456)).toEqual(
        new Uint8Array([0xc0, 0xbb, 0x78]),
      );
    });

    it("throws on a value exceeding the signed 32-bit max", () => {
      expect(() => encodeSLEB128(0x80000000)).toThrow(
        "exceeds signed 32-bit range",
      );
    });

    it("throws on a value below the signed 32-bit min", () => {
      expect(() => encodeSLEB128(-0x80000001)).toThrow(
        "exceeds signed 32-bit range",
      );
    });
  });

  describe("decodeSLEB128()", () => {
    it("decodes `0`", () => {
      expect(decodeSLEB128(new Uint8Array([0x00]))).toEqual({
        value: 0,
        nextIndex: 1,
      });
    });

    it("decodes `-1`", () => {
      expect(decodeSLEB128(new Uint8Array([0x7f]))).toEqual({
        value: -1,
        nextIndex: 1,
      });
    });

    it("decodes `63`", () => {
      expect(decodeSLEB128(new Uint8Array([0x3f]))).toEqual({
        value: 63,
        nextIndex: 1,
      });
    });

    it("decodes `-64`", () => {
      expect(decodeSLEB128(new Uint8Array([0x40]))).toEqual({
        value: -64,
        nextIndex: 1,
      });
    });

    it("decodes `-123456` (Wikipedia example)", () => {
      expect(decodeSLEB128(new Uint8Array([0xc0, 0xbb, 0x78]))).toEqual({
        value: -123456,
        nextIndex: 3,
      });
    });

    it("throws on truncated input", () => {
      expect(() => decodeSLEB128(new Uint8Array([0x80]))).toThrow(
        "unexpected end",
      );
    });

    describe("round-tripping", () => {
      const values = [
        0,
        1,
        -1,
        63,
        64,
        -64,
        -65,
        127,
        128,
        -128,
        -129,
        1000,
        -1000,
      ];
      for (const v of values) {
        it(`recovers \`${v}\``, () => {
          const encoded = encodeSLEB128(v);
          const decoded = decodeSLEB128(encoded);
          expect(decoded.value).toBe(v);
          expect(decoded.nextIndex).toBe(encoded.length);
        });
      }
    });
  });
});
