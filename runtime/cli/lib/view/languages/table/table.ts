/**
 * Delimited tables for the pager: comma-separated values, tab-separated
 * values, and the whitespace-separated numeric tables that plotting tools
 * read. Each line is a record, and a dialect says what separates its fields,
 * whether a field can be quoted, and which characters start a comment line. An
 * unquoted field that reads as a number is colored as one, any other field that
 * holds more than spaces and tabs is colored as a string, and each separator is
 * punctuation. A file carries no mark of whether its first record names the
 * columns, so that record is colored like any other.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";

/** How one family of delimited tables writes its records. */
export interface TableDialect {
  /**
   * The single character that separates two fields. Without one, fields are
   * separated by runs of spaces and tabs, which also surround a record.
   */
  readonly separator?: string;

  /**
   * Whether a field that opens with `"` runs to the next `"` that is not
   * doubled, across separators and line breaks, as RFC 4180 defines.
   */
  readonly quoted: boolean;

  /**
   * The characters that make a line a comment when one starts it. Where spaces
   * and tabs separate fields, they may come before it.
   */
  readonly commentStarts: string;
}

/** A whole field that holds a decimal number, with an optional sign,
 * fraction, and exponent, and any spaces and tabs around it. */
const NUMBER_FIELD =
  /^[ \t]*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?[ \t]*$/;

/** Whether a field's text reads as a decimal number. */
export function readsAsNumber(field: string): boolean {
  return NUMBER_FIELD.test(field);
}

/** A field that holds nothing but spaces and tabs. */
const BLANK_FIELD = /^[ \t]*$/;
const SPACE = /[ \t]*/y;

/** The token class of each character of `text`. */
function tableClasses(
  text: string,
  dialect: TableDialect,
): (TokenClass | undefined)[] {
  const classes = new Array<TokenClass | undefined>(text.length);
  const { separator, quoted, commentStarts } = dialect;
  const space = (at: number): number => {
    SPACE.lastIndex = at;
    SPACE.test(text);
    return SPACE.lastIndex;
  };
  /** Where the field that starts at `at` ends, without a quoted part. */
  const unquotedEnd = (at: number): number => {
    while (at < text.length) {
      const c = text[at];
      if (c === "\n" || c === separator) break;
      if (separator === undefined && (c === " " || c === "\t")) break;
      at++;
    }
    return at;
  };
  /** Where the quoted part that opens at `at` ends, after its closing `"`. */
  const quotedEnd = (at: number): number => {
    for (let from = at + 1;;) {
      const close = text.indexOf('"', from);
      if (close < 0) return text.length;
      if (text[close + 1] !== '"') return close + 1;
      from = close + 2;
    }
  };

  let at = 0;
  while (at < text.length) {
    const first = separator === undefined ? space(at) : at;
    if (first < text.length && commentStarts.includes(text[first])) {
      const end = text.indexOf("\n", first);
      at = end < 0 ? text.length : end + 1;
      classes.fill("comment", first, end < 0 ? text.length : end);
      continue;
    }
    at = first;
    for (;;) {
      const start = at;
      const isQuoted = quoted && text[start] === '"';
      const end = unquotedEnd(isQuoted ? quotedEnd(start) : start);
      // A carriage return that ends the line is not part of the field.
      const fieldEnd = end > start && text[end - 1] === "\r" &&
          (end === text.length || text[end] === "\n")
        ? end - 1
        : end;
      const field = text.slice(start, fieldEnd);
      if (isQuoted || !BLANK_FIELD.test(field)) {
        const cls = !isQuoted && readsAsNumber(field) ? "number" : "string";
        classes.fill(cls, start, fieldEnd);
      }
      if (end >= text.length) return classes;
      if (text[end] === "\n") {
        at = end + 1;
        break;
      }
      if (separator === undefined) {
        at = space(end);
        if (text[at] === "\n") {
          at++;
          break;
        }
        if (at >= text.length) return classes;
      } else {
        classes[end] = "punctuation";
        at = end + 1;
      }
    }
  }
  return classes;
}

/** Color `text` as a table in `dialect`, one display line per source line. */
export function tableLines(text: string, dialect: TableDialect): Line[] {
  return linesFromClasses(text, tableClasses(text, dialect));
}

/** Color `text` as a table in `dialect`. A table has no structure tree. */
export function tableDocument(text: string, dialect: TableDialect): Document {
  return {
    text,
    lines: tableLines(text, dialect),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}
