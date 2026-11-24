/**
 * Graphviz DOT for the pager, as Graphviz's own scanner reads it. A comment
 * runs from `//` or `#` to the end of its line, or from `/*` to the next `*\/`.
 * An identifier is a letter, an underscore, or any character outside ASCII,
 * followed by any of those or digits; a numeral is an optional `-` and digits
 * with at most one `.`; a quoted string runs to the next `"` that no backslash
 * escapes; and an HTML string runs from `<` to the `>` that balances it. Each
 * of the four is an ID. The keywords `strict`, `graph`, `digraph`, `subgraph`,
 * `node`, and `edge` are spelled in any case. `->` and `--` are edge operators.
 *
 * An ID is colored by what it names: a graph, an attribute, an attribute's
 * value, a port, or a node. The structure tree lists graphs and subgraphs, and
 * the nodes that node statements declare inside them. A node that only an edge
 * names is not listed. A block that no `subgraph` keyword introduces is not
 * listed, and the node statements inside it are listed with the graph around
 * it.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { type LocatedEntry, scannedDocument } from "../structure.ts";

const TOKEN = new RegExp(
  [
    String.raw`(\s+)`,
    String
      .raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*)`,
    String.raw`("(?:[^"\\]|\\[\s\S])*"?)`,
    String.raw`(->|--)`,
    String.raw`(-?(?:\.\d+|\d+(?:\.\d*)?))`,
    String.raw`([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)`,
    String.raw`(<)`,
    String.raw`[\s\S]`,
  ].join("|"),
  "gy",
);

const KEYWORDS = new Set([
  "strict",
  "graph",
  "digraph",
  "subgraph",
  "node",
  "edge",
]);

type TokenKind =
  | "id"
  | "quoted"
  | "html"
  | "numeral"
  | "keyword"
  | "edge"
  | "symbol";

/** The kind of token each of {@link TOKEN}'s groups matches, by group number. */
const GROUP_KINDS: readonly (TokenKind | "space" | "comment" | undefined)[] = [
  undefined,
  "space",
  "comment",
  "quoted",
  "edge",
  "numeral",
  "id",
  "html",
];

/** A token other than white space or a comment. */
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;

  /** A keyword token's keyword, in lower case. */
  readonly keyword?: string;
}

/** What an ID names, which decides its token class. */
type Role = "graph" | "attribute" | "value" | "port" | "node";

const ROLE_CLASSES: Readonly<Record<Role, TokenClass>> = {
  graph: "interfaceName",
  attribute: "propertyName",
  value: "string",
  port: "propertyName",
  node: "identifier",
};

/** A graph, a subgraph, or a node, whose end grows as its source is read. */
interface Entry extends LocatedEntry {
  endOffset: number;
  readonly children: Entry[];
}

/** The tokens of `text`, with comments colored as they are found. */
function tokenize(
  text: string,
  classes: (TokenClass | undefined)[],
): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  for (let match; (match = TOKEN.exec(text)) !== null;) {
    const start = match.index;
    let end = TOKEN.lastIndex;
    const kind = GROUP_KINDS[
      match.findIndex((group, index) => index > 0 && group !== undefined)
    ] ?? "symbol";
    if (kind === "html") {
      end = TOKEN.lastIndex = htmlEnd(text, start);
    }
    if (kind === "comment") classes.fill("comment", start, end);
    if (kind !== "space" && kind !== "comment") {
      const word = text.slice(start, end);
      const keyword = kind === "id" ? word.toLowerCase() : undefined;
      tokens.push(
        keyword !== undefined && KEYWORDS.has(keyword)
          ? { kind: "keyword", text: word, start, end, keyword }
          : { kind, text: word, start, end },
      );
    }
  }
  return tokens;
}

/** The end of the HTML string that opens with the `<` at `start`. */
function htmlEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "<") depth++;
    else if (text[index] === ">" && --depth === 0) return index + 1;
  }
  return text.length;
}

/**
 * `text` on one line, as a structure entry's label is shown: a quoted string
 * can span lines.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

function isId(token: Token | undefined): boolean {
  return token !== undefined && token.kind !== "edge" &&
    token.kind !== "symbol" && token.kind !== "keyword";
}

function isSymbol(token: Token | undefined, symbol: string): boolean {
  return token?.kind === "symbol" && token.text === symbol;
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The top-level graphs, in order. */
  readonly entries: Entry[] = [];

  #tokens: Token[];

  /**
   * The open blocks, innermost last, each with the entry it opened, if any,
   * and the innermost listed entry around what it holds.
   */
  #blocks: { opened?: Entry; container?: Entry }[] = [];

  #textEnd: number;
  #inAttributes = false;
  #attributeOpen = -1;
  #lastRole: Role = "node";

  /**
   * The node statement read last, and the index of the token that would
   * continue it with an attribute list.
   */
  #node: Entry | undefined;
  #nodeContinues = -1;

  /** Whether the node list read last is part of an edge statement. */
  #inEdge = false;

  constructor(text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    this.#textEnd = text.length;
    this.#tokens = tokenize(text, this.classes);
    for (let index = 0; index < this.#tokens.length; index++) {
      this.#token(index);
    }
  }

  #mark(cls: TokenClass, token: Token): void {
    this.classes.fill(cls, token.start, token.end);
  }

  /** The innermost listed entry around the current token. */
  get #parent(): Entry | undefined {
    return this.#blocks.at(-1)?.container;
  }

  #token(index: number): void {
    const token = this.#tokens[index];
    if (token.kind === "edge") {
      this.#mark("operator", token);
    } else if (token.kind === "symbol") {
      this.#symbol(index);
    } else if (token.kind === "keyword") {
      this.#keyword(index);
    } else {
      this.#id(index);
    }
  }

  #symbol(index: number): void {
    const token = this.#tokens[index];
    switch (token.text) {
      case "{":
        this.#mark("bracket", token);
        this.#inAttributes = false;
        this.#open(index);
        break;
      case "}": {
        this.#mark("bracket", token);
        this.#inAttributes = false;
        const entry = this.#blocks.pop()?.opened;
        if (entry !== undefined) entry.endOffset = token.end;
        break;
      }
      case "[":
        this.#mark("bracket", token);
        if (!this.#inAttributes) this.#attributeOpen = index;
        this.#inAttributes = true;
        break;
      case "]":
        this.#mark("bracket", token);
        if (!this.#inAttributes) break;
        this.#inAttributes = false;
        if (
          this.#node !== undefined &&
          this.#attributeOpen === this.#nodeContinues
        ) {
          this.#node.endOffset = token.end;
          this.#nodeContinues = index + 1;
        }
        break;
      case "=":
      case "+":
        this.#mark("operator", token);
        break;
      case ";":
      case ",":
      case ":":
        this.#mark("punctuation", token);
        break;
    }
  }

  /**
   * Open the block at `index`, which lists a graph or a subgraph when the
   * keyword for one, and optionally a name, come before it.
   */
  #open(index: number): void {
    let first = index - 1;
    let name: Pick<Entry, "name" | "nameOffset"> = {};
    if (isId(this.#tokens[first])) {
      const start = this.#idStart(first);
      name = {
        name: this.#source(start, first),
        nameOffset: this.#tokens[start].start,
      };
      first = start - 1;
    }
    const keyword = this.#graphKeyword(first);
    if (keyword === undefined) {
      this.#blocks.push({ container: this.#parent });
      return;
    }
    if (this.#tokens[first - 1]?.keyword === "strict") first--;
    const entry: Entry = {
      kind: "object",
      label: oneLine(this.#source(first, index - 1)),
      ...name,
      startOffset: this.#tokens[first].start,
      endOffset: this.#textEnd,
      astKind: keyword,
      children: [],
    };
    (this.#parent?.children ?? this.entries).push(entry);
    this.#blocks.push({ opened: entry, container: entry });
  }

  /**
   * The keyword at `index` when it opens a graph: `digraph`, `subgraph`, or a
   * `graph` that no attribute list follows.
   */
  #graphKeyword(index: number): string | undefined {
    const keyword = this.#tokens[index]?.keyword;
    return keyword === "digraph" || keyword === "subgraph" ||
        (keyword === "graph" && !isSymbol(this.#tokens[index + 1], "["))
      ? keyword
      : undefined;
  }

  #keyword(index: number): void {
    const token = this.#tokens[index];
    this.#mark(
      token.keyword === "strict" || this.#graphKeyword(index) !== undefined
        ? "storageKeyword"
        : "keyword",
      token,
    );
  }

  #id(index: number): void {
    const token = this.#tokens[index];
    const role = this.#role(index);
    this.#lastRole = role;
    this.#mark(
      token.kind === "numeral" && role === "value"
        ? "number"
        : ROLE_CLASSES[role],
      token,
    );
    if (role === "node") this.#nodeStatement(index);
  }

  /**
   * The index of the first token of the ID whose last token is at `index`,
   * which runs over the quoted strings `+` joins.
   */
  #idStart(index: number): number {
    let first = index;
    while (this.#continuesId(first)) first -= 2;
    return first;
  }

  /**
   * Whether the token at `index` is a quoted string that `+` joins to the
   * quoted string before it.
   */
  #continuesId(index: number): boolean {
    return this.#tokens[index]?.kind === "quoted" &&
      isSymbol(this.#tokens[index - 1], "+") &&
      this.#tokens[index - 2]?.kind === "quoted";
  }

  /** The index of the last token of the ID whose first token is at `index`. */
  #idEnd(index: number): number {
    let last = index;
    while (this.#continuesId(last + 2)) last += 2;
    return last;
  }

  /** The tokens from `first` to `last`, separated by spaces. */
  #source(first: number, last: number): string {
    return this.#tokens.slice(first, last + 1).map((token) => token.text)
      .join(" ");
  }

  #role(index: number): Role {
    if (this.#continuesId(index)) return this.#lastRole;
    const previous = this.#tokens[index - 1];
    const next = this.#tokens[this.#idEnd(index) + 1];
    if (this.#graphKeyword(index - 1) !== undefined) return "graph";
    if (isSymbol(next, "=")) return "attribute";
    if (isSymbol(previous, "=")) return "value";
    if (this.#inAttributes) return "attribute";
    if (isSymbol(previous, ":")) return "port";
    return "node";
  }

  /**
   * List the node whose ID starts at `index` when it is in a node statement,
   * which is a comma-separated list of nodes, each with an optional port, that
   * no edge operator precedes or follows.
   */
  #nodeStatement(index: number): void {
    if (this.#continuesId(index)) return;
    const previous = this.#tokens[index - 1];
    if (previous?.kind === "edge") {
      this.#inEdge = true;
      return;
    }
    const last = this.#nodeEnd(index);
    if (!isSymbol(previous, ",")) {
      let end = last;
      while (
        isSymbol(this.#tokens[end + 1], ",") && isId(this.#tokens[end + 2])
      ) {
        end = this.#nodeEnd(end + 2);
      }
      this.#inEdge = this.#tokens[end + 1]?.kind === "edge";
    }
    if (this.#inEdge) return;
    const nameEnd = this.#idEnd(index);
    const name = this.#source(index, nameEnd);
    const start = this.#tokens[index].start;
    this.#node = {
      kind: "variable",
      label: oneLine(name),
      name,
      nameOffset: start,
      startOffset: start,
      endOffset: this.#tokens[last].end,
      astKind: "node",
      children: [],
    };
    this.#nodeContinues = last + 1;
    (this.#parent?.children ?? this.entries).push(this.#node);
  }

  /** The index of the last token of the node ID at `index` and its port. */
  #nodeEnd(index: number): number {
    let last = this.#idEnd(index);
    while (
      isSymbol(this.#tokens[last + 1], ":") && isId(this.#tokens[last + 2])
    ) {
      last = this.#idEnd(last + 2);
    }
    return last;
  }
}

/** Color `text`, one display line per source line. */
export function dotLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its graphs, subgraphs, and declared nodes. */
export function dotDocument(text: string): Document {
  const scanner = new Scanner(text);
  return scannedDocument(text, scanner.classes, scanner.entries);
}
