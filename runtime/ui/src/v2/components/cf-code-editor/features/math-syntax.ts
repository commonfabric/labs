/**
 * The Markdown syntax of TeX formulas: `$…$` inline and `$$…$$` display. Each
 * formula is a node of the document's syntax tree, `InlineMath` or
 * `DisplayMath`, with a `MathMark` child for each delimiter, so no emphasis,
 * link or code inside it is parsed. It follows Pandoc: inline math neither
 * opens before a space nor closes after one, and a closing `$` followed by a
 * digit closes nothing, so `$5 and $6` stays text. `\$` is a literal dollar
 * sign. A formula stays within one paragraph, so a `$$` with no closing `$$`
 * before the next blank line stays text.
 *
 * The editor parses with this whenever it draws formulas, and `prose-math.ts`
 * draws the nodes it makes. Neither imports KaTeX, which the editor loads from
 * `katex-render.ts` only when it first draws math.
 */

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

/** The character code of `$`, which opens and closes a formula. */
const DOLLAR = 0x24;

/** The character code of `\`, which escapes the character after it. */
const BACKSLASH = 0x5c;

/** The syntax node of a `$…$` formula. */
export const INLINE_MATH = "InlineMath";

/** The syntax node of a `$$…$$` formula. */
export const DISPLAY_MATH = "DisplayMath";

/** Whether `code` is a space, a tab or a line break. */
function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Whether `code` is an ASCII digit. */
function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Helper for `parseMath`, which finds where the formula whose TeX starts at
 * `start` ends: the position of its closing `$`, or of the first `$` of its
 * closing `$$` when `display`, or `-1` when nothing in the inline section
 * closes it. A backslash escapes the character after it.
 */
function closingDollar(
  cx: InlineContext,
  start: number,
  display: boolean,
): number {
  if (!display && (start >= cx.end || isSpace(cx.char(start)))) return -1;
  for (let pos = start; pos < cx.end; pos++) {
    const code = cx.char(pos);
    if (code === BACKSLASH) {
      pos++;
      continue;
    }
    if (code !== DOLLAR || pos === start) continue;
    if (display) {
      if (cx.char(pos + 1) === DOLLAR) return pos;
    } else if (!isSpace(cx.char(pos - 1)) && !isDigit(cx.char(pos + 1))) {
      return pos;
    }
  }
  return -1;
}

/**
 * Parses the formula opening at `pos`, if one does. A `$$` that nothing
 * closes is consumed as text, so its second `$` cannot open inline math.
 */
function parseMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1;
  const display = cx.char(pos + 1) === DOLLAR;
  const delimiter = display ? 2 : 1;
  const close = closingDollar(cx, pos + delimiter, display);
  if (close === -1) return display ? pos + 2 : -1;
  const end = close + delimiter;
  return cx.addElement(
    cx.elt(display ? DISPLAY_MATH : INLINE_MATH, pos, end, [
      cx.elt("MathMark", pos, pos + delimiter),
      cx.elt("MathMark", close, end),
    ]),
  );
}

/** The Markdown parser extension that makes `$…$` and `$$…$$` formulas. */
export const mathMarkdown: MarkdownConfig = {
  defineNodes: [INLINE_MATH, DISPLAY_MATH, "MathMark"],
  parseInline: [{ name: "Math", parse: parseMath }],
};
