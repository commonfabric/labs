/**
 * LEB128 (Little Endian Base 128) variable-length integer encoding, in both
 * its unsigned and signed forms.
 *
 * Derived from the `leb` npm package by Dan Bornstein et alia.
 *
 * Original: https://www.npmjs.com/package/leb
 * Copyright 2012-2024 the Leb Authors (Dan Bornstein et alia).
 * SPDX-License-Identifier: Apache-2.0
 */

/** Maximum value encodable with 32-bit bitwise operations. */
const MAX_UINT32 = 0xFFFFFFFF;

/**
 * Encodes a non-negative integer as unsigned LEB128. Throws if `value` is
 * negative, non-integer, or beyond the unsigned 32-bit range, that range
 * being what the JavaScript bitwise operators used here can carry.
 */
export function encodeULEB128(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(
      `\`encodeULEB128()\`: expected non-negative integer, got \`${value}\``,
    );
  }
  if (value > MAX_UINT32) {
    throw new Error(
      `\`encodeULEB128()\`: value \`${value}\` exceeds 32-bit range ` +
        `(max \`${MAX_UINT32}\`)`,
    );
  }

  if (value === 0) {
    return new Uint8Array([0]);
  }

  const bytes: number[] = [];
  let remaining = value;

  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) {
      byte |= 0x80; // Set high bit to indicate more bytes follow.
    }
    bytes.push(byte);
  }

  return new Uint8Array(bytes);
}

/** Result of decoding an LEB128-encoded value. */
export interface DecodeResult {
  /** The decoded value. */
  value: number;

  /** The index of the first byte after the encoded value. */
  nextIndex: number;
}

/**
 * Decodes an unsigned LEB128 value from `buffer`, starting at `index`. Throws
 * if the buffer runs out mid-encoding, or if the encoded value is beyond the
 * unsigned 32-bit range.
 */
export function decodeULEB128(
  buffer: Uint8Array,
  index = 0,
): DecodeResult {
  let result = 0;
  let shift = 0;
  let byte: number;

  do {
    if (index >= buffer.length) {
      throw new Error("`decodeULEB128()`: unexpected end of `buffer`");
    }
    byte = buffer[index]!;
    // At shift 28, only 4 bits remain in a 32-bit value; reject if
    // the payload bits would overflow.
    if (shift >= 28 && (byte & 0x7f) > 0x0f) {
      throw new Error("`decodeULEB128()`: value exceeds 32-bit range");
    }
    if (shift >= 35) {
      throw new Error("`decodeULEB128()`: value exceeds 32-bit range");
    }
    result |= (byte & 0x7f) << shift;
    shift += 7;
    index++;
  } while (byte & 0x80);

  return { value: result >>> 0, nextIndex: index };
}

/** Minimum value of the signed 32-bit range. */
const MIN_INT32 = -0x80000000;

/** Maximum value of the signed 32-bit range. */
const MAX_INT32 = 0x7FFFFFFF;

/**
 * Encodes a signed integer as signed LEB128. Throws if `value` is non-integer
 * or outside the signed 32-bit range.
 */
export function encodeSLEB128(value: number): Uint8Array {
  if (!Number.isInteger(value)) {
    throw new Error(`\`encodeSLEB128()\`: expected integer, got \`${value}\``);
  }
  if (value < MIN_INT32 || value > MAX_INT32) {
    throw new Error(
      `\`encodeSLEB128()\`: value \`${value}\` exceeds signed 32-bit range ` +
        `(\`${MIN_INT32}..${MAX_INT32}\`)`,
    );
  }

  const bytes: number[] = [];
  let more = true;

  while (more) {
    let byte = value & 0x7f;
    value >>= 7;

    // If the sign bit of the current byte (bit 6) matches the remaining
    // value, we're done. For positive numbers, remaining must be 0 and
    // bit 6 must be 0. For negative, remaining must be -1 and bit 6
    // must be 1.
    if (
      (value === 0 && (byte & 0x40) === 0) ||
      (value === -1 && (byte & 0x40) !== 0)
    ) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }

  return new Uint8Array(bytes);
}

/**
 * Decodes a signed LEB128 value from `buffer`, starting at `index`. Throws if
 * the buffer runs out mid-encoding, or if the encoded value is beyond the
 * signed 32-bit range.
 */
export function decodeSLEB128(
  buffer: Uint8Array,
  index = 0,
): DecodeResult {
  let result = 0;
  let shift = 0;
  let byte: number;

  do {
    if (index >= buffer.length) {
      throw new Error("`decodeSLEB128()`: unexpected end of `buffer`");
    }
    byte = buffer[index]!;
    if (shift >= 35) {
      throw new Error("`decodeSLEB128()`: value exceeds signed 32-bit range");
    }
    result |= (byte & 0x7f) << shift;
    shift += 7;
    index++;
  } while (byte & 0x80);

  // Sign-extend if the sign bit (bit 6 of the last byte) is set.
  if (shift < 32 && (byte & 0x40) !== 0) {
    result |= -(1 << shift);
  }

  return { value: result, nextIndex: index };
}
