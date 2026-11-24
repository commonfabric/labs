/** Helpers for both `bigint` codec implementations. */

/** Shared 8-byte scratch buffer. */
const dv64Buf = new ArrayBuffer(8);

/** `DataView` of `dv64buf`. */
const dv64View = new DataView(dv64Buf);

/** `Uint8Array` view of `dv64buf`. */
const dv64Bytes = new Uint8Array(dv64Buf);

/**
 * Converts a hex digit at a particular index in a string to its 4-bit
 * (nibble-sized) numeric value. Handles '0'-'9' (0x30-0x39) and 'a'-'f'
 * (0x61-0x66).
 */
export function nibbleValueAt(hex: string, at: number): number {
  const c = hex.charCodeAt(at);

  // '0'-'9' = 0x30-0x39, 'a'-'f' = 0x61-0x66
  return c < 0x3a ? c - 0x30 : c - 0x57;
}

/**
 * Converts a pair of hex digits at a particular index in a string to its 8-bit
 * (byte-sized) numeric value. Handles '0'-'9' (0x30-0x39) and 'a'-'f'
 * (0x61-0x66).
 */
export function byteValueAt(hex: string, at: number): number {
  return (nibbleValueAt(hex, at) << 4) | nibbleValueAt(hex, at + 1);
}

/**
 * Converts a positive `bigint` to a hex string with an even number of digits,
 * _and_ a leading `00` if it would otherwise be interpreted as a negative
 * number in twos-complement.
 */
export function hexStringFromPositiveValue(value: bigint): string {
  const hex = value.toString(16);
  if ((hex.length & 1) === 1) {
    // Round up to an even number of nibbles.
    return "0" + hex;
  } else if (nibbleValueAt(hex, 0) >= 8) {
    // Add an extra `0x00` byte, because the high-order bit would otherwise
    // be `1` and therefore the encoded result would be negative, which
    // would be wrong.
    return "00" + hex;
  } else {
    return hex;
  }
}

/** Converts a value that fits into 64 bits and requires `length >= 5`. */
export function encode5To8Bytes(value: bigint, negative: boolean): Uint8Array {
  const skipByte = negative ? 0xff : 0x00;
  const signBit = skipByte & 0x80;

  dv64View.setBigInt64(0, value, false); // `false` means big-endian.

  // Note: Loop necessarily ends before running off the end of the array
  // because by virtue of the caller's up-front check, there's definitely a
  // non-skipped byte).
  for (let i = 0; true; i++) {
    const byte = dv64Bytes[i]!;
    if (byte !== skipByte) {
      // Adjust starting index backwards if the non-skipped byte would flip
      // the sign of the result.
      return ((byte & 0x80) === signBit)
        ? dv64Bytes.slice(i)
        : dv64Bytes.slice(i - 1);
    }
  }
}
