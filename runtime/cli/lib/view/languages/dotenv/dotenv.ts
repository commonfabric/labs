/**
 * Dotenv files for the pager, in the forms that the dotenv libraries, Docker
 * Compose, and a shell sourcing the file read alike. A line whose first
 * character other than white space is `#` is a comment. Any other line that is
 * not blank sets a variable: an optional `export` word, the variable's name,
 * which runs to the first `=` or white space, and after an `=` its value.
 *
 * A value that opens with a quote runs to the matching quote, across lines,
 * and is read as an unquoted value when no quote matches it. A backslash in a
 * double-quoted value escapes the character after it. An unquoted value runs
 * to the end of its line or to a comment. A comment on the line of a value
 * starts at a `#` that follows white space, whether the value is quoted or
 * not, and even inside a reference in an unquoted value. Forms that those
 * readers read differently, such as a `#` that follows no white space and a
 * backslash in a single-quoted value, are read as a shell reads them. A
 * `$NAME` or
 * `${NAME}` reference to another variable is colored in an unquoted or
 * double-quoted value, along with the operator and default of a form such as
 * `${NAME:-default}`, and `$$` is a dollar sign, as Docker Compose reads it. A
 * line ends at a line feed, as every line the pager shows does.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

const SPACE = /[^\S\n]*/y;
const EXPORT = /export[^\S\n]+(?=[^\s#=])/y;
const NAME = /[^\s=]+/y;
const REFERENCE_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const REFERENCE_OPERATOR = /:?[-+?=]/y;

/** The token classes and variables of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** Each variable the source sets, in order. */
  readonly entries: LocatedEntry[] = [];

  #at = 0;

  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    while (this.#match(SPACE) < text.length) this.#line();
  }

  /** Consume `pattern` at the current offset and return the offset after it,
   * which is the current offset when it does not match. */
  #match(pattern: RegExp): number {
    pattern.lastIndex = this.#at;
    if (pattern.test(this.text)) this.#at = pattern.lastIndex;
    return this.#at;
  }

  /** Consume `pattern` and give what it matched the class `cls`. */
  #mark(pattern: RegExp, cls: TokenClass): boolean {
    const start = this.#at;
    this.classes.fill(cls, start, this.#match(pattern));
    return this.#at > start;
  }

  #line(): void {
    const text = this.text;
    const start = this.#at;
    if (text[start] === "\n") {
      this.#at++;
      return;
    }
    if (text[start] === "#") {
      this.#comment();
      return;
    }
    this.#mark(EXPORT, "storageKeyword");
    const nameOffset = this.#at;
    this.#mark(NAME, "propertyName");
    const name = text.slice(nameOffset, this.#at);
    this.#match(SPACE);
    if (text[this.#at] !== "=") {
      this.#rest();
      return;
    }
    this.classes[this.#at++] = "operator";
    this.#match(SPACE);
    const quote = text[this.#at];
    if (quote === '"' || quote === "'") {
      this.#quoted(quote);
    } else {
      this.#unquoted();
    }
    if (name !== "") {
      this.entries.push({
        kind: "variable",
        label: name,
        name,
        nameOffset,
        startOffset: start,
        endOffset: this.#at,
        astKind: "assignment",
      });
    }
    this.#rest();
  }

  /**
   * A quoted value, through its closing quote, or read as an unquoted value
   * when nothing closes it. A later value cannot open with a quote that a
   * value left unclosed, since no backslash precedes an opening quote and the
   * scan would have taken it as the closing one, so the scan to the end of
   * the source fails at most once for each kind of quote.
   */
  #quoted(quote: '"' | "'"): void {
    const text = this.text;
    const start = this.#at;
    const double = quote === '"';
    this.classes[this.#at++] = "string";
    while (this.#at < text.length) {
      const c = text[this.#at];
      if (c === quote) {
        this.classes[this.#at++] = "string";
        return;
      }
      if (double && c === "$" && this.#reference(true)) continue;
      const width = double && c === "\\" ? 2 : 1;
      this.classes.fill("string", this.#at, this.#at += width);
    }
    this.classes.fill(undefined, start);
    this.#at = start;
    this.#unquoted();
  }

  /** An unquoted value, which ends before the white space at the end of its
   * line or before a comment. */
  #unquoted(): void {
    const text = this.text;
    const start = this.#at;
    while (this.#at < text.length && text[this.#at] !== "\n") {
      const c = text[this.#at];
      if (this.#startsComment()) break;
      if (c === "$" && this.#reference()) continue;
      this.classes[this.#at++] = "string";
    }
    while (start < this.#at && /\s/.test(text[this.#at - 1])) {
      this.classes[--this.#at] = undefined;
    }
  }

  /**
   * A `$NAME` or `${...}` reference at the current offset, which is a `$`.
   * Returns whether there was one to consume. A `${` form runs to the `}`
   * that closes it, so a reference in its default is colored as a reference.
   * When nothing closes it, it stops at the end of its line, before the
   * closing quote of a double-quoted value holding it, or before a comment in
   * an unquoted value.
   */
  #reference(quoted = false): boolean {
    const text = this.text;
    let depth = 0;
    do {
      const start = this.#at;
      if (text[start] === "$" && text[start + 1] === "$") {
        this.classes.fill("string", start, this.#at += 2);
        continue;
      }
      if (text[start] === "$" && text[start + 1] === "{") {
        this.classes.fill("punctuation", start, this.#at += 2);
        this.#mark(REFERENCE_NAME, "propertyName");
        this.#mark(REFERENCE_OPERATOR, "operator");
        depth++;
        continue;
      }
      if (text[start] === "$") {
        this.#at++;
        if (this.#mark(REFERENCE_NAME, "propertyName")) {
          this.classes[start] = "punctuation";
          continue;
        }
      }
      if (depth === 0) {
        this.#at = start;
        return false;
      }
      const closes = text[start] === "}";
      const escape = quoted && text[start] === "\\" &&
        start + 1 < text.length && text[start + 1] !== "\n";
      this.classes.fill(
        closes ? "punctuation" : "string",
        start,
        this.#at = start + (escape ? 2 : 1),
      );
      if (closes) depth--;
    } while (
      depth > 0 && this.#at < text.length && text[this.#at] !== "\n" &&
      (quoted ? text[this.#at] !== '"' : !this.#startsComment())
    );
    return true;
  }

  /** What follows a value on its line: a comment, or text that the value's
   * closing quote left over. */
  #rest(): void {
    const text = this.text;
    while (this.#match(SPACE) < text.length && text[this.#at] !== "\n") {
      if (this.#startsComment()) {
        this.#comment();
        return;
      }
      this.classes[this.#at++] = "string";
    }
  }

  /** Whether a comment starts at the current offset, which is so of a `#`
   * that follows white space. */
  #startsComment(): boolean {
    return this.text[this.#at] === "#" && /\s/.test(this.text[this.#at - 1]);
  }

  /** A comment, to the end of its line. */
  #comment(): void {
    const start = this.#at;
    const end = this.text.indexOf("\n", start);
    this.#at = end < 0 ? this.text.length : end;
    this.classes.fill("comment", start, this.#at);
  }
}

/** Color `text`, one display line per source line. */
export function dotenvLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list the variables it sets. */
export function dotenvDocument(text: string): Document {
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
