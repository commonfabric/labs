/**
 * Go module files (`go.mod`) and workspace files (`go.work`) for the pager,
 * read as the Go command's `modfile` package reads them. `//` starts a comment
 * that runs to the end of its line. `(`, `)`, `[`, `]`, `{`, `}`, and `,` are
 * tokens of their own, `"` and a backtick open a string that ends on its own
 * line, and any other run of characters other than white space is a word, such
 * as the `=>` of a replacement. A line's first word outside a block names its
 * directive, such as `module` or `require`. A `(` that ends a directive's line
 * opens a block, which the next line starting with `)` closes, and each line
 * inside the block continues the directive with its own tokens.
 *
 * A directive the Go command knows is a keyword, the path the `module`
 * directive declares is a declared name, a word in a version's form is a
 * number, and every other word is an identifier. The
 * structure tree lists each directive, and each line of a block under it.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

const TOKEN =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\[^\n])*"?|`[^`\n]*`?)|([()[\]{},])|((?:(?!\/\/)[^\s()[\]{},])+)|(\n)|([^\S\n]+)/g;

/**
 * What may follow a `(` that opens a block: the end of the line, or a `)` that
 * closes an empty block there.
 */
const BLOCK_OPENING = /[^\S\n]*(?:\/\/|\n|$|\)[^\S\n]*(?:\/\/|\n|$))/y;

/**
 * A version, such as `v1.2.3` or `v0.0.0-20240101-abcdef`, or a Go release
 * named by the `go` and `toolchain` directives, such as `1.22`, `1.21rc1`, or
 * `go1.22.0`.
 */
const VERSION = /^(?:v|go)?\d+(?:\.\d+)*(?:[a-z]+\d+)?(?:[-+][\w.+-]*)?$/;

const DIRECTIVES: ReadonlySet<string> = new Set([
  "exclude",
  "go",
  "godebug",
  "ignore",
  "module",
  "replace",
  "require",
  "retract",
  "tool",
  "toolchain",
  "use",
]);

/** One directive and the lines of its block, as they are read. */
interface Directive {
  readonly entry: LocatedEntry;
  end: number;
  readonly lines: LocatedEntry[];
}

interface Token {
  readonly text: string;
  readonly at: number;
}

class Scanner {
  readonly classes: (TokenClass | undefined)[];
  readonly directives: Directive[] = [];
  #block: Directive | undefined;

  /** The tokens of the line being read, other than its comment. */
  #tokens: Token[] = [];

  /** The module path the line being read declares. */
  #declared: Token | undefined;
  #lineEnd = 0;

  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    // Every character is in some token, so the matches are contiguous.
    for (const match of text.matchAll(TOKEN)) {
      const [token, comment, string, punctuation, word, newline, space] = match;
      const at = match.index;
      const end = at + token.length;
      const block = this.#block;
      BLOCK_OPENING.lastIndex = end;
      const opens = punctuation === "(" && block === undefined &&
        this.#tokens.length > 0 && BLOCK_OPENING.test(text);
      const closes = punctuation === ")" && block !== undefined &&
        this.#tokens.length === 0;
      if (newline !== undefined) {
        this.#endLine();
      } else if (comment !== undefined) {
        this.classes.fill("comment", at, end);
      } else if (opens || closes) {
        this.classes[at] = "bracket";
        this.#endLine();
        if (closes) block.end = end;
        this.#block = opens ? this.directives.at(-1) : undefined;
      } else if (space === undefined) {
        const declares = punctuation === undefined && this.#declaresModule();
        this.classes.fill(
          string !== undefined
            ? "string"
            : punctuation === ","
            ? "punctuation"
            : punctuation !== undefined
            ? "bracket"
            : declares
            ? "interfaceName"
            : this.#wordClass(word),
          at,
          end,
        );
        // A quoted path declares the path inside its quotes.
        if (declares) {
          this.#declared = string === undefined
            ? { text: token, at }
            : { text: token.slice(1, -1), at: at + 1 };
        }
        this.#tokens.push({ text: token, at });
        this.#lineEnd = end;
      }
    }
    this.#endLine();
  }

  /**
   * Whether the next token is the path a `module` directive declares: the
   * token after `module` on its line, or the first of a line in its block.
   */
  #declaresModule(): boolean {
    const tokens = this.#tokens;
    return this.#block === undefined
      ? tokens.length === 1 && tokens[0].text === "module"
      : tokens.length === 0 && this.#block.entry.label === "module";
  }

  #wordClass(word: string): TokenClass {
    if (word === "=>") return "operator";
    if (this.#block === undefined && this.#tokens.length === 0) {
      if (DIRECTIVES.has(word)) return "keyword";
    }
    return VERSION.test(word) ? "number" : "identifier";
  }

  /** Records the line just read as a directive, or as a line of a block. */
  #endLine(): void {
    const first = this.#tokens[0];
    const declared = this.#declared;
    this.#tokens = [];
    this.#declared = undefined;
    if (first === undefined) return;
    const entry: LocatedEntry = {
      kind: "variable",
      label: this.text.slice(first.at, this.#lineEnd).replace(/\s+/g, " "),
      name: declared?.text,
      nameOffset: declared?.at,
      startOffset: first.at,
      endOffset: this.#lineEnd,
      astKind: "line",
    };
    if (this.#block !== undefined) {
      this.#block.lines.push(entry);
      this.#block.end = this.#lineEnd;
      return;
    }
    this.directives.push({
      entry: { ...entry, kind: "object" },
      end: this.#lineEnd,
      lines: [],
    });
  }
}

/** Color `text`, one display line per source line. */
export function goModLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its directives and the lines of their blocks. */
export function goModDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const structure: StructureNode[] = scanner.directives.map((directive) =>
    structureNode(
      source,
      { ...directive.entry, endOffset: directive.end },
      0,
      (depth) =>
        directive.lines.map((line) =>
          structureNode(source, line, depth, () => [])
        ),
    )
  );
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
