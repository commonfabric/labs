/** Reusable 8-byte buffer for float64 encoding. */
const f64Buf = new ArrayBuffer(8);

/** Float64 "view" of `f64Buf`. */
const f64View = new DataView(f64Buf);

/** Byte-array "view" of `f64Buf`. */
const f64Bytes = new Uint8Array(f64Buf);

/**
 * Canonical quiet-NaN payload (big-endian `7F F8 00 00 00 00 00 00`). All NaN
 * bit patterns hash to this single representation.
 */
const CANONICAL_NAN_BYTES = new Uint8Array([
  0x7f,
  0xf8,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
]);

/**
 * Returns the eight bytes that represent the given number in a hash, which are
 * its big-endian IEEE 754 form. Every `NaN` gets `CANONICAL_NAN_BYTES`, and
 * those are not read from the value, so whichever bits an engine holds for a
 * `NaN` have no effect on a hash.
 *
 * The result is good until the next call. For every value other than `NaN`, it
 * is the one buffer this function writes into each time.
 *
 * @internal Not in the `value-hash` barrel; `for-testing-only.ts` offers it to
 * tests.
 */
export function float64BytesOf(value: number): Uint8Array {
  if (Number.isNaN(value)) {
    return CANONICAL_NAN_BYTES;
  }

  f64View.setFloat64(0, value, false); // big-endian
  return f64Bytes;
}
