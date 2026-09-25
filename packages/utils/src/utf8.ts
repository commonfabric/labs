/**
 * UTF-8 helper functions.
 *
 * Note: UTF-8 sort order is the same as general Unicode code point sort order,
 * whereas UTF-16 sort order is _different_ because of the existence of
 * surrogate code points. Any time a string sort needs to be performed in a way
 * that is consistent across language platforms (e.g. work the same in a
 * JavaScript environment and a Rust environmentg), UTF-8 sorting is the way to
 * go. The unfortunate fact is that native JavaScript string sorting (`string1 <
 * string2`, etc.) is a UTF-16 sort.
 */

/**
 * `WeakMap` cache from frozen objects to already-calculated sorted keys. Used
 * by `utf8SortedKeysOf()`.
 */
const sortedKeyCache = new WeakMap<object, readonly string[]>();

/** Helper for `utf8Compare()`: Is the given character code a surrogate? */
function isSurrogateCharCode(c: number) {
  return (c >= 0xd800) && (c <= 0xdfff);
}

/**
 * Helper for `utf8Compare()`: Is the given character code a high (leading)
 * surrogate?
 */
function isHighSurrogateCharCode(c: number) {
  return (c >= 0xd800) && (c <= 0xdbff);
}

/**
 * Helper for `utf8Compare()`: Does the given string contain any surrogate code
 * points?
 */
function hasSurrogateCharCode(value: string) {
  return /[\ud800-\udfff]/.test(value);
}

/**
 * Compares strings by UTF-8 sort order, which is also Unicode code point
 * order. A lone surrogate sorts as the code point of the same value, which
 * makes this the byte order of the strings' WTF-8 encodings (see
 * `encodeWtf8()`).
 *
 * The order is by code point even where two strings share a high surrogate
 * that only one of them pairs. For example, `"\ud800\udc00"` is the single
 * character U+10000, encoded as `F0 90 80 80`, and `"\ud800\ue000"` is a lone
 * high surrogate followed by U+E000, encoded as `ED A0 80 EE 80 80`. The
 * second sorts first, because its first code point (`0xD800`) is less than
 * the first's (`0x10000`), even though at the first differing code unit the
 * first string's `0xDC00` is less than the second's `0xE000`.
 */
export function utf8Compare(a: string, b: string): number {
  // Credit where due: Though this started out as an independent implementation
  // of the key insight for fast sorting, this incorporates ideas from
  // <https://github.com/rocicorp/compare-utf8>.

  // Here's what's going on: JS native string sort and UTF-8 sort can differ
  // only when at least one of the JS-form strings contains a codepoint for a
  // surrogate-pair. As long as we don't run into one of those, we can just
  // do a regular difference-based comparison. But if we _do_ run into one, then
  // we have to do something extra, one way or another.

  if (a === b) {
    // Easy out!
    return 0;
  }

  const minCharLen = Math.min(a.length, b.length);

  if (
    (minCharLen >= 20) && !(hasSurrogateCharCode(a) || hasSurrogateCharCode(b))
  ) {
    // Strings are long enough that it's worth a preflight check for surrogate
    // pairs, and it turns out that neither had them.
    return (a < b) ? -1 : ((a > b) ? 1 : 0);
  }

  // No luck for us today. Gotta do it the hard way.

  for (let i = 0; i < minCharLen; i++) {
    const aChar = a.charCodeAt(i);
    const bChar = b.charCodeAt(i);
    if (aChar === bChar) {
      continue;
    } else if (!(isSurrogateCharCode(aChar) || isSurrogateCharCode(bChar))) {
      return aChar - bChar;
    } else {
      // At least one is a surrogate. Use `codePointAt()` to decode whichever of
      // the strings have surrogate characters. That method operates reasonably
      // whether or not the code point is in the basic or astral plane, and it
      // also returns a reasonable value given an invalid surrogate-pair
      // sequence. Importantly, Unicode code-point order corresponds to UTF-8
      // byte order.
      if (i > 0 && isHighSurrogateCharCode(a.charCodeAt(i - 1))) {
        // The strings share a high surrogate just before `i`, which each one
        // either pairs with what is at `i` or leaves alone. Where they differ
        // on that, the code points starting there are the ones that differ.
        const aPrevPoint = a.codePointAt(i - 1)!;
        const bPrevPoint = b.codePointAt(i - 1)!;
        if (aPrevPoint !== bPrevPoint) {
          return aPrevPoint - bPrevPoint;
        }
      }
      const aPoint = a.codePointAt(i)!;
      const bPoint = b.codePointAt(i)!;
      return aPoint - bPoint;
    }
  }

  return a.length - b.length;
}

/**
 * Produces a frozen array containing the ordered keys of the given object,
 * in UTF-8 sort order. If the given object is frozen, it gets cached for
 * possible reuse.
 */
export function utf8SortedKeysOf(value: object): readonly string[] {
  if (value === null) {
    throw new TypeError("Value must not be `null`.");
  }

  const cached = sortedKeyCache.get(value);
  if (cached !== undefined) {
    return cached;
  }

  // `Array.prototype.sort()` costs more to set up than the comparisons it
  // performs on a short array, and object keys usually arrive already in
  // order.
  const keys = Object.keys(value);
  let ordered = true;
  for (let at = 1; at < keys.length; at++) {
    if (utf8Compare(keys[at - 1]!, keys[at]!) > 0) {
      ordered = false;
      break;
    }
  }

  const sorted = Object.freeze(ordered ? keys : keys.sort(utf8Compare));

  if (Object.isFrozen(value)) {
    sortedKeyCache.set(value, sorted);
  }

  return sorted;
}
