/**
 * Reads facts off JSON text without parsing it into a tree. Parsing builds
 * every value the text holds before a caller can look at any of them, so the
 * questions here -- how much the text would build, and what its root record
 * says about itself -- are answered by scanning the characters instead, at a
 * cost of one pass and no allocation proportional to the text.
 *
 * Both scans assume nothing about the text being well formed. On malformed
 * text they return an answer that is safe for their purpose rather than an
 * error; a parse of the same text is what reports the malformation.
 */

/** A scalar member of the record at the root of JSON text. */
export type RootScalar = null | boolean | number | string;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/** Returns the first 50 characters of `text`, marked when cut short. */
export function excerptOf(text: string): string {
  return (text.length <= 50) ? text : `${text.slice(0, 50)}...`;
}

/**
 * Indicates whether `text` writes more than `limit` array elements and record
 * members, counted wherever they appear. That is the number of values and keys
 * a parse of `text` would build, so a caller can refuse text before paying for
 * the parse. The scan stops as soon as the count passes `limit`.
 *
 * The count is exact for well-formed JSON: every comma outside a string
 * separates two elements or members, and every container that is not empty
 * holds one more than it has commas.
 */
export function writesMoreMembersThan(text: string, limit: number): boolean {
  let members = 0;
  let justOpened = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isWhitespace(code)) continue;
    if (justOpened) {
      justOpened = false;
      if (code !== CLOSE_BRACKET && code !== CLOSE_BRACE) {
        if (++members > limit) return true;
      }
    }
    if (code === QUOTE) {
      index = closingQuoteOf(text, index);
    } else if (code === OPEN_BRACKET || code === OPEN_BRACE) {
      justOpened = true;
    } else if (code === COMMA) {
      if (++members > limit) return true;
    }
  }
  return false;
}

/**
 * Returns the value of the member named `name` in the record at the root of
 * `text`, if that value is a scalar. Nothing else is parsed: every other member
 * is stepped over, and a key is compared as written unless it holds an escape.
 * Where the name appears more than once the last one counts, as for a parse.
 *
 * Returns `undefined` when the root is not a record, when the member is absent
 * or not a scalar, or when the text is malformed before the member is read.
 */
export function rootScalarOf(
  text: string,
  name: string,
): RootScalar | undefined {
  let found: RootScalar | undefined;
  try {
    let index = skipWhitespace(text, 0);
    if (text.charCodeAt(index) !== OPEN_BRACE) return undefined;
    index = skipWhitespace(text, index + 1);
    while (text.charCodeAt(index) === QUOTE) {
      const keyEnd = closingQuoteOf(text, index);
      const matches = keyMatches(text, index, keyEnd, name);
      index = skipWhitespace(text, keyEnd + 1);
      if (text.charCodeAt(index) !== COLON) break;
      const valueStart = skipWhitespace(text, index + 1);
      const valueEnd = endOfValue(text, valueStart);
      if (matches) {
        const first = text.charCodeAt(valueStart);
        found = first === OPEN_BRACKET || first === OPEN_BRACE
          ? undefined
          : JSON.parse(text.slice(valueStart, valueEnd));
      }
      index = skipWhitespace(text, valueEnd);
      if (text.charCodeAt(index) !== COMMA) break;
      index = skipWhitespace(text, index + 1);
    }
  } catch {
    // Malformed text: keep what was read before it.
  }
  return found;
}

/**
 * Indicates whether the string whose quotes are at `open` and `close` in `text`
 * is `name`. A string without escapes is compared in place; one with escapes
 * is parsed first.
 */
function keyMatches(
  text: string,
  open: number,
  close: number,
  name: string,
): boolean {
  for (let index = open + 1; index < close; index++) {
    if (text.charCodeAt(index) === BACKSLASH) {
      return JSON.parse(text.slice(open, close + 1)) === name;
    }
  }
  return close - open - 1 === name.length && text.startsWith(name, open + 1);
}

/**
 * Returns the index just past the value starting at `start`: past the
 * matching close of an array or record, past the closing quote of a string,
 * and otherwise at the next comma, close, or whitespace.
 */
function endOfValue(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      index = closingQuoteOf(text, index);
      if (depth === 0) return index + 1;
    } else if (code === OPEN_BRACKET || code === OPEN_BRACE) {
      depth++;
    } else if (code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      if (depth === 0) return index;
      if (--depth === 0) return index + 1;
    } else if (depth === 0 && (code === COMMA || isWhitespace(code))) {
      return index;
    }
  }
  return text.length;
}

/**
 * Returns the index of the quote closing the string whose opening quote is at
 * `open`, or the last index of `text` when the string is not closed. A quote is
 * escaped when an odd number of backslashes precede it, and each backslash is
 * looked at by at most one such check, so a scan stays linear in the text.
 */
function closingQuoteOf(text: string, open: number): number {
  let index = open;
  while (true) {
    index = text.indexOf('"', index + 1);
    if (index === -1) return text.length - 1;
    let backslashes = 0;
    while (text.charCodeAt(index - 1 - backslashes) === BACKSLASH) {
      backslashes++;
    }
    if (backslashes % 2 === 0) return index;
  }
}

/**
 * Returns the index of the first character at or after `index` that is not
 * JSON whitespace.
 */
function skipWhitespace(text: string, index: number): number {
  while (index < text.length && isWhitespace(text.charCodeAt(index))) index++;
  return index;
}

/** Indicates whether `code` is JSON whitespace. */
function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}
