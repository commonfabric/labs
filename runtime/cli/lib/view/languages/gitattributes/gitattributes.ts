/**
 * Git attributes files for the pager, read as Git reads them. A line that is
 * blank, or whose first character other than a blank is `#`, sets nothing;
 * blanks are spaces, tabs, and carriage returns. Any other line is a pattern
 * followed by attributes, each separated from the next by blanks. A pattern
 * that starts with `"` is quoted in C's style and may hold blanks; any other
 * pattern runs to the first blank. A pattern written `[attr]name` instead
 * defines a macro, an attribute named `name` that sets the attributes after it
 * wherever it is set. Git reads macro definitions only in a repository's
 * top-level file, which a file's name alone does not show, so they are colored
 * in every file. An attribute is a name, which is set when bare, unset after
 * `-`, left unspecified after `!`, and given a value after `=`. Git ignores a
 * whole line when a name on it is not one it accepts, when its pattern starts
 * with `!`, or when it is 2,048 bytes long or longer without the carriage
 * return before its line feed, so such a line is left uncolored. Coloring
 * keeps no state from one line to the next.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { colorGlob } from "../glob.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

const BLANKS = /[ \t\r]*/y;
const WORD = /[^ \t\r\n]*/y;

/** A name Git accepts for an attribute or a macro. */
const ATTRIBUTE_NAME = /^(?!builtin_)[\w.][-\w.]*$/;

const MACRO_PREFIX = "[attr]";

/** The length in bytes from which Git ignores a line. */
const MAX_LINE_BYTES = 2048;

/** The character C-style quoting stands for with each letter after `\`. */
const C_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/** A pattern as Git matches it, with any quoting removed. */
interface Pattern {
  readonly chars: string;

  /** The source offset just past the pattern, and past any closing quote. */
  readonly end: number;

  /**
   * The source offset of the character at `index` in {@link chars}, or, for
   * the length of {@link chars}, where the last character ends.
   */
  offset(index: number): number;
}

/** The token classes and the patterns and macros of one source. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** Each pattern and macro definition the source holds, in order. */
  readonly entries: LocatedEntry[] = [];

  #text: string;

  constructor(text: string) {
    this.#text = text;
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let start = 0; start <= text.length;) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      this.#line(start, end);
      start = end + 1;
    }
  }

  /** The offset `pattern` reaches from `at`. */
  #skip(pattern: RegExp, at: number): number {
    pattern.lastIndex = at;
    pattern.test(this.#text);
    return pattern.lastIndex;
  }

  #line(start: number, end: number): void {
    const text = this.#text;
    const first = this.#skip(BLANKS, start);
    if (first === end) return;
    if (text[first] === "#") {
      this.classes.fill("comment", first, end);
      return;
    }
    // Git reads a line without the carriage return before its line feed.
    const crlf = end < text.length && text[end - 1] === "\r";
    if (tooLongForGit(text, start, crlf ? end - 1 : end)) return;
    const pattern = this.#quotedPattern(first) ?? this.#plainPattern(first);
    const patternEnd = pattern.end;
    const attributes: [number, number][] = [];
    let last = patternEnd;
    for (let at = this.#skip(BLANKS, last); at < end;) {
      last = this.#skip(WORD, at);
      attributes.push([at, last]);
      at = this.#skip(BLANKS, last);
    }
    const macro = macroName(pattern);
    const accepted =
      (macro === undefined
        ? !pattern.chars.startsWith("!")
        : ATTRIBUTE_NAME.test(macro.name)) &&
      attributes.every(([from, to]) => attributeNameEnd(text, from, to) >= 0);
    if (!accepted) return;
    for (const [from, to] of attributes) this.#attribute(from, to);
    const label = text.slice(first, patternEnd);
    if (macro === undefined) {
      this.#pattern(first, pattern);
      this.entries.push({
        kind: "object",
        label,
        startOffset: first,
        endOffset: last,
        astKind: "pattern",
      });
      return;
    }
    const { offset } = pattern;
    const nameOffset = offset(macro.start);
    this.classes.fill("string", first, patternEnd);
    this.classes.fill("keyword", offset(0), offset(MACRO_PREFIX.length));
    this.classes.fill("functionName", nameOffset, offset(macro.end));
    this.entries.push({
      kind: "function",
      label,
      name: macro.name,
      nameOffset,
      startOffset: first,
      endOffset: last,
      astKind: "macro",
    });
  }

  /** The pattern that runs from `start` to the first blank. */
  #plainPattern(start: number): Pattern {
    const end = this.#skip(WORD, start);
    return {
      chars: this.#text.slice(start, end),
      end,
      offset: (index) => start + index,
    };
  }

  /**
   * The C-quoted pattern that starts at `start`, or `undefined` when no valid
   * quoting starts there, in which case Git reads the line as though the
   * pattern were not quoted.
   */
  #quotedPattern(start: number): Pattern | undefined {
    const text = this.#text;
    if (text[start] !== '"') return undefined;
    let chars = "";
    const offsets: number[] = [];
    for (let at = start + 1; at < text.length && text[at] !== "\n";) {
      const c = text[at];
      if (c === '"') {
        offsets.push(at);
        // Git's pattern ends at a NUL that an octal escape writes.
        const nul = chars.indexOf("\0");
        return {
          chars: nul < 0 ? chars : chars.slice(0, nul),
          end: at + 1,
          offset: (index) => offsets[index],
        };
      }
      offsets.push(at);
      if (c !== "\\") {
        chars += c;
        at++;
        continue;
      }
      const escaped = C_ESCAPES[text[at + 1]];
      const octal = text.slice(at + 1, at + 4);
      if (escaped !== undefined) {
        chars += escaped;
        at += 2;
      } else if (/^[0-3][0-7]{2}$/.test(octal)) {
        chars += String.fromCharCode(parseInt(octal, 8));
        at += 4;
      } else {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Color the pattern that starts at `start` as {@link colorGlob} colors what
   * Git matches, after removing any quoting, whose quotes are strings.
   */
  #pattern(start: number, { chars, end, offset }: Pattern): void {
    if (offset(0) === start) {
      colorGlob(this.#text, this.classes, start, end, "git");
      return;
    }
    const classes = new Array<TokenClass | undefined>(chars.length);
    colorGlob(chars, classes, 0, chars.length, "git");
    this.classes.fill("string", start, end);
    for (let at = 0; at < chars.length; at++) {
      this.classes.fill(classes[at], offset(at), offset(at + 1));
    }
  }

  /** Color the attribute, which Git accepts, from `start` to `end`. */
  #attribute(start: number, end: number): void {
    const text = this.#text;
    const nameEnd = attributeNameEnd(text, start, end);
    const prefixed = text[start] === "-" || text[start] === "!";
    if (prefixed) this.classes[start] = "operator";
    this.classes.fill("propertyName", prefixed ? start + 1 : start, nameEnd);
    // Git reads no value after an unset or unspecified attribute.
    if (nameEnd < end && !prefixed) {
      this.classes[nameEnd] = "operator";
      this.classes.fill("string", nameEnd + 1, end);
    }
  }
}

/**
 * The offset where the name of the attribute from `start` to `end` ends, at
 * its `=` or at `end`, or -1 when Git does not accept the name.
 */
function attributeNameEnd(text: string, start: number, end: number): number {
  const word = text.slice(start, end);
  const equals = word.indexOf("=");
  const nameEnd = equals < 0 ? word.length : equals;
  const nameStart = word[0] === "-" || word[0] === "!" ? 1 : 0;
  return ATTRIBUTE_NAME.test(word.slice(nameStart, nameEnd))
    ? start + nameEnd
    : -1;
}

/**
 * The name a pattern's macro definition defines, with the indexes in the
 * pattern's characters where it starts and ends, or `undefined` when the
 * pattern defines no macro. As in Git, blanks may come between a quoted
 * pattern's prefix and the name, and the name ends at the first blank after
 * it.
 */
function macroName(
  { chars }: Pattern,
): { name: string; start: number; end: number } | undefined {
  if (
    !chars.startsWith(MACRO_PREFIX) || chars.length === MACRO_PREFIX.length
  ) {
    return undefined;
  }
  const start = MACRO_PREFIX.length +
    /^[ \t\r\n]*/.exec(chars.slice(MACRO_PREFIX.length))![0].length;
  const end = start + /^[^ \t\r\n]*/.exec(chars.slice(start))![0].length;
  return { name: chars.slice(start, end), start, end };
}

/** Whether the line from `start` to `end` is too long in UTF-8 for Git. */
function tooLongForGit(text: string, start: number, end: number): boolean {
  if (end - start >= MAX_LINE_BYTES) return true;
  if ((end - start) * 3 < MAX_LINE_BYTES) return false;
  let bytes = 0;
  for (let at = start; at < end; at++) {
    const unit = text.charCodeAt(at);
    // Each half of a surrogate pair stands for two of its character's four.
    bytes += unit < 0x80
      ? 1
      : unit < 0x800 || (unit >= 0xd800 && unit < 0xe000)
      ? 2
      : 3;
  }
  return bytes >= MAX_LINE_BYTES;
}

/** Color `text`, one display line per source line. */
export function gitAttributesLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list the patterns and macros it holds. */
export function gitAttributesDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const structure: StructureNode[] = scanner.entries.map((entry) =>
    structureNode(source, entry, 0, () => [])
  );
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
