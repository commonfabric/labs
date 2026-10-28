import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fromBase64Polyfill,
  fromBase64url,
  toBase64Polyfill,
  toUnpaddedBase64url,
  toUnpaddedBase64urlFromText,
} from "@commonfabric/utils/base64url";

const TEST_PAIRS: { arr: readonly number[]; b64: string }[] = [
  { arr: [], b64: "" },
  { arr: [0x00], b64: "AA" },
  { arr: [0xff], b64: "_w" },
  { arr: [0x12, 0x34], b64: "EjQ" },
  { arr: [0x98, 0x76, 0x54], b64: "mHZU" },
  { arr: [0x0a, 0x2b, 0x4c, 0x5d], b64: "CitMXQ" },
] as const;

function arrayString(arr: readonly number[]): string {
  const result: string[] = ["["];
  let first = true;
  for (const elem of arr) {
    if (first) {
      first = false;
    } else {
      result.push(", ");
    }
    if (elem < 0x10) {
      result.push("0");
    }
    result.push(elem.toString(16));
  }
  result.push("]");
  return result.join("");
}

for (const toBase64 of [toUnpaddedBase64url, toBase64Polyfill]) {
  describe(`${toBase64.name}()`, () => {
    for (const { arr, b64 } of TEST_PAIRS) {
      const arrStr = arrayString(arr);
      it(`encodes ${arrStr} to \`${b64}\``, () => {
        expect(toBase64(new Uint8Array(arr))).toBe(b64);
      });
    }
  });
}

for (const fromBase64 of [fromBase64url, fromBase64Polyfill]) {
  describe(`${fromBase64.name}()`, () => {
    for (const { arr, b64 } of TEST_PAIRS) {
      const arrStr = arrayString(arr);
      const paddingCount = 2 - ((arr.length + 2) % 3);
      const paddedStr = `${b64}${"=".repeat(paddingCount)}`;
      it(`decodes \`${b64}\` to ${arrStr}`, () => {
        expect(fromBase64(b64)).toEqual(new Uint8Array(arr));
      });
      if (paddedStr !== b64) {
        it(`decodes \`${paddedStr}\` to ${arrStr}`, () => {
          expect(fromBase64(paddedStr)).toEqual(new Uint8Array(arr));
        });
      }
    }

    describe("whitespace", () => {
      // ASCII whitespace, which `Uint8Array.fromBase64()` would skip.

      const WHITESPACE: readonly (readonly [string, string])[] = [
        ["a space", " "],
        ["a tab", "\t"],
        ["a line feed", "\n"],
        ["a form feed", "\f"],
        ["a carriage return", "\r"],
      ];

      for (const [label, ws] of WHITESPACE) {
        it(`throws on ${label} inside the text`, () => {
          expect(() => fromBase64(`AQ${ws}I`)).toThrow();
        });
      }

      it("throws on whitespace after the text", () => {
        expect(() => fromBase64("AQI ")).toThrow();
      });
    });

    describe("padding", () => {
      // Exactly RFC 4648's (section 3.2): two `=` after a final group of two
      // characters, one after a final group of three, and none after whole
      // groups. The accepted forms are the padded cases above.

      const REFUSED: readonly string[] = [
        "=",
        "==",
        "AA=",
        "AQ=",
        "AQ===",
        "AAA==",
        "AQI==",
        "AAAA=",
        "AQID=",
        "AAAA====",
        "A=Q=",
      ];

      for (const encoded of REFUSED) {
        it(`throws on \`${encoded}\``, () => {
          expect(() => fromBase64(encoded)).toThrow();
        });
      }
    });

    describe("a final group of one character", () => {
      // Six bits, which hold no whole byte.

      for (const encoded of ["A", "AAAAA", "A==", "A==="]) {
        it(`throws on \`${encoded}\``, () => {
          expect(() => fromBase64(encoded)).toThrow();
        });
      }
    });

    describe("bits past the last whole byte", () => {
      // A final group of two characters carries four bits past its byte, and
      // one of three carries two. Each case sets one of them.

      const NONZERO: readonly string[] = ["AR", "AS", "AU", "AY", "AQJ", "AQK"];

      for (const encoded of NONZERO) {
        it(`throws on \`${encoded}\`, which sets one of them`, () => {
          expect(() => fromBase64(encoded)).toThrow(
            "nonzero bits past the last whole byte",
          );
        });
      }

      it("throws on one of them set under padding", () => {
        expect(() => fromBase64("AR==")).toThrow(
          "nonzero bits past the last whole byte",
        );
      });

      it("throws on one of them set after whole groups", () => {
        expect(() => fromBase64("AQIDBR")).toThrow(
          "nonzero bits past the last whole byte",
        );
      });

      it("decodes text whose bits past the last whole byte are all zero", () => {
        expect(fromBase64("AQIDBA")).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(fromBase64("AQIDBAU")).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      });
    });
  });
}

describe("toUnpaddedBase64urlFromText()", () => {
  const textEncoder = new TextEncoder();

  // The scratch buffer inside the function holds 4096 bytes, so these cases
  // land on both sides of it: text that fits, text that is too long to fit,
  // and text short enough to try but with characters too wide to fit.
  const CASES: readonly (readonly [string, string])[] = [
    ["empty text", ""],
    ["one character", "x"],
    ["encoded JSON text", `fvj1:{"value":42}`],
    ["a length that is not a multiple of three", "abcd"],
    ["two-byte characters", "Ñoño"],
    ["three-byte characters", "你好世界"],
    ["an astral-plane character", "🚀"],
    ["an unpaired surrogate", "a\ud800b"],
    ["text exactly filling the buffer", "x".repeat(4096)],
    ["text one character too long for the buffer", "x".repeat(4097)],
    ["text short enough but too wide for the buffer", "é".repeat(4096)],
  ] as const;

  for (const [label, text] of CASES) {
    it(`gives the same answer as encoding to bytes first, for ${label}`, () => {
      expect(toUnpaddedBase64urlFromText(text)).toBe(
        toUnpaddedBase64url(textEncoder.encode(text)),
      );
    });
  }

  it("leaves no trace of one call in the next", () => {
    const long = toUnpaddedBase64urlFromText("z".repeat(400));
    const short = toUnpaddedBase64urlFromText("z");
    expect(short).toBe(toUnpaddedBase64url(textEncoder.encode("z")));
    expect(long).toBe(toUnpaddedBase64url(textEncoder.encode("z".repeat(400))));
  });
});

describe("base64url round-trip", () => {
  it("round-trips various byte arrays", () => {
    const testArrays = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      new Uint8Array([0x00, 0x80]),
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]),
      new Uint8Array(256).map((_, i) => i),
    ];

    for (const bytes of testArrays) {
      const b64 = toUnpaddedBase64url(bytes);
      const decoded = fromBase64url(b64);
      expect(decoded).toEqual(bytes);
    }
  });
});
