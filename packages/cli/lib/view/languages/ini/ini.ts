/**
 * INI files for the pager, in the dialect Python's `configparser` reads by
 * default, extended with the host lines of Ansible inventories. A line whose
 * first character other than white space is `;` or `#` is a comment. A line
 * indented further than the line that set the current key continues that key's
 * value. Any other line that opens with `[` heads a section, whose name runs to
 * the last `]` on the line. Any other line that is not blank sets a key: the
 * key runs to the first `=` or `:`, without the white space before it, and the
 * value is the rest of the line. A line whose first word does not end in `:`
 * and is followed by a `name=value` field or a `#` is an inventory host line
 * instead, split into words as Ansible splits it: the first word is the host,
 * each `name=value` word after it sets one of the host's variables, a word
 * runs to white space outside quotes, and a `#` outside quotes starts a
 * comment. A line ends at a line feed, as every line the pager shows does,
 * without a carriage return before it.
 */

import type {
  Definition,
  Document,
  Line,
  StructureNode,
  TokenClass,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { computeLineStarts } from "../../lines.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureNode,
  type StructureSource,
} from "../structure.ts";

const HOST_LINE = /^[^\s=]*[^\s=:]\s+(?:[^\s=]+=|#)/;
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"?|'[^']*'?`;
const WORD = new RegExp(String.raw`(?:[^\s"']|${QUOTED})+`, "g");
const QUOTED_OR_COMMENT = new RegExp(`${QUOTED}|#`, "g");
const SPACE = /\s*/y;

/** A section or a key, whose end grows as the lines it spans are read. */
interface Entry extends LocatedEntry {
  endOffset: number;
  readonly children: Entry[];
}

/** The offset of the first character of `text` at or after `from` that is not
 * white space. */
function skipSpace(text: string, from: number): number {
  SPACE.lastIndex = from;
  SPACE.test(text);
  return SPACE.lastIndex;
}

/** The offset of the first `#` in `text` outside quotes, or its length. */
function commentStart(text: string): number {
  for (const { 0: token, index } of text.matchAll(QUOTED_OR_COMMENT)) {
    if (token === "#") return index;
  }
  return text.length;
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The sections, and the keys before the first section, in order. */
  readonly entries: Entry[] = [];

  #section: Entry | undefined;
  #key: Entry | undefined;
  #keyIndent = 0;

  constructor(text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let start = 0; start <= text.length;) {
      const feed = text.indexOf("\n", start);
      const next = feed < 0 ? text.length : feed;
      const end = feed > start && text[feed - 1] === "\r" ? feed - 1 : next;
      this.#line(text.slice(start, end), start);
      start = next + 1;
    }
  }

  /** Mark `cls` from `from` to `to`, offsets into the line at `at`. */
  #mark(cls: TokenClass, at: number, from: number, to: number): void {
    this.classes.fill(cls, at + from, at + to);
  }

  /** Scan `line`, which starts at offset `at` and holds no line feed. */
  #line(line: string, at: number): void {
    const indent = skipSpace(line, 0);
    if (indent === line.length) return;
    const first = line[indent];
    if (first === ";" || first === "#") {
      this.#mark("comment", at, indent, line.length);
      return;
    }
    if (this.#key !== undefined && indent > this.#keyIndent) {
      this.#mark("string", at, indent, line.length);
      this.#extend(this.#key, at + line.length);
      return;
    }
    this.#key = undefined;
    if (first === "[") {
      this.#sectionHeader(line, at, indent);
      return;
    }
    this.#keyIndent = indent;
    const rest = line.slice(indent);
    if (HOST_LINE.test(rest)) {
      this.#hostLine(line, at, indent + rest.search(/\s/));
      return;
    }
    const delimiter = rest.search(/[=:]/);
    const keyEnd = delimiter < 0 ? line.length : indent + delimiter;
    const name = line.slice(indent, keyEnd).trimEnd();
    this.#mark("propertyName", at, indent, indent + name.length);
    if (keyEnd < line.length) {
      this.classes[at + keyEnd] = "operator";
      this.#mark("string", at, skipSpace(line, keyEnd + 1), line.length);
    }
    this.#addKey(name, line, at);
  }

  #sectionHeader(line: string, at: number, indent: number): void {
    const close = line.lastIndexOf("]");
    const nameEnd = close > indent ? close : line.length;
    this.classes[at + indent] = "bracket";
    this.#mark("interfaceName", at, indent + 1, nameEnd);
    if (nameEnd < line.length) this.classes[at + nameEnd] = "bracket";
    const name = line.slice(indent + 1, nameEnd);
    this.#section = {
      kind: "object",
      label: `[${name}]`,
      name,
      nameOffset: at + indent + 1,
      startOffset: at + indent,
      endOffset: at + line.length,
      astKind: "section",
      children: [],
    };
    this.entries.push(this.#section);
  }

  /** Scan an inventory host line whose host name ends at `hostEnd`. */
  #hostLine(line: string, at: number, hostEnd: number): void {
    const indent = this.#keyIndent;
    this.#mark("propertyName", at, indent, hostEnd);
    const comment = hostEnd + commentStart(line.slice(hostEnd));
    this.#mark("comment", at, comment, line.length);
    for (
      const { 0: word, index } of line.slice(hostEnd, comment).matchAll(WORD)
    ) {
      const start = hostEnd + index;
      const equals = word.indexOf("=");
      if (equals < 0) continue;
      this.#mark("propertyName", at, start, start + equals);
      this.classes[at + start + equals] = "operator";
      this.#mark("string", at, start + equals + 1, start + word.length);
    }
    this.#addKey(line.slice(indent, hostEnd), line, at);
  }

  /** Record the key `name`, set on `line` at offset `at`. */
  #addKey(name: string, line: string, at: number): void {
    if (name === "") return;
    const start = at + this.#keyIndent;
    this.#key = {
      kind: "variable",
      label: name,
      name,
      nameOffset: start,
      startOffset: start,
      endOffset: at + line.length,
      astKind: "key",
      children: [],
    };
    (this.#section?.children ?? this.entries).push(this.#key);
    this.#extend(this.#key, at + line.length);
  }

  /** Extend `key` and the section it is in to `end`. */
  #extend(key: Entry, end: number): void {
    key.endOffset = end;
    if (this.#section !== undefined) this.#section.endOffset = end;
  }
}

/** Color `text`, one display line per source line. */
export function iniLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its sections and the keys each one sets. */
export function iniDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source: StructureSource = {
    text,
    lineStarts: computeLineStarts(text),
    definitions: new Map<string, Definition[]>(),
  };
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
