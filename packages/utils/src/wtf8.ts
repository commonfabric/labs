/** Shared UTF-8 encoder, for strings that are well-formed. */
const utf8Encoder = new TextEncoder();

/** Helper for {@link encodeWtf8}: Is the given code unit a low surrogate? */
function isLowSurrogate(unit: number): boolean {
  return (unit >= 0xdc00) && (unit <= 0xdfff);
}

/**
 * Encodes a string as WTF-8 (<https://wtf-8.codeberg.page/>). For a
 * well-formed string, which is to say one with no lone surrogates, the result
 * is the same as its UTF-8 encoding. A lone surrogate is encoded as the
 * three-byte sequence UTF-8 would use for a code point of the same value, where
 * `TextEncoder` substitutes the replacement character U+FFFD. So, unlike UTF-8,
 * this encoding is one-to-one: two strings encode to the same bytes if and only
 * if they are equal (`===`). The byte order of two encodings is the order of
 * the strings by code point, the same as `utf8Compare()`.
 *
 * The returned array is exact-sized and unshared -- the caller may mutate it
 * freely.
 */
export function encodeWtf8(value: string): Uint8Array<ArrayBuffer> {
  if (value.isWellFormed()) {
    return utf8Encoder.encode(value);
  }

  // No UTF-16 code unit takes more than three bytes: a character outside the
  // Basic Multilingual Plane takes four, but it is two code units long.
  const bytes = new Uint8Array(value.length * 3);
  let at = 0;
  let runStart = 0;

  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);

    if ((unit < 0xd800) || (unit > 0xdfff)) {
      continue;
    } else if ((unit <= 0xdbff) && isLowSurrogate(value.charCodeAt(i + 1))) {
      i++; // A pair, which `TextEncoder` encodes along with the run.
      continue;
    }

    // A lone surrogate. The run before it is well-formed, so `TextEncoder`
    // encodes it as it would on its own. The surrogate takes the three-byte
    // form of a code point of the same value, which starts `0xED` for every
    // surrogate.
    at += utf8Encoder.encodeInto(
      value.slice(runStart, i),
      bytes.subarray(at),
    ).written;
    bytes[at++] = 0xed;
    bytes[at++] = 0x80 | ((unit >> 6) & 0x3f);
    bytes[at++] = 0x80 | (unit & 0x3f);
    runStart = i + 1;
  }

  at += utf8Encoder.encodeInto(value.slice(runStart), bytes.subarray(at))
    .written;

  return (at === bytes.length) ? bytes : bytes.slice(0, at);
}
