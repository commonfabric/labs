/**
 * Bazel's rc files for the pager, read as Bazel reads them. Bazel first
 * removes each backslash that ends a line, joining the line to the next: those
 * before a carriage return and line feed, and then, in what remains, those
 * before a line feed. It strips white space from each joined line's ends and
 * reads the line as a list of words separated by white space. A backslash
 * makes the character after it part of a word, quotes make what they enclose
 * part of one, and a `#` outside quotes makes the rest of the line a comment.
 * A line's first word is the command its options apply to, such as `build`,
 * optionally followed by `:` and the name of the configuration they define, as
 * in `build:race`. The other words are options and their values. A first word
 * of `import` or `try-import` instead reads the file the one word after it
 * names, and `try-import-if-bazel-version` reads the second word's file when
 * Bazel's version meets the first word's condition. Bazel ignores a line for
 * any other command, warning about each option on it, and refuses an import
 * with any other number of words, and so such lines are left plain.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

/** The commands Bazel reads options for: its own commands, and `startup`,
 * `common`, and `always`, which apply to the server's startup and to every
 * command. */
const COMMANDS = new Set([
  "always",
  "analyze-profile",
  "aquery",
  "build",
  "canonicalize-flags",
  "clean",
  "common",
  "config",
  "coverage",
  "cquery",
  "dump",
  "fetch",
  "help",
  "info",
  "license",
  "mobile-install",
  "mod",
  "print_action",
  "query",
  "run",
  "shutdown",
  "startup",
  "sync",
  "test",
  "vendor",
  "version",
]);

/** The words after each first word that imports a file, which name the
 * condition, if any, and then the file. */
const IMPORTS: ReadonlyMap<string, number> = new Map([
  ["import", 1],
  ["try-import", 1],
  ["try-import-if-bazel-version", 2],
]);

/** One word of a line: what Bazel reads, and where each character of that came
 * from in the source. */
interface Word {
  start: number;
  end: number;
  text: string;
  offsets: number[];
}

/** Whether a character is white space that Bazel strips from a line's ends. */
function isSpace(c: string): boolean {
  return c === " " || (c >= "\t" && c <= "\r");
}

/** The token classes and entries of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** Each import, and each configuration where a line first defines it. */
  readonly entries: LocatedEntry[] = [];

  readonly #configurations = new Set<string>();

  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    const kept = this.#joined();
    let from = 0;
    for (let index = 0; index <= kept.length; index++) {
      if (index === kept.length || text[kept[index]] === "\n") {
        this.#line(kept, from, index);
        from = index + 1;
      }
    }
  }

  /** The offsets of the characters Bazel reads once it has joined lines. Each
   * backslash it removes is punctuation. */
  #joined(): number[] {
    const { text, classes } = this;
    const first: number[] = [];
    for (let at = 0; at < text.length; at++) {
      if (text.startsWith("\\\r\n", at)) {
        classes[at] = "punctuation";
        at += 2;
      } else {
        first.push(at);
      }
    }
    const kept: number[] = [];
    for (let index = 0; index < first.length; index++) {
      const at = first[index];
      if (text[at] === "\\" && text[first[index + 1]] === "\n") {
        classes[at] = "punctuation";
        index++;
      } else {
        kept.push(at);
      }
    }
    return kept;
  }

  /** Read the joined line made of the characters at `kept[from]` up to
   * `kept[to]`, which ends it. */
  #line(kept: readonly number[], from: number, to: number): void {
    const { text, classes } = this;
    const lineEnd = to < kept.length ? kept[to] : text.length;
    while (from < to && isSpace(text[kept[from]])) from++;
    while (to > from && isSpace(text[kept[to - 1]])) to--;
    if (from === to) return;
    const words: Word[] = [];
    let word: Word | undefined;
    let quote: string | undefined;
    let escaped = false;
    const take = (at: number, c?: string) => {
      word ??= { start: at, end: at, text: "", offsets: [] };
      word.end = at + 1;
      if (c === undefined) return;
      word.text += c;
      word.offsets.push(at);
    };
    // Bazel drops a word that reads as nothing, such as `''`.
    const end = (): void => {
      if (word !== undefined && word.text !== "") words.push(word);
      word = undefined;
    };
    for (let index = from; index < to; index++) {
      const at = kept[index];
      const c = text[at];
      if (escaped) {
        escaped = false;
        take(at, c);
      } else if (c === "\\") {
        escaped = true;
        take(at);
      } else if (quote !== undefined) {
        if (c === quote) quote = undefined;
        take(at, quote === undefined ? undefined : c);
      } else if (c === " " || c === "\t" || c === "\r") {
        end();
      } else if (c === "#") {
        classes.fill("comment", at, lineEnd);
        break;
      } else if (c === '"' || c === "'") {
        quote = c;
        take(at);
      } else {
        take(at, c);
      }
    }
    end();
    this.#color(words, kept[from], kept[to - 1] + 1);
  }

  #color(words: readonly Word[], start: number, end: number): void {
    const [command, ...rest] = words;
    if (command === undefined) return;
    const name = command.text;
    const imported = IMPORTS.get(name);
    if (imported !== undefined) {
      if (rest.length !== imported) return;
      const path = rest[imported - 1];
      this.#fill("keyword", command.start, command.end);
      for (const word of rest) this.#fill("string", word.start, word.end);
      this.entries.push({
        kind: "import",
        label: `${name} ${path.text}`,
        startOffset: start,
        endOffset: end,
        astKind: name,
      });
      return;
    }
    const colon = name.indexOf(":");
    if (!COMMANDS.has(colon < 0 ? name : name.slice(0, colon))) return;
    if (colon < 0) {
      this.#fill("keyword", command.start, command.end);
    } else {
      const at = command.offsets[colon];
      this.#fill("keyword", command.start, at);
      this.classes[at] = "punctuation";
      this.#fill("interfaceName", at + 1, command.end);
      const configuration = name.slice(colon + 1);
      if (configuration !== "" && !this.#configurations.has(configuration)) {
        this.#configurations.add(configuration);
        this.entries.push({
          kind: "object",
          label: configuration,
          name: configuration,
          nameOffset: command.offsets[colon + 1],
          startOffset: start,
          endOffset: end,
          astKind: "configuration",
        });
      }
    }
    for (const option of rest) this.#option(option);
  }

  /** Mark an option's name and value, or a word that is a value alone. */
  #option({ start, end, text, offsets }: Word): void {
    const equals = text.indexOf("=");
    if (text[0] !== "-" || equals < 0) {
      this.#fill(text[0] === "-" ? "propertyName" : "string", start, end);
      return;
    }
    const at = offsets[equals];
    this.#fill("propertyName", start, at);
    this.classes[at] = "operator";
    this.#fill("string", at + 1, end);
  }

  /** Mark a stretch, leaving the backslashes that join lines as they are. */
  #fill(cls: TokenClass, start: number, end: number): void {
    for (let at = start; at < end; at++) {
      if (this.classes[at] === undefined) this.classes[at] = cls;
    }
  }
}

/** Color `text`, one display line per source line. */
export function bazelrcLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its imports and the configurations it defines. */
export function bazelrcDocument(text: string): Document {
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
