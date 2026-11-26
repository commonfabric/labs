/**
 * How many columns of a terminal text takes, character by character as a
 * reader sees them, for any view that lines text up in columns.
 */

import { unicodeWidth } from "@std/cli/unicode-width";
import { stripAnsi } from "./ansi.ts";

const segmenter = new Intl.Segmenter();

/** The characters of `text` as a reader sees them. */
export function graphemes(text: string): string[] {
  // Stepping from segment to segment is much faster than iterating over
  // them.
  const segments = segmenter.segment(text);
  const out: string[] = [];
  for (let found = segments.containing(0); found;) {
    out.push(found.segment);
    found = segments.containing(found.index + found.segment.length);
  }
  return out;
}

/** The UTF-16 indices at which the character of `text` as a reader sees it
 * that holds the code unit at `index` starts and ends. */
export function graphemeAt(
  text: string,
  index: number,
): { start: number; end: number } {
  const found = segmenter.segment(text).containing(index);
  return found
    ? { start: found.index, end: found.index + found.segment.length }
    : { start: text.length, end: text.length };
}

/**
 * How many columns `text` takes. An emoji made of several code points, such
 * as one asking for emoji presentation, one with a skin tone, a flag, or
 * emoji joined into one, takes two, as terminals draw them.
 */
export function columns(text: string): number {
  let total = 0;
  for (const char of graphemes(text)) total += charColumns(char);
  return total;
}

/** How many columns `text` takes once its ANSI escapes are removed. */
export function visibleWidth(text: string): number {
  return columns(stripAnsi(text));
}

/** How many columns the one character `char` takes. */
export function charColumns(char: string): number {
  return [...char].length > 1 && EMOJI.test(char) ? 2 : unicodeWidth(char);
}

/**
 * A code point that makes a character of several an emoji: a pictograph,
 * a flag's letter, or a keycap. A presentation selector alone does not,
 * since terminals draw `a` and a selector as one column.
 */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/**
 * The cells of a terminal that `text` fills, from left to right: each
 * character in the first cell it takes, followed by an empty string for each
 * further cell it takes, as a wide character does. A character that takes no
 * column, such as a combining mark with nothing before it, is drawn on a
 * space of its own.
 */
export function cells(text: string): string[] {
  const out: string[] = [];
  for (const char of graphemes(text)) {
    const width = charColumns(char);
    out.push(width === 0 ? ` ${char}` : char);
    for (let i = 1; i < width; i++) out.push("");
  }
  return out;
}
