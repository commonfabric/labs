import { backtickFence } from "@commonfabric/utils/markdown";

import { toCompactDebugString, toIndentedDebugString } from "./impl.ts";
import { DEBUG_STR_SIZE_WORDS, DEBUG_STR_WORDS } from "./interface.ts";
import { parseDebugStrDirective } from "./parseDebugStrDirective.ts";

/** A size word of a directive. */
type SizeWord = (typeof DEBUG_STR_SIZE_WORDS)[number];

/** Length a compact rendering is cut to, by size word. */
const MAX_CHARACTERS: Readonly<Record<SizeWord, number>> = Object.freeze({
  short: 50,
  long: 500,
  xlong: 5000,
});

/** Number of lines an indented rendering is cut to, by size word. */
const MAX_LINES: Readonly<Record<SizeWord, number>> = Object.freeze({
  short: 5,
  long: 50,
  xlong: 500,
});

/**
 * One template string of a call site along with what to do with the
 * substitution after it: the text to emit, how to convert the substituted
 * value, and whether the converted value is a block, which goes on lines of
 * its own.
 */
type Piece = {
  readonly text: string;
  readonly convert: (value: unknown) => string;
  readonly isBlock: boolean;
};

/** The pieces of each call site seen, which are parsed once per site. */
const piecesBySite = new WeakMap<TemplateStringsArray, readonly Piece[]>();

/**
 * Converts a value the way an ordinary template substitution does, except
 * that a value which cannot be converted that way gets its default debug
 * rendering.
 */
function convertPlainly(value: unknown): string {
  try {
    return String(value);
  } catch {
    return toCompactDebugString(value, { maxLength: MAX_CHARACTERS.short });
  }
}

/** Returns `text` cut to its first `maxLines` lines, with a note of the cut. */
function cutToLines(text: string, maxLines: number): string {
  const lines = text.split("\n");

  if (lines.length <= maxLines) {
    return text;
  }

  return [...lines.slice(0, maxLines), `... lines: ${lines.length}`].join("\n");
}

/** Makes the piece for a template string which ends in the given directive. */
function pieceForDirective(text: string, words: readonly string[]): Piece {
  const has = (word: string): boolean => words.includes(word);
  const size = DEBUG_STR_SIZE_WORDS.findLast(has) ?? "short";
  const isQuoted = has("quote");

  if (has("indent")) {
    const maxLines = MAX_LINES[size];
    return {
      text,
      isBlock: isQuoted,
      convert: (value) => {
        const rendered = cutToLines(toIndentedDebugString(value), maxLines);
        return isQuoted ? backtickFence(rendered) : rendered;
      },
    };
  }

  const options = {
    maxLength: MAX_CHARACTERS[size],
    backtickQuote: isQuoted,
  };
  return {
    text,
    isBlock: false,
    convert: (value) => toCompactDebugString(value, options),
  };
}

/** Parses the template strings of a call site into its pieces. */
function parsePieces(strings: TemplateStringsArray): readonly Piece[] {
  const known: readonly string[] = DEBUG_STR_WORDS;

  return strings.raw.map((raw, index) => {
    // A template string holding an invalid escape has no cooked form.
    const cooked = strings[index] ?? raw;
    const isLast = index === (strings.length - 1);
    const directive = isLast ? undefined : parseDebugStrDirective(raw);

    if (directive === undefined) {
      return { text: cooked, convert: convertPlainly, isBlock: false };
    } else if (!directive.words.every((word) => known.includes(word))) {
      // The directive stays in the text, where the unknown word can be seen.
      return pieceForDirective(cooked, []);
    } else {
      return pieceForDirective(
        cooked.slice(0, -directive.length),
        directive.words,
      );
    }
  });
}

/**
 * Template tag for composing a diagnostic message. A substitution is converted
 * the way a template literal converts one, except that the conversion never
 * throws, and except where a _directive_ comes right before it: a dollar sign
 * and one or more comma-separated words, as in `$quote,long${value}`. A
 * directive is removed from the text, and the value after it gets a debug
 * rendering:
 *
 * - With no `indent`, the rendering is that of `toCompactDebugString()`, cut
 *   to 50 characters, or with `long` to 500, or with `xlong` to 5000; `short`
 *   names the default. With `quote` it is quoted as a Markdown code span.
 * - With `indent`, the rendering is that of `toIndentedDebugString()`, cut to
 *   5 lines, or with `long` to 50, or with `xlong` to 500, a cut rendering
 *   ending in a line which says how many lines there were. With `quote` it is
 *   quoted as a Markdown fenced code block, on lines of its own.
 *
 * A backslash before the dollar sign, as in `\$quote${value}`, makes the text
 * literal and the substitution an ordinary one. A directive holding a word
 * other than those named here is left in the text, and the value after it gets
 * the default debug rendering; the `cf-debug-str/valid-directive` lint rule
 * reports one.
 *
 * As with the renderers it calls, how a value renders is not a contract.
 */
export function debugStr(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): string {
  let pieces = piecesBySite.get(strings);
  if (pieces === undefined) {
    pieces = parsePieces(strings);
    piecesBySite.set(strings, pieces);
  }

  let result = "";
  let afterBlock = false;

  pieces.forEach((piece, index) => {
    const hasValue = index < values.length;

    // A block's closing fence is followed by a line break, unless the text
    // supplies one or nothing at all comes after the block.
    if (
      afterBlock && !piece.text.startsWith("\n") &&
      ((piece.text !== "") || hasValue)
    ) {
      result += "\n";
    }
    result += piece.text;
    afterBlock = false;

    if (hasValue) {
      // A block's opening fence starts a line.
      if (piece.isBlock && (result !== "") && !result.endsWith("\n")) {
        result += "\n";
      }
      result += piece.convert(values[index]);
      afterBlock = piece.isBlock;
    }
  });

  return result;
}
