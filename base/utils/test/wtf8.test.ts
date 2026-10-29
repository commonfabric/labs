import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { utf8Compare } from "@commonfabric/utils/utf8";
import { encodeWtf8 } from "@commonfabric/utils/wtf8";

/** Renders a string's UTF-16 code units, for a test message. */
function codeUnitsOf(value: string): string {
  return Array.from(
    { length: value.length },
    (_, i) => value.charCodeAt(i).toString(16).padStart(4, "0"),
  ).join(" ");
}

/** Compares two byte arrays lexicographically, as `memcmp()` would. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

describe("encodeWtf8()", () => {
  describe("given a well-formed string", () => {
    const cases: [string, string][] = [
      ["the empty string", ""],
      ["ASCII", "\x00abc\x7f"],
      ["two-byte characters", "\u0080\u07ff"],
      ["three-byte characters", "\u0800\ud7ff\ue000\uffff"],
      ["the replacement character", "\ufffd"],
      ["four-byte characters", "😀a\u{10000}b\u{10ffff}"],
    ];

    for (const [label, value] of cases) {
      it(`returns the UTF-8 encoding of ${label}`, () => {
        expect(encodeWtf8(value)).toEqual(new TextEncoder().encode(value));
      });
    }
  });

  describe("given a string with a lone surrogate", () => {
    it("encodes a lone high surrogate as three bytes", () => {
      expect(encodeWtf8("\ud800")).toEqual(
        Uint8Array.of(0xed, 0xa0, 0x80),
      );
      expect(encodeWtf8("\udbff")).toEqual(
        Uint8Array.of(0xed, 0xaf, 0xbf),
      );
    });

    it("encodes a lone low surrogate as three bytes", () => {
      expect(encodeWtf8("\udc00")).toEqual(
        Uint8Array.of(0xed, 0xb0, 0x80),
      );
      expect(encodeWtf8("\udfff")).toEqual(
        Uint8Array.of(0xed, 0xbf, 0xbf),
      );
    });

    it("encodes the characters around a lone surrogate as UTF-8", () => {
      expect(encodeWtf8("a\ud800\u00e9😀")).toEqual(
        Uint8Array.of(
          0x61,
          0xed,
          0xa0,
          0x80,
          0xc3,
          0xa9,
          0xf0,
          0x9f,
          0x98,
          0x80,
        ),
      );
    });

    it("encodes a low surrogate followed by a high surrogate as two lone surrogates", () => {
      expect(encodeWtf8("\udc00\ud800")).toEqual(
        Uint8Array.of(0xed, 0xb0, 0x80, 0xed, 0xa0, 0x80),
      );
    });

    it("encodes two high surrogates in a row as two lone surrogates", () => {
      expect(encodeWtf8("\ud800\ud800")).toEqual(
        Uint8Array.of(0xed, 0xa0, 0x80, 0xed, 0xa0, 0x80),
      );
    });

    it("encodes a surrogate pair after a lone high surrogate as one character", () => {
      expect(encodeWtf8("\ud800😀")).toEqual(
        Uint8Array.of(0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, 0x80),
      );
    });

    it("returns an exact-sized array", () => {
      const bytes = encodeWtf8("a\ud800");
      expect(bytes.length).toBe(4);
      expect(bytes.buffer.byteLength).toBe(4);

      // Every code unit takes three bytes, which fills the working buffer.
      const full = encodeWtf8("\udc00\ud800");
      expect(full.length).toBe(6);
      expect(full.buffer.byteLength).toBe(6);
    });

    it("returns bytes that differ from those of the replacement character", () => {
      expect(encodeWtf8("\ud800")).not.toEqual(encodeWtf8("\ufffd"));
      expect(encodeWtf8("x\udc00y")).not.toEqual(encodeWtf8("x\ufffdy"));
    });
  });

  it("orders encodings the way `utf8Compare()` orders the strings", () => {
    const strings = [
      "",
      "a",
      "\ud7ff",
      "\ud800",
      "\ud800a",
      "\ud800\ud801",
      "\ud800\udc00",
      "\ud800\ue000",
      "\ud800\ud801\udc00",
      "\udbff",
      "\udc00",
      "\udfff",
      "\ue000",
      "\ufffd",
      "\uffff",
      "😀",
      "\u{10000}",
      "\u{10ffff}",
    ];
    for (const a of strings) {
      for (const b of strings) {
        const expected = Math.sign(utf8Compare(a, b));
        const actual = Math.sign(compareBytes(encodeWtf8(a), encodeWtf8(b)));
        expect(actual, `[${codeUnitsOf(a)}] vs [${codeUnitsOf(b)}]`)
          .toBe(expected);
      }
    }
  });
});
