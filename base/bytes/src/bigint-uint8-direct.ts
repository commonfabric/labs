/**
 * Implementation of `bigint.ts` which directly / algorithmically constructs and
 * parses `Uint8Array`s.
 */

import {
  byteValueAt,
  encode5To8Bytes,
  hexStringFromPositiveValue,
} from "./bigint-shared-impl.ts";

/**
 * Direct-`Uint8Array`-construction version of
 * `bigintToMinimalTwosComplement()`.
 */
export function bigintToMtcDirect(value: bigint): Uint8Array {
  if (value >= 0n) {
    if (value <= 0x7fff_ffffn) {
      const num = Number(value);
      if (num <= 0x7fff) {
        if (num <= 0x7f) {
          const result = new Uint8Array(1);
          result[0] = num;
          return result;
        } else {
          const result = new Uint8Array(2);
          result[0] = num >> 8;
          result[1] = num;
          return result;
        }
      } else {
        if (num <= 0x7f_ffff) {
          const result = new Uint8Array(3);
          result[0] = num >> 16;
          result[1] = num >> 8;
          result[2] = num;
          return result;
        } else {
          const result = new Uint8Array(4);
          result[0] = num >> 24;
          result[1] = num >> 16;
          result[2] = num >> 8;
          result[3] = num;
          return result;
        }
      }
    } else if (value <= 0x7fff_ffff_ffff_ffffn) {
      return encode5To8Bytes(value, false);
    }

    // Slow path for positive numbers: This stringifies and then parses back the
    // `value`, to work around JS's very limited set of `bigint` functionality.
    // If and when the TC39 BigInt Math proposal lands, this code could be
    // reworked to be much more performant. See:
    // <https://github.com/tc39/proposal-bigint-math>.

    const hex = hexStringFromPositiveValue(value);

    // Note: When it is widely-enough available, we will be able to say `return
    // Uint8Array.fromHex(hex)` here and probably see a major performance
    // improvement.

    const bytes = new Uint8Array(hex.length >> 1);

    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = byteValueAt(hex, i * 2);
    }

    return bytes;
  } else {
    if (value >= -0x8000_0000n) {
      const num = Number(value);
      if (num >= -0x8000) {
        if (num >= -0x80) {
          const result = new Uint8Array(1);
          result[0] = num;
          return result;
        } else {
          const result = new Uint8Array(2);
          result[0] = num >> 8;
          result[1] = num;
          return result;
        }
      } else {
        if (num >= -0x80_0000) {
          const result = new Uint8Array(3);
          result[0] = num >> 16;
          result[1] = num >> 8;
          result[2] = num;
          return result;
        } else {
          const result = new Uint8Array(4);
          result[0] = num >> 24;
          result[1] = num >> 16;
          result[2] = num >> 8;
          result[3] = num;
          return result;
        }
      }
    } else if (value >= -0x8000_0000_0000_0000n) {
      return encode5To8Bytes(value, true);
    }

    // Slow path for negative numbers. See above for details. The extra twist
    // here is that we need to end up with a string that correctly represents
    // `value` as a twos-complement negative value. The trick we do here is
    // convert the _ones_-complement of `value` to a string, and then undo it
    // byte-by-byte when storing the result.

    const hex = hexStringFromPositiveValue(~value);
    const bytes = new Uint8Array(hex.length >> 1);

    for (let i = 0; i < bytes.length; i++) {
      // `0xff ^ value` to undo the ones-complement in `~value` above.
      bytes[i] = 0xff ^ byteValueAt(hex, i * 2);
    }

    return bytes;
  }
}

/**
 * Direct-`Uint8Array`-construction version of
 * `bigintFromMinimalTwosComplement()`.
 */
export function bigintFromMtcDirect(bytes: Uint8Array): bigint {
  switch (bytes.length) {
    case 0: {
      throw new Error("`bigintFromMinimalTwosComplement()`: empty input");
    }

    case 1: {
      // `(x << 24) >> 24` to sign extend. Similar below.
      return BigInt((bytes[0]! << 24) >> 24);
    }

    case 2: {
      return BigInt(((bytes[0]! << 24) | (bytes[1]! << 16)) >> 16);
    }

    case 3: {
      return BigInt(
        ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8)) >> 8,
      );
    }

    case 4: {
      return BigInt(
        (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
      );
    }

    case 5: {
      const subResult1 = BigInt(
        (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
      );
      const subResult2 = BigInt(bytes[4]!);
      return (subResult1 << 8n) | subResult2;
    }

    case 6: {
      const subResult1 = BigInt(
        (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
      );
      const subResult2 = BigInt((bytes[4]! << 8) | bytes[5]!);
      return (subResult1 << 16n) | subResult2;
    }

    case 7: {
      const subResult1 = BigInt(
        (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
      );
      const subResult2 = BigInt(
        (bytes[4]! << 16) | (bytes[5]! << 8) | bytes[6]!,
      );
      return (subResult1 << 24n) | subResult2;
    }

    case 8: {
      const subResult1 = BigInt(
        (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
      );
      const subResult2 = BigInt(
        (bytes[4]! << 24) | (bytes[5]! << 16) | (bytes[6]! << 8) | bytes[7]!,
      ) & 0xffff_ffffn;
      return (subResult1 << 32n) | subResult2;
    }
  }

  // Slow path.

  // Determine sign from the high bit of the first byte.
  const negative = (bytes[0]! & 0x80) !== 0;

  // Count of partial-`int64` bytes.
  const partials = bytes.length & 7;

  let result;

  // This calculates the high-order "partial" `int64`, if any. We waste a little
  // bit of work in cases where the partial count isn't a multiple of `4`, but
  // it's worth it for the simplicity (and is at worst negligible in time cost).
  if (partials === 0) {
    result = negative ? -1n : 0n;
  } else if (partials <= 4) {
    const partial = BigInt(
      (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
    );
    result = partial >> BigInt(32 - (partials * 8));
  } else {
    const partial1 = BigInt(
      (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!,
    );
    const partial2 = BigInt(
      (bytes[4]! << 24) | (bytes[5]! << 16) | (bytes[6]! << 8) | bytes[7]!,
    ) & 0xffff_ffffn;
    result = ((partial1 << 32n) | partial2) >> BigInt(64 - (partials * 8));
  }

  // Possibly surprising test here: Benchmarks indicate that V8 (and assumed to
  // be similar in other JS VMs) has internal optimizations for left-shift on
  // large positive numbers but _not_ large negative numbers. The cross-over
  // point of this code was measured to be at 128 bytes for negative numbers.
  if (!negative || (bytes.length <= 128)) {
    // Note: Over ~1024 bytes, benchmarks indicate there is a win to be had by
    // using a `DataView` to extract `uint64`s from `bytes`.
    for (let i = partials; i < bytes.length; i += 8) {
      const subResult1 = BigInt(
        (bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) |
          bytes[i + 3]!,
      ) & 0xffff_ffffn;
      const subResult2 = BigInt(
        (bytes[i + 4]! << 24) | (bytes[i + 5]! << 16) |
          (bytes[i + 6]! << 8) |
          bytes[i + 7]!,
      ) & 0xffff_ffffn;
      result = (result << 64n) | (subResult1 << 32n) | subResult2;
    }

    return result;
  } else {
    // Negative and large enough to feel the pain of an unoptimized `bigint`
    // left shift. This uses uses a similar ones-complement trick as is done in
    // the encoder function, above, so that we operate on positive `bigint`s
    // within the loop.

    result = ~result; // Because the `partials` calc made it negative.

    for (let i = partials; i < bytes.length; i += 8) {
      const subResult1 = BigInt(
        ~((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) |
          bytes[i + 3]!),
      ) & 0xffff_ffffn;
      const subResult2 = BigInt(
        ~((bytes[i + 4]! << 24) | (bytes[i + 5]! << 16) |
          (bytes[i + 6]! << 8) |
          bytes[i + 7]!),
      ) & 0xffff_ffffn;
      result = (result << 64n) | (subResult1 << 32n) | subResult2;
    }

    return ~result;
  }
}
