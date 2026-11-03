/**
 * How many columns of a terminal text takes, character by character as a
 * reader sees them, for any view that lines text up in columns.
 */

import { unicodeWidth } from "@std/cli/unicode-width";

const segmenter = new Intl.Segmenter();

/** The characters of `text` as a reader sees them. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
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
