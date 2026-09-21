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

import { createHasher } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

import { FabricValue, hashOf, hashStringOf, taggedHashStringOf } from "@";
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
import { float64BytesOfForTestingOnly } from "@/for-testing-only.ts";
import * as nodeCrypto from "@node/crypto";

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

/** Returns the lowercase hex rendering of `hash`. */
function hex(hash: Uint8Array): string {
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns the raw hash bytes from `hashOf()`, for comparison. Takes `unknown`,
 * as `hashOf()` itself does: the JS-instance cases below hash a JS
 * `Date` / `RegExp` / `Uint8Array`, none of which is a `FabricValue`.
 */
function hashBytesOf(value: unknown): Uint8Array {
  return hashOf(value).bytes;
}

describe("value-hash", () => {
  describe("hashOf()", () => {
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

      it("takes the TAG_STRING_HASH path for a long string", () => {
        // utf8Length(100) > MAX_DIRECT_STRING_LENGTH(64), so the value is fed
        // as [TAG_STRING_HASH][sha256(utf8)] -- a fixed-length compaction in
        // place of the inline `[TAG_STRING][len][utf8]` form.
        const value = "x".repeat(100);
        const valueHash = sha256(new TextEncoder().encode(value));
        const expected = sha256([0xf0, ...valueHash]);
        expect(hashBytesOf(value)).toEqual(expected);
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

      it("encodes a large `bigint` correctly", () => {
        // 2^64 = 18446744073709551616n
        // hex: 10000000000000000 -> 9 bytes: 01 00 00 00 00 00 00 00 00
        const big = 2n ** 64n;
        const hash = hashBytesOf(big);
        expect(hash.length).toBe(32); // SHA-256 produces 32 bytes

        // Verify it's consistent
        expect(hashBytesOf(big)).toEqual(hash);
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

      it("hashes a FabricEpochNsec with negative value (pre-epoch)", () => {
        const nsec = new FabricEpochNsec(-1000000000n);
        const hash = hashBytesOf(nsec);
        expect(hash.length).toBe(32);
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

      it("hashes a FabricEpochDay with negative value (pre-epoch)", () => {
        const days = new FabricEpochDay(-365n);
        const hash = hashBytesOf(days);
        expect(hash.length).toBe(32);
      });

      it("produces different hashes for `FabricEpochNsec` and `FabricEpochDay` with the same `bigint`", () => {
        // Same underlying value, different tag -> different hash
        const nsec = new FabricEpochNsec(100n);
        const days = new FabricEpochDay(100n);
        expect(hex(hashBytesOf(nsec))).not.toBe(hex(hashBytesOf(days)));
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
        expect(hashBytesOf(new FabricUnavailable("pending"))).toEqual(expected);
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
          .not.toBe(hex(hashBytesOf(new FabricUnavailable("error", "decode"))));
      });

      it("produces different hashes for different messages", () => {
        expect(hex(hashBytesOf(new FabricUnavailable("error", "general", "a"))))
          .not.toBe(
            hex(hashBytesOf(new FabricUnavailable("error", "general", "b"))),
          );
      });
    });
    describe("FabricError (FabricInstance via [CODEC])", () => {
      it("matches a byte stream built from `[CODEC]` `encode()` output for `FabricError`", () => {
        // Build the expected byte stream programmatically because the encoded
        // state includes `stack` which is environment-dependent.
        // We construct the stream the same way `hashOf()` does, then SHA-256
        // it.
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

      it("hashes an object with mixed value types", () => {
        const hash = hashBytesOf({
          str: "hello",
          num: 42,
          bool: true,
          nil: null,
        });
        expect(hash.length).toBe(32);
        // Consistency
        expect(hash).toEqual(
          hashBytesOf({ str: "hello", num: 42, bool: true, nil: null }),
        );
      });
    });
    describe("Consistency and distinctness", () => {
      it("produces the same hash for the same value every time", () => {
        expect(hashBytesOf(42)).toEqual(hashBytesOf(42));
        expect(hashBytesOf("hello")).toEqual(hashBytesOf("hello"));
        expect(hashBytesOf([1, 2, 3])).toEqual(hashBytesOf([1, 2, 3]));
        expect(hashBytesOf({ a: 1 })).toEqual(hashBytesOf({ a: 1 }));
      });

      it("produces a 32-byte hash (SHA-256)", () => {
        const values: FabricValue[] = [
          null,
          true,
          false,
          0,
          42,
          "",
          "hello",
          0n,
          127n,
          undefined,
          [],
          [1, 2],
          {},
          { a: 1 },
          new FabricEpochNsec(0n),
          new FabricEpochDay(0n),
          new FabricBytes(new Uint8Array([1])),
          new FabricUnavailable("pending"),
          FabricError.fromNativeError(new Error("x")),
        ];
        for (const v of values) {
          expect(hashBytesOf(v).length).toBe(32);
        }
      });

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
      it("hashes a deeply nested structure", () => {
        const deep = { a: { b: { c: { d: [1, { e: true }] } } } };
        const hash = hashBytesOf(deep);
        expect(hash.length).toBe(32);
        expect(hashBytesOf(deep)).toEqual(hash);
      });

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

      it("hashes a `FabricHash` inside a plain object without throwing", () => {
        // This captures the essence of using `FabricHash` instances as things
        // like content IDs inside `Fact` objects.
        const fact = {
          cause: new FabricHash(new Uint8Array([0x05, 0x06]), "fid1"),
          the: "text/plain",
          of: "entity:456",
          is: { value: 914 },
        };

        expect(() => hashOf(fact)).not.toThrow();
      });
    });
    describe("`FabricHash` result", () => {
      it("returns a `FabricHash` with the `fid1` tag", () => {
        const result = hashOf(42);
        expect(result).toBeInstanceOf(FabricHash);
        expect(result.tag).toBe("fid1");
        expect(result.length).toBe(32);
      });

      it("produces `fid1:<base64>` via `FabricHash.toString()`", () => {
        const result = hashOf(42);
        const str = result.toString();
        expect(str.startsWith("fid1:")).toBe(true);
        // Should not contain padding (unpadded base64).
        expect(str.includes("=")).toBe(false);
      });

      it("produces a frozen `FabricHash` (`FabricPrimitive`)", () => {
        const result = hashOf(42);
        expect(Object.isFrozen(result)).toBe(true);
      });
    });
  });

  describe("`hashOf()` caching", () => {
    it("returns the same precomputed-constant object for `null`", () => {
      const a = hashOf(null);
      const b = hashOf(null);
      expect(a).toBe(b);
    });

    it("returns the same precomputed-constant object for `undefined`", () => {
      const a = hashOf(undefined);
      const b = hashOf(undefined);
      expect(a).toBe(b);
    });

    it("returns the same precomputed-constant object for `true`", () => {
      const a = hashOf(true);
      const b = hashOf(true);
      expect(a).toBe(b);
    });

    it("returns the same precomputed-constant object for `false`", () => {
      const a = hashOf(false);
      const b = hashOf(false);
      expect(a).toBe(b);
    });

    it("returns the same cached object for a primitive string", () => {
      const a = hashOf("cache-test-string");
      const b = hashOf("cache-test-string");
      expect(a).toBe(b);
    });

    it("returns the same cached object for a primitive number", () => {
      const a = hashOf(98765);
      const b = hashOf(98765);
      expect(a).toBe(b);
    });

    it("returns the same cached object for a primitive `bigint`", () => {
      const a = hashOf(99887766n);
      const b = hashOf(99887766n);
      expect(a).toBe(b);
    });

    it("returns the same cached object for a deep-frozen object", () => {
      const obj = Object.freeze({ a: 1, b: Object.freeze({ c: 2 }) });
      const a = hashOf(obj);
      const b = hashOf(obj);
      expect(a).toBe(b);
    });

    it("does not cache a mutable object (recomputes each time)", () => {
      const obj = { a: 1 };
      const a = hashOf(obj);
      // Mutate
      obj.a = 2;
      const b = hashOf(obj);
      // Hashes should differ because the object changed
      expect(hex(a.bytes)).not.toEqual(hex(b.bytes));
    });

    it("produces different hashes for different primitives of the same type", () => {
      const a = hashOf("hello");
      const b = hashOf("world");
      expect(hex(a.bytes)).not.toEqual(hex(b.bytes));
    });
  });

  describe("`hashOf()` JS instances", () => {
    describe("Date", () => {
      it("hashes a JS `Date` without throwing", () => {
        const date = new Date("2024-01-01T00:00:00Z");
        const hash = hashBytesOf(date);
        expect(hash.length).toBe(32);
      });

      it("produces the same hash for a JS `Date` as for an equivalent `FabricEpochNsec`", () => {
        const date = new Date("2024-01-01T00:00:00Z");
        const nsec = BigInt(date.getTime()) * 1_000_000n;
        const dateHash = hex(hashBytesOf(date));
        const epochHash = hex(hashBytesOf(new FabricEpochNsec(nsec)));
        expect(dateHash).toBe(epochHash);
      });

      it("produces different hashes for different Dates", () => {
        const d1 = new Date("2024-01-01T00:00:00Z");
        const d2 = new Date("2025-06-15T12:00:00Z");
        expect(hex(hashBytesOf(d1))).not.toBe(hex(hashBytesOf(d2)));
      });
    });
    describe("RegExp", () => {
      it("hashes a JS `RegExp` without throwing", () => {
        const re = /hello/gi;
        const hash = hashBytesOf(re);
        expect(hash.length).toBe(32);
      });

      it("produces the same hash for a JS `RegExp` as for an equivalent `FabricRegExp`", () => {
        const re = /hello/gi;
        const nativeHash = hex(hashBytesOf(re));
        const fabricHash = hex(hashBytesOf(new FabricRegExp(re)));
        expect(nativeHash).toBe(fabricHash);
      });

      it("produces different hashes for different RegExps", () => {
        const r1 = /foo/;
        const r2 = /bar/;
        expect(hex(hashBytesOf(r1))).not.toBe(hex(hashBytesOf(r2)));
      });
    });
    describe("Uint8Array", () => {
      it("hashes a JS `Uint8Array` without throwing", () => {
        const buf = new Uint8Array([1, 2, 3]);
        const hash = hashBytesOf(buf);
        expect(hash.length).toBe(32);
      });

      it("produces the same hash for a JS `Uint8Array` as for a `FabricBytes` with the same bytes", () => {
        const bytes = new Uint8Array([10, 20, 30]);
        const nativeHash = hex(hashBytesOf(bytes));
        const fabricHash = hex(hashBytesOf(new FabricBytes(bytes)));
        expect(nativeHash).toBe(fabricHash);
      });

      it("produces different hashes for different Uint8Arrays", () => {
        const b1 = new Uint8Array([1, 2, 3]);
        const b2 = new Uint8Array([4, 5, 6]);
        expect(hex(hashBytesOf(b1))).not.toBe(hex(hashBytesOf(b2)));
      });
    });
    describe("Deferred types (not yet handled — these document known gaps)", () => {
      it("throws for `Map` (deferred — needs recursive translation)", () => {
        expect(() => hashOf(new Map([["a", 1]]))).toThrow(
          "unsupported object type",
        );
      });

      it("throws for `Set` (deferred — needs recursive translation)", () => {
        expect(() => hashOf(new Set([1, 2, 3]))).toThrow(
          "unsupported object type",
        );
      });

      it("throws for `Error` (deferred — needs recursive translation)", () => {
        expect(() => hashOf(new Error("test"))).toThrow(
          "unsupported object type",
        );
      });

      it("throws for a member that is a function", () => {
        // `toJSON` gets no special reading here either: it is a function-valued
        // member, and functions have no hash.
        const obj = { toJSON: () => "hello" };
        expect(() => hashOf(obj)).toThrow("unsupported type `function`");
      });
    });
  });

  describe("hashStringOf", () => {
    it("returns a string", () => {
      const result = hashStringOf(42);
      expect(typeof result).toBe("string");
    });

    it("matches `FabricHash.hashString` for primitives", () => {
      const values: FabricValue[] = [
        null,
        true,
        false,
        0,
        42,
        "",
        "hello",
        0n,
        127n,
        undefined,
      ];
      for (const v of values) {
        expect(hashStringOf(v)).toBe(hashOf(v).hashString);
      }
    });

    it("matches `FabricHash.hashString` for frozen objects", () => {
      const obj = Object.freeze({ a: 1, b: Object.freeze({ c: 2 }) });
      expect(hashStringOf(obj)).toBe(hashOf(obj).hashString);
    });

    it("matches `FabricHash.hashString` for mutable objects", () => {
      const obj = { x: [1, 2, 3] };
      expect(hashStringOf(obj)).toBe(hashOf(obj).hashString);
    });

    it("returns consistent results", () => {
      expect(hashStringOf("test")).toBe(hashStringOf("test"));
    });

    it("produces different strings for different values", () => {
      const a = hashStringOf(1);
      const b = hashStringOf(2);
      expect(a).not.toBe(b);
    });

    it("returns a result that does not contain the algorithm tag or colon", () => {
      const result = hashStringOf({ hello: "world" });
      expect(result.includes("fid1")).toBe(false);
      expect(result.includes(":")).toBe(false);
    });

    it("returns a valid unpadded base64url result", () => {
      const result = hashStringOf(42);
      // No padding characters.
      expect(result.includes("=")).toBe(false);
      // Only base64url characters.
      expect(/^[A-Za-z0-9_-]+$/.test(result)).toBe(true);
    });
  });

  describe("taggedHashStringOf", () => {
    it("returns a string", () => {
      const result = taggedHashStringOf(42);
      expect(typeof result).toBe("string");
    });

    it("returns a string that starts with a `tag:`", () => {
      const result = taggedHashStringOf(42);
      expect(result.startsWith("fid1:")).toBe(true);
    });

    it("returns a hash portion that matches that of `hashStringOf()`", () => {
      const value = 42;
      const result = taggedHashStringOf(value);
      const sansTag = result.replace(/^[a-z0-9]+:/, "");
      expect(sansTag).toBe(hashStringOf(value));
    });
  });

  describe("IncrementalHasher digest base64url", () => {
    it("returns a string", () => {
      const hasher = createHasher();
      hasher.update(new Uint8Array([1, 2, 3]));
      const result = hasher.digest("base64url");
      expect(typeof result).toBe("string");
    });

    it("matches manual base64url encoding of the raw digest", () => {
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

      const hasher1 = createHasher();
      hasher1.update(data);
      const rawDigest = hasher1.digest();

      const hasher2 = createHasher();
      hasher2.update(data);
      const b64Digest = hasher2.digest("base64url");

      expect(b64Digest).toBe(toUnpaddedBase64url(rawDigest));
    });

    it("returns a valid unpadded base64url result", () => {
      const hasher = createHasher();
      hasher.update(new Uint8Array([42]));
      const result = hasher.digest("base64url");
      expect(result.includes("=")).toBe(false);
      expect(/^[A-Za-z0-9_-]+$/.test(result)).toBe(true);
    });

    it("produces different base64url digests for different inputs", () => {
      const h1 = createHasher();
      h1.update(new Uint8Array([1]));
      const h2 = createHasher();
      h2.update(new Uint8Array([2]));
      expect(h1.digest("base64url")).not.toBe(h2.digest("base64url"));
    });
  });

  describe("`hashOf()` interned symbols", () => {
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

    it("throws for `Symbol(desc)` (unique / uninterned)", () => {
      expect(() => hashOf(Symbol("nope"))).toThrow(
        "Cannot hash unique (uninterned) symbol",
      );
    });

    it("also throws for a unique symbol nested in an object", () => {
      const value = { tag: Symbol("nope") };
      expect(() => hashOf(value)).toThrow(
        "Cannot hash unique (uninterned) symbol",
      );
    });
  });

  describe("float64BytesOf()", () => {
    // The function returns one buffer for every number other than `NaN`, and
    // writes into it on each call. So a case reads a result, as hex, before it
    // makes another call.

    it("returns the big-endian IEEE 754 bytes of a number", () => {
      expect(hex(float64BytesOfForTestingOnly(1))).toBe("3ff0000000000000");
      expect(hex(float64BytesOfForTestingOnly(-2.5))).toBe("c004000000000000");
    });

    it("returns different bytes for `-0` and `+0`", () => {
      expect(hex(float64BytesOfForTestingOnly(-0))).toBe("8000000000000000");
      expect(hex(float64BytesOfForTestingOnly(0))).toBe("0000000000000000");
    });

    it("returns the canonical quiet-`NaN` bytes for `NaN`", () => {
      expect(hex(float64BytesOfForTestingOnly(NaN))).toBe("7ff8000000000000");
    });

    it("returns an array for `NaN` which is not the one it returns for other numbers", () => {
      // This is the case that shows a `NaN`'s bytes are not read from the
      // value. The engine decides which bits a `NaN` has by the time it gets
      // here, so a case about the bytes of some particular `NaN` passes or
      // fails by engine. Which array comes back does not vary that way.

      const forNumber = float64BytesOfForTestingOnly(1);
      const forNaN = float64BytesOfForTestingOnly(NaN);

      expect(forNaN).not.toBe(forNumber);
      expect(float64BytesOfForTestingOnly(2)).toBe(forNumber);
    });

    it("returns the canonical quiet-`NaN` bytes for a `NaN` that has a payload", () => {
      // Where the engine canonicalizes the `NaN` before the call, this case
      // repeats the one for a plain `NaN`. Where the payload reaches the
      // function, this case fails if the function reads the bytes from the
      // value.

      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, 0x7ff8000000000001n, false);

      expect(hex(float64BytesOfForTestingOnly(view.getFloat64(0, false))))
        .toBe("7ff8000000000000");
    });
  });
});
