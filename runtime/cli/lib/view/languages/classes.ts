/**
 * Lines colored from the token class of every character of a source. A
 * language decides each character's class, through a parser's query or its
 * own scanner, and this cuts the source into one display line per source line,
 * gives each bracket its nesting depth, and leaves the space between tokens
 * uncolored.
 */

import type { Line, Span, TokenClass } from "../model.ts";
import { cpLen } from "../ansi.ts";
import { computeLineStarts } from "../lines.ts";
import type { Highlighter } from "./language.ts";

/**
 * Color every line of `text` from the class of each of its characters. A
 * character with no class is plain.
 */
export function linesFromClasses(
  text: string,
  classes: readonly (TokenClass | undefined)[],
  lineStarts: number[] = computeLineStarts(text),
): Line[] {
  const classAt = (offset: number): TokenClass => {
    const claimed = classes[offset];
    if (!isWhitespace(text.charCodeAt(offset))) return claimed ?? "plain";
    // A class that spans several tokens, such as a whole type annotation,
    // covers the space between them; that space is not part of any token.
    return claimed !== undefined && LITERAL_CLASSES.has(claimed)
      ? claimed
      : "whitespace";
  };
  const lines: Line[] = [];
  let depth = 0;
  for (let line = 0; line < lineStarts.length; line++) {
    const start = lineStarts[line];
    const end = line + 1 < lineStarts.length
      ? lineStarts[line + 1] - 1
      : text.length;
    const spans: Span[] = [];
    let column = 0;
    let offset = start;
    while (offset < end) {
      const cls = classAt(offset);
      let next = offset + 1;
      if (cls !== "bracket") {
        while (next < end && classAt(next) === cls) next++;
      }
      const segment = text.slice(offset, next);
      if (cls === "bracket") {
        const opening = segment === "(" || segment === "[" || segment === "{";
        const bracketDepth = opening
          ? depth++
          : (depth = Math.max(0, depth - 1));
        spans.push({ col: column, text: segment, cls, bracketDepth });
      } else {
        spans.push({ col: column, text: segment, cls });
      }
      column += cpLen(segment);
      offset = next;
    }
    lines.push({ text: text.slice(start, end), spans });
  }
  return lines;
}

/** A highlighter that colors the whole text again on each update. */
export function createRecoloringHighlighter(
  initial: string,
  color: (text: string) => Line[],
): Highlighter {
  let text = initial;
  let lines = color(initial);
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      if (next === text) return lines;
      text = next;
      lines = color(next);
      return lines;
    },
  };
}

const WHITESPACE = /\s/;

/** Whether a UTF-16 code unit is white space, without a regular expression for
 * the ASCII range that almost every character falls in. */
function isWhitespace(code: number): boolean {
  if (code > 0x7f) return WHITESPACE.test(String.fromCharCode(code));
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/** Token classes whose text is content, so the space inside one belongs to it. */
const LITERAL_CLASSES: ReadonlySet<TokenClass> = new Set<TokenClass>([
  "string",
  "template",
  "regex",
  "comment",
  "docComment",
  "markdownQuote",
]);
