/**
 * Ignore files for the pager: lists of paths, one to a line, that tell a tool
 * which files to leave out. Git, Docker, and Bazel read the lines differently,
 * so the scanner takes the dialect of the tool that reads the file.
 *
 * The scanner follows each tool's comments, negation, wildcards, and white
 * space. In every dialect a line that starts with `#` in its first column is a
 * comment. Git reads each other line as a pattern: a leading `!` negates it,
 * `*`, `?`, and a bracket expression match names, `/` separates directories, a
 * backslash makes the next character literal, and spaces at the end of the line
 * that no backslash escapes are not part of the pattern. Docker's patterns are
 * colored much as Git's are, except that Docker trims white space from both
 * ends of the line and from after a leading `!`, and its bracket expressions
 * follow Go's syntax. Bazel reads each other line, white space included, as a
 * literal directory path, and also ends a line at a carriage return.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { colorGlob } from "../glob.ts";

/** The tool whose reading of an ignore file the scanner follows. */
export type IgnoreDialect = "git" | "docker" | "bazel";

/** The white space outside ASCII that Go's `strings.TrimSpace` removes. */
const GO_SPACE_OUTSIDE_ASCII =
  /[\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** The token class of each character of `text`. */
function ignoreClasses(
  text: string,
  dialect: IgnoreDialect,
): (TokenClass | undefined)[] {
  const classes = new Array<TokenClass | undefined>(text.length);
  if (dialect === "bazel") {
    // A line break, carriage return included, ends a line, and is white space.
    let comment = false;
    for (let at = 0; at < text.length; at++) {
      const c = text[at];
      if (c === "\r" || c === "\n") continue;
      const previous = text[at - 1];
      if (at === 0 || previous === "\r" || previous === "\n") {
        comment = c === "#";
      }
      classes[at] = comment ? "comment" : c === "/" ? "punctuation" : "string";
    }
    return classes;
  }
  let start = 0;
  while (start <= text.length) {
    const lineFeed = text.indexOf("\n", start);
    const end = lineFeed < 0 ? text.length : lineFeed;
    // The pager ends a line at a line feed; a carriage return before one is
    // white space that neither Git nor Docker reads as part of a pattern.
    const stop = text[end - 1] === "\r" ? end - 1 : end;
    if (text[start] === "#") {
      classes.fill("comment", start, stop);
    } else {
      pattern(text, classes, start, stop, dialect === "docker");
    }
    start = end + 1;
  }
  return classes;
}

/**
 * Helper for {@link ignoreClasses}, which marks the Git or Docker pattern on
 * the line between `start` and `stop`.
 */
function pattern(
  text: string,
  classes: (TokenClass | undefined)[],
  start: number,
  stop: number,
  docker: boolean,
): void {
  let at = start;
  if (docker) at = skipSpace(text, classes, at, stop);
  if (text[at] === "!") {
    classes[at++] = "operator";
    if (docker) at = skipSpace(text, classes, at, stop);
  }
  let end = at;
  for (let scan = at; scan < stop;) {
    const c = text[scan];
    const escape = c === "\\" && !docker;
    scan = escape ? Math.min(scan + 2, stop) : scan + 1;
    if (escape || !(docker ? isGoSpace(c) : c === " ")) end = scan;
  }
  if (docker) classes.fill("whitespace", end, stop);
  colorGlob(text, classes, at, end, docker ? "go" : "git");
}

/**
 * Whether Go's `strings.TrimSpace`, which Docker trims a line with, removes
 * the character `c`.
 */
function isGoSpace(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code > 0x7f) return GO_SPACE_OUTSIDE_ASCII.test(c);
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/**
 * Helper for {@link pattern}, which marks the white space that Docker trims
 * from `at` as white space, and returns the position of the first character
 * after it.
 */
function skipSpace(
  text: string,
  classes: (TokenClass | undefined)[],
  at: number,
  stop: number,
): number {
  while (at < stop && isGoSpace(text[at])) classes[at++] = "whitespace";
  return at;
}

/** Colors `text` in `dialect`, one display line per source line. */
export function ignoreLines(text: string, dialect: IgnoreDialect): Line[] {
  return linesFromClasses(text, ignoreClasses(text, dialect));
}

/**
 * Colors `text` in `dialect`. An ignore file declares no names, so the
 * document has no structure or definitions.
 */
export function ignoreDocument(text: string, dialect: IgnoreDialect): Document {
  return {
    text,
    lines: ignoreLines(text, dialect),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}
