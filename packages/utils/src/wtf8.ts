/** Shared UTF-8 encoder, for strings that are well-formed. */
const utf8Encoder = new TextEncoder();

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

  for (let i = 0; i < value.length; i++) {
    // `codePointAt()` combines a surrogate pair, and returns a lone surrogate
    // as itself.
    const codePoint = value.codePointAt(i)!;
    if (codePoint < 0x80) {
      bytes[at++] = codePoint;
    } else if (codePoint < 0x800) {
      bytes[at++] = 0xc0 | (codePoint >> 6);
      bytes[at++] = 0x80 | (codePoint & 0x3f);
    } else if (codePoint < 0x10000) {
      bytes[at++] = 0xe0 | (codePoint >> 12);
      bytes[at++] = 0x80 | ((codePoint >> 6) & 0x3f);
      bytes[at++] = 0x80 | (codePoint & 0x3f);
    } else {
      bytes[at++] = 0xf0 | (codePoint >> 18);
      bytes[at++] = 0x80 | ((codePoint >> 12) & 0x3f);
      bytes[at++] = 0x80 | ((codePoint >> 6) & 0x3f);
      bytes[at++] = 0x80 | (codePoint & 0x3f);
      i++; // The pair's second code unit.
    }
  }

  return bytes.slice(0, at);
}
