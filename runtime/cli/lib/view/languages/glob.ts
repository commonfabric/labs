/**
 * Colors for the path patterns Git matches files with, and for the patterns of
 * Docker's ignore files, which Go's `filepath.Match` decides the validity of
 * and Docker matches as Go regular expressions. `*` and `?` are wildcards, `/`
 * separates directories, a backslash escapes the next character, and a
 * bracket expression matches one character from a set. Every other character
 * is literal.
 *
 * A bracket expression runs to the first `]` after its first member that no
 * backslash escapes and no `[:name:]` class holds. A `[` that ends a range,
 * as in `[a-[]`, opens no class, and a class whose name the tool does not
 * know makes the expression invalid. In Go's syntax, only `^` negates an
 * expression, a class name runs to the first `:]` and may start with a `^` that
 * negates the class, a `]` or `-` where a member starts makes the expression
 * invalid unless a class comes before the `-`, and so does a range that ends in
 * an unescaped `-` or runs backwards. Those are
 * the only checks the Go syntax makes of what Docker accepts; it does not
 * check Go's escapes, nor follow Docker's rewriting of a `*` or `?` inside a
 * bracket expression into an expression of its own. Git
 * matches nothing with a pattern that holds a `[` with no valid closing `]`,
 * and Docker rejects such a pattern; that `[`, and every later `[` in the
 * pattern, is colored as literal, which keeps the time spent on a pattern in
 * proportion to its length. A backslash at the end of a pattern, which both
 * tools reject too, is colored as literal.
 */

import type { TokenClass } from "../model.ts";

/** The character classes Git's wildmatch knows, which Go knows as well. */
const GIT_CLASSES: ReadonlySet<string> = new Set([
  "alnum",
  "alpha",
  "blank",
  "cntrl",
  "digit",
  "graph",
  "lower",
  "print",
  "punct",
  "space",
  "upper",
  "xdigit",
]);

/** The character classes Go's regular expressions know. */
const GO_CLASSES: ReadonlySet<string> = new Set([
  ...GIT_CLASSES,
  "ascii",
  "word",
]);

/**
 * Sets the token class of each character of the pattern that runs from
 * `start` to `end` in `text`: `regex` for a wildcard or a whole bracket
 * expression, `punctuation` for a separator or an escaping backslash, and
 * `string` for a literal character. `syntax` names whose bracket expressions
 * the pattern uses.
 */
export function colorGlob(
  text: string,
  classes: (TokenClass | undefined)[],
  start: number,
  end: number,
  syntax: "git" | "go",
): void {
  let brackets = true;
  // In Go's syntax, the position of the last `:]` in the pattern, which a
  // class name that runs past a `]` ends at, or -1.
  let lastClassEnd = -1;
  if (syntax === "go") {
    for (let at = start; at + 1 < end; at++) {
      if (text[at] === ":" && text[at + 1] === "]") lastClassEnd = at;
    }
  }
  let at = start;
  while (at < end) {
    const c = text[at];
    if (c === "\\" && at + 1 < end) {
      classes[at++] = "punctuation";
      classes[at++] = "string";
      continue;
    }
    if (c === "[" && brackets) {
      const close = bracketEnd(
        text,
        at,
        end,
        syntax === "go" ? lastClassEnd : undefined,
      );
      if (close > at) {
        classes.fill("regex", at, close);
        at = close;
        continue;
      }
      brackets = false;
    }
    classes[at++] = c === "*" || c === "?"
      ? "regex"
      : c === "/"
      ? "punctuation"
      : "string";
  }
}

/**
 * Helper for {@link colorGlob}, which finds the end of the bracket expression
 * that opens at `open`: the position after its closing `]`, or -1 when no `]`
 * before `end` closes it. Go's syntax is selected by `lastClassEnd`, the
 * position of the pattern's last `:]` or -1, and Git's by its absence.
 */
function bracketEnd(
  text: string,
  open: number,
  end: number,
  lastClassEnd?: number,
): number {
  const go = lastClassEnd !== undefined;
  let at = open + 1;
  if (at < end && (text[at] === "^" || (!go && text[at] === "!"))) at++;
  // The code point of the member before `at` when that member is one
  // character, which a `-` after it makes the low end of a range, or -1.
  let low = -1;
  if (at < end && text[at] === "]") {
    if (go) return -1;
    low = 0x5d;
    at++;
  }
  // Whether a class has come before `at`, after which Go reads a `-` as a
  // member.
  let afterClass = false;
  // No `[:` before this position opens a class.
  let noClassBefore = at;
  while (at < end) {
    const c = text[at];
    if (c === "]") return at + 1;
    if (c === "-" && low >= 0 && at + 1 < end && text[at + 1] !== "]") {
      const escaped = text[at + 1] === "\\";
      const highAt = escaped ? at + 2 : at + 1;
      const high = text.codePointAt(highAt) ?? -1;
      if (go && ((!escaped && high === 0x2d) || high < low)) return -1;
      at = highAt + (high > 0xffff ? 2 : 1);
      // Git reads a range's end one byte at a time, so the bytes of a UTF-8
      // sequence after its first are members, and the last can start a range.
      low = !go && high > 0x7f ? 0x80 | (high & 0x3f) : -1;
      continue;
    }
    if (go && c === "-" && !afterClass) return -1;
    if (c === "[" && text[at + 1] === ":" && at >= noClassBefore) {
      // A class name ends at the first `]` for Git, and at the first `:]` for
      // Go; a name holding a `]` is one Go does not know.
      let close = at + 2;
      while (close < end && text[close] !== "]") close++;
      if (close === end && !go) return -1;
      if (close < end && close > at + 2 && text[close - 1] === ":") {
        const name = text.slice(at + 2, close - 1);
        const known = go
          ? GO_CLASSES.has(name.startsWith("^") ? name.slice(1) : name)
          : GIT_CLASSES.has(name);
        if (!known) return -1;
        at = close + 1;
        low = -1;
        afterClass = true;
        continue;
      }
      if (go && lastClassEnd >= at + 2) return -1;
      noClassBefore = close;
    }
    const escaped = c === "\\";
    low = text.codePointAt(escaped ? at + 1 : at) ?? -1;
    at += (escaped ? 1 : 0) + (low > 0xffff ? 2 : 1);
  }
  return -1;
}
