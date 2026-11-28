/**
 * Git configuration files for the pager, such as `.gitmodules` and
 * `.gitconfig`, read by the rules Git reads them by. White space at the start
 * of a line is ignored. A `#` or `;` there starts a comment that runs to the
 * end of the line. A `[` there starts a section header: a name of letters,
 * digits, `-`, and `.`, then optionally white space and a quoted subsection
 * name in which a backslash escapes the next character, then a `]`. The name
 * may be empty when a subsection follows it. Another header or a variable may
 * follow a header on the same line. Otherwise the line sets a variable: a name
 * of letters, digits, and `-` that starts with a letter, then optionally spaces
 * and tabs, then either the end of the line or a `=` and the value. In a value,
 * double quotes enclose text in which `#` and `;` are literal, a `#` or `;`
 * outside quotes starts a comment, a backslash escapes `n`, `t`, `b`, `\`, or
 * `"`, and a backslash at the end of a line continues the value on the next
 * line. A line ends at a line feed, without a carriage return before it. A line
 * Git rejects is left out of the structure tree. It is colored up to the point
 * where Git rejects it, except that a name is colored as a variable's only when
 * a `=` or the end of the line follows it.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { type LocatedEntry, scannedDocument } from "../structure.ts";

const VARIABLE_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const SECTION_NAME = /[A-Za-z0-9.-]*/y;

/** The characters Git reads as white space inside a line. */
const SPACE = /[ \t\r]/;

/** A run of value characters that are neither white space nor special. */
const VALUE_RUN = /[^\\"#; \t\r\n]+/y;

/** The escapes Git accepts in a value, by the character after the
 * backslash. */
const ESCAPED = new Set(["n", "t", "b", "\\", '"']);

/** A section, whose end grows as the lines it spans are read. */
interface Section extends LocatedEntry {
  endOffset: number;
  readonly children: LocatedEntry[];
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The sections, and the variables before the first section, in order. */
  readonly entries: LocatedEntry[] = [];

  #text: string;
  #at = 0;
  #section: Section | undefined;

  constructor(text: string) {
    this.#text = text;
    this.classes = new Array<TokenClass | undefined>(text.length);
    while (this.#at < text.length) {
      this.#line();
      this.#nextLine();
    }
  }

  /** The offset where the current line's content ends: at its line feed, at
   * a carriage return before that line feed, or at the end of the source. */
  #lineEnd(): number {
    const text = this.#text;
    const feed = text.indexOf("\n", this.#at);
    if (feed < 0) return text.length;
    return feed > this.#at && text[feed - 1] === "\r" ? feed - 1 : feed;
  }

  /** Move to the start of the next line, or to the end of the source. */
  #nextLine(): void {
    const feed = this.#text.indexOf("\n", this.#at);
    this.#at = feed < 0 ? this.#text.length : feed + 1;
  }

  /** Whether the current line ends at the current offset. */
  #atLineEnd(): boolean {
    const text = this.#text;
    const c = text[this.#at];
    return c === undefined || c === "\n" ||
      (c === "\r" && text[this.#at + 1] === "\n");
  }

  #skipSpace(): void {
    while (!this.#atLineEnd() && SPACE.test(this.#text[this.#at])) this.#at++;
  }

  /** Mark `cls` from the current offset to `end`, and move there. */
  #mark(cls: TokenClass, end: number): void {
    this.classes.fill(cls, this.#at, end);
    this.#at = end;
  }

  /** Move past the text `pattern`, a sticky regular expression, matches at
   * the current offset, and return where that text started. */
  #match(pattern: RegExp): number {
    const start = pattern.lastIndex = this.#at;
    if (pattern.test(this.#text)) this.#at = pattern.lastIndex;
    return start;
  }

  /** Scan from the current offset, which starts a line, to the line's end. */
  #line(): void {
    this.#skipSpace();
    while (this.#text[this.#at] === "[") {
      if (!this.#sectionHeader()) return;
    }
    const c = this.#text[this.#at];
    if (c === "#" || c === ";") this.#mark("comment", this.#lineEnd());
    else this.#variable();
  }

  /** Scan a variable, through any lines its value continues onto. */
  #variable(): void {
    const text = this.#text;
    const start = this.#match(VARIABLE_NAME);
    const name = text.slice(start, this.#at);
    while (text[this.#at] === " " || text[this.#at] === "\t") this.#at++;
    const assigned = name !== "" && text[this.#at] === "=";
    if (!assigned && (name === "" || !this.#atLineEnd())) return;
    this.classes.fill("propertyName", start, start + name.length);
    if (assigned) {
      this.#mark("operator", this.#at + 1);
      this.#skipSpace();
      if (!this.#value()) return;
      if (!this.#atLineEnd()) this.#mark("comment", this.#lineEnd());
    }
    (this.#section?.children ?? this.entries).push({
      kind: "variable",
      label: name,
      name,
      nameOffset: start,
      startOffset: start,
      endOffset: this.#at,
      astKind: "variable",
    });
    if (this.#section !== undefined) this.#section.endOffset = this.#at;
  }

  /** Scan a value, through any lines it continues onto, to the end of its
   * last line or to the comment that ends it, and return whether Git accepts
   * it. White space after the last character of the value outside quotes is
   * not part of it. Git rejects an escape it does not know, which ends the
   * scan at the backslash, and a quote still open at the end of the value. */
  #value(): boolean {
    const text = this.#text;
    let quoted = false;
    let end = this.#at;
    while (!this.#atLineEnd()) {
      VALUE_RUN.lastIndex = this.#at;
      if (VALUE_RUN.test(text)) {
        this.#mark("string", VALUE_RUN.lastIndex);
        end = this.#at;
        continue;
      }
      const c = text[this.#at];
      if (c === "\\") {
        this.#at++;
        if (this.#atLineEnd()) {
          this.classes[this.#at - 1] = "punctuation";
          this.#nextLine();
          end = this.#at;
          continue;
        }
        if (!ESCAPED.has(text[this.#at])) return false;
        this.classes[this.#at - 1] = "string";
      } else if (!quoted && (c === "#" || c === ";")) {
        break;
      } else if (c === '"') {
        quoted = !quoted;
      }
      this.#mark("string", this.#at + 1);
      if (quoted || !SPACE.test(c)) end = this.#at;
    }
    this.classes.fill(undefined, end, this.#at);
    return !quoted;
  }

  /** Scan a section header, and return whether Git accepts it. */
  #sectionHeader(): boolean {
    const text = this.#text;
    const start = this.#at;
    this.#section = undefined;
    this.#mark("bracket", start + 1);
    this.#match(SECTION_NAME);
    this.classes.fill("interfaceName", start + 1, this.#at);
    const nameEnd = this.#at;
    this.#skipSpace();
    const valid =
      (this.#at === nameEnd ? nameEnd > start + 1 : this.#subsection()) &&
      text[this.#at] === "]";
    if (!valid) return false;
    this.#mark("bracket", this.#at + 1);
    const name = text.slice(start + 1, this.#at - 1);
    this.#section = {
      kind: "object",
      label: `[${name}]`,
      name,
      nameOffset: start + 1,
      startOffset: start,
      endOffset: this.#at,
      astKind: "section",
      children: [],
    };
    this.entries.push(this.#section);
    this.#skipSpace();
    return true;
  }

  /** Scan a quoted subsection name, and return whether it is closed on its
   * line. */
  #subsection(): boolean {
    const text = this.#text;
    if (text[this.#at] !== '"') return false;
    const start = this.#at++;
    while (!this.#atLineEnd() && text[this.#at] !== '"') {
      if (text[this.#at++] === "\\" && !this.#atLineEnd()) this.#at++;
    }
    const closed = text[this.#at] === '"';
    const end = this.#at + (closed ? 1 : 0);
    this.#at = start;
    this.#mark("string", end);
    return closed;
  }
}

/** Color `text`, one display line per source line. */
export function gitConfigLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its sections and the variables each one sets. */
export function gitConfigDocument(text: string): Document {
  const scanner = new Scanner(text);
  return scannedDocument(text, scanner.classes, scanner.entries);
}
