/**
 * Java properties files for the pager. A file is a series of logical lines. A
 * logical line whose first character other than white space is `#` or `!` is
 * a comment. Any other logical line that is not blank sets a key: the key runs
 * to the first `=`, `:`, or white space that a backslash does not escape, and
 * the value is the rest of the logical line. A physical line that ends in a
 * backslash which is not itself escaped continues its logical line on the next
 * physical line, whose leading white space is not part of the value. A comment
 * does not continue. A line ends at a line feed, as every line the pager shows
 * does, so a carriage return before one is part of the line.
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

const SPACE = /[ \t\f]*/y;
const LINE_END = /\r?\n/y;
const SEPARATOR = /[=: \t\f]/;

/** The token classes and keys of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** Each key the source sets, in order. */
  readonly entries: LocatedEntry[] = [];

  #at = 0;

  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    while (this.#space() < text.length) this.#logicalLine();
  }

  #space(): number {
    SPACE.lastIndex = this.#at;
    SPACE.test(this.text);
    return this.#at = SPACE.lastIndex;
  }

  /** The length of the line break at `at`, or 0 when none is there. */
  #lineEnd(at: number): number {
    LINE_END.lastIndex = at;
    return LINE_END.test(this.text) ? LINE_END.lastIndex - at : 0;
  }

  #logicalLine(): void {
    const text = this.text;
    const start = this.#at;
    const first = text[start];
    const blank = this.#lineEnd(start);
    if (blank > 0) {
      this.#at += blank;
      return;
    }
    if (first === "#" || first === "!") {
      const end = text.indexOf("\n", start);
      this.#at = end < 0 ? text.length : end;
      this.classes.fill("comment", start, this.#at);
      return;
    }
    const key = this.#run("propertyName", true);
    this.#space();
    if (text[this.#at] === "=" || text[this.#at] === ":") {
      this.classes[this.#at++] = "operator";
      this.#space();
    }
    this.#run("string", false);
    if (key !== "") {
      this.entries.push({
        kind: "variable",
        label: key,
        name: key,
        nameOffset: start,
        startOffset: start,
        endOffset: this.#at,
        astKind: "property",
      });
    }
  }

  /**
   * Consume and mark a key or a value, which a key's separator or the end of
   * the logical line ends. Returns its text without the line continuations.
   */
  #run(cls: TokenClass, key: boolean): string {
    const text = this.text;
    let segment = this.#at;
    let joined = "";
    while (this.#at < text.length) {
      const c = text[this.#at];
      if (this.#lineEnd(this.#at) > 0 || (key && SEPARATOR.test(c))) break;
      if (c !== "\\") {
        this.#at++;
        continue;
      }
      const lineEnd = this.#lineEnd(this.#at + 1);
      if (lineEnd === 0 && this.#at + 1 < text.length) {
        this.#at += 2;
        continue;
      }
      this.classes.fill(cls, segment, this.#at);
      joined += text.slice(segment, this.#at);
      this.classes[this.#at++] = "punctuation";
      if (lineEnd === 0) return joined;
      this.#at += lineEnd;
      segment = this.#space();
    }
    this.classes.fill(cls, segment, this.#at);
    return joined + text.slice(segment, this.#at);
  }
}

/** Color `text`, one display line per source line. */
export function propertiesLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list the keys it sets. */
export function propertiesDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source: StructureSource = {
    text,
    lineStarts: computeLineStarts(text),
    definitions: new Map<string, Definition[]>(),
  };
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
