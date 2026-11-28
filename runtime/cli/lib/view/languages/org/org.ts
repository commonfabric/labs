/**
 * Org mode files for the pager, read one line at a time as Org's own parser
 * reads them. A line that starts with stars and a space is a headline: the
 * stars, an optional to-do keyword, an optional priority cookie, the title, and
 * optional tags. The to-do keywords are `TODO` and `DONE` unless a `#+TODO:`,
 * `#+SEQ_TODO:`, or `#+TYP_TODO:` line outside a literal block names others.
 * Below the headlines, a line is a `#+KEY: value` keyword, a `#+begin_NAME` or
 * `#+end_NAME` block delimiter, a `#` comment, a `:` fixed-width line, a drawer
 * delimiter such as `:PROPERTIES:`, a property inside a property drawer that
 * ends before the next headline, a planning or clock line, a horizontal rule, a
 * table row, a list item, or paragraph text.
 *
 * A source, example, export, or comment block is literal: its body is not Org.
 * A source block's body is colored as the language its first parameter names,
 * when a language has that name, after removing the indentation its lines share
 * and one of the commas that escape a line starting with `*` or `#+`. A block is
 * a block only when its end line, which holds nothing after the block's name,
 * comes before the next headline, as in Org; otherwise the lines after its
 * begin line remain Org.
 *
 * Inside headline titles, list items, table cells, and paragraph text, links,
 * `~code~` and `=verbatim=` text, and timestamps are colored. Markup is read
 * within one line, and within one cell of a table.
 */

import { minOf } from "@commonfabric/collections/math";

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { firstIndexAtLeast } from "../../lines.ts";
import { linesFromClasses } from "../classes.ts";
import { languageForName } from "../language.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

const HEADLINE = /^\*+ /;
const TODO_DECLARATION = /^[ \t]*#\+(?:SEQ_|TYP_)?TODO:(.*)$/is;
const PRIORITY = /^\[#[A-Za-z0-9]\](?=[ \t]|$)/;
const TAGS = /^:(?:[\p{L}\p{N}_@#%]+:)+$/u;
const BLOCK = /^([ \t]*#\+(?:begin|end)_)(\S+)(.*)$/is;
const KEYWORD = /^([ \t]*#\+[^\s:]+:)(.*)$/s;
const COMMENT = /^[ \t]*#(?:[ \t]|$)/;
const FIXED_WIDTH = /^[ \t]*:(?:[ \t]|$)/;
const DRAWER = /^[ \t]*:[\p{L}\p{N}_-]+:[ \t]*$/u;
const DRAWER_END = /^[ \t]*:END:[ \t]*$/i;
const PROPERTY = /^[ \t]*:[^\s:]+:/;
const PLANNING = /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED|CLOCK):/;
const PLANNING_WORD = /\b(?:SCHEDULED|DEADLINE|CLOSED|CLOCK):/g;
const RULE = /^[ \t]*-{5,}[ \t]*$/;
const TABLE_RULE = /^[ \t]*\|-/;
const TABLE = /^[ \t]*\|/;
const BULLET = /^([ \t]*(?:[-+]|\d+[.)])|[ \t]+\*)(?=[ \t]|$)/;
const CHECKBOX = /^[ \t]+(\[[ Xx-]\])(?=[ \t]|$)/;
const DESCRIPTION = /^([ \t]+)(\S.*?)[ \t]::(?=[ \t]|$)/s;
const PARAMETER = /\S+/g;
const ESCAPED = /^([ \t]*),(?=,*(?:\*|#\+))/;
const SPACE = /[ \t]*/y;

const TIMESTAMP =
  /<\d{4}-\d{2}-\d{2}(?: [^<>[\]\n]*)?>|\[\d{4}-\d{2}-\d{2}(?: [^<>[\]\n]*)?\]/y;

/** What may come before code or verbatim text, and after it. */
const BEFORE_CODE = /[\s\-({'"]/;
const AFTER_CODE = /[\s\-.,;:!?')}["\\]/;

/** Blocks whose bodies are not Org. */
const LITERAL_BLOCKS = new Set(["src", "example", "export", "comment"]);

/** One source line. */
interface SourceLine {
  /** The line's text, without its line ending. */
  readonly text: string;

  /** Offset of the line's first character in the source. */
  readonly start: number;
}

/** A headline, whose end grows until a headline at its level or above. */
interface Entry extends LocatedEntry {
  /** Number of stars the headline starts with. */
  readonly level: number;

  /** Offset where the headline's section ends. */
  endOffset: number;

  /** The headlines directly inside this one. */
  readonly children: Entry[];
}

/**
 * Returns the offset of the first character of `line` at or after `from` that
 * is not a space or a tab.
 */
function skipSpace(line: string, from: number): number {
  SPACE.lastIndex = from;
  SPACE.test(line);
  return SPACE.lastIndex;
}

/**
 * Returns a search for the first of the ascending `values` at or after a bound,
 * for a caller whose bound never decreases, so that all its searches together
 * read each value once.
 */
function forwardSearch(
  values: readonly number[],
): (from: number) => number | undefined {
  let next = 0;
  return (from) => {
    while (next < values.length && values[next] < from) next++;
    return values[next];
  };
}

/** Returns the first of the ascending `values` at or after `from`. */
function firstAtOrAfter(
  values: readonly number[],
  from: number,
): number | undefined {
  return values[firstIndexAtLeast(values, from)];
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The headlines that no other headline contains, in order. */
  readonly entries: Entry[] = [];

  readonly #lines: SourceLine[] = [];
  readonly #todo: ReadonlySet<string>;

  /** The headlines containing the current line, outermost first. */
  readonly #open: Entry[] = [];

  /** The line index of each headline, and of each block end by block name. */
  readonly #headlines: number[] = [];
  readonly #ends = new Map<string, number[]>();

  /** The line index of each line that ends a drawer. */
  readonly #drawerEnds: number[] = [];

  #inProperties = false;

  /** The offset where the last line other than a blank one ends. */
  #contentEnd = 0;

  /** Constructs an instance holding the classes and headlines of `text`. */
  constructor(text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let start = 0; start <= text.length;) {
      const feed = text.indexOf("\n", start);
      const next = feed < 0 ? text.length : feed;
      const end = next > start && text[next - 1] === "\r" ? next - 1 : next;
      const line = text.slice(start, end);
      if (HEADLINE.test(line)) this.#headlines.push(this.#lines.length);
      if (DRAWER_END.test(line)) this.#drawerEnds.push(this.#lines.length);
      const block = line.match(BLOCK);
      if (block !== null && /end_$/i.test(block[1]) && block[3].trim() === "") {
        const name = block[2].toLowerCase();
        const ends = this.#ends.get(name) ?? [];
        ends.push(this.#lines.length);
        this.#ends.set(name, ends);
      }
      this.#lines.push({ text: line, start });
      start = next + 1;
    }
    this.#todo = this.#todoKeywords();
    for (let index = 0; index < this.#lines.length;) {
      const next = this.#line(index);
      for (; index < next; index++) {
        const { text: line, start } = this.#lines[index];
        if (line.trim() !== "") this.#contentEnd = start + line.length;
      }
    }
    this.#close(0);
  }

  /**
   * Returns the to-do keywords declared outside literal blocks, or Org's
   * default ones.
   */
  #todoKeywords(): ReadonlySet<string> {
    const declared: string[] = [];
    for (let index = 0; index < this.#lines.length; index++) {
      const line = this.#lines[index].text;
      const block = line.match(BLOCK);
      if (block !== null) {
        index = this.#literalEnd(index, block) ?? index;
        continue;
      }
      const words = line.match(TODO_DECLARATION)?.[1].split(/\s+/) ?? [];
      for (const word of words) {
        if (word !== "" && word !== "|") {
          declared.push(word.replace(/\([^()]*\)$/, ""));
        }
      }
    }
    return new Set(declared.length > 0 ? declared : ["TODO", "DONE"]);
  }

  /** Marks `cls` from `from` to `to`, offsets into the line starting at `at`. */
  #mark(cls: TokenClass, at: number, from: number, to: number): void {
    this.classes.fill(cls, at + from, at + to);
  }

  /** Scans the line at `index`, and returns the index of the next to scan. */
  #line(index: number): number {
    const { text: line, start: at } = this.#lines[index];
    if (HEADLINE.test(line)) {
      this.#headline(line, at);
      return index + 1;
    }
    // An end line holding more than the block's name is text.
    const block = line.match(BLOCK);
    if (
      block !== null && (/begin_$/i.test(block[1]) || block[3].trim() === "")
    ) {
      return this.#block(index, block);
    }
    const keyword = line.match(KEYWORD);
    if (keyword !== null) {
      this.#mark("keyword", at, 0, keyword[1].length);
      this.#mark("string", at, skipSpace(line, keyword[1].length), line.length);
    } else if (COMMENT.test(line)) {
      this.#mark("comment", at, 0, line.length);
    } else if (FIXED_WIDTH.test(line)) {
      this.#mark("string", at, 0, line.length);
    } else if (
      this.#inProperties && !DRAWER_END.test(line) && PROPERTY.test(line)
    ) {
      const name = line.indexOf(":", line.indexOf(":") + 1) + 1;
      this.#mark("propertyName", at, 0, name);
      this.#mark("string", at, skipSpace(line, name), line.length);
    } else if (DRAWER.test(line)) {
      this.#mark("keyword", at, 0, line.length);
      const end = firstAtOrAfter(this.#drawerEnds, index + 1);
      const headline = firstAtOrAfter(this.#headlines, index + 1);
      this.#inProperties = /^[ \t]*:PROPERTIES:/i.test(line) &&
        end !== undefined && (headline === undefined || end < headline);
    } else if (PLANNING.test(line)) {
      this.#inline(line, at, 0, line.length);
      for (const { 0: word, index: from } of line.matchAll(PLANNING_WORD)) {
        this.#mark("keyword", at, from, from + word.length);
      }
    } else if (RULE.test(line)) {
      this.#mark("punctuation", at, 0, line.length);
    } else if (TABLE_RULE.test(line)) {
      this.#mark("punctuation", at, 0, line.length);
    } else if (TABLE.test(line)) {
      // Each cell's markup is read on its own.
      let cell = 0;
      for (
        let bar = line.indexOf("|");
        bar >= 0;
        bar = line.indexOf("|", cell)
      ) {
        this.#inline(line, at, cell, bar);
        this.classes[at + bar] = "punctuation";
        cell = bar + 1;
      }
      this.#inline(line, at, cell, line.length);
    } else {
      this.#item(line, at);
    }
    return index + 1;
  }

  /** Scans a headline, ending the sections it closes and opening its own. */
  #headline(line: string, at: number): void {
    const level = line.indexOf(" ");
    this.#close(level);
    this.#inProperties = false;
    this.#mark("sectionHeader", at, 0, line.length);
    let from = skipSpace(line, level + 1);
    const word = line.slice(from).match(/^\S+(?=[ \t]|$)/)?.[0];
    if (word !== undefined && this.#todo.has(word)) {
      this.#mark("keyword", at, from, from + word.length);
      from = skipSpace(line, from + word.length);
    }
    const priority = line.slice(from).match(PRIORITY)?.[0];
    if (priority !== undefined) {
      this.#mark("keyword", at, from, from + priority.length);
      from = skipSpace(line, from + priority.length);
    }
    // Tags are the last word, after white space.
    const trimmed = line.trimEnd().length;
    const lastWord = Math.max(
      line.lastIndexOf(" ", trimmed - 1),
      line.lastIndexOf("\t", trimmed - 1),
    ) + 1;
    const tagged = lastWord >= from && TAGS.test(line.slice(lastWord, trimmed));
    const titleEnd = tagged ? lastWord : line.length;
    if (tagged) this.#mark("typeName", at, lastWord, trimmed);
    this.#inline(line, at, from, titleEnd);
    const title = line.slice(from, titleEnd).trim();
    const entry: Entry = {
      kind: "section",
      label: title === ""
        ? line.slice(0, level)
        : `${line.slice(0, level)} ${title}`,
      ...(title === "" ? {} : { name: title, nameOffset: at + from }),
      startOffset: at,
      endOffset: at + line.length,
      astKind: "headline",
      level,
      children: [],
    };
    (this.#open[this.#open.length - 1]?.children ?? this.entries).push(entry);
    this.#open.push(entry);
  }

  /**
   * Ends every open headline at `level` or deeper after the last line read
   * that is not blank.
   */
  #close(level: number): void {
    for (
      let entry = this.#open.at(-1);
      entry !== undefined && entry.level >= level;
      entry = this.#open.at(-1)
    ) {
      entry.endOffset = this.#contentEnd;
      this.#open.pop();
    }
  }

  /** Scans a block delimiter line, and the body of a literal block it opens. */
  #block(index: number, block: RegExpMatchArray): number {
    const at = this.#lines[index].start;
    const [, delimiter, rawName, rest] = block;
    const nameEnd = delimiter.length + rawName.length;
    this.#mark("keyword", at, 0, nameEnd);
    const name = rawName.toLowerCase();
    const opens = /begin_$/i.test(delimiter);
    const parameters = [...rest.matchAll(PARAMETER)];
    for (const { 0: word, index: offset } of parameters) {
      const from = nameEnd + offset;
      const cls: TokenClass = word.startsWith(":")
        ? "propertyName"
        : word.startsWith("-")
        ? "keyword"
        : opens && name === "src" && offset === parameters[0].index
        ? "typeName"
        : "string";
      this.#mark(cls, at, from, from + word.length);
    }
    const end = this.#literalEnd(index, block);
    if (end === undefined) return index + 1;
    if (end === index + 1) return end;
    const language = name === "src" ? parameters[0]?.[0] : undefined;
    if (language === undefined || !this.#embedded(language, index + 1, end)) {
      for (let body = index + 1; body < end; body++) {
        const { text, start } = this.#lines[body];
        this.#mark(
          name === "comment" ? "comment" : "string",
          start,
          0,
          text.length,
        );
      }
    }
    return end;
  }

  /**
   * Returns the line that ends the literal block the delimiter `block` at
   * `index` opens, when it opens one and an end comes before the next headline.
   */
  #literalEnd(index: number, block: RegExpMatchArray): number | undefined {
    const [, delimiter, rawName] = block;
    const name = rawName.toLowerCase();
    if (!/begin_$/i.test(delimiter) || !LITERAL_BLOCKS.has(name)) {
      return undefined;
    }
    const end = firstAtOrAfter(this.#ends.get(name) ?? [], index + 1);
    const headline = firstAtOrAfter(this.#headlines, index + 1);
    return end !== undefined && (headline === undefined || end < headline)
      ? end
      : undefined;
  }

  /**
   * Colors the body lines from `first` up to `end` as the language called
   * `name`, and returns whether there is one. The indentation the lines share
   * and one comma escaping a line are hidden from that language.
   */
  #embedded(name: string, first: number, end: number): boolean {
    // Org inside Org stays literal: colored as Org, each level of nesting
    // would scan every level inside it again.
    const language = languageForName(name.toLowerCase());
    if (
      language === undefined || language.input.kind !== "text" ||
      language.id === "org"
    ) {
      return false;
    }
    const body = this.#lines.slice(first, end);
    const indent = minOf(
      body.filter(({ text }) => text.trim() !== "").map(({ text }) =>
        skipSpace(text, 0)
      ),
    );
    // Each line of the view is aligned with the end of its source line. When
    // an escaping comma follows more indentation, that aligns the spaces
    // before it one character late, and each comma after it with a comma.
    const starts: number[] = [];
    const view = body.map(({ text, start }) => {
      const dedented = text.slice(Math.min(indent, text.length));
      const unescaped = dedented.replace(ESCAPED, "$1");
      starts.push(start + text.length - unescaped.length);
      return unescaped;
    });
    language.highlightLines(view.join("\n")).forEach((colored, i) => {
      let offset = starts[i];
      for (const span of colored.spans) {
        if (span.cls !== "plain" && span.cls !== "whitespace") {
          this.classes.fill(span.cls, offset, offset + span.text.length);
        }
        offset += span.text.length;
      }
    });
    return true;
  }

  /** Scans a list item or a line of paragraph text. */
  #item(line: string, at: number): void {
    const bullet = line.match(BULLET)?.[0];
    if (bullet === undefined) {
      this.#inline(line, at, 0, line.length);
      return;
    }
    const indent = skipSpace(line, 0);
    this.#mark("punctuation", at, indent, bullet.length);
    let from = bullet.length;
    const checkbox = line.slice(from).match(CHECKBOX);
    if (checkbox !== null) {
      this.#mark(
        "keyword",
        at,
        from + checkbox[0].length - 3,
        from + checkbox[0].length,
      );
      from += checkbox[0].length;
    }
    const term = line.slice(from).match(DESCRIPTION);
    if (term !== null) {
      const termStart = from + term[1].length;
      const termEnd = termStart + term[2].length;
      this.#mark("propertyName", at, termStart, termEnd);
      this.#mark("operator", at, termEnd + 1, termEnd + 3);
    }
    this.#inline(line, at, from, line.length);
  }

  /**
   * Colors the links, code, and timestamps in `line` from offset `from` up to
   * offset `to`, taking the first markup to start, as Org does. A link's
   * description keeps the class of the text around the link.
   */
  #inline(line: string, at: number, from: number, to: number): void {
    const openings: number[] = [];
    const brackets: number[] = [];
    const linkEnds: number[] = [];
    const closers: Record<string, number[]> = { "~": [], "=": [] };
    for (let i = from; i < to; i++) {
      const char = line[i];
      if (char === "[") {
        openings.push(i);
      } else if (char === "]") {
        brackets.push(i);
        if (i + 1 < to && line[i + 1] === "]") linkEnds.push(i);
      } else if (
        (char === "~" || char === "=") && i > from && /\S/.test(line[i - 1]) &&
        (i + 1 === to || AFTER_CODE.test(line[i + 1]))
      ) {
        closers[char].push(i);
      }
    }
    const nextBracket = forwardSearch(brackets);
    const nextOpening = forwardSearch(openings);
    const nextLinkEnd = forwardSearch(linkEnds);
    const nextCloser: Record<string, (from: number) => number | undefined> = {
      "~": forwardSearch(closers["~"]),
      "=": forwardSearch(closers["="]),
    };
    for (let i = from; i < to;) {
      const char = line[i];
      if (char === "[" && i + 1 < to && line[i + 1] === "[") {
        // A target holds no bracket; a description holds no `]]`.
        const target = nextBracket(i + 2);
        const opening = nextOpening(i + 2);
        const close = target === undefined ||
            (opening !== undefined && opening < target)
          ? undefined
          : target + 1 < to && line[target + 1] === "]"
          ? target
          : target + 1 < to && line[target + 1] === "["
          ? nextLinkEnd(target + 2)
          : undefined;
        if (target !== undefined && close !== undefined) {
          this.#mark("punctuation", at, i, i + 2);
          this.#mark("string", at, i + 2, target);
          this.#mark("punctuation", at, target, target + 2);
          this.#mark("punctuation", at, close, close + 2);
          if (close > target) this.#inline(line, at, target + 2, close);
          i = close + 2;
          continue;
        }
      }
      if (char === "<" || char === "[") {
        TIMESTAMP.lastIndex = i;
        if (TIMESTAMP.test(line) && TIMESTAMP.lastIndex <= to) {
          this.#mark("number", at, i, TIMESTAMP.lastIndex);
          i = TIMESTAMP.lastIndex;
          continue;
        }
      }
      if (
        (char === "~" || char === "=") && i + 1 < to &&
        /\S/.test(line[i + 1]) && (i === from || BEFORE_CODE.test(line[i - 1]))
      ) {
        const close = nextCloser[char](i + 2);
        if (close !== undefined) {
          this.#mark("string", at, i, close + 1);
          i = close + 1;
          continue;
        }
      }
      i++;
    }
  }
}

/** Colors `text`, one display line per source line. */
export function orgLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Colors `text` and lists its headlines, each inside the one above it. */
export function orgDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const node = (entry: Entry, depth: number): StructureNode =>
    structureNode(
      source,
      entry,
      depth,
      (inner) => entry.children.map((child) => node(child, inner)),
    );
  const structure = scanner.entries.map((entry) => node(entry, 0));
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
