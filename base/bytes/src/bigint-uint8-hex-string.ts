/**
 * Implementation of `bigint.ts` which uses the hex conversion methods of
 * `Uint8Array`. These only became part of the EcmaScript standard in 2025 and
 * so (as of this writing) cannot be relied on to exist in arbitrary JS
 * environments. This implementation also ends up using the "direct" tactics /
 * code for small lengths, where it has been measured to be a win.
 */

import {
  encode5To8Bytes,
  hexStringFromPositiveValue,
} from "./bigint-shared-impl.ts";
import { bigintFromMtcDirect } from "./bigint-uint8-direct.ts";

/**
 * Version of `bigintToMinimalTwosComplement()` which uses the `Uint8Array`
 * hex-string methods.
 */
export function bigintToMtcHex(value: bigint): Uint8Array {
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

    // Slow path for positive numbers, using string manipulation.

    const hexString = hexStringFromPositiveValue(value);
    return Uint8Array.fromHex(hexString);
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

    // Slow path for negative numbers, using string manipulation. We
    // ones-complement it before conversion to string, then undo the conversion
    // in the array result.

    const hexString = hexStringFromPositiveValue(~value);
    const result = Uint8Array.fromHex(hexString);
    const resultLength = result.length;

    if (resultLength < 128) {
      for (let i = 0; i < resultLength; i++) {
        result[i] = ~result[i]!;
      }
    } else {
      // At around 128 bytes (measured in benchmarks), it becomes faster to
      // construct a temporary `Uint32Array` just to complement four bytes at a
      // time. But we might have a little bit extra to do if the length isn't a
      // multiple of four.
      const byteRemainder = resultLength & 0x03;
      const resultUint32 = new Uint32Array(result.buffer, 0, resultLength >> 2);

      for (let i = 0; i < resultUint32.length; i++) {
        resultUint32[i] = ~resultUint32[i]!;
      }

      for (let i = resultLength - byteRemainder; i < resultLength; i++) {
        result[i] = ~result[i]!;
      }
    }

    return result;
  }
}

/**
 * Version of `bigintFromMinimalTwosComplement()` which uses the `Uint8Array`
 * hex-string methods.
 */
export function bigintFromMtcHex(bytes: Uint8Array): bigint {
  if (bytes.length <= 32) {
    return bigintFromMtcDirect(bytes);
  }

  const hexString = bytes.toHex();
  const positiveResult = BigInt(`0x${hexString}`);

  if (bytes[0]! <= 0x7f) {
    return positiveResult;
  } else {
    // Negative number. We make the initial positive result of conversion
    // negative by OR-ing on the sign bit.
    const signBit = -1n << (BigInt(bytes.length) * 8n);
    return positiveResult | signBit;
  }
}
