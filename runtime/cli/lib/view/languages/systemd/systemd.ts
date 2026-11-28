/**
 * systemd unit files for the pager, as `systemd.syntax(7)` describes them and
 * systemd's own parser reads them. A line ends at a line feed, a carriage
 * return, or the two together in either order. A line whose first character
 * other than white space is `#` or `;` is a comment, even inside a
 * continuation. Any other line that ends in an odd number of backslashes
 * continues on the next line that is not a comment, and the last backslash
 * stands for a space; the lines joined that way are one logical line. A
 * logical line that opens with `[` heads a section, whose name runs to the
 * last `]` on the line; systemd rejects a header with anything after that `]`,
 * so that text is left uncolored. Any other logical line that holds an `=` sets
 * a key: the key runs to the first `=`, without the white space before it, and
 * the value is the rest of the line, without the white space around it.
 * systemd ignores a line with no `=`, so it is left uncolored. White space is
 * spaces and tabs.
 *
 * A value that is a boolean, a number, a size, or a time span of one or more
 * parts, or `infinity`, is colored as one, and any other value as a string. A `%` and the
 * letter or `%` after it are a specifier, which systemd replaces when it loads
 * the unit. The value of a setting that runs commands, such as `ExecStart` or
 * `ExecStopPost`, is a command line. Its words run to white space that is
 * outside quotes and not escaped by a backslash. The first word after a `;`
 * word starts another command, and a command's first word names the program
 * after the `-`, `@`, `:`, `+`, `!`, and `|` characters that prefix it, inside
 * its opening quote if it has one. In a later word, a closed `${NAME}` with no
 * `:` in it expands an environment variable, as does a word that is only `$NAME` with a name that
 * does not start with a digit, and `$$` is a dollar sign, except in a command
 * whose prefix holds a `:`.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { scannedDocument, type TreeEntry } from "../structure.ts";

const SPACE = /[ \t]*/y;
const PREFIX = /[@:+!|-]*/y;
const BOOLEAN = /^(?:yes|y|true|t|on|no|n|false|f|off)$/i;
const SPAN_PART = new RegExp(
  String
    .raw`[ \t]*(?:\d+(?:\.\d+)?|\.\d+)[ \t]*(?:(?:usec|us|µs|μs|nsec|ns|msec|ms|seconds|second|sec|s|minutes|minute|min|m|hours|hour|hr|h|days|day|d|weeks|week|w|months|month|M|years|year|y|[KGTPEB%])(?![A-Za-zµμ]))?`,
  "y",
);
const COMMAND_KEY = /^Exec(?:Start|Stop|Reload|Condition)(?:Pre|Post)?$/;
const SPECIFIER = /%[A-Za-z%]/g;
const WORD = /(?:\\.?|[^ \t"'\\]|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)+/gs;
const VARIABLE = /\$(?:\$|\{([^}:]*)\}|[A-Za-z_]\w*)/g;
const QUOTES = /["']/g;

/** A stretch of one physical line that belongs to a logical line. */
interface Segment {
  readonly start: number;
  readonly end: number;

  /** The offset into the logical line at which the stretch starts. */
  readonly base: number;
}

/** A section or a key, whose end is known once its logical line is read. */
interface Entry extends TreeEntry {
  endOffset: number;
  readonly children: Entry[];
}

/** The offset at which `pattern`, a sticky pattern that also matches nothing,
 * stops matching `text` from `from`. */
function skip(pattern: RegExp, text: string, from: number): number {
  pattern.lastIndex = from;
  pattern.test(text);
  return pattern.lastIndex;
}

/** The offset just past the last character of `text` before `to` that is not
 * white space, or `from` when there is none after it. */
function spaceBefore(text: string, from: number, to = text.length): number {
  let end = to;
  while (end > from && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return end;
}

/** Whether `text` from `start` to `end` ends in an odd number of
 * backslashes. */
function endsInEscape(text: string, start: number, end: number): boolean {
  let backslash = end;
  while (backslash > start && text[backslash - 1] === "\\") backslash--;
  return (end - backslash) % 2 === 1;
}

/** Whether `value` is a number, a size, or a time span of one or more parts,
 * each a number with an optional unit, as systemd reads them. */
function isNumber(value: string): boolean {
  if (value === "infinity") return true;
  const first = value[0] === "+" || value[0] === "-" ? 1 : 0;
  if (first === value.length) return false;
  for (let at = first; at < value.length;) {
    // Only the first part may start with its fraction's `.`, which leaves an
    // address such as `10.0.0.1` a string.
    if (at > first && value[skip(SPACE, value, at)] === ".") return false;
    SPAN_PART.lastIndex = at;
    if (!SPAN_PART.test(value)) return false;
    at = SPAN_PART.lastIndex;
  }
  return true;
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The sections, and the keys before the first section, in order. */
  readonly entries: Entry[] = [];

  #section: Entry | undefined;

  /** The physical lines of the logical line being read, each without the
   * backslash that continues it. */
  #segments: Segment[] = [];

  constructor(text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    const length = text.length;
    for (let start = 0; start <= length;) {
      let end = start;
      while (end < length && text[end] !== "\n" && text[end] !== "\r") end++;
      const indent = skip(SPACE, text, start);
      if (indent < end && (text[indent] === "#" || text[indent] === ";")) {
        this.classes.fill("comment", indent, end);
      } else if (endsInEscape(text, start, end)) {
        this.classes[end - 1] = "punctuation";
        this.#addSegment(start, end - 1);
      } else if (indent < end || this.#segments.length > 0) {
        this.#addSegment(start, end);
        this.#logicalLine(text);
      }
      // A line feed and a carriage return, in either order, end one line.
      const pair = text[end] === "\n" ? "\r" : "\n";
      start = end + (end < length && text[end + 1] === pair ? 2 : 1);
    }
    if (this.#segments.length > 0) this.#logicalLine(text);
  }

  /** Add the stretch from `start` to `end` to the logical line. */
  #addSegment(start: number, end: number): void {
    const last = this.#segments.at(-1);
    const base = last === undefined ? 0 : last.base + last.end - last.start + 1;
    this.#segments.push({ start, end, base });
  }

  /** The index of the segment that holds offset `at` into the logical line. */
  #segmentAt(at: number): number {
    const segments = this.#segments;
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (segments[middle].base <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** Mark `cls` from `from` to `to`, offsets into the logical line, which
   * joins its segments with the space each continuing backslash stands for. */
  #mark(cls: TokenClass, from: number, to: number): void {
    const segments = this.#segments;
    for (
      let index = this.#segmentAt(from);
      index < segments.length && segments[index].base < to;
      index++
    ) {
      const { start, end, base } = segments[index];
      const low = Math.max(from, base) - base;
      const high = Math.min(to - base, end - start);
      if (low < high) this.classes.fill(cls, start + low, start + high);
    }
  }

  /** The source offset of offset `at` into the logical line. */
  #offset(at: number): number {
    const { start, end, base } = this.#segments[this.#segmentAt(at)];
    return start + Math.min(at - base, end - start);
  }

  /** Scan the logical line the segments hold, and start the next one. */
  #logicalLine(text: string): void {
    const segments = this.#segments;
    const line = segments.length === 1
      ? text.slice(segments[0].start, segments[0].end)
      : segments.map(({ start, end }) => text.slice(start, end)).join(" ");
    const indent = skip(SPACE, line, 0);
    if (line[indent] === "[") {
      this.#sectionHeader(line, indent);
    } else if (indent < line.length) {
      this.#keyLine(line, indent);
    }
    this.#segments = [];
  }

  #sectionHeader(line: string, indent: number): void {
    const close = line.lastIndexOf("]");
    const nameEnd = close > indent ? close : spaceBefore(line, indent + 1);
    this.#mark("bracket", indent, indent + 1);
    this.#mark("interfaceName", indent + 1, nameEnd);
    this.#mark("bracket", nameEnd, close + 1);
    const name = line.slice(indent + 1, nameEnd);
    this.#section = {
      kind: "object",
      label: `[${name}]`,
      name,
      nameOffset: this.#offset(indent + 1),
      startOffset: this.#offset(indent),
      endOffset: this.#offset(line.length),
      astKind: "section",
      children: [],
    };
    this.entries.push(this.#section);
  }

  #keyLine(line: string, indent: number): void {
    const equals = line.indexOf("=", indent);
    if (equals < 0) return;
    const name = line.slice(indent, spaceBefore(line, indent, equals));
    this.#mark("propertyName", indent, indent + name.length);
    this.#mark("operator", equals, equals + 1);
    const start = skip(SPACE, line, equals + 1);
    const end = spaceBefore(line, start);
    if (COMMAND_KEY.test(name)) {
      this.#commandLine(line, start, end);
    } else {
      const value = line.slice(start, end);
      const cls = BOOLEAN.test(value)
        ? "boolean"
        : isNumber(value)
        ? "number"
        : "string";
      this.#mark(cls, start, end);
    }
    const specifiers = line.includes("%", start)
      ? line.slice(start, end).matchAll(SPECIFIER)
      : [];
    for (const { index } of specifiers) {
      const at = start + index;
      const escaped = line[at + 1] === "%";
      this.#mark("punctuation", at, at + 1);
      this.#mark(escaped ? "punctuation" : "propertyName", at + 1, at + 2);
    }
    const lineEnd = this.#offset(line.length);
    if (this.#section !== undefined) this.#section.endOffset = lineEnd;
    if (name === "") return;
    (this.#section?.children ?? this.entries).push({
      kind: "variable",
      label: name,
      name,
      nameOffset: this.#offset(indent),
      startOffset: this.#offset(indent),
      endOffset: lineEnd,
      astKind: "key",
      children: [],
    });
  }

  /** Color the command line from `start` to `end` of the logical line. */
  #commandLine(line: string, start: number, end: number): void {
    let program = true;
    let expands = true;
    for (const { 0: word, index } of line.slice(start, end).matchAll(WORD)) {
      const at = start + index;
      if (word === ";") {
        this.#mark("punctuation", at, at + 1);
        program = true;
      } else if (program) {
        const quote = word[0] === '"' || word[0] === "'" ? 1 : 0;
        const prefixEnd = skip(PREFIX, line, at + quote);
        this.#mark("callName", at, at + word.length);
        this.#mark("operator", at + quote, prefixEnd);
        expands = !line.slice(at, prefixEnd).includes(":");
        program = false;
      } else {
        this.#mark("string", at, at + word.length);
        if (expands && word.includes("$")) this.#variables(word, at);
      }
    }
  }

  /** Color the environment variable expansions in the word at `at`. */
  #variables(word: string, at: number): void {
    const unquoted = word.replace(QUOTES, "");
    for (const { 0: text, 1: braced, index } of word.matchAll(VARIABLE)) {
      const from = at + index;
      if (text === "$$") {
        this.#mark("punctuation", from, from + 2);
      } else if (braced !== undefined) {
        const close = from + 2 + braced.length;
        this.#mark("punctuation", from, from + 2);
        this.#mark("propertyName", from + 2, close);
        this.#mark("punctuation", close, from + text.length);
      } else if (unquoted === text) {
        this.#mark("punctuation", from, from + 1);
        this.#mark("propertyName", from + 1, from + text.length);
      }
    }
  }
}

/** Color `text`, one display line per source line. */
export function systemdLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its sections and the keys each one sets. */
export function systemdDocument(text: string): Document {
  const scanner = new Scanner(text);
  return scannedDocument(text, scanner.classes, scanner.entries);
}
