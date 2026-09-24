/**
 * The content hash of a `FabricValue`: the same value hashing the same way
 * every time, and different values hashing differently.
 *
 * Distinctness is the harder half, and is why each type contributes its own
 * tag to what gets hashed. Without that, values of different types sharing
 * underlying bytes would collide, so one group's whole job is comparing across
 * types rather than within one.
 *
 * The scalar groups carry the awkward cases, being where a hash most easily
 * merges values it ought to separate or separates ones it ought to merge.
 *
 * One group records types that are not handled yet. They are written as
 * assertions about the behavior today, so the gap is visible in the suite
 * rather than merely absent from it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

import type { FabricValue } from "@";
import { UnknownValue } from "@/codec-common";
import { FabricError } from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  FabricUnavailable,
  UNAVAILABLE_PENDING,
} from "@/fabric-primitives";
import { ValueHasher } from "@/value-hash/ValueHasher.ts";
import * as nodeCrypto from "@node/crypto";

import { hex } from "./hex.ts";

/**
 * Returns the SHA-256 hash of a raw byte sequence, for verifying against
 * byte-level spec examples.
 */
function sha256(bytes: number[] | Uint8Array): Uint8Array {
  // node:crypto digest() returns Buffer; normalize to plain Uint8Array so
  // expect comparisons against production code (which also normalizes)
  // work correctly.
  const buf = nodeCrypto.createHash("sha256").update(new Uint8Array(bytes))
    .digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Returns the digest of a new `ValueHasher` fed `value` alone. */
function digestOf(value: FabricValue): FabricHash {
  const hasher = new ValueHasher();
  hasher.feedValue(value);
  return hasher.digest();
}

/** Returns the raw bytes of `digestOf(value)`, for comparison. */
function hashBytesOf(value: FabricValue): Uint8Array {
  return digestOf(value).bytes;
}

describe("ValueHasher", () => {
  describe("instance members", () => {
    describe("digest()", () => {
      it("returns a `FabricHash` with the `fid1` tag", () => {
        const result = digestOf(42);
        expect(result).toBeInstanceOf(FabricHash);
        expect(result.tag).toBe("fid1");
        expect(result.length).toBe(32);
      });

      it("produces `fid1:<base64>` via `FabricHash.toString()`", () => {
        const result = digestOf(42);
        const str = result.toString();
        expect(str.startsWith("fid1:")).toBe(true);
        // Should not contain padding (unpadded base64).
        expect(str.includes("=")).toBe(false);
      });

      it("produces a frozen `FabricHash` (`FabricPrimitive`)", () => {
        const result = digestOf(42);
        expect(Object.isFrozen(result)).toBe(true);
      });
    });

    describe("digestString()", () => {
      it("returns the unpadded base64url form of the bytes `digest()` returns", () => {
        const hasher = new ValueHasher();
        hasher.feedValue({ a: [1, "two"] });

        expect(hasher.digestString()).toBe(
          toUnpaddedBase64url(hashBytesOf({ a: [1, "two"] })),
        );
      });
    });

    describe("feedValue()", () => {
      it("feeds each value after the ones fed before it", () => {
        const hasher = new ValueHasher();
        hasher.feedValue(1);
        hasher.feedValue("a");

        expect(hasher.digest().bytes).toEqual(
          sha256([0x23, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0, 0x24, 0x01, 0x61]),
        );
      });

      it("feeds a container fed before it as itself, not as a cycle", () => {
        const array = [1];
        const hasher = new ValueHasher();
        hasher.feedValue(array);
        hasher.feedValue(array);

        const arrayBytes = [0x10, 0x23, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0, 0x00];
        expect(hasher.digest().bytes).toEqual(
          sha256([...arrayBytes, ...arrayBytes]),
        );
      });

      it("produces `TAG_NULL` byte stream for `null`", () => {
        // Byte stream: [0x20]
        const expected = sha256([0x20]);
        expect(hashBytesOf(null)).toEqual(expected);
      });

      describe("boolean", () => {
        it("produces `TAG_BOOLEAN` + `0x01` for `true`", () => {
          // [0x22, 0x01]
          const expected = sha256([0x22, 0x01]);
          expect(hashBytesOf(true)).toEqual(expected);
        });

        it("produces `TAG_BOOLEAN` + `0x00` for `false`", () => {
          // [0x22, 0x00]
          const expected = sha256([0x22, 0x00]);
          expect(hashBytesOf(false)).toEqual(expected);
        });

        it("produces different hashes for `true` and `false`", () => {
          expect(hex(hashBytesOf(true))).not.toBe(hex(hashBytesOf(false)));
        });
      });
      describe("number", () => {
        it("produces `TAG_NUMBER` + IEEE 754 float64 BE for `42`", () => {
          const expected = sha256([
            0x23,
            0x40,
            0x45,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ]);
          expect(hashBytesOf(42)).toEqual(expected);
        });

        it("produces `TAG_NUMBER` + all zeros for `0`", () => {
          const expected = sha256([
            0x23,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ]);
          expect(hashBytesOf(0)).toEqual(expected);
        });

        it("produces `TAG_NUMBER` + IEEE 754 negative-zero bit pattern for `-0`", () => {
          // 80 00 00 00 00 00 00 00
          const expected = sha256([
            0x23,
            0x80,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ]);
          expect(hashBytesOf(-0)).toEqual(expected);
        });

        it("produces different hashes for `-0` and `+0`", () => {
          expect(hex(hashBytesOf(-0))).not.toBe(hex(hashBytesOf(0)));
        });

        it("produces canonical `TAG_NUMBER` quiet-NaN bytes for `NaN`", () => {
          // 7F F8 00 00 00 00 00 00
          const expected = sha256([
            0x23,
            0x7f,
            0xf8,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ]);
          expect(hashBytesOf(NaN)).toEqual(expected);
        });

        it("produces `TAG_NUMBER` + IEEE 754 `+Infinity` bit pattern for `Infinity`", () => {
          // 7F F0 00 00 00 00 00 00
          const expected = sha256([
            0x23,
            0x7f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ]);
          expect(hashBytesOf(Infinity)).toEqual(expected);
        });

        it("produces `TAG_NUMBER` + IEEE 754 `-Infinity` bit pattern for `-Infinity`", () => {
          // FF F0 00 00 00 00 00 00
          const expected = sha256([
            0x23,
            0xff,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
          ]);
          expect(hashBytesOf(-Infinity)).toEqual(expected);
        });

        it("produces distinct hashes for `NaN`, `+Infinity`, and `-Infinity`", () => {
          expect(hex(hashBytesOf(NaN))).not.toBe(hex(hashBytesOf(Infinity)));
          expect(hex(hashBytesOf(NaN))).not.toBe(hex(hashBytesOf(-Infinity)));
          expect(hex(hashBytesOf(Infinity))).not.toBe(
            hex(hashBytesOf(-Infinity)),
          );
        });

        it("produces different hashes for different numbers", () => {
          expect(hex(hashBytesOf(1))).not.toBe(hex(hashBytesOf(2)));
          expect(hex(hashBytesOf(0))).not.toBe(hex(hashBytesOf(1)));
          expect(hex(hashBytesOf(-1))).not.toBe(hex(hashBytesOf(1)));
        });

        it("produces `TAG_NUMBER` + all-nonzero IEEE 754 bytes for `Number.MAX_VALUE`", () => {
          // IEEE 754 float64 big-endian for Number.MAX_VALUE:
          // 7F EF FF FF FF FF FF FF  (all bytes non-zero)
          const expected = sha256([
            0x23,
            0x7f,
            0xef,
            0xff,
            0xff,
            0xff,
            0xff,
            0xff,
            0xff,
          ]);
          expect(hex(hashBytesOf(Number.MAX_VALUE))).toBe(hex(expected));
        });
      });
      describe("string", () => {
        it("produces `TAG_STRING` + LEB128 byte length + UTF-8 for `hello`", () => {
          // UTF-8 for "hello": [0x68, 0x65, 0x6c, 0x6c, 0x6f], 5 bytes
          // LEB128(5) = [0x05]
          const expected = sha256([
            0x24,
            0x05,
            0x68,
            0x65,
            0x6c,
            0x6c,
            0x6f,
          ]);
          expect(hashBytesOf("hello")).toEqual(expected);
        });

        it("produces `TAG_STRING` + zero length for the empty string", () => {
          // LEB128(0) = [0x00]
          const expected = sha256([0x24, 0x00]);
          expect(hashBytesOf("")).toEqual(expected);
        });

        it("produces different hashes for different strings", () => {
          expect(hex(hashBytesOf("a"))).not.toBe(hex(hashBytesOf("b")));
          expect(hex(hashBytesOf(""))).not.toBe(hex(hashBytesOf("a")));
        });

        it("encodes multi-byte UTF-8 characters correctly", () => {
          // Verify consistency (same value -> same hash)
          expect(hashBytesOf("\u00e9")).toEqual(hashBytesOf("\u00e9"));
          // e-acute is 2 bytes in UTF-8
          expect(hex(hashBytesOf("e"))).not.toBe(hex(hashBytesOf("\u00e9")));
        });

        it("encodes surrogate pairs (emoji) correctly", () => {
          // U+1F600 (grinning face) is 4 bytes in UTF-8
          const emoji = "\u{1F600}";
          const enc = new TextEncoder();
          const utf8 = enc.encode(emoji);
          expect(utf8.length).toBe(4); // 4 bytes in UTF-8
          // LEB128(4) = [0x04]
          const expected = sha256([
            0x24,
            0x04,
            ...utf8,
          ]);
          expect(hashBytesOf(emoji)).toEqual(expected);
        });

        it("encodes a lone surrogate as its three WTF-8 bytes", () => {
          // A lone surrogate takes the three-byte form UTF-8 would give a code
          // point of the same value. LEB128(3) = [0x03]
          expect(hashBytesOf("\ud800")).toEqual(
            sha256([0x24, 0x03, 0xed, 0xa0, 0x80]),
          );
          expect(hashBytesOf("\udfff")).toEqual(
            sha256([0x24, 0x03, 0xed, 0xbf, 0xbf]),
          );
          expect(hex(hashBytesOf("\ud800"))).not.toBe(
            hex(hashBytesOf("\ufffd")),
          );
        });

        it("takes the TAG_STRING_HASH path for a long string", () => {
          // utf8Length(100) > MAX_DIRECT_STRING_LENGTH(64), so the value is fed
          // as [TAG_STRING_HASH][sha256(utf8)] -- a fixed-length compaction in
          // place of the inline `[TAG_STRING][len][utf8]` form.
          const value = "x".repeat(100);
          const valueHash = sha256(new TextEncoder().encode(value));
          const expected = sha256([0xf0, ...valueHash]);
          expect(hashBytesOf(value)).toEqual(expected);
        });

        it("sorts object keys by the byte order of their WTF-8 encodings", () => {
          // The pair `"\ud800\udc00"` encodes as `F0 90 80 80`, and
          // `"\ud800\ue000"` (a lone high surrogate, then U+E000) as
          // `ED A0 80 EE 80 80`, so the second key comes first.
          const value = { "\ud800\udc00": 1, "\ud800\ue000": 2 };
          const one = [0x23, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0];
          const two = [0x23, 0x40, 0, 0, 0, 0, 0, 0, 0];
          expect(hashBytesOf(value)).toEqual(
            sha256([
              0x11,
              0x24,
              0x06,
              0xed,
              0xa0,
              0x80,
              0xee,
              0x80,
              0x80,
              ...two,
              0x24,
              0x04,
              0xf0,
              0x90,
              0x80,
              0x80,
              ...one,
              0x00,
            ]),
          );
        });

        it("takes the TAG_STRING_HASH path over the WTF-8 bytes of a long string", () => {
          const value = `${"x".repeat(64)}\udc00`;
          const valueHash = sha256([
            ...new TextEncoder().encode("x".repeat(64)),
            0xed,
            0xb0,
            0x80,
          ]);
          expect(hashBytesOf(value)).toEqual(sha256([0xf0, ...valueHash]));
          expect(hex(hashBytesOf(value))).not.toBe(
            hex(hashBytesOf(value.toWellFormed())),
          );
        });

        it("is deterministic and value-distinct on the long-string path", () => {
          // Two different strings both > 64 utf8 bytes should hash differently;
          // identical long strings should hash the same.
          const a1 = "a".repeat(100);
          const a2 = "a".repeat(100);
          const b = "b".repeat(100);
          expect(hex(hashBytesOf(a1))).toBe(hex(hashBytesOf(a2)));
          expect(hex(hashBytesOf(a1))).not.toBe(hex(hashBytesOf(b)));
        });
      });
      describe("bigint", () => {
        it("encodes `0n` as `TAG_BIGINT` + LEB128 length 1 + `[0x00]`", () => {
          // LEB128(1) = [0x01]
          const expected = sha256([0x26, 0x01, 0x00]);
          expect(hashBytesOf(0n)).toEqual(expected);
        });

        it("encodes `127n` as 1 byte: `0x7F`", () => {
          const expected = sha256([0x26, 0x01, 0x7f]);
          expect(hashBytesOf(127n)).toEqual(expected);
        });

        it("encodes `128n` as 2 bytes: `0x00`, `0x80`", () => {
          // 128 = 0x80, but high bit set means negative in two's complement,
          // so we need a leading 0x00. LEB128(2) = [0x02].
          const expected = sha256([0x26, 0x02, 0x00, 0x80]);
          expect(hashBytesOf(128n)).toEqual(expected);
        });

        it("encodes `-1n` as 1 byte: `0xFF`", () => {
          const expected = sha256([0x26, 0x01, 0xff]);
          expect(hashBytesOf(-1n)).toEqual(expected);
        });

        it("encodes `-128n` as 1 byte: `0x80`", () => {
          const expected = sha256([0x26, 0x01, 0x80]);
          expect(hashBytesOf(-128n)).toEqual(expected);
        });

        it("encodes `-129n` as 2 bytes: `0xFF`, `0x7F`", () => {
          const expected = sha256([0x26, 0x02, 0xff, 0x7f]);
          expect(hashBytesOf(-129n)).toEqual(expected);
        });

        it("matches a hand-computed byte stream for `0x112233445566778899abcdefn`", () => {
          // 12-byte positive bigint, high nibble 0x1 so no sign-extension needed.
          // TAG_BIGINT(0x26) + LEB128(12)=0x0c + big-endian bytes
          const expected = sha256([
            0x26,
            0x0c,
            0x11,
            0x22,
            0x33,
            0x44,
            0x55,
            0x66,
            0x77,
            0x88,
            0x99,
            0xab,
            0xcd,
            0xef,
          ]);
          expect(hex(hashBytesOf(0x112233445566778899abcdefn))).toBe(
            hex(expected),
          );
        });

        it("matches a hand-computed byte stream for `-0x112233445566778899abcdefn`", () => {
          // Negative two's complement of 11 22 33 44 55 66 77 88 99 AB CD EF:
          //   Invert: EE DD CC BB AA 99 88 77 66 54 32 10
          //   Add 1:  EE DD CC BB AA 99 88 77 66 54 32 11
          // High byte 0xEE has bit 7 set -- correctly negative, 12 bytes.
          // TAG_BIGINT(0x26) + LEB128(12)=0x0c + big-endian two's complement
          const expected = sha256([
            0x26,
            0x0c,
            0xee,
            0xdd,
            0xcc,
            0xbb,
            0xaa,
            0x99,
            0x88,
            0x77,
            0x66,
            0x54,
            0x32,
            0x11,
          ]);
          expect(hex(hashBytesOf(-0x112233445566778899abcdefn))).toBe(
            hex(expected),
          );
        });

        it("produces `TAG_UNDEFINED` for `undefined`", () => {
          // [0x21]
          const expected = sha256([0x21]);
          expect(hashBytesOf(undefined)).toEqual(expected);
        });
      });
      describe("cross-type distinctness", () => {
        it("produces different hashes for `null`, `undefined`, and `false`", () => {
          const nullH = hex(hashBytesOf(null));
          const undefH = hex(hashBytesOf(undefined));
          const falseH = hex(hashBytesOf(false));
          expect(nullH).not.toBe(undefH);
          expect(nullH).not.toBe(falseH);
          expect(undefH).not.toBe(falseH);
        });

        it('number `0` vs `bigint` value `0n` vs string `"0"` are distinct', () => {
          const numH = hex(hashBytesOf(0));
          const bigH = hex(hashBytesOf(0n));
          const strH = hex(hashBytesOf("0"));
          expect(numH).not.toBe(bigH);
          expect(numH).not.toBe(strH);
          expect(bigH).not.toBe(strH);
        });
      });
      describe("FabricBytes", () => {
        it("produces `TAG_BYTES` + LEB128 length + raw bytes for a `FabricBytes`", () => {
          const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
          // LEB128(3) = [0x03]
          const expected = sha256([
            0x25,
            0x03,
            0x01,
            0x02,
            0x03,
          ]);
          expect(hashBytesOf(bytes)).toEqual(expected);
        });

        it("produces `TAG_BYTES` + zero length for an empty `FabricBytes`", () => {
          const bytes = new FabricBytes(new Uint8Array([]));
          const expected = sha256([0x25, 0x00]);
          expect(hashBytesOf(bytes)).toEqual(expected);
        });
      });
      describe("FabricEpochNsec (dedicated TAG_EPOCH_NSEC primitive tag)", () => {
        it("matches a hand-computed byte stream for `FabricEpochNsec(0n)`", () => {
          // TAG_EPOCH_NSEC (0x27) + LEB128(1) + [0x00]
          const expected = sha256([
            0x27,
            0x01,
            0x00,
          ]);
          expect(hashBytesOf(new FabricEpochNsec(0n))).toEqual(expected);
        });

        it("produces different hashes for FabricEpochNsec values", () => {
          const d1 = new FabricEpochNsec(0n);
          const d2 = new FabricEpochNsec(1704067200000000000n);
          expect(hex(hashBytesOf(d1))).not.toBe(hex(hashBytesOf(d2)));
        });
      });
      describe("FabricEpochDay (dedicated TAG_EPOCH_DAY primitive tag)", () => {
        it("matches a hand-computed byte stream for `FabricEpochDay(0n)`", () => {
          // TAG_EPOCH_DAY (0x28) + LEB128(1) + [0x00]
          const expected = sha256([
            0x28,
            0x01,
            0x00,
          ]);
          expect(hashBytesOf(new FabricEpochDay(0n))).toEqual(expected);
        });

        it("produces different hashes for FabricEpochDay values", () => {
          const d1 = new FabricEpochDay(0n);
          const d2 = new FabricEpochDay(19723n);
          expect(hex(hashBytesOf(d1))).not.toBe(hex(hashBytesOf(d2)));
        });

        it("produces different hashes for `FabricEpochNsec` and `FabricEpochDay` with the same `bigint`", () => {
          // Same underlying value, different tag -> different hash
          const nsec = new FabricEpochNsec(100n);
          const days = new FabricEpochDay(100n);
          expect(hex(hashBytesOf(nsec))).not.toBe(hex(hashBytesOf(days)));
        });
      });
      describe("FabricRegExp (dedicated TAG_REGEXP primitive tag)", () => {
        it("matches a hand-computed byte stream for `FabricRegExp(/abc/gi)`", () => {
          // TAG_REGEXP (0x2B), then source, flags, and flavor, each a direct
          // string (TAG_STRING + length + UTF-8), fed positionally with no
          // terminator. Mirrored in Section 7.12 of `2-hash-byte-format.md`,
          // so the two have to be changed together.
          const expected = sha256([
            0x2b,
            0x24,
            0x03,
            0x61,
            0x62,
            0x63,
            0x24,
            0x02,
            0x67,
            0x69,
            0x24,
            0x06,
            0x65,
            0x73,
            0x32,
            0x30,
            0x32,
            0x35,
          ]);
          expect(hashBytesOf(new FabricRegExp(/abc/gi))).toEqual(expected);
        });

        it("produces different hashes for different sources", () => {
          const r1 = new FabricRegExp(/foo/);
          const r2 = new FabricRegExp(/bar/);
          expect(hex(hashBytesOf(r1))).not.toBe(hex(hashBytesOf(r2)));
        });

        it("produces different hashes for different flags", () => {
          const r1 = new FabricRegExp(/foo/g);
          const r2 = new FabricRegExp(/foo/i);
          expect(hex(hashBytesOf(r1))).not.toBe(hex(hashBytesOf(r2)));
        });
      });

      describe("FabricUnavailable (dedicated TAG_UNAVAILABLE primitive tag)", () => {
        it('matches a hand-computed byte stream for `FabricUnavailable("pending")`', () => {
          // TAG_UNAVAILABLE (0x2D), the reason as a tagged string, then the
          // absent kind and the absent message each as TAG_NULL (0x20).
          const expected = sha256([
            0x2d,
            0x24,
            0x07,
            ...new TextEncoder().encode("pending"),
            0x20,
            0x20,
          ]);
          expect(hashBytesOf(new FabricUnavailable("pending"))).toEqual(
            expected,
          );
        });

        it('matches a hand-computed byte stream for `FabricUnavailable("error", "network", "boom")`', () => {
          // TAG_UNAVAILABLE (0x2D), then the reason, the kind, and the message
          // each as a tagged string.
          const expected = sha256([
            0x2d,
            0x24,
            0x05,
            ...new TextEncoder().encode("error"),
            0x24,
            0x07,
            ...new TextEncoder().encode("network"),
            0x24,
            0x04,
            ...new TextEncoder().encode("boom"),
          ]);
          expect(hashBytesOf(new FabricUnavailable("error", "network", "boom")))
            .toEqual(expected);
        });

        it("feeds `TAG_NULL` for the message of an error given none", () => {
          const expected = sha256([
            0x2d,
            0x24,
            0x05,
            ...new TextEncoder().encode("error"),
            0x24,
            0x07,
            ...new TextEncoder().encode("network"),
            0x20,
          ]);
          expect(hashBytesOf(new FabricUnavailable("error", "network")))
            .toEqual(expected);
        });

        it("produces the same hash for a prefab and a fresh instance with its reason", () => {
          expect(hex(hashBytesOf(UNAVAILABLE_PENDING)))
            .toBe(hex(hashBytesOf(new FabricUnavailable("pending"))));
        });

        it("produces the same hash for an error given its kind's default message and one given none", () => {
          const given = new FabricUnavailable("error", "network");
          expect(hex(hashBytesOf(
            new FabricUnavailable("error", "network", given.errorMessage),
          ))).toBe(hex(hashBytesOf(given)));
        });

        it("produces different hashes for different reasons", () => {
          expect(hex(hashBytesOf(new FabricUnavailable("pending"))))
            .not.toBe(hex(hashBytesOf(new FabricUnavailable("syncing"))));
        });

        it("produces different hashes for different kinds", () => {
          expect(hex(hashBytesOf(new FabricUnavailable("error", "network"))))
            .not.toBe(
              hex(hashBytesOf(new FabricUnavailable("error", "decode"))),
            );
        });

        it("produces different hashes for different messages", () => {
          expect(
            hex(hashBytesOf(new FabricUnavailable("error", "general", "a"))),
          )
            .not.toBe(
              hex(hashBytesOf(new FabricUnavailable("error", "general", "b"))),
            );
        });
      });
      describe("FabricError (FabricInstance via [CODEC])", () => {
        it("matches a byte stream built from `[CODEC]` `encode()` output for `FabricError`", () => {
          // Build the expected byte stream programmatically because the encoded
          // state includes `stack` which is environment-dependent.
          // We construct the stream the same way `ValueHasher` does, then
          // SHA-256 it.
          const error = FabricError.fromNativeError(new Error("test"));
          const enc = new TextEncoder();

          // TAG_INSTANCE (0x12)
          const stream: number[] = [0x12];

          const pushShortString = (value: string) => {
            const encoded = enc.encode(value);
            stream.push(0x24, encoded.length, ...encoded);
          };

          const pushLongString = (value: string) => {
            const hashed = sha256(enc.encode(value));
            stream.push(0xf0, ...hashed);
          };

          // Type tag.
          pushShortString("Error@1");

          // The encoded state is an object with sorted keys.
          // `FabricError[CODEC].encode()` returns:
          //   { type: "Error", name: null, message: "test", stack: <string> }
          // Keys sorted by UTF-8: message, name, stack, type
          stream.push(0x11); // TAG_OBJECT

          // Key "message" + value "test"
          pushShortString("message");
          pushShortString("test");

          // Key "name" + value null (name === type for Error, so null)
          pushShortString("name");
          stream.push(0x20); // TAG_NULL

          // Key "stack" + value (the actual stack string)
          pushShortString("stack");
          pushLongString(error.stack!);

          // Key "type" + value "Error"
          pushShortString("type");
          pushShortString("Error");

          // TAG_END for the object
          stream.push(0x00);

          const expected = sha256(stream);
          expect(hashBytesOf(error)).toEqual(expected);
        });

        it("produces different hashes for different errors", () => {
          const e1 = FabricError.fromNativeError(new Error("hello"));
          const e2 = FabricError.fromNativeError(new Error("world"));
          expect(hex(hashBytesOf(e1))).not.toBe(hex(hashBytesOf(e2)));
        });

        it("produces different hashes for `TypeError` vs. `Error`", () => {
          const e1 = FabricError.fromNativeError(new Error("msg"));
          const e2 = FabricError.fromNativeError(new TypeError("msg"));
          expect(hex(hashBytesOf(e1))).not.toBe(hex(hashBytesOf(e2)));
        });
      });
      describe("Arrays", () => {
        it("produces TAG_ARRAY + TAG_END for an empty array", () => {
          const expected = sha256([0x10, 0x00]);
          expect(hashBytesOf([])).toEqual(expected);
        });

        it("uses hole run-length encoding for the sparse array [1, , 3]", () => {
          // TAG_ARRAY
          // + number 1 (TAG_NUMBER + IEEE754)
          // + TAG_HOLE + LEB128(1)
          // + number 3 (TAG_NUMBER + IEEE754)
          // + TAG_END
          const expected = sha256([
            // TAG_ARRAY
            0x10,
            // Element 0: number 1
            0x23,
            0x3f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // Element 1: hole run of 1
            0x01,
            0x01,
            // Element 2: number 3
            0x23,
            0x40,
            0x08,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // TAG_END
            0x00,
          ]);
          // deno-lint-ignore no-sparse-arrays
          expect(hashBytesOf([1, , 3])).toEqual(expected);
        });

        it("coalesces multiple consecutive holes into one run", () => {
          // [1, , , , 5] -> hole run of 3
          const arr = new Array(5);
          arr[0] = 1;
          arr[4] = 5;
          const hash = hashBytesOf(arr);

          // Verify by building the expected byte stream manually
          const expected = sha256([
            // TAG_ARRAY
            0x10,
            // Element 0: number 1
            0x23,
            0x3f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // Elements 1-3: hole run of 3
            0x01,
            0x03,
            // Element 4: number 5
            0x23,
            0x40,
            0x14,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // TAG_END
            0x00,
          ]);
          expect(hash).toEqual(expected);
        });

        it("produces distinct hashes for `[1, undefined, 3]` vs. `[1, , 3]` vs. `[1, null, 3]`", () => {
          // deno-lint-ignore no-sparse-arrays
          const sparseH = hex(hashBytesOf([1, , 3]));
          const undefH = hex(hashBytesOf([1, undefined, 3]));
          const nullH = hex(hashBytesOf([1, null, 3]));

          expect(sparseH).not.toBe(undefH);
          expect(sparseH).not.toBe(nullH);
          expect(undefH).not.toBe(nullH);
        });

        it("recursively hashes nested arrays", () => {
          const hash = hashBytesOf([[1, 2], [3]]);
          expect(hash.length).toBe(32);
          // Different from flat array
          expect(hex(hash)).not.toBe(hex(hashBytesOf([1, 2, 3])));
        });
      });
      describe("Objects", () => {
        it("produces TAG_OBJECT + TAG_END for an empty object", () => {
          const expected = sha256([0x11, 0x00]);
          expect(hashBytesOf({})).toEqual(expected);
        });

        it("is deterministic in object key order (sorted by UTF-8)", () => {
          // Keys inserted in different orders produce the same hash.
          const h1 = hashBytesOf({ a: 1, b: 2 });
          const h2 = hashBytesOf({ b: 2, a: 1 });
          expect(h1).toEqual(h2);
        });

        it("hashes a null-prototype object as an ordinary plain object", () => {
          const nullProto = Object.create(null) as Record<string, FabricValue>;
          nullProto.a = 1;

          expect(hashBytesOf(nullProto)).toEqual(hashBytesOf({ a: 1 }));
        });

        it("matches a hand-computed byte stream for {a: 1, b: 2}", () => {
          // Keys sorted: "a" (0x61) < "b" (0x62)
          // LEB128 lengths are single bytes for small values.
          const expected = sha256([
            // TAG_OBJECT
            0x11,
            // Key "a": TAG_STRING + LEB128(1) + UTF-8
            0x24,
            0x01,
            0x61,
            // Value 1: TAG_NUMBER + IEEE754 for 1.0
            0x23,
            0x3f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // Key "b": TAG_STRING + LEB128(1) + UTF-8
            0x24,
            0x01,
            0x62,
            // Value 2: TAG_NUMBER + IEEE754 for 2.0
            0x23,
            0x40,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // TAG_END
            0x00,
          ]);
          expect(hashBytesOf({ a: 1, b: 2 })).toEqual(expected);
        });

        it("recursively hashes nested objects", () => {
          const hash = hashBytesOf({ x: { y: 1 } });
          expect(hash.length).toBe(32);
          expect(hex(hash)).not.toBe(hex(hashBytesOf({ x: 1 })));
        });
      });
      describe("Cycles", () => {
        /** The direct-form bytes of a short ASCII string. */
        function stringBytes(value: string): number[] {
          return [0x24, value.length, ...new TextEncoder().encode(value)];
        }

        it("encodes an object that holds itself as `TAG_CYCLE` + distance 1", () => {
          const self: Record<string, FabricValue> = {};
          self.self = self;

          expect(hashBytesOf(self)).toEqual(
            sha256([0x11, ...stringBytes("self"), 0x02, 0x01, 0x00]),
          );
        });

        it("encodes an array that holds itself as `TAG_CYCLE` + distance 1", () => {
          const self: FabricValue[] = [];
          self.push(self);

          expect(hashBytesOf(self)).toEqual(sha256([0x10, 0x02, 0x01, 0x00]));
        });

        it("encodes the distance up the path to the container the cycle returns to", () => {
          const a: Record<string, FabricValue> = {};
          const b: Record<string, FabricValue> = { a };
          a.b = b;

          expect(hashBytesOf(a)).toEqual(
            sha256([
              0x11,
              ...stringBytes("b"),
              0x11,
              ...stringBytes("a"),
              0x02,
              0x02,
              0x00,
              0x00,
            ]),
          );
        });

        it("encodes a cycle through a `FabricInstance`, counting the instance and its state", () => {
          const state: Record<string, FabricValue> = {};
          const instance = new UnknownValue("Node@1", state);
          state.self = instance;

          expect(hashBytesOf(instance)).toEqual(
            sha256([
              0x12,
              ...stringBytes("Node@1"),
              0x11,
              ...stringBytes("self"),
              0x02,
              0x02,
              0x00,
            ]),
          );
        });

        it("encodes a cyclic value the same way wherever it sits", () => {
          const self: Record<string, FabricValue> = {};
          self.self = self;

          expect(hashBytesOf([self])).toEqual(
            sha256([
              0x10,
              0x11,
              ...stringBytes("self"),
              0x02,
              0x01,
              0x00,
              0x00,
            ]),
          );
        });

        it("encodes a distance past the height at which the path is indexed", () => {
          // 100 nested objects, the innermost holding the outermost.
          const root: Record<string, FabricValue> = {};
          let inner = root;
          for (let i = 1; i < 100; i++) {
            const next: Record<string, FabricValue> = {};
            inner.n = next;
            inner = next;
          }
          inner.root = root;

          const nest = Array.from(
            { length: 99 },
            () => [0x11, ...stringBytes("n")],
          ).flat();
          expect(hashBytesOf(root)).toEqual(
            sha256([
              ...nest,
              0x11,
              ...stringBytes("root"),
              0x02,
              100, // LEB128(100) = [0x64]
              0x00,
              ...new Array(99).fill(0x00),
            ]),
          );
        });

        it("expands a shared container that is not on the path, as it does in an acyclic value", () => {
          const shared = { v: 1 };

          expect(hashBytesOf({ a: shared, b: shared })).toEqual(
            hashBytesOf({ a: { v: 1 }, b: { v: 1 } }),
          );
          expect(hashBytesOf([shared, [shared]])).toEqual(
            hashBytesOf([{ v: 1 }, [{ v: 1 }]]),
          );
        });

        it("hashes differently where a cycle closes at a different container", () => {
          const one: Record<string, FabricValue> = {};
          one.x = one;
          const two: Record<string, FabricValue> = {};
          two.x = { x: two };

          expect(hex(hashBytesOf(one))).not.toBe(hex(hashBytesOf(two)));
          expect(hex(hashBytesOf({ x: one }))).not.toBe(hex(hashBytesOf(one)));
        });
      });

      describe("Consistency and distinctness", () => {
        it("produces different hashes for different values of different types", () => {
          const hashes = new Set([
            hex(hashBytesOf(null)),
            hex(hashBytesOf(true)),
            hex(hashBytesOf(false)),
            hex(hashBytesOf(0)),
            hex(hashBytesOf("")),
            hex(hashBytesOf(0n)),
            hex(hashBytesOf(undefined)),
            hex(hashBytesOf([])),
            hex(hashBytesOf({})),
          ]);
          // All 9 should be distinct.
          expect(hashes.size).toBe(9);
        });
      });
      describe("Edge cases", () => {
        it("hashes an array with all holes", () => {
          const arr = new Array(5); // all holes
          const hash = hashBytesOf(arr);
          expect(hash.length).toBe(32);

          // TAG_ARRAY + TAG_HOLE + LEB128(5) + TAG_END
          const expected = sha256([
            0x10,
            0x01,
            0x05,
            0x00,
          ]);
          expect(hash).toEqual(expected);
        });

        it("sorts non-ASCII object keys by UTF-8 bytes", () => {
          // Keys with non-ASCII should sort by UTF-8 byte values.
          const h1 = hashBytesOf({ "\u00e9": 1, "a": 2 });
          const h2 = hashBytesOf({ "a": 2, "\u00e9": 1 });
          expect(h1).toEqual(h2);
        });

        it("sorts object keys by UTF-8, not UTF-16 (supplementary vs. BMP)", () => {
          // U+F000 (private use area, BMP): UTF-8 = [EF 80 80] (3 bytes)
          // U+10000 (supplementary plane):  UTF-8 = [F0 90 80 80] (4 bytes)
          //
          // UTF-16 order: U+10000 < U+F000 (surrogates 0xD800 < 0xF000)
          // UTF-8 order:  U+F000 < U+10000 (0xEF < 0xF0)
          //
          // If sorting were naive JS string comparison (UTF-16), U+10000 would
          // come first. Under correct UTF-8 byte sort, U+F000 comes first.
          const keyA = "\uF000"; // UTF-8: EF 80 80
          const keyB = "\u{10000}"; // UTF-8: F0 90 80 80

          // Verify the JS string order is opposite to UTF-8 order.
          expect(keyB < keyA).toBe(true);

          const obj = { [keyA]: 1, [keyB]: 2 };

          // Expected byte stream with UTF-8 sort order (keyA first):
          // TAG_OBJECT (0x11)
          // + keyA: TAG_STRING(0x24) + LEB128(3) + EF 80 80
          // + value 1: TAG_NUMBER(0x23) + IEEE754 for 1.0
          // + keyB: TAG_STRING(0x24) + LEB128(4) + F0 90 80 80
          // + value 2: TAG_NUMBER(0x23) + IEEE754 for 2.0
          // + TAG_END (0x00)
          const expected = sha256([
            // TAG_OBJECT
            0x11,
            // keyA: U+F000 (UTF-8 first)
            0x24,
            0x03,
            0xef,
            0x80,
            0x80,
            // value 1
            0x23,
            0x3f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // keyB: U+10000 (UTF-8 second)
            0x24,
            0x04,
            0xf0,
            0x90,
            0x80,
            0x80,
            // value 2
            0x23,
            0x40,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // TAG_END
            0x00,
          ]);
          expect(hashBytesOf(obj)).toEqual(expected);

          // Also verify the wrong (UTF-16) order produces a different hash.
          const wrongOrder = sha256([
            0x11,
            // keyB first (wrong -- UTF-16 order)
            0x24,
            0x04,
            0xf0,
            0x90,
            0x80,
            0x80,
            0x23,
            0x40,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // keyA second
            0x24,
            0x03,
            0xef,
            0x80,
            0x80,
            0x23,
            0x3f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            // TAG_END
            0x00,
          ]);
          expect(hex(hashBytesOf(obj))).not.toBe(hex(wrongOrder));
        });

        it("takes the TAG_STRING_HASH path for a long object key", () => {
          // `utf8Length(100)` exceeds `MAX_DIRECT_STRING_LENGTH` (64). Object
          // keys go through the same `getStringRep()` codepath as bare string
          // values, so a long key is fed as `[TAG_STRING_HASH][sha256(utf8)]`.
          const longKey = "x".repeat(100);
          const obj = { [longKey]: 1 };
          const keyHash = sha256(new TextEncoder().encode(longKey));
          // Stream: TAG_OBJECT, [TAG_STRING_HASH, keyHash], value(1.0), TAG_END
          const expected = sha256([
            0x11, // TAG_OBJECT
            0xf0, // TAG_STRING_HASH
            ...keyHash,
            // Value `1`: TAG_NUMBER + IEEE-754 BE bit pattern for 1.0
            0x23,
            0x3f,
            0xf0,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00, // TAG_END
          ]);
          expect(hashBytesOf(obj)).toEqual(expected);
        });

        it("is deterministic and key-distinct for long object keys", () => {
          const a1 = { ["a".repeat(100)]: 1 };
          const a2 = { ["a".repeat(100)]: 1 };
          const b = { ["b".repeat(100)]: 1 };
          expect(hex(hashBytesOf(a1))).toBe(hex(hashBytesOf(a2)));
          expect(hex(hashBytesOf(a1))).not.toBe(hex(hashBytesOf(b)));
        });
      });
      describe("FabricKeyPair hashing (TAG_KEY_PAIR = 0x2C)", () => {
        it("matches a hand-computed byte stream for `FabricKeyPair`", () => {
          // Algorithm "Ed25519" = 7 bytes UTF-8, under the 64-byte threshold, so
          // the direct string form. Each key is a complete tagged `FabricBytes`
          // value: TAG_BYTES, a LEB128 length, then the raw bytes.
          //
          // A real algorithm name, unlike the placeholder the fixtures use: its
          // own bytes are spelled out below and mirrored in Section 7.13 of
          // `2-hash-byte-format.md`, so the two have to be changed together.
          // Nothing here depends on the algorithm being one this system uses.
          const pair = new FabricKeyPair(
            "Ed25519",
            new Uint8Array([0xDE, 0xAD]),
            new Uint8Array([0xBE, 0xEF, 0x01]),
          );
          const expected = sha256([
            0x2C, // TAG_KEY_PAIR
            0x24, // TAG_STRING
            0x07, // length of "Ed25519"
            0x45,
            0x64,
            0x32,
            0x35,
            0x35,
            0x31,
            0x39, // "Ed25519"
            0x25, // TAG_BYTES
            0x02, // public key length
            0xDE,
            0xAD,
            0x25, // TAG_BYTES
            0x03, // private key length
            0xBE,
            0xEF,
            0x01,
          ]);

          expect(hex(hashBytesOf(pair))).toBe(hex(expected));
        });

        it("hashes the two keys in a fixed order", () => {
          // The layout above feeds the public key first. Swapping the two is a
          // different value rather than the same one -- which the byte stream
          // decides and no distinctness test alone could show, the two keys
          // here being of different lengths only so that a swap is visible at
          // all.
          const pair = new FabricKeyPair(
            "Ed25519",
            new Uint8Array([0xDE, 0xAD]),
            new Uint8Array([0xBE, 0xEF, 0x01]),
          );
          const swapped = new FabricKeyPair(
            "Ed25519",
            new Uint8Array([0xBE, 0xEF, 0x01]),
            new Uint8Array([0xDE, 0xAD]),
          );

          expect(hex(hashBytesOf(pair))).not.toBe(hex(hashBytesOf(swapped)));
        });
      });

      describe("FabricHash hashing (TAG_HASH = 0x29)", () => {
        it("matches a hand-computed byte stream for `FabricHash`", () => {
          // Algorithm tag "fid1" = [0x66, 0x69, 0x64, 0x31] (4 bytes UTF-8)
          // Hash bytes: [0xDE, 0xAD, 0xBE, 0xEF] (4 bytes)
          const cid = new FabricHash(
            new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
            "fid1",
          );
          // Expected: TAG_HASH (0x29), "fid1" (encoded), hashLen (0x04), hash
          const expected = sha256([
            0x29,
            0x24,
            0x04,
            0x66,
            0x69,
            0x64,
            0x31,
            0x04,
            0xDE,
            0xAD,
            0xBE,
            0xEF,
          ]);
          expect(hex(hashBytesOf(cid))).toBe(hex(expected));
        });

        it("produces different hashes for `FabricHash` with different algorithm tags", () => {
          const bytes = new Uint8Array([0x01, 0x02, 0x03]);
          const cid1 = new FabricHash(bytes, "fid1");
          const cid2 = new FabricHash(bytes, "fid2");
          expect(hex(hashBytesOf(cid1))).not.toBe(hex(hashBytesOf(cid2)));
        });

        it("produces different hashes for `FabricHash` with different hash bytes", () => {
          const cid1 = new FabricHash(
            new Uint8Array([0x01, 0x02]),
            "fid1",
          );
          const cid2 = new FabricHash(
            new Uint8Array([0x03, 0x04]),
            "fid1",
          );
          expect(hex(hashBytesOf(cid1))).not.toBe(hex(hashBytesOf(cid2)));
        });
      });

      describe("values outside the data model", () => {
        it("throws for a JS `Date`", () => {
          const date = new Date("2024-01-01T00:00:00Z");
          // @ts-expect-error A JS `Date` is not a `FabricValue`.
          expect(() => hashBytesOf(date)).toThrow("Cannot hash value");
        });

        it("throws for a JS `RegExp`", () => {
          // @ts-expect-error A JS `RegExp` is not a `FabricValue`.
          expect(() => hashBytesOf(/hello/gi)).toThrow("Cannot hash value");
        });

        it("throws for a JS `Uint8Array`", () => {
          const bytes = new Uint8Array([10, 20, 30]);
          // @ts-expect-error A JS `Uint8Array` is not a `FabricValue`.
          expect(() => hashBytesOf(bytes)).toThrow("Cannot hash value");
        });

        it("throws for a `Date` nested in a container", () => {
          const nested = { at: [new Date("2024-01-01T00:00:00Z")] };
          // @ts-expect-error A JS `Date` is not a `FabricValue`.
          expect(() => hashBytesOf(nested)).toThrow("Cannot hash value");
        });

        it("throws for `Map`", () => {
          // @ts-expect-error A `Map` is not a `FabricValue`.
          expect(() => hashBytesOf(new Map([["a", 1]]))).toThrow(
            "Cannot hash value",
          );
        });

        it("throws for `Set`", () => {
          // @ts-expect-error A `Set` is not a `FabricValue`.
          expect(() => hashBytesOf(new Set([1, 2, 3]))).toThrow(
            "Cannot hash value",
          );
        });

        it("throws for `Error`", () => {
          // @ts-expect-error A JS `Error` is not a `FabricValue`.
          expect(() => hashBytesOf(new Error("test"))).toThrow(
            "Cannot hash value",
          );
        });

        it("throws for a member that is a function", () => {
          // `toJSON` gets no special reading here either: it is a
          // function-valued member, and functions have no hash.
          const obj = { toJSON: () => "hello" };
          // @ts-expect-error A function is not a `FabricValue`.
          expect(() => hashBytesOf(obj)).toThrow("Cannot hash value");
        });
      });

      describe("interned symbols", () => {
        // Registry-interned symbols: hashed via TAG_SYMBOL (0x2a) followed by a
        // self-tagged string-rep of `Symbol.keyFor(s)` (i.e., the same byte stream
        // that a plain string of that key would feed). Unique (uninterned) symbols
        // have no portable key and throw.

        it("takes the inline TAG_STRING path for a short key", () => {
          // utf8Length(3) <= MAX_DIRECT_STRING_LENGTH(64), so the key is fed as
          // [TAG_STRING][len][utf8].
          // Final stream: [TAG_SYMBOL=0x2a, TAG_STRING=0x24, len=0x03, 'f','o','o']
          const expected = sha256([0x2a, 0x24, 0x03, 0x66, 0x6f, 0x6f]);
          expect(hashBytesOf(Symbol.for("foo"))).toEqual(expected);
        });

        it('empty-key `Symbol.for("")` has length zero, not absent', () => {
          // [TAG_SYMBOL=0x2a, TAG_STRING=0x24, len=0x00]
          const expected = sha256([0x2a, 0x24, 0x00]);
          expect(hashBytesOf(Symbol.for(""))).toEqual(expected);
        });

        it("takes the TAG_STRING_HASH path for a long key", () => {
          // utf8Length(100) > MAX_DIRECT_STRING_LENGTH(64), so the key is fed as
          // [TAG_STRING_HASH][sha256(utf8)] -- a fixed-length compaction.
          // Final stream: [TAG_SYMBOL=0x2a, TAG_STRING_HASH=0xf0, ...keyHash]
          const key = "x".repeat(100);
          const keyHash = sha256(new TextEncoder().encode(key));
          const expected = sha256([0x2a, 0xf0, ...keyHash]);
          expect(hashBytesOf(Symbol.for(key))).toEqual(expected);
        });

        it("is deterministic and key-distinct on the long-key path", () => {
          // Two different keys both > 64 utf8 bytes should hash differently;
          // identical long keys should hash the same.
          const a1 = Symbol.for("a".repeat(100));
          const a2 = Symbol.for("a".repeat(100));
          const b = Symbol.for("b".repeat(100));
          expect(hex(hashBytesOf(a1))).toBe(hex(hashBytesOf(a2)));
          expect(hex(hashBytesOf(a1))).not.toBe(hex(hashBytesOf(b)));
        });

        it("hashes equal-keyed interned symbols identically", () => {
          expect(hex(hashBytesOf(Symbol.for("hello"))))
            .toBe(hex(hashBytesOf(Symbol.for("hello"))));
        });

        it("hashes differently-keyed interned symbols differently", () => {
          expect(hex(hashBytesOf(Symbol.for("a"))))
            .not.toBe(hex(hashBytesOf(Symbol.for("b"))));
        });

        it("does not collide a same-key string with an interned symbol", () => {
          // The TAG_SYMBOL prefix must distinguish a symbol from its key string.
          expect(hex(hashBytesOf(Symbol.for("x"))))
            .not.toBe(hex(hashBytesOf("x")));
        });

        it("hashes deterministically for an interned symbol nested in an object", () => {
          const a = { tag: Symbol.for("nested-tag") };
          const b = { tag: Symbol.for("nested-tag") };
          expect(hex(hashBytesOf(a))).toBe(hex(hashBytesOf(b)));
        });

        it("hashes deterministically for an interned symbol nested in an array", () => {
          const a = [Symbol.for("x"), 1];
          const b = [Symbol.for("x"), 1];
          expect(hex(hashBytesOf(a))).toBe(hex(hashBytesOf(b)));
        });

        it("also throws for a unique symbol nested in an object", () => {
          const value = { tag: Symbol("nope") };
          expect(() => hashBytesOf(value)).toThrow(
            "Cannot hash unique (uninterned) symbol",
          );
        });
      });
    });
  });

  describe("static members", () => {
    describe("computeHash()", () => {
      it("returns what `digest()` returns from a new instance fed the value", () => {
        for (const value of [null, 42, "hi", [1, , 3], { a: { b: 2n } }]) {
          expect(ValueHasher.computeHash(value).bytes).toEqual(
            hashBytesOf(value),
          );
        }
      });
    });

    describe("computeHashAsString()", () => {
      it("returns what `digestString()` returns from a new instance fed the value", () => {
        for (const value of [null, 42, "hi", [1, , 3], { a: { b: 2n } }]) {
          const hasher = new ValueHasher();
          hasher.feedValue(value);
          expect(ValueHasher.computeHashAsString(value)).toBe(
            hasher.digestString(),
          );
        }
      });
    });
  });
});
