import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import {
  bigintFromMinimalTwosComplement,
  bigintFromUnpaddedBase64url,
  bigintToMinimalTwosComplement,
  bigintToUnpaddedBase64url,
} from "@commonfabric/bytes/bigint";

import {
  bigintFromMtcDirect,
  bigintToMtcDirect,
} from "../src/bigint-uint8-direct.ts";
import {
  bigintFromMtcHex,
  bigintToMtcHex,
} from "../src/bigint-uint8-hex-string.ts";

//
// Reference encoder
//

/**
 * Deliberately-naive minimal two's-complement encoder, used as the test
 * oracle. Optimized for obviousness rather than speed: derive the byte
 * length from the magnitude's binary representation, apply two's complement
 * via plain bigint arithmetic, then materialize bytes through `toString(16)`
 * plus `parseInt`.
 */
function referenceEncode(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0]);

  const abs = value < 0n ? -value : value;
  const magBits = abs.toString(2).length;

  // For positive `v`, the encoding needs `magBits + 1` bits (extra leading
  // 0 for the sign). For negative `v`, the same holds, except the boundary
  // value `-(2^(magBits-1))` (a power of two) fits in exactly `magBits`
  // bits because its high bit doubles as the sign bit.
  let totalBits: number;
  if (value > 0n) {
    totalBits = magBits + 1;
  } else if ((1n << BigInt(magBits - 1)) === abs) {
    totalBits = magBits;
  } else {
    totalBits = magBits + 1;
  }
  const byteLen = (totalBits + 7) >> 3;

  // Map negatives onto their unsigned two's-complement representation.
  const unsigned = value < 0n ? value + (1n << BigInt(byteLen * 8)) : value;

  // Hex pad to even, then parse byte-by-byte.
  let hex = unsigned.toString(16);
  while (hex.length < byteLen * 2) hex = "0" + hex;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

//
// Fixtures, and the check that pins the oracle
//
// Both fixture sets — the main ones the per-function loops consume, and the
// hand-written reference bytes — and then the block that pins
// `referenceEncode()` against those bytes.
//

interface Fixture {
  value: bigint;
  encoded: Uint8Array;
  label: string;
}

const rawFixtures: Set<bigint> = new Set();

{
  // Full range of small numbers.
  for (let i = -0x100n; i <= 0x100n; i++) {
    rawFixtures.add(i);
  }

  // Many nines, decimal edition!
  for (let i = 999n; i < (1n << 200n); i = (i * 10n) + 9n) {
    rawFixtures.add(i);
    rawFixtures.add(-i);
  }

  // Many nines, hex edition!
  for (let i = 0x999n; i < (1n << 200n); i = (i << 4n) + 0x09n) {
    rawFixtures.add(i);
    rawFixtures.add(-i);
  }

  // Potential sign-bit confusion edge cases.
  for (let i = 0n; i <= 256n; i++) {
    rawFixtures.add(0x01n << i);
    rawFixtures.add(0x7en << i);
    rawFixtures.add(0x7fn << i);
    rawFixtures.add(0x80n << i);
    rawFixtures.add(0x81n << i);
    rawFixtures.add(-0x01n << i);
    rawFixtures.add(-0x7en << i);
    rawFixtures.add(-0x7fn << i);
    rawFixtures.add(-0x80n << i);
    rawFixtures.add(-0x81n << i);
  }

  // Programmatic expansion via a deterministic recurrence. The multiplier `99`
  // adds ~6.63 bits per step, so 2000 iterations sweep magnitudes from a few
  // bits up to roughly 13_270 bits (~1659 bytes), with both signs at every
  // step.
  let n = 123n;
  for (let i = 0; i < 2000; i++) {
    n = (n * 99n) + 9876n;
    rawFixtures.add(n);
    rawFixtures.add(-n);
  }
}

/**
 * Formats a `bigint` for use in a test name. Decimals up to 64 bits, hex up to
 * 128 bits, and beyond that just a hex prefix and the encoded byte count.
 */
function fixtureLabel(v: bigint, encoded: Uint8Array): string {
  if (v === 0n) return "0n";
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  if (abs < 1n << 64n) return `${v}n`;
  const hex = abs.toString(16);
  if (hex.length <= 32) return `${sign}0x${hex}n`;
  return `${sign}0x${hex.slice(0, 12)}... (${encoded.length} bytes)`;
}

/** Makes a fixture, optionally calculating the encoded form. */
function makeFixture(value: bigint, preEncoded?: number[]): Fixture {
  let encoded: Uint8Array;

  if (preEncoded) {
    encoded = new Uint8Array(preEncoded);
  } else {
    encoded = referenceEncode(value);
  }

  return { value, encoded, label: fixtureLabel(value, encoded) };
}

const fixtures: readonly Fixture[] = [...rawFixtures].sort().map((value) =>
  makeFixture(value)
);

// These don't use `referenceEncode()` because these are what's used to test the
// _integrity_ of `referenceEncode()`.
const referenceFixtures: readonly Fixture[] = [
  makeFixture(-129n, [0xff, 0x7f]),
  makeFixture(-128n, [0x80]),
  makeFixture(-1n, [0xff]),
  makeFixture(0n, [0x00]),
  makeFixture(1n, [0x01]),
  makeFixture(127n, [0x7f]),
  makeFixture(255n, [0x00, 0xff]),
  makeFixture(1n << 1n, [0x02]),
  makeFixture(1n << 2n, [0x04]),
  makeFixture(1n << 3n, [0x08]),
  makeFixture(1n << 4n, [0x10]),
  makeFixture(1n << 5n, [0x20]),
  makeFixture(1n << 6n, [0x40]),
  makeFixture(1n << 7n, [0x00, 0x80]),
  makeFixture(1n << 8n, [0x01, 0x00]),
  makeFixture(1n << 9n, [0x02, 0x00]),
  makeFixture(1n << 10n, [0x04, 0x00]),
  makeFixture(1n << 11n, [0x08, 0x00]),
  makeFixture(1n << 12n, [0x10, 0x00]),
  makeFixture(1n << 13n, [0x20, 0x00]),
  makeFixture(1n << 14n, [0x40, 0x00]),
  makeFixture(1n << 15n, [0x00, 0x80, 0x00]),
  makeFixture(1n << 16n, [0x01, 0x00, 0x00]),
  makeFixture(1n << 17n, [0x02, 0x00, 0x00]),
  makeFixture(1n << 63n, [
    0x00,
    0x80,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]),
  makeFixture(1n << 64n, [
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]),
  makeFixture(
    0x0123_4567_89ab_cdef_0987_6543_21fe_dcban,
    [
      0x01,
      0x23,
      0x45,
      0x67,
      0x89,
      0xab,
      0xcd,
      0xef,
      0x09,
      0x87,
      0x65,
      0x43,
      0x21,
      0xfe,
      0xdc,
      0xba,
    ],
  ),
];

describe("`referenceEncode()` (test oracle)", () => {
  it("encodes all reference fixtures as expected", () => {
    // A small set of explicit byte-level assertions that pin `referenceEncode`
    // against the spec. The rest of the suite trusts it as an oracle, so it
    // matters that these can't both be wrong in the same way.

    for (const { value, encoded, label } of referenceFixtures) {
      try {
        expect(referenceEncode(value)).toEqual(new Uint8Array(encoded));
      } catch (e) {
        throw new Error(`Failed on ${label}.`, { cause: e });
      }
    }
  });
});

//
// Per-function fixture loops
//

for (
  const { biToMtc, biFromMtc, full } of [
    {
      biToMtc: bigintToMinimalTwosComplement,
      biFromMtc: bigintFromMinimalTwosComplement,
      full: false,
    },
    { biToMtc: bigintToMtcDirect, biFromMtc: bigintFromMtcDirect, full: true },
    { biToMtc: bigintToMtcHex, biFromMtc: bigintFromMtcHex, full: true },
  ]
) {
  const FIXTURE_SLICE_SIZE = 1000;
  for (let at = 0; at < fixtures.length; at += FIXTURE_SLICE_SIZE) {
    const slice = full
      ? fixtures.slice(at, at + FIXTURE_SLICE_SIZE)
      : fixtures.slice(at, at + 5);
    const sliceLabel = `fixtures ${at}..${at + slice.length - 1}`;

    describe(`${biToMtc.name}()`, () => {
      it(`encodes ${sliceLabel}`, () => {
        for (let i = 0; i < slice.length; i++) {
          const { value, encoded, label } = slice[i]!;
          try {
            expect(biToMtc(value)).toEqual(encoded);
          } catch (e) {
            throw new Error(`Failed on ${label}.`, { cause: e });
          }
        }
      });
    });

    describe(`${biFromMtc.name}()`, () => {
      it(`decodes ${sliceLabel}`, () => {
        for (let i = 0; i < slice.length; i++) {
          const { value, encoded, label } = slice[i]!;
          try {
            expect(biFromMtc(encoded)).toBe(value);
          } catch (e) {
            throw new Error(`Failed on ${label}.`, { cause: e });
          }
        }
      });
    });

    describe(
      `\`${biToMtc.name}()\` -> \`${biFromMtc.name}()\` round trip ` +
        `through base64url`,
      () => {
        it(`round-trips ${sliceLabel}`, () => {
          for (let i = 0; i < slice.length; i++) {
            const { value, label } = slice[i]!;
            const bytes = biToMtc(value);
            const b64 = toUnpaddedBase64url(bytes);
            const decodedBytes = fromBase64url(b64);
            try {
              expect(biFromMtc(decodedBytes)).toBe(value);
            } catch (e) {
              throw new Error(`Failed on ${label}.`, { cause: e });
            }
          }
        });
      },
    );
  }

  //
  // Edge cases
  //

  describe(`${biFromMtc.name}()`, () => {
    it("throws on empty input", () => {
      expect(() => biFromMtc(new Uint8Array([]))).toThrow(
        "empty input",
      );
    });
  });
}

//
// The base64url-string convenience pair
//

/**
 * Fixtures for the base64url convenience functions. The strings are written
 * out directly, so that neither `toUnpaddedBase64url()` nor the reference
 * encoder above is trusted to produce them.
 */
const base64urlFixtures: readonly { value: bigint; encoded: string }[] = [
  { value: 0n, encoded: "AA" },
  { value: 1n, encoded: "AQ" },
  { value: -1n, encoded: "_w" },
  { value: 42n, encoded: "Kg" },
  { value: 127n, encoded: "fw" },
  { value: 128n, encoded: "AIA" },
  { value: -128n, encoded: "gA" },
  { value: -129n, encoded: "_38" },
  { value: 255n, encoded: "AP8" },
  { value: 256n, encoded: "AQA" },
  { value: -256n, encoded: "_wA" },
  { value: 0x0123_4567_89ab_cdefn, encoded: "ASNFZ4mrze8" },
];

describe("bigintToUnpaddedBase64url()", () => {
  it("encodes all base64url fixtures as expected", () => {
    for (const { value, encoded } of base64urlFixtures) {
      try {
        expect(bigintToUnpaddedBase64url(value)).toBe(encoded);
      } catch (e) {
        throw new Error(`Failed on ${value}n.`, { cause: e });
      }
    }
  });

  it("encodes all fixtures as the reference encoding does, in base64url", () => {
    for (const { value, encoded, label } of fixtures) {
      try {
        expect(bigintToUnpaddedBase64url(value))
          .toBe(toUnpaddedBase64url(encoded));
      } catch (e) {
        throw new Error(`Failed on ${label}.`, { cause: e });
      }
    }
  });
});

describe("bigintFromUnpaddedBase64url()", () => {
  it("decodes all base64url fixtures as expected", () => {
    for (const { value, encoded } of base64urlFixtures) {
      try {
        expect(bigintFromUnpaddedBase64url(encoded)).toBe(value);
      } catch (e) {
        throw new Error(`Failed on ${value}n.`, { cause: e });
      }
    }
  });

  it("decodes all fixtures from the reference encoding, via base64url", () => {
    for (const { value, encoded, label } of fixtures) {
      try {
        expect(bigintFromUnpaddedBase64url(toUnpaddedBase64url(encoded)))
          .toBe(value);
      } catch (e) {
        throw new Error(`Failed on ${label}.`, { cause: e });
      }
    }
  });

  it("accepts padded input", () => {
    expect(bigintFromUnpaddedBase64url("AA==")).toBe(0n);
    expect(bigintFromUnpaddedBase64url("AP8=")).toBe(255n);
  });

  it("throws on an empty string", () => {
    expect(() => bigintFromUnpaddedBase64url("")).toThrow("empty input");
  });

  it("throws on a non-base64url character", () => {
    expect(() => bigintFromUnpaddedBase64url("A/8")).toThrow();
  });

  describe("minimality", () => {
    // A leading `0x00` is needed exactly when the next byte's high bit is set,
    // and a leading `0xff` exactly when it is clear (`3-json-encoding.md`
    // Section 3, `BigInt@1`).

    const NOT_MINIMAL: readonly (readonly [string, string])[] = [
      ["`0x00 0x00`", "AAA"],
      ["`0x00 0x7f`", "AH8"],
      ["`0x00 0x00 0x80`", "AACA"],
      ["`0xff 0xff`", "__8"],
      ["`0xff 0x80`", "_4A"],
      ["`0xff 0xff 0x7f`", "__9_"],
    ];

    for (const [bytes, encoded] of NOT_MINIMAL) {
      it(`throws on ${bytes}, whose leading byte the sign does not need`, () => {
        expect(() => bigintFromUnpaddedBase64url(encoded)).toThrow(
          "not minimal",
        );
      });
    }

    const MINIMAL: readonly (readonly [string, string, bigint])[] = [
      ["`0x00`", "AA", 0n],
      ["`0xff`", "_w", -1n],
      ["`0x00 0x80`", "AIA", 128n],
      ["`0xff 0x7f`", "_38", -129n],
    ];

    for (const [bytes, encoded, value] of MINIMAL) {
      it(`decodes ${bytes}, whose leading byte the sign needs`, () => {
        expect(bigintFromUnpaddedBase64url(encoded)).toBe(value);
      });
    }

    it("throws on bytes that are not minimal under padding", () => {
      expect(() => bigintFromUnpaddedBase64url("AAA=")).toThrow(
        "not minimal",
      );
    });
  });
});
