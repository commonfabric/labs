/**
 * A small JSON, JSONC, and JSON Lines highlighter and structure builder for the
 * pager. It is hand-written — it shares nothing with the TypeScript parser —
 * so JSON data is colored with keys apart from string values, numbers,
 * `true`/`false`/`null`, and rainbow brackets rather than run through a
 * TypeScript parse that would misread a bare top-level `{…}` as a block and
 * shred it.
 *
 * The tokenizer is lenient: it never throws on malformed input, so the pager
 * keeps coloring a file the user is midway through editing. An unterminated
 * string or comment runs to the end of an ordinary JSON source. JSON Lines
 * ends it at the record boundary so the next record starts with fresh lexical
 * state. JSONC line and block comments and trailing commas are colored, not
 * rejected. Object keys in a single top-level value become a navigation tree,
 * so `wasd`/Tab step through its structure.
 */

import type {
  Definition,
  Document,
  Line,
  Span,
  StructureKind,
  StructureNode,
  TokenClass,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import type { Highlighter } from "../language.ts";
import { cpLen } from "../../ansi.ts";
import { computeLineStarts, lineIndexOf } from "../../lines.ts";

interface Token {
  readonly start: number;
  readonly end: number;
  readonly cls: TokenClass;

  /** Nesting depth for `bracket` tokens, for rainbow coloring. */
  readonly depth?: number;
}

const WS = new Set([" ", "\t", "\n", "\r"]);

/** Tokenize `text` into a gapless run of tokens covering every character. */
function tokenize(text: string, isolateLines = false): Token[] {
  if (!isolateLines) return tokenizeRange(text, 0, text.length);

  const toks: Token[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    for (const token of tokenizeRange(text, start, end)) toks.push(token);
    if (newline < 0) break;
    toks.push({ start: newline, end: newline + 1, cls: "whitespace" });
    start = newline + 1;
  }
  return toks;
}

/** Tokenize the half-open range from `start` to `end`. */
function tokenizeRange(text: string, start: number, end: number): Token[] {
  const toks: Token[] = [];
  let i = start;
  let depth = 0;
  while (i < end) {
    const c = text[i];
    if (WS.has(c)) {
      let j = i + 1;
      while (j < end && WS.has(text[j])) j++;
      toks.push({ start: i, end: j, cls: "whitespace" });
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < end && text[j] !== "\n") j++;
      toks.push({ start: i, end: j, cls: "comment" });
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      let j = i + 2;
      while (j < end && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j = Math.min(end, j + 2); // include the closing `*/` when present
      toks.push({ start: i, end: j, cls: "comment" });
      i = j;
    } else if (c === '"') {
      const stringEnd = scanString(text, i, end);
      // A string immediately followed (past trivia) by `:` is an object key.
      const cls: TokenClass = nextSignificantIs(text, stringEnd, end, ":")
        ? "propertyName"
        : "string";
      toks.push({ start: i, end: stringEnd, cls });
      i = stringEnd;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const numberEnd = scanNumber(text, i, end);
      toks.push({ start: i, end: numberEnd, cls: "number" });
      i = numberEnd;
    } else if (c === "{" || c === "[") {
      toks.push({ start: i, end: i + 1, cls: "bracket", depth });
      depth++;
      i++;
    } else if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      toks.push({ start: i, end: i + 1, cls: "bracket", depth });
      i++;
    } else if (c === ":" || c === ",") {
      toks.push({ start: i, end: i + 1, cls: "punctuation" });
      i++;
    } else if (isWordChar(c)) {
      let j = i + 1;
      while (j < end && isWordChar(text[j])) j++;
      const word = text.slice(i, j);
      const cls: TokenClass = word === "true" || word === "false"
        ? "boolean"
        : word === "null"
        ? "keyword"
        : "plain";
      toks.push({ start: i, end: j, cls });
      i = j;
    } else {
      // Any other character is a lone `plain` token. A non-BMP code point is two
      // UTF-16 units — keep the pair in one token so it renders as one glyph in
      // one column rather than two replacement characters.
      const cp = text.codePointAt(i)!;
      const size = cp > 0xffff ? 2 : 1;
      toks.push({ start: i, end: i + size, cls: "plain" });
      i += size;
    }
  }
  return toks;
}

/**
 * Return the end offset of the string literal starting at `start`.
 * Backslash escapes the next character.
 */
function scanString(text: string, start: number, end: number): number {
  let j = start + 1;
  while (j < end && text[j] !== '"') {
    if (text[j] === "\\") j++;
    j++;
  }
  return Math.min(end, j + 1);
}

/** End offset of the number literal starting at `start`. */
function scanNumber(text: string, start: number, end: number): number {
  let j = start;
  if (text[j] === "-") j++;
  while (j < end && isDigit(text[j])) j++;
  if (text[j] === ".") {
    j++;
    while (j < end && isDigit(text[j])) j++;
  }
  if (text[j] === "e" || text[j] === "E") {
    j++;
    if (text[j] === "+" || text[j] === "-") j++;
    while (j < end && isDigit(text[j])) j++;
  }
  return j;
}

/** Whether the next significant (non-trivia) character from `from` is `ch`. */
function nextSignificantIs(
  text: string,
  from: number,
  end: number,
  ch: string,
): boolean {
  let i = from;
  while (i < end) {
    const c = text[i];
    if (WS.has(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < end && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < end && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      return c === ch;
    }
  }
  return false;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isWordChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/** Color `text` into rendered lines from the selected token stream. */
function highlightLines(text: string, isolateLines: boolean): Line[] {
  const lineStarts = computeLineStarts(text);
  const rawLines = text.split("\n");
  const spans: Span[][] = rawLines.map(() => []);
  const col = rawLines.map(() => 0);
  for (const tok of tokenize(text, isolateLines)) {
    let pos = tok.start;
    let li = lineIndexOf(lineStarts, pos);
    while (pos < tok.end && li < rawLines.length) {
      const lineEnd = li + 1 < lineStarts.length
        ? lineStarts[li + 1] - 1
        : text.length;
      const segEnd = Math.min(tok.end, lineEnd);
      if (segEnd > pos) {
        const segText = text.slice(pos, segEnd);
        spans[li].push(
          tok.depth !== undefined
            ? {
              col: col[li],
              text: segText,
              cls: tok.cls,
              bracketDepth: tok.depth,
            }
            : { col: col[li], text: segText, cls: tok.cls },
        );
        col[li] += cpLen(segText);
      }
      if (segEnd < tok.end) {
        li++;
        pos = lineStarts[li] ?? tok.end;
      } else {
        pos = segEnd;
      }
    }
  }
  return rawLines.map((t, i) => ({ text: t, spans: spans[i] }));
}

/** Color a JSON or JSONC source into rendered lines. */
export function jsonHighlightLines(text: string): Line[] {
  return highlightLines(text, false);
}

/** Color JSON Lines source with independent lexical state for every record. */
export function jsonLinesHighlightLines(text: string): Line[] {
  return highlightLines(text, true);
}

/**
 * Build a whole-document JSON highlighter. JSON is cheap enough to recolor
 * whole on every keystroke, so no incremental state is needed.
 */
export function createJsonHighlighter(initial: string): Highlighter {
  return createHighlighter(initial, jsonHighlightLines);
}

/** A whole-document JSON Lines highlighter with independent record state. */
export function createJsonLinesHighlighter(initial: string): Highlighter {
  return createHighlighter(initial, jsonLinesHighlightLines);
}

/** Build a highlighter from a whole-source coloring function. */
function createHighlighter(
  initial: string,
  highlight: (text: string) => Line[],
): Highlighter {
  let lines: Line[] = highlight(initial);
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      lines = highlight(next);
      return lines;
    },
  };
}

/** Builds a full JSON {@link Document}. Every document has colored lines. A
 * single top-level value can also contribute navigation and declaration
 * entries for object keys and container array elements. */
export function jsonDocument(text: string): Document {
  const lines = jsonHighlightLines(text);
  const definitions = new Map<string, Definition[]>();
  let structure: StructureNode[] = [];
  try {
    structure = buildStructure(text, definitions);
  } catch {
    structure = [];
    definitions.clear();
  }
  return {
    text,
    lines,
    structure,
    flatStructure: flattenStructure(structure),
    definitions,
  };
}

/** Build a JSON Lines document with structure only for one-record input. */
export function jsonLinesDocument(text: string): Document {
  const lines = jsonLinesHighlightLines(text);
  const recordCount =
    text.split("\n").filter((line) => line.trim().length > 0).length;
  if (recordCount === 1) {
    return { ...jsonDocument(text), lines };
  }
  return {
    text,
    lines,
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

//
// structure
//

/** The significant tokens (no whitespace, no comments), which the structure
 * pass walks as a recursive-descent value grammar. */
function significantTokens(text: string): Token[] {
  return tokenize(text).filter((t) =>
    t.cls !== "whitespace" && t.cls !== "comment"
  );
}

interface Cursor {
  readonly toks: Token[];
  i: number;
}

/** The parsed extent of a value, plus the nodes it contributes (empty for a
 * scalar; the members/elements for a container). */
interface Parsed {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly container: boolean;
  readonly children: StructureNode[];
}

function buildStructure(
  text: string,
  definitions: Map<string, Definition[]>,
): StructureNode[] {
  const lineStarts = computeLineStarts(text);
  const cur: Cursor = { toks: significantTokens(text), i: 0 };
  const ctx = { text, lineStarts, definitions };
  // Text with no significant tokens (empty, all whitespace, all comments) has no
  // first token, which `parseValue` reports as an empty value with no members.
  const root = parseValue(cur, 0, ctx);
  if (cur.i < cur.toks.length) {
    definitions.clear();
    return [];
  }
  // The nav tree is the top value's members/elements; a bare scalar has none.
  return root.children;
}

interface StructCtx {
  readonly text: string;
  readonly lineStarts: number[];
  readonly definitions: Map<string, Definition[]>;
}

function parseValue(cur: Cursor, depth: number, ctx: StructCtx): Parsed {
  const tok = cur.toks[cur.i];
  if (!tok) {
    return { startOffset: 0, endOffset: 0, container: false, children: [] };
  }
  const open = ctx.text[tok.start];
  if (tok.cls === "bracket" && open === "{") {
    return parseObject(cur, depth, ctx);
  }
  if (tok.cls === "bracket" && open === "[") return parseArray(cur, depth, ctx);
  // A scalar (string / number / boolean / null): consume the single token.
  cur.i++;
  return {
    startOffset: tok.start,
    endOffset: tok.end,
    container: false,
    children: [],
  };
}

function parseObject(cur: Cursor, depth: number, ctx: StructCtx): Parsed {
  const openTok = cur.toks[cur.i++];
  const members: StructureNode[] = [];
  while (cur.i < cur.toks.length) {
    const tok = cur.toks[cur.i];
    if (tok.cls === "bracket" && ctx.text[tok.start] === "}") {
      cur.i++;
      break;
    }
    if (isPunct(tok, ctx.text, ",") || isPunct(tok, ctx.text, ":")) {
      cur.i++;
      continue;
    }
    // A member is `key : value`. The key is a string (a `propertyName` token);
    // anything else we skip so a malformed object cannot wedge the walk.
    if (tok.cls !== "propertyName" && tok.cls !== "string") {
      cur.i++;
      continue;
    }
    const keyTok = cur.toks[cur.i++];
    skipPunct(cur, ctx.text, ":");
    const value = cur.i < cur.toks.length &&
        !(cur.toks[cur.i].cls === "bracket" &&
          ctx.text[cur.toks[cur.i].start] === "}")
      ? parseValue(cur, depth + 1, ctx)
      : {
        startOffset: keyTok.end,
        endOffset: keyTok.end,
        container: false,
        children: [],
      };
    const name = unquote(ctx.text.slice(keyTok.start, keyTok.end));
    members.push(makeNode(
      value.container ? "object" : "variable",
      name,
      keyTok.start,
      keyTok.start,
      value.endOffset > keyTok.end ? value.endOffset : keyTok.end,
      depth,
      value.children,
      ctx,
    ));
  }
  return {
    startOffset: openTok.start,
    endOffset: cur.toks[cur.i - 1]?.end ?? openTok.end,
    container: true,
    children: members,
  };
}

function parseArray(cur: Cursor, depth: number, ctx: StructCtx): Parsed {
  const openTok = cur.toks[cur.i++];
  const elements: StructureNode[] = [];
  let index = 0;
  while (cur.i < cur.toks.length) {
    const tok = cur.toks[cur.i];
    if (tok.cls === "bracket" && ctx.text[tok.start] === "]") {
      cur.i++;
      break;
    }
    if (isPunct(tok, ctx.text, ",")) {
      cur.i++;
      continue;
    }
    const value = parseValue(cur, depth + 1, ctx);
    // Only container elements are worth a navigation node; scalars would flood
    // the tree with unlabelled entries.
    if (value.container) {
      elements.push(makeNode(
        "object",
        `[${index}]`,
        value.startOffset,
        value.startOffset,
        value.endOffset,
        depth,
        value.children,
        ctx,
      ));
    }
    index++;
  }
  return {
    startOffset: openTok.start,
    endOffset: cur.toks[cur.i - 1]?.end ?? openTok.end,
    container: true,
    children: elements,
  };
}

function isPunct(tok: Token, text: string, ch: string): boolean {
  return tok.cls === "punctuation" && text[tok.start] === ch;
}

function skipPunct(cur: Cursor, text: string, ch: string): void {
  if (cur.i < cur.toks.length && isPunct(cur.toks[cur.i], text, ch)) cur.i++;
}

function unquote(raw: string): string {
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1)
    : raw;
}

function makeNode(
  kind: StructureKind,
  name: string,
  nameOffset: number,
  startOffset: number,
  endOffset: number,
  depth: number,
  children: StructureNode[],
  ctx: StructCtx,
): StructureNode {
  const start = posAt(ctx, startOffset);
  const end = posAt(ctx, endOffset);
  const list = ctx.definitions.get(name) ?? [];
  list.push({
    name,
    kind,
    startLine: start.line,
    endLine: end.line,
    startOffset,
    endOffset,
  });
  ctx.definitions.set(name, list);
  return {
    kind,
    label: name,
    name,
    nameOffset,
    startLine: start.line,
    endLine: end.line,
    startCol: start.col,
    endCol: end.col,
    startOffset,
    endOffset,
    depth,
    children,
  };
}

function posAt(ctx: StructCtx, offset: number): { line: number; col: number } {
  const line = lineIndexOf(ctx.lineStarts, offset);
  const col = cpLen(ctx.text.slice(ctx.lineStarts[line], offset));
  return { line, col };
}
