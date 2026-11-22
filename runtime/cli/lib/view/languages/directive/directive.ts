/**
 * Directive configuration for the pager: the syntax nginx, Apache httpd,
 * nftables, Netdata health alerts, and sysusers.d share. A source is a series
 * of statements. The first word of a statement is its directive and the words
 * after it are its arguments. A statement ends at a line feed, unless the line
 * ends with `\` or a list is open. A statement whose directive words start with
 * a lowercase letter and end with a `:` followed by white space sets a key, as
 * a Netdata health line does. A statement that opens with `<` is an Apache
 * section tag, which opens a section, or closes one when it opens with `</`; a
 * `;`, `{`, or `}` inside the tag is part of it. A `{` that ends its line opens
 * a block and ends the statement, and a `}` that starts a line closes the
 * innermost block; other braces belong to an argument. A line that starts with
 * `#` is a comment, unless the line before ended with `\`.
 *
 * A source in which at least half of the statement lines end with `;`, as
 * nginx's and some nftables rulesets' do, reads statements differently. A `;`
 * ends a statement, any `{` opens a block and any `}` closes one, and a `#`
 * after white space, `;`, `{`, or `}` starts a comment that runs to the end of
 * its line. A line feed does not end a statement when the next line other than
 * blank lines and comments is indented further than the line that started it,
 * unless that line sets a key or opens a section, so that an argument list can
 * run over several lines. A quoted string runs to its closing quote, over as
 * many lines as it takes.
 *
 * A word that opens with a quote runs to the matching quote, with a backslash
 * escaping the character after it, and a quote inside a word is part of the
 * word. Commas separate words. `$name`, `${name}`, and `%{name}` are variable
 * references, in quoted words too, and a `{` after `$` or `%` belongs to the
 * reference. A `{` that follows `=` opens a list rather than a block, such as
 * an nftables set, and so does a block's `{` that a comma follows on its line
 * with no `;` before the `}` or the end of the line, or that a `}` closes later
 * on its line around content without a `;`, `{`, or `#`, counting nothing
 * inside quotes. An argument that is a number, with an optional unit such as
 * `10s` or `64k`, is a number, and `on`, `off`, `yes`, `no`, `true`, and
 * `false` are booleans.
 *
 * The structure tree lists blocks and sections, and the entries that a
 * top-level Netdata `alarm` or `template` key starts, each running to the next
 * one.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureSource,
  structureTree,
} from "../structure.ts";

const KEY = /[a-z_]\w*(?: [a-z_]\w*)*:(?=\s|$)/y;
const REFERENCE = String.raw`[$%]\{[^}\s;>]*\}?`;
const WORD = new RegExp(
  String.raw`(?:${REFERENCE}|[^\s;,{}()[\]"'])(?:${REFERENCE}|[^\s;,{}()[\]])*`,
  "y",
);
/** A word inside a section tag, which the tag's `>` ends. */
const TAG_WORD = new RegExp(
  String
    .raw`(?:${REFERENCE}|[^\s;,{}()[\]"'>])(?:${REFERENCE}|[^\s;,{}()[\]>])*`,
  "y",
);
type Quote = '"' | "'";
const STRING_BODY: Readonly<Record<Quote, RegExp>> = {
  '"': /(?:[^"\\\n]|\\.)*/y,
  "'": /(?:[^'\\\n]|\\.)*/y,
};
const VARIABLE = new RegExp(String.raw`${REFERENCE}|\$\w+`, "g");
const NUMBER = /^[+-]?\d+(?:\.\d+)?(?:[kKmMgGtT]i?[bB]?|[smhdwy]|ms|us|%)?$/;
const BOOLEAN = /^(?:on|off|yes|no|true|false)$/i;
const SECTION =
  /<\/?[^\s>]*(?:"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^>"'\n])*>?/y;
const TAG = /[^\s/>]*/y;
const LIST = new RegExp(
  String.raw`(?:[^;{}#"',\n]|"[^"\n]*"|'[^'\n]*')*,` +
    String.raw`(?:[^;{}#"'\n]|"[^"\n]*"|'[^'\n]*')*(?:[}#\n]|$)` +
    String.raw`|[^\S\n]*(?:[^\s;{}#"']|"[^"\n]*"|'[^'\n]*')` +
    String.raw`(?:[^;{}#"'\n]|"[^"\n]*"|'[^'\n]*')*\}`,
  "y",
);
const ENDS_WITH_SEMICOLON = /;[^\S\n]*(?:\}[^\S\n]*)*$/;
const OPENS_OR_CLOSES = /^[}<]|[{}]$/;
const BEFORE_COMMENT = /[\s;{}]/;
const WORD_BREAK = String.raw`[\s;,{}()[\]]`;
const QUOTED_STRING = String.raw`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?`;
/** The part of a line before its comment: text other than quotes and `#`, a
 * quoted string that starts a word, a quote inside a word, and a `#` inside a
 * word, as the scanner reads each. */
const CODE = new RegExp(
  String.raw`^(?:[^"'#]|(?<!(?!${WORD_BREAK}).)(?:${QUOTED_STRING})` +
    String.raw`|(?<=(?!${WORD_BREAK}).)["']|(?<=[^\s;{}])#)*`,
);
const LINE_END = /[^\S\n]*(?:\n|$)/y;
const SPACE = /\s/;
const ENTRY_KEYS: ReadonlySet<string> = new Set(["alarm", "template"]);

/** A block, a section, or an entry. */
interface Entry extends LocatedEntry {
  endOffset: number;
  readonly children: Entry[];

  /** The tag name of a section, which its closing tag names again. */
  readonly tag?: string;
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The outermost blocks, sections, and entries, in order. */
  readonly entries: Entry[] = [];

  readonly #text: string;

  /** Whether `;` ends statements, and indentation and quotes continue them. */
  readonly #semicolons: boolean;

  /** The open blocks and sections, innermost last. */
  readonly #open: Entry[] = [];

  /** How many open entries each section tag, or a block for `{`, names. */
  readonly #openCounts = new Map<string, number>();

  /** The Netdata entry the lines being read belong to. */
  #entry: Entry | undefined;

  /** The end of the last line that holds a token. */
  #lastEnd = 0;

  /** Offset where the current statement starts, if one is open. */
  #statement: number | undefined;

  /** Indentation of the line that started the current statement. */
  #indent = 0;

  /** Whether the previous line ended with `\`. */
  #continued = false;

  /** The quote that opened a string the previous line left open. */
  #quote: Quote | undefined;

  /** Where the statement that the last line feed ended starts, until the next
   * token, so that a `{` alone on the next line opens a block it names. */
  #previous: number | undefined;

  /** How many `{` lists, such as an nftables set, are open. */
  #lists = 0;

  /** Where the first token of the line being read starts. */
  #lineFirst = 0;

  /** Whether the tokens being read are a section tag's arguments, where no
   * `;`, `{`, or `}` ends a statement or opens a block. */
  #inTag = false;

  constructor(text: string) {
    this.#text = text;
    this.#semicolons = endsStatementsWithSemicolons(text);
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let start = 0; start <= text.length;) {
      const feed = text.indexOf("\n", start);
      const next = feed < 0 ? text.length : feed;
      this.#line(
        start,
        feed > start && text[feed - 1] === "\r" ? feed - 1 : next,
      );
      start = next + 1;
    }
    for (const entry of this.#open) entry.endOffset = this.#lastEnd;
    if (this.#entry !== undefined) this.#entry.endOffset = this.#lastEnd;
  }

  #mark(cls: TokenClass, from: number, to: number): void {
    this.classes.fill(cls, from, to);
  }

  /** Scan the line from `start` to `end`, which holds no line feed. */
  #line(start: number, end: number): void {
    const text = this.#text;
    let at = start;
    if (this.#quote !== undefined) {
      at = this.#string(this.#quote, at, end);
    } else {
      while (at < end && (text[at] === " " || text[at] === "\t")) at++;
      if (at === end) {
        this.#continued = false;
        return;
      }
      if (text[at] === "#" && !this.#continued) {
        this.#mark("comment", at, end);
        return;
      }
      this.#lineFirst = at;
      const indent = at - start;
      KEY.lastIndex = at;
      const continues = this.#continued || this.#lists > 0 ||
        (this.#semicolons && indent > this.#indent && text[at] !== "<" &&
          !KEY.test(text));
      if (this.#statement !== undefined && !continues) {
        this.#previous = this.#statement;
        this.#statement = undefined;
      }
      if (this.#statement === undefined) this.#indent = indent;
    }
    while (at < end) at = this.#token(at, end);
    this.#continued = text[end - 1] === "\\" &&
      this.classes[end - 1] !== "comment";
    this.#lastEnd = end;
  }

  /** Scan the token at `at`, before `end`, and return the offset after it. */
  #token(at: number, end: number): number {
    const text = this.#text;
    const char = text[at];
    if (SPACE.test(char)) return at + 1;
    const previous = this.#previous;
    this.#previous = undefined;
    if (
      char === "#" && this.#semicolons &&
      (at === this.#lineFirst || BEFORE_COMMENT.test(text[at - 1]))
    ) {
      this.#mark("comment", at, end);
      return end;
    }
    if (char === ";" && this.#semicolons && !this.#inTag) {
      this.classes[at] = "punctuation";
      this.#statement = undefined;
      return at + 1;
    }
    if (char === "{" || char === "}") {
      this.classes[at] = "bracket";
      // In a source whose statements end at line feeds, only a `{` that ends
      // its line and a `}` that starts one are block braces; others, such as
      // a regular expression's `{4}`, belong to an argument.
      const delimits = !this.#inTag && (this.#semicolons ||
        (char === "{" ? this.#at(LINE_END, at + 1) : at === this.#lineFirst));
      if (char === "{" && !this.#inTag && this.#followsEquals(at)) {
        this.#lists++;
        this.#statement ??= at;
      } else if (char === "}" && !this.#inTag && this.#lists > 0) {
        this.#lists--;
      } else if (!delimits) this.#statement ??= at;
      else if (char === "{" && this.#at(LIST, at + 1)) this.#lists++;
      else if (char === "{") this.#openBlock(at, previous);
      else {
        this.#statement = undefined;
        this.#close("{", at + 1);
      }
      return at + 1;
    }
    if ("()[],;".includes(char)) {
      this.classes[at] = char === ","
        ? "punctuation"
        : char === ";"
        ? "plain"
        : "bracket";
      this.#statement ??= at;
      return at + 1;
    }
    const first = this.#statement === undefined;
    this.#statement ??= at;
    if (first && char === "<") return this.#section(at, end);
    if (first) {
      KEY.lastIndex = at;
      if (KEY.test(text)) return this.#key(at, KEY.lastIndex, end);
    }
    if (char === '"' || char === "'") return this.#string(char, at + 1, end);
    const pattern = this.#inTag ? TAG_WORD : WORD;
    pattern.lastIndex = at;
    pattern.test(text);
    const stop = Math.min(pattern.lastIndex, end);
    const word = text.slice(at, stop);
    this.#mark(
      first
        ? "keyword"
        : NUMBER.test(word)
        ? "number"
        : BOOLEAN.test(word)
        ? "boolean"
        : "plain",
      at,
      stop,
    );
    this.#variables(at, stop);
    return stop;
  }

  /** Whether the sticky `pattern` matches at `at`. */
  #at(pattern: RegExp, at: number): boolean {
    pattern.lastIndex = at;
    return pattern.test(this.#text);
  }

  /** Whether the `{` at `at` follows `=`, which makes it a value's list. */
  #followsEquals(at: number): boolean {
    let before = at - 1;
    while (this.#text[before] === " " || this.#text[before] === "\t") before--;
    return this.#text[before] === "=";
  }

  /** Scan the rest of a string that `quote` opened, from `at` before `end`,
   * and return the offset after it. In a source whose `;` ends statements, a
   * string that the line leaves open continues on the next line. */
  #string(quote: Quote, at: number, end: number): number {
    const body = STRING_BODY[quote];
    body.lastIndex = at;
    body.test(this.#text);
    const closed = body.lastIndex < end && this.#text[body.lastIndex] === quote;
    const stop = closed ? body.lastIndex + 1 : end;
    const start = this.#quote === undefined ? at - 1 : at;
    this.#mark("string", start, stop);
    this.#variables(start, stop);
    this.#quote = closed || !this.#semicolons || this.#inTag
      ? undefined
      : quote;
    return stop;
  }

  /** Color the variable references between `from` and `to`. */
  #variables(from: number, to: number): void {
    const text = this.#text.slice(from, to);
    for (const { 0: name, index } of text.matchAll(VARIABLE)) {
      this.#mark("propertyName", from + index, from + index + name.length);
    }
  }

  /** Scan a key that runs from `at` to just past its `:` at `colon`. A
   * top-level `alarm` or `template` key ends the entry before it and starts
   * an entry of its own. */
  #key(at: number, colon: number, end: number): number {
    this.#mark("keyword", at, colon - 1);
    this.classes[colon - 1] = "punctuation";
    const key = this.#text.slice(at, colon - 1);
    if (!ENTRY_KEYS.has(key) || this.#open.length > 0) return colon;
    const name = this.#text.slice(colon, end).trim();
    if (this.#entry !== undefined) this.#entry.endOffset = this.#lastEnd;
    this.#entry = {
      kind: "object",
      label: name === "" ? `${key}:` : `${key}: ${name}`,
      ...(name === ""
        ? {}
        : { name, nameOffset: this.#text.indexOf(name, colon) }),
      startOffset: at,
      endOffset: end,
      astKind: key,
      children: [],
    };
    this.entries.push(this.#entry);
    return colon;
  }

  /** Scan an Apache section tag that starts at `at`. */
  #section(at: number, end: number): number {
    const text = this.#text;
    SECTION.lastIndex = at;
    SECTION.test(text);
    const stop = Math.min(SECTION.lastIndex, end);
    const closing = text[at + 1] === "/";
    const nameStart = at + (closing ? 2 : 1);
    TAG.lastIndex = nameStart;
    TAG.test(text);
    const argumentsStart = TAG.lastIndex;
    const tag = text.slice(nameStart, argumentsStart).toLowerCase();
    const argumentsEnd = stop - (text[stop - 1] === ">" ? 1 : 0);
    this.#mark("punctuation", at, stop);
    this.#mark("typeName", nameStart, argumentsStart);
    this.#inTag = true;
    for (let next = argumentsStart; next < argumentsEnd;) {
      next = this.#token(next, argumentsEnd);
    }
    this.#inTag = false;
    this.#statement = undefined;
    if (closing) {
      this.#close(tag, stop);
      return stop;
    }
    const name = text.slice(argumentsStart, argumentsEnd).trim();
    this.#push(
      this.#add({
        kind: "object",
        label: text.slice(at, stop).replace(/\s+/g, " "),
        ...(name === "" ? {} : { name }),
        startOffset: at,
        endOffset: stop,
        astKind: "section",
        children: [],
        tag,
      }),
      tag,
    );
    return stop;
  }

  /** Open a block at the `{` at `at`, named by the statement before it, or
   * by the statement that ended at the line feed `previous` names. */
  #openBlock(at: number, previous: number | undefined): void {
    const start = this.#statement ?? previous ?? at;
    const statement = this.#text.slice(start, at);
    const words = statement.split(/\s+/).filter(Boolean);
    const names = statement.replace(/\[[^\][]*\]|\([^()]*\)/g, " ").split(/\s+/)
      .filter(Boolean);
    this.#statement = undefined;
    this.#push(
      this.#add({
        kind: "object",
        label: words.length === 0 ? "{" : words.join(" "),
        ...(names.length > 1 ? { name: names[names.length - 1] } : {}),
        startOffset: start,
        endOffset: at + 1,
        astKind: "block",
        children: [],
      }),
      "{",
    );
  }

  /** Add `entry` inside the innermost open block or section, or else inside
   * the current Netdata entry. */
  #add(entry: Entry): Entry {
    const parent = this.#open.at(-1) ?? this.#entry;
    (parent?.children ?? this.entries).push(entry);
    return entry;
  }

  /** Open `entry`, which the closing token `closer` closes. */
  #push(entry: Entry, closer: string): void {
    this.#open.push(entry);
    this.#openCounts.set(closer, (this.#openCounts.get(closer) ?? 0) + 1);
  }

  /** Close the innermost open entry that `closer` closes, and those inside
   * it, at `end`. Nothing closes when none is open. */
  #close(closer: string, end: number): void {
    if (!this.#openCounts.get(closer)) return;
    for (let entry = this.#open.pop(); entry; entry = this.#open.pop()) {
      const entryCloser = entry.tag ?? "{";
      this.#openCounts.set(
        entryCloser,
        (this.#openCounts.get(entryCloser) ?? 1) - 1,
      );
      entry.endOffset = end;
      if (entryCloser === closer) return;
    }
  }
}

/**
 * Whether `text` ends statements with `;`, as nginx and nftables do: at least
 * half of its statement lines end with `;` before any comment, counting
 * neither blank or comment lines nor lines that only open or close a block or
 * section. A comment starts at a `#` outside quotes that starts the line or
 * follows white space, `;`, `{`, or `}`, as the scanner reads one in such a
 * source.
 */
function endsStatementsWithSemicolons(text: string): boolean {
  let semicolons = 0;
  let others = 0;
  for (const line of text.split("\n")) {
    const statement = CODE.exec(line)?.[0].trim() ?? "";
    if (statement === "") continue;
    if (ENDS_WITH_SEMICOLON.test(statement)) semicolons++;
    else if (!OPENS_OR_CLOSES.test(statement)) others++;
  }
  return semicolons > 0 && semicolons >= others;
}

/** Color `text`, one display line per source line. */
export function directiveLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its blocks, sections, and entries. */
export function directiveDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const structure = structureTree(
    source,
    scanner.entries,
    (entry) => entry,
    (entry) => entry.children,
  );
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
