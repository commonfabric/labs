/**
 * A small Markdown highlighter, used when a diff (or a directly-opened file)
 * names a `.md`/`.markdown` file. The pager otherwise colors everything as
 * TypeScript, which turns prose into a soup of identifiers and operators and
 * paints inline-code backticks as runaway template literals. This colors the
 * things Markdown actually has — headings, fenced and inline code, block quotes,
 * list markers, rules and links — and leaves prose plain. Headings also become
 * the navigation tree, so `wasd`/Tab step through a document's sections.
 *
 * It is line-oriented (the only cross-line state is whether a fenced code block
 * is open), so re-highlighting is cheap enough to redo whole on every keystroke.
 */

import { decodeHTMLStrict as decodeEntities } from "entities";
import { Lexer } from "marked";

import { maxOf } from "@commonfabric/utils/math";

import { cpLen } from "../../ansi.ts";
import { computeLineStarts, lineIndexOf } from "../../lines.ts";
import type {
  Document,
  Line,
  Span,
  StructureNode,
  TokenClass,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import type { Highlighter } from "../language.ts";

/** Color Markdown text into rendered lines. */
export function highlightMarkdownLines(text: string): Line[] {
  const raw = text.split("\n");
  const out: Line[] = [];
  let fence: string | null = null; // the run (``` or ~~~) of an open code block
  for (const t of raw) {
    const opener = t.trimStart().match(/^(`{3,}|~{3,})/);
    if (fence !== null) {
      const closing = opener && t.trimStart().startsWith(fence);
      out.push(oneSpan(t, closing ? "punctuation" : "string"));
      if (closing) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      out.push(oneSpan(t, "punctuation"));
      continue;
    }
    out.push(renderLine(t));
  }
  return out;
}

/**
 * Format Markdown for terminal reading while retaining one display line for
 * every source line. Block delimiters occupy blank display lines. Tables,
 * headings, quotes, lists, inline formatting, links, and code use terminal
 * glyphs and rich span modifiers.
 */
export function renderMarkdownLines(text: string): Line[] {
  const normalized = normalizeMarkdownText(text);
  return renderMarkdownBlocks(
    normalized,
    referenceAwareLexer(normalized),
  );
}

/** A full Markdown {@link Document}: highlighted lines, headings as the
 * navigation tree, and no definitions. */
export function markdownDocument(text: string): Document {
  const raw = text.split("\n");
  const lineStarts = computeLineStarts(text);
  const lines = highlightMarkdownLines(text);
  const structure = headingTree(raw, lineStarts, text.length);
  const flatStructure = flattenStructure(structure);
  return { text, lines, structure, flatStructure, definitions: new Map() };
}

/** A whole-document Markdown highlighter (no incremental state needed). */
export function createMarkdownHighlighter(initial: string): Highlighter {
  let lines: Line[] = highlightMarkdownLines(initial);
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      lines = highlightMarkdownLines(next);
      return lines;
    },
  };
}

function oneSpan(text: string, cls: TokenClass): Line {
  return text.length === 0
    ? { text: "", spans: [] }
    : { text, spans: [{ col: 0, text, cls }] };
}

interface InlineToken {
  readonly type: string;
  readonly raw: string;
  readonly text?: string;
  readonly href?: string;
  readonly tokens?: readonly InlineToken[];
}

interface BlockToken extends InlineToken {
  readonly codeBlockStyle?: string;
  readonly items?: readonly ListItemToken[];
}

interface ListItemToken extends BlockToken {
  readonly task?: boolean;
  readonly checked?: boolean;
}

interface RichStyle {
  readonly cls: TokenClass;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

class RichLine {
  text = "";
  readonly spans: Span[] = [];
  #sourceHidden = false;

  append(value: string, style: RichStyle): void {
    if (value.length === 0) return;
    const span: Span = {
      col: cpLen(this.text),
      text: value,
      cls: style.cls,
      ...(style.bold ? { bold: true } : {}),
      ...(style.italic ? { italic: true } : {}),
      ...(style.underline ? { underline: true } : {}),
      ...(style.strikethrough ? { strikethrough: true } : {}),
    };
    const last = this.spans[this.spans.length - 1];
    if (last && sameRichStyle(last, span)) {
      this.spans[this.spans.length - 1] = {
        ...last,
        text: last.text + value,
      };
    } else {
      this.spans.push(span);
    }
    this.text += value;
  }

  appendLine(line: Line, extra: Partial<RichStyle> = {}): void {
    if (line.renderedSourceHidden) this.#sourceHidden = true;
    if (line.spans.length === 0 && line.text.length > 0) {
      this.append(line.text, { ...extra, cls: extra.cls ?? "plain" });
      return;
    }
    for (const span of line.spans) {
      this.append(span.text, {
        cls: extra.cls ?? span.cls,
        bold: extra.bold || span.bold,
        italic: extra.italic || span.italic,
        underline: extra.underline || span.underline,
        strikethrough: extra.strikethrough || span.strikethrough,
      });
    }
  }

  hideSource(): void {
    this.#sourceHidden = true;
  }

  line(): Line {
    return {
      text: this.text,
      spans: this.spans,
      ...(this.#sourceHidden ? { renderedSourceHidden: true } : {}),
    };
  }
}

function sameRichStyle(a: Span, b: Span): boolean {
  return a.cls === b.cls &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough;
}

function emptyLine(): Line {
  return { text: "", spans: [] };
}

function hiddenLine(): Line {
  return { text: "", spans: [], renderedSourceHidden: true };
}

function normalizeMarkdownText(text: string): string {
  return text.replace(/\r(?=\n|$)/g, "").replaceAll("\r", " ");
}

function singleStyledLine(text: string, cls: TokenClass): Line {
  return text.length === 0
    ? emptyLine()
    : { text, spans: [{ col: 0, text, cls }] };
}

function renderMarkdownBlocks(
  text: string,
  inlineLexer?: Lexer,
): Line[] {
  const rawLines = text.split("\n");
  const out = rawLines.map((line) =>
    renderMarkdownSourceLine(line, inlineLexer)
  );
  let tokens: readonly BlockToken[];
  try {
    tokens = Lexer.lex(text) as unknown as readonly BlockToken[];
  } catch {
    return out;
  }

  const lineStarts = computeLineStarts(text);
  let offset = 0;
  const declarations: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    const tokenOffset = text.startsWith(token.raw, offset)
      ? offset
      : text.indexOf(token.raw, offset);
    if (tokenOffset < 0) continue;
    offset = tokenOffset + token.raw.length;
    const range = tokenLineRange(token.raw, tokenOffset, lineStarts);
    if (!range) continue;
    const source = rawLines.slice(range.start, range.end + 1);
    const rendered = renderBlockToken(token, source, inlineLexer);
    for (let i = 0; i < source.length; i++) {
      out[range.start + i] = rendered[i] ?? emptyLine();
    }
    const tokenDeclarations = htmlDeclarationRanges(text, tokenOffset, token);
    for (const declaration of tokenDeclarations) declarations.push(declaration);
  }
  applyHtmlDeclarations(text, rawLines, out, declarations, inlineLexer);
  return out;
}

function htmlDeclarationRanges(
  text: string,
  tokenOffset: number,
  token: BlockToken,
): Array<{ start: number; end: number }> {
  if (token.type !== "html") return [];
  const prefix = token.raw.match(/^(?:\n)*( {0,3})(?=<![A-Za-z])/);
  if (!prefix) return [];

  const declarations: Array<{ start: number; end: number }> = [];
  const tokenEnd = tokenOffset + token.raw.length;
  let cursor = tokenOffset + prefix[0].length;
  for (;;) {
    if (!/^<![A-Za-z]/.test(text.slice(cursor))) break;
    const end = declarationMarkupEnd(text, cursor + 2);
    if (end === null) break;
    if (end > tokenEnd) declarations.push({ start: cursor, end });
    cursor = end;

    for (;;) {
      cursor = skipAdjacentDeclarationWhitespace(text, cursor);
      if (text.startsWith("<!--", cursor)) {
        const commentEnd = text.indexOf("-->", cursor + 4);
        if (commentEnd < 0) return declarations;
        cursor = commentEnd + 3;
        continue;
      }
      if (text.startsWith("<?", cursor)) {
        const instructionEnd = text.indexOf("?>", cursor + 2);
        if (instructionEnd < 0) return declarations;
        cursor = instructionEnd + 2;
        continue;
      }
      break;
    }
  }
  return declarations;
}

function skipAdjacentDeclarationWhitespace(
  text: string,
  start: number,
): number {
  let cursor = start;
  let atLineStart = cursor === 0 || text[cursor - 1] === "\n";
  let indentation = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\n") {
      cursor++;
      atLineStart = true;
      indentation = 0;
    } else if (char === " " && atLineStart) {
      if (indentation === 3) break;
      cursor++;
      indentation++;
    } else if (char === "\t" && atLineStart) {
      break;
    } else if (char === " " || char === "\t") {
      cursor++;
    } else {
      break;
    }
  }
  return cursor;
}

function applyHtmlDeclarations(
  text: string,
  sourceLines: readonly string[],
  lines: Line[],
  declarations: readonly { start: number; end: number }[],
  inlineLexer?: Lexer,
): void {
  if (declarations.length === 0) return;

  let visible = "";
  let offset = 0;
  for (const declaration of declarations) {
    const start = Math.max(offset, declaration.start);
    const end = Math.max(start, declaration.end);
    visible += text.slice(offset, start);
    visible += text.slice(start, end).replace(
      /[^\n]/g,
      "",
    );
    offset = end;
  }
  visible += text.slice(offset);

  const visibleLines = visible.split("\n");
  for (let index = 0; index < sourceLines.length; index++) {
    const sourceLine = sourceLines[index];
    const visibleLine = visibleLines[index] ?? "";
    if (visibleLine === sourceLine) continue;
    lines[index] = {
      ...renderMarkdownSourceLine(visibleLine, inlineLexer),
      renderedSourceHidden: true,
    };
  }
}

function tokenLineRange(
  raw: string,
  offset: number,
  lineStarts: number[],
): { start: number; end: number } | null {
  let first = 0;
  while (first < raw.length && raw[first] === "\n") first++;
  let last = raw.length - 1;
  while (last >= first && raw[last] === "\n") last--;
  if (last < first) return null;
  return {
    start: lineIndexOf(lineStarts, offset + first),
    end: lineIndexOf(lineStarts, offset + last),
  };
}

function renderBlockToken(
  token: BlockToken,
  source: readonly string[],
  inlineLexer?: Lexer,
): Line[] {
  switch (token.type) {
    case "heading": {
      const heading = renderInlineLine(
        token.text ?? "",
        "sectionHeader",
        inlineLexer,
        true,
      );
      return splitRichLine(
        { ...heading, renderedSourceHidden: true },
        source.length,
      );
    }
    case "hr":
      return [
        singleStyledLine("────────────────────────────────", "punctuation"),
        ...source.slice(1).map(emptyLine),
      ];
    case "code":
      return renderCodeBlock(token, source);
    case "table":
      return renderTableBlock(source, inlineLexer);
    case "blockquote":
      return renderBlockquoteBlock(source, inlineLexer);
    case "list":
      return renderListBlock(token, source, inlineLexer);
    case "paragraph":
    case "text":
      return renderParagraphBlock(token, source, inlineLexer);
    case "html":
      return renderHtmlBlock(source, inlineLexer);
    case "def":
      return source.map(hiddenLine);
    case "space":
      return source.map(emptyLine);
    default:
      return source.map((line) => renderMarkdownSourceLine(line, inlineLexer));
  }
}

function renderParagraphBlock(
  token: BlockToken,
  source: readonly string[],
  inlineLexer?: Lexer,
): Line[] {
  let tokens = token.tokens;
  try {
    tokens = inlineTokensFor(token.text ?? token.raw, inlineLexer);
  } catch {
    // Keep the block lexer's inline tokens.
  }
  if (!tokens) {
    return source.map((line) => renderInlineLine(line));
  }
  const line = new RichLine();
  appendInlineTokens(line, tokens, { cls: "plain" }, true);
  return splitRichLine(line.line(), source.length);
}

function splitRichLine(line: Line, lineCount: number): Line[] {
  let current = new RichLine();
  const out: Line[] = [];
  if (line.renderedSourceHidden) current.hideSource();
  for (const span of line.spans) {
    const parts = span.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      current.append(parts[i], {
        cls: span.cls,
        bold: span.bold,
        italic: span.italic,
        underline: span.underline,
        strikethrough: span.strikethrough,
      });
      if (i + 1 < parts.length) {
        out.push(current.line());
        current = new RichLine();
        if (line.renderedSourceHidden) current.hideSource();
      }
    }
  }
  out.push(current.line());
  while (out.length < lineCount) {
    out.push(line.renderedSourceHidden ? hiddenLine() : emptyLine());
  }
  return out.slice(0, lineCount);
}

function renderHtmlBlock(
  source: readonly string[],
  inlineLexer?: Lexer,
): Line[] {
  const block = source.join("\n");
  if (
    /^ {0,3}<!\[CDATA\[/.test(source[0] ?? "") &&
    !block.includes("]]>")
  ) {
    return source.map((line) => singleStyledLine(line, "plain"));
  }
  const rawTag = rawHtmlBlockTag(block);
  if (rawTag) {
    const visibleLines = stripRawHtmlContainer(block, rawTag).split("\n");
    return source.map((sourceLine, index) => {
      const visible = visibleLines[index] ?? "";
      const line = singleStyledLine(
        visible,
        rawTag === "pre" ? "string" : "plain",
      );
      return visible !== sourceLine
        ? { ...line, renderedSourceHidden: true }
        : line;
    });
  }
  const visibleLines = stripHtmlTags(block).split("\n");
  return source.map((sourceLine, index) => {
    const visible = visibleLines[index] ?? "";
    const line = renderMarkdownSourceLine(visible, inlineLexer);
    return visible !== sourceLine && !line.renderedSourceHidden
      ? { ...line, renderedSourceHidden: true }
      : line;
  });
}

function renderCodeBlock(
  token: BlockToken,
  source: readonly string[],
): Line[] {
  if (token.codeBlockStyle === "indented") {
    return source.map((line) =>
      singleStyledLine(line.replace(/^(?: {4}|\t)/, ""), "string")
    );
  }

  const fence = openingFence(source[0] ?? "");
  if (!fence) {
    const content = (token.text ?? "").split("\n");
    return source.map((_, i) => ({
      ...singleStyledLine(content[i] ?? "", "string"),
      renderedSourceHidden: true,
    }));
  }
  return source.map((line, i) => {
    if (i === 0 || (i === source.length - 1 && isClosingFence(line, fence))) {
      return hiddenLine();
    }
    return singleStyledLine(stripFenceIndent(line, fence.indent), "string");
  });
}

function renderBlockquoteBlock(
  source: readonly string[],
  inlineLexer?: Lexer,
): Line[] {
  const inner: string[] = [];
  const prefixes: string[] = [];
  let removedMarker = false;
  for (const line of source) {
    const marker = line.match(/^([ \t]{0,3})>[ \t]?/);
    if (marker) removedMarker = true;
    prefixes.push(`${marker?.[1] ?? ""}│ `);
    inner.push(marker ? line.slice(marker[0].length) : line);
  }
  if (!removedMarker) {
    return source.map((line) => renderMarkdownSourceLine(line, inlineLexer));
  }
  const rendered = renderMarkdownBlocks(inner.join("\n"), inlineLexer);
  return rendered.map((line, i) =>
    prependLine(prefixes[i] ?? "│ ", line, "markdownQuote")
  );
}

function renderListBlock(
  token: BlockToken,
  source: readonly string[],
  inlineLexer?: Lexer,
): Line[] {
  if (!token.items || token.items.length === 0) {
    return source.map((line) => renderMarkdownSourceLine(line, inlineLexer));
  }

  const out = source.map(emptyLine);
  const lineStarts = computeLineStarts(token.raw);
  let cursor = 0;
  for (const item of token.items) {
    const itemOffset = token.raw.startsWith(item.raw, cursor)
      ? cursor
      : token.raw.indexOf(item.raw, cursor);
    if (itemOffset < 0) continue;
    cursor = itemOffset + item.raw.length;
    const range = tokenLineRange(item.raw, itemOffset, lineStarts);
    if (!range) continue;
    const start = range.start;
    const end = Math.min(source.length, range.end + 1);
    const marker = source[start].match(
      /^(\s*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/,
    );
    if (!marker) continue;
    const markerSpace = marker[3] ?? "";
    const firstContent = marker[4] ?? "";
    const contentIndent = marker[1].length + marker[2].length +
      markerSpace.length;
    let inner = (item.text ?? "").split("\n");
    if (inner.length !== end - start) {
      inner = [firstContent];
      for (let line = start + 1; line < end; line++) {
        inner.push(stripContainerIndent(source[line], contentIndent));
      }
    }

    const unordered = /^[-*+]$/.test(marker[2]);
    let displayMarker = unordered ? "• " : `${marker[2].replace(/\)$/, ".")} `;
    if (item.task) {
      const checkbox = item.checked ? "☑ " : "☐ ";
      displayMarker = unordered ? checkbox : `${displayMarker}${checkbox}`;
    }

    const rendered = renderMarkdownBlocks(inner.join("\n"), inlineLexer);
    for (let line = start; line < end; line++) {
      if (source[line].trim().length === 0) {
        out[line] = emptyLine();
        continue;
      }
      const prefix = line === start
        ? `${marker[1]}${displayMarker}`
        : `${marker[1]}${" ".repeat(cpLen(displayMarker))}`;
      out[line] = prependLine(
        prefix,
        rendered[line - start] ?? emptyLine(),
        line === start ? "punctuation" : "plain",
      );
    }
  }
  return out;
}

function stripContainerIndent(line: string, width: number): string {
  let removed = 0;
  while (removed < width && line[removed] === " ") removed++;
  return line.slice(removed);
}

function prependLine(
  prefix: string,
  content: Line,
  cls: TokenClass,
): Line {
  const line = new RichLine();
  line.append(prefix, { cls });
  line.appendLine(content);
  return line.line();
}

function renderMarkdownSourceLine(
  source: string,
  inlineLexer?: Lexer,
): Line {
  if (source.trim().length === 0) return emptyLine();
  if (/^ {0,3}\[[^\]]+\]:[ \t]+\S/.test(source)) return hiddenLine();

  const quote = quotePrefix(source);
  const body = quote.body;
  const heading = body.match(/^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/);
  if (heading) {
    const title = heading[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
    const line = new RichLine();
    line.hideSource();
    line.append(quote.glyphs, { cls: "markdownQuote" });
    line.appendLine(renderInlineLine(title, "sectionHeader", inlineLexer));
    return line.line();
  }

  if (isThematicRule(body)) {
    const line = new RichLine();
    line.append(quote.glyphs, { cls: "markdownQuote" });
    line.append("────────────────────────────────", { cls: "punctuation" });
    return line.line();
  }

  const list = body.match(/^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/);
  if (list) {
    const line = new RichLine();
    line.append(quote.glyphs + list[1], { cls: "markdownQuote" });
    const unordered = /^[-*+]$/.test(list[2]);
    const task = list[4].match(/^\[([ xX])\][ \t]+(.*)$/);
    if (task && unordered) {
      line.append(task[1] === " " ? "☐ " : "☑ ", { cls: "punctuation" });
      line.appendLine(renderInlineLine(task[2], "plain", inlineLexer));
    } else {
      const marker = unordered ? "•" : list[2].replace(/\)$/, ".");
      line.append(`${marker} `, { cls: "punctuation" });
      if (task) {
        line.append(task[1] === " " ? "☐ " : "☑ ", { cls: "punctuation" });
        line.appendLine(renderInlineLine(task[2], "plain", inlineLexer));
      } else {
        line.appendLine(renderInlineLine(list[4], "plain", inlineLexer));
      }
    }
    return line.line();
  }

  if (/^ {4}/.test(body)) {
    const line = new RichLine();
    line.append(quote.glyphs, { cls: "markdownQuote" });
    line.append(body.slice(4), { cls: "string" });
    return line.line();
  }

  const line = new RichLine();
  line.append(quote.glyphs, { cls: "markdownQuote" });
  line.appendLine(
    renderInlineLine(
      body,
      quote.glyphs ? "markdownQuote" : "plain",
      inlineLexer,
    ),
  );
  return line.line();
}

function quotePrefix(source: string): { glyphs: string; body: string } {
  let body = source;
  let glyphs = "";
  for (;;) {
    const match = body.match(/^([ \t]{0,3})>[ \t]?/);
    if (!match) break;
    glyphs += `${match[1]}│ `;
    body = body.slice(match[0].length);
  }
  return { glyphs, body };
}

function isThematicRule(line: string): boolean {
  return /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(
    line,
  );
}

function renderInlineLine(
  source: string,
  cls: TokenClass = "plain",
  inlineLexer?: Lexer,
  multiline = false,
): Line {
  const line = new RichLine();
  let tokens: readonly InlineToken[];
  try {
    tokens = inlineTokensFor(source, inlineLexer);
  } catch {
    line.append(source, { cls });
    return line.line();
  }
  appendInlineTokens(line, tokens, { cls }, multiline);
  return line.line();
}

function inlineTokensFor(
  source: string,
  inlineLexer?: Lexer,
): readonly InlineToken[] {
  const lex = (text: string) =>
    (inlineLexer?.inlineTokens(text) ??
      Lexer.lexInline(text)) as unknown as readonly InlineToken[];
  const tokens = lex(source);
  if (!inlineTokensHaveUnpairedSurrogate(tokens)) return tokens;

  const masked = maskAstralCharacters(source);
  if (!masked) return [{ type: "text", raw: source, text: source }];
  return restoreInlineTokens(lex(masked.text), masked.original);
}

function inlineTokensHaveUnpairedSurrogate(
  tokens: readonly InlineToken[],
): boolean {
  return tokens.some((token) =>
    hasUnpairedSurrogate(token.raw) ||
    (token.text !== undefined && hasUnpairedSurrogate(token.text)) ||
    (token.href !== undefined && hasUnpairedSurrogate(token.href)) ||
    (token.tokens !== undefined &&
      inlineTokensHaveUnpairedSurrogate(token.tokens))
  );
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (i + 1 >= text.length || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function maskAstralCharacters(
  source: string,
): { text: string; original: ReadonlyMap<string, string> } | null {
  const astral = [...new Set([...source].filter((char) => char.length > 1))];
  if (astral.length === 0) return null;
  const used = new Set([...source]);
  const replacement = new Map<string, string>();
  const original = new Map<string, string>();
  const ranges = [[0x2600, 0x26ff], [0x2700, 0x27bf], [0x2b00, 0x2bff]];
  for (const [from, to] of ranges) {
    for (
      let code = from;
      code <= to && replacement.size < astral.length;
      code++
    ) {
      const candidate = String.fromCodePoint(code);
      if (used.has(candidate) || !/\p{So}/u.test(candidate)) continue;
      const value = astral[replacement.size];
      replacement.set(value, candidate);
      original.set(candidate, value);
    }
  }
  if (replacement.size !== astral.length) return null;
  return {
    text: [...source].map((char) => replacement.get(char) ?? char).join(""),
    original,
  };
}

function restoreInlineTokens(
  tokens: readonly InlineToken[],
  original: ReadonlyMap<string, string>,
): InlineToken[] {
  const restore = (value: string) =>
    [...value].map((char) => original.get(char) ?? char).join("");
  return tokens.map((token) => ({
    type: token.type,
    raw: restore(token.raw),
    ...(token.text !== undefined ? { text: restore(token.text) } : {}),
    ...(token.href !== undefined ? { href: restore(token.href) } : {}),
    ...(token.tokens !== undefined
      ? { tokens: restoreInlineTokens(token.tokens, original) }
      : {}),
  }));
}

function referenceAwareLexer(text: string): Lexer | undefined {
  try {
    const lexer = new Lexer();
    lexer.lex(text);
    return lexer;
  } catch {
    return undefined;
  }
}

function appendInlineTokens(
  line: RichLine,
  tokens: readonly InlineToken[],
  style: RichStyle,
  multiline = false,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        appendTokenChildren(
          line,
          token,
          { ...style, bold: true },
          multiline,
        );
        break;
      case "em":
        appendTokenChildren(
          line,
          token,
          { ...style, italic: true },
          multiline,
        );
        break;
      case "del":
        appendTokenChildren(line, token, {
          ...style,
          strikethrough: true,
        }, multiline);
        break;
      case "codespan":
        line.append(codeSpanText(token, multiline), {
          ...style,
          cls: "string",
        });
        break;
      case "link":
        line.hideSource();
        {
          const start = line.text.length;
          appendTokenChildren(line, token, {
            ...style,
            cls: "callName",
            underline: true,
          }, multiline);
          appendHiddenLineBreaks(line, token.raw, start, style);
        }
        break;
      case "image": {
        line.hideSource();
        const start = line.text.length;
        line.append("▧ ", { cls: "punctuation" });
        const contentStart = line.text.length;
        appendTokenChildren(line, token, {
          ...style,
          cls: "callName",
          italic: true,
        }, multiline);
        if (line.text.length === contentStart) {
          line.append("image", {
            ...style,
            cls: "callName",
            italic: true,
          });
        }
        appendHiddenLineBreaks(line, token.raw, start, style);
        break;
      }
      case "escape":
        line.append(decodeInlineText(token.text ?? token.raw), style);
        break;
      case "html": {
        line.hideSource();
        const visible = decodeInlineText(
          stripHtmlTags(token.text ?? token.raw),
        );
        line.append(visible, style);
        break;
      }
      case "br":
        if (multiline) line.append("\n", style);
        break;
      default:
        if (token.tokens && token.tokens.length > 0) {
          appendInlineTokens(line, token.tokens, style, multiline);
        } else {
          line.append(
            decodeInlineText(token.text ?? token.raw),
            style,
          );
        }
        break;
    }
  }
}

function appendHiddenLineBreaks(
  line: RichLine,
  raw: string,
  renderedStart: number,
  style: RichStyle,
): void {
  const hidden = countLineBreaks(raw) -
    countLineBreaks(line.text.slice(renderedStart));
  if (hidden > 0) line.append("\n".repeat(hidden), style);
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (const char of text) if (char === "\n") count++;
  return count;
}

function codeSpanText(token: InlineToken, multiline: boolean): string {
  if (!multiline || !token.raw.includes("\n")) return token.text ?? "";
  const marker = token.raw.match(/^`+/)?.[0];
  if (!marker || !token.raw.endsWith(marker)) return token.text ?? "";

  let text = token.raw.slice(marker.length, -marker.length);
  if (
    text.startsWith(" ") &&
    text.endsWith(" ") &&
    /[^ \n]/.test(text)
  ) {
    text = text.slice(1, -1);
  }
  return text;
}

function decodeInlineText(text: string): string {
  return text.split("\n").map((sourceLine) => {
    let decoded = "";
    for (const char of decodeEntities(sourceLine)) {
      const code = char.codePointAt(0)!;
      if (
        char === "\r" || char === "\n" || code === 0x2028 || code === 0x2029
      ) {
        decoded += " ";
      } else if (code < 0x20) {
        decoded += String.fromCodePoint(0x2400 + code);
      } else if (code === 0x7f) {
        decoded += "␡";
      } else if (code >= 0x80 && code <= 0x9f) {
        decoded += "␦";
      } else {
        decoded += char;
      }
    }
    return decoded;
  }).join("\n");
}

function stripHtmlTags(source: string): string {
  let out = "";
  for (let i = 0; i < source.length;) {
    if (source[i] !== "<") {
      out += source[i++];
      continue;
    }

    const commentEnd = source.startsWith("<!--", i)
      ? source.indexOf("-->", i + 4)
      : -1;
    if (source.startsWith("<!--", i) && commentEnd < 0) {
      out += source.slice(i).replace(/[^\n]/g, "");
      break;
    }
    if (commentEnd >= 0) {
      out += source.slice(i, commentEnd + 3).replace(/[^\n]/g, "");
      i = commentEnd + 3;
      continue;
    }
    const cdataEnd = source.startsWith("<![CDATA[", i)
      ? source.indexOf("]]>", i + 9)
      : -1;
    if (source.startsWith("<![CDATA[", i) && cdataEnd < 0) {
      out += source.slice(i);
      break;
    }
    if (cdataEnd >= 0) {
      out += source.slice(i + 9, cdataEnd);
      i = cdataEnd + 3;
      continue;
    }

    const markupEnd = htmlMarkupEnd(source, i);
    if (markupEnd === null) {
      out += source[i++];
      continue;
    }
    out += source.slice(i, markupEnd).replace(/[^\n]/g, "");
    i = markupEnd;
  }
  return out;
}

function rawHtmlBlockTag(source: string): string | null {
  const match = source.match(
    /^ {0,3}<(script|pre|style|textarea)(?=[\t\n\f\r />])/i,
  );
  return match?.[1].toLowerCase() ?? null;
}

function stripRawHtmlContainer(source: string, tag: string): string {
  const openStart = source.indexOf("<");
  const openEnd = htmlMarkupEnd(source, openStart);
  if (openEnd === null) return source;

  const closePrefix = `</${tag}`;
  let closeStart = source.indexOf("<", openEnd);
  let closeEnd: number | null = null;
  while (closeStart >= 0) {
    const candidate = source.slice(
      closeStart,
      closeStart + closePrefix.length,
    ).toLowerCase();
    const delimiter = source[closeStart + closePrefix.length];
    if (
      candidate === closePrefix &&
      /[\t\n\f\r >]/.test(delimiter ?? "")
    ) {
      closeEnd = htmlMarkupEnd(source, closeStart);
      if (closeEnd !== null) break;
    }
    closeStart = source.indexOf("<", closeStart + 1);
  }

  const hiddenOpen = source.slice(openStart, openEnd).replace(/[^\n]/g, "");
  if (closeStart < 0 || closeEnd === null) {
    return source.slice(0, openStart) + hiddenOpen + source.slice(openEnd);
  }
  const hiddenClose = source.slice(closeStart, closeEnd).replace(/[^\n]/g, "");
  return source.slice(0, openStart) + hiddenOpen +
    source.slice(openEnd, closeStart) + hiddenClose + source.slice(closeEnd);
}

function htmlMarkupEnd(source: string, start: number): number | null {
  if (source.startsWith("<?", start)) {
    const end = source.indexOf("?>", start + 2);
    return end < 0 ? null : end + 2;
  }

  let nameStart = start + 1;
  let closing = false;
  if (source[nameStart] === "!") {
    nameStart++;
  } else if (source[nameStart] === "/") {
    closing = true;
    nameStart++;
  }
  if (!/[A-Za-z]/.test(source[nameStart] ?? "")) return null;

  let nameEnd = nameStart + 1;
  while (/[A-Za-z0-9-]/.test(source[nameEnd] ?? "")) nameEnd++;
  if (!/[\t\n\f\r />]/.test(source[nameEnd] ?? "")) return null;

  if (source[start + 1] === "!") {
    return declarationMarkupEnd(source, nameEnd);
  }

  let cursor = skipHtmlSpace(source, nameEnd);
  if (closing) {
    return source[cursor] === ">" ? cursor + 1 : null;
  }

  for (;;) {
    if (source[cursor] === ">") return cursor + 1;
    if (source[cursor] === "/" && source[cursor + 1] === ">") {
      return cursor + 2;
    }
    if (!/[A-Za-z_:]/.test(source[cursor] ?? "")) return null;

    cursor++;
    while (/[A-Za-z0-9_.:-]/.test(source[cursor] ?? "")) cursor++;
    cursor = skipHtmlSpace(source, cursor);
    if (source[cursor] !== "=") continue;

    cursor = skipHtmlSpace(source, cursor + 1);
    const quote = source[cursor];
    if (quote === "'" || quote === '"') {
      const end = source.indexOf(quote, cursor + 1);
      if (end < 0) return null;
      cursor = skipHtmlSpace(source, end + 1);
      continue;
    }

    const valueStart = cursor;
    while (
      cursor < source.length &&
      !/[\t\n\f\r "'=<>`]/.test(source[cursor])
    ) {
      cursor++;
    }
    if (cursor === valueStart) return null;
    cursor = skipHtmlSpace(source, cursor);
  }
}

function skipHtmlSpace(source: string, start: number): number {
  let end = start;
  while (/[\t\n\f\r ]/.test(source[end] ?? "")) end++;
  return end;
}

function declarationMarkupEnd(source: string, start: number): number | null {
  let quote: "'" | '"' | null = null;
  let bracketDepth = 0;
  for (let end = start; end < source.length; end++) {
    const char = source[end];
    if (quote) {
      if (char === quote) quote = null;
    } else if (source.startsWith("<!--", end)) {
      const commentEnd = source.indexOf("-->", end + 4);
      if (commentEnd < 0) return null;
      end = commentEnd + 2;
    } else if (source.startsWith("<?", end)) {
      const instructionEnd = source.indexOf("?>", end + 2);
      if (instructionEnd < 0) return null;
      end = instructionEnd + 1;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "[") {
      bracketDepth++;
    } else if (char === "]" && bracketDepth > 0) {
      bracketDepth--;
    } else if (char === ">" && bracketDepth === 0) {
      return end + 1;
    }
  }
  return null;
}

function appendTokenChildren(
  line: RichLine,
  token: InlineToken,
  style: RichStyle,
  multiline = false,
): void {
  if (token.tokens && token.tokens.length > 0) {
    appendInlineTokens(line, token.tokens, style, multiline);
  } else {
    line.append(decodeInlineText(token.text ?? token.raw), style);
  }
}

interface Fence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly indent: number;
}

function openingFence(line: string): Fence | null {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[2][0] as "`" | "~";
  if (marker === "`" && match[3].includes("`")) return null;
  return {
    marker,
    length: match[2].length,
    indent: match[1].length,
  };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return !!match &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length;
}

function stripFenceIndent(line: string, indent: number): string {
  let remove = 0;
  while (remove < indent && line[remove] === " ") remove++;
  return line.slice(remove);
}

type TableAlign = "left" | "center" | "right";

function renderTableBlock(
  source: readonly string[],
  inlineLexer?: Lexer,
): Line[] {
  const align = tableAlignment(source[1] ?? "");
  const cells = source.map(splitTableCells);
  if (
    !align ||
    cells.some((row) => !row || row.length !== align.length)
  ) {
    return source.map((line) => renderMarkdownSourceLine(line, inlineLexer));
  }

  const richRows = cells.map((row, index) =>
    index === 1
      ? []
      : row!.map((cell) => renderInlineLine(cell.trim(), "plain", inlineLexer))
  );
  const widths = align.map((_, column) =>
    Math.max(
      1,
      maxOf(richRows.map((row) => cpLen(row[column]?.text ?? ""))),
    )
  );
  return source.map((_, index) =>
    index === 1
      ? renderTableDivider(widths)
      : renderTableRow(richRows[index], widths, align, index === 0)
  );
}

function tableAlignment(line: string): TableAlign[] | null {
  const cells = splitTableCells(line);
  if (!cells || !line.includes("|")) return null;
  const out: TableAlign[] = [];
  for (const raw of cells) {
    const cell = raw.trim();
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    out.push(
      cell.startsWith(":") && cell.endsWith(":")
        ? "center"
        : cell.endsWith(":")
        ? "right"
        : "left",
    );
  }
  return out.length > 0 ? out : null;
}

function splitTableCells(line: string): string[] | null {
  let source = line.trim();
  if (!source.includes("|")) return null;
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) {
    source = source.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let ticks = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (
      ticks === 0 &&
      char === "\\" &&
      (source[i + 1] === "|" || source[i + 1] === "\\")
    ) {
      escaped = true;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (source[i + run] === "`") run++;
      current += "`".repeat(run);
      i += run - 1;
      ticks = ticks === run ? 0 : ticks === 0 ? run : ticks;
      continue;
    }
    if (char === "|" && ticks === 0) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function renderTableRow(
  cells: readonly Line[],
  widths: readonly number[],
  align: readonly TableAlign[],
  header: boolean,
): Line {
  const line = new RichLine();
  line.append("│ ", { cls: "punctuation" });
  for (let column = 0; column < widths.length; column++) {
    const cell = cells[column] ?? emptyLine();
    const missing = widths[column] - cpLen(cell.text);
    const left = align[column] === "right"
      ? missing
      : align[column] === "center"
      ? Math.floor(missing / 2)
      : 0;
    const right = missing - left;
    line.append(" ".repeat(left), { cls: "plain" });
    line.appendLine(cell, header ? { bold: true } : {});
    line.append(" ".repeat(right), { cls: "plain" });
    line.append(column + 1 < widths.length ? " │ " : " │", {
      cls: "punctuation",
    });
  }
  return line.line();
}

function renderTableDivider(widths: readonly number[]): Line {
  const text = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
  return singleStyledLine(text, "punctuation");
}

/** Color one non-fenced line by classifying each code point, then run-length
 * encoding the classes into spans. */
function renderLine(t: string): Line {
  if (t.length === 0) return { text: "", spans: [] };
  if (/^#{1,6}(\s|$)/.test(t)) return oneSpan(t, "sectionHeader");
  if (/^\s*>/.test(t)) return oneSpan(t, "markdownQuote");
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(t)) return oneSpan(t, "punctuation");

  const cps = [...t];
  const cls: TokenClass[] = new Array(cps.length).fill("plain");
  let start = 0;
  // A list marker (`- `, `* `, `1. `) past any indentation.
  const list = t.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s)/);
  if (list) {
    const at = [...list[1]].length;
    for (let k = at; k < at + [...list[2]].length; k++) cls[k] = "punctuation";
    start = [...list[0]].length;
  }
  markInline(cps, start, cls);

  const spans: Span[] = [];
  for (let s = 0; s < cps.length;) {
    let e = s + 1;
    while (e < cps.length && cls[e] === cls[s]) e++;
    spans.push({ col: s, text: cps.slice(s, e).join(""), cls: cls[s] });
    s = e;
  }
  return { text: t, spans };
}

/** Mark inline code spans and links over `cls`, working in code points. */
function markInline(cps: string[], from: number, cls: TokenClass[]): void {
  let i = from;
  while (i < cps.length) {
    if (cps[i] === "`") {
      let n = 0;
      while (i + n < cps.length && cps[i + n] === "`") n++;
      let j = i + n;
      let close = -1;
      while (j < cps.length) {
        if (cps[j] === "`") {
          let m = 0;
          while (j + m < cps.length && cps[j + m] === "`") m++;
          if (m === n) {
            close = j + m;
            break;
          }
          j += m;
        } else j++;
      }
      if (close >= 0) {
        for (let k = i; k < close; k++) cls[k] = "string";
        i = close;
        continue;
      }
      i += n;
      continue;
    }
    // A `[text](url)` link: bracket/paren punctuation, the URL a string.
    if (cps[i] === "[") {
      const rb = cps.indexOf("]", i + 1);
      if (rb > i && cps[rb + 1] === "(") {
        const rp = cps.indexOf(")", rb + 2);
        if (rp > rb) {
          cls[i] =
            cls[rb] =
            cls[rb + 1] =
            cls[rp] =
              "punctuation";
          for (let k = rb + 2; k < rp; k++) cls[k] = "string";
          i = rp + 1;
          continue;
        }
      }
    }
    i++;
  }
}

/** Headings as a nested navigation tree: each heading owns the lines down to the
 * next heading of the same or a higher level. */
function headingTree(
  raw: string[],
  lineStarts: number[],
  textLen: number,
): StructureNode[] {
  const heads: { level: number; title: string; line: number }[] = [];
  let fence: string | null = null; // the run (``` or ~~~) of an open code block
  for (let i = 0; i < raw.length; i++) {
    const opener = raw[i].trimStart().match(/^(`{3,}|~{3,})/);
    if (fence !== null) {
      if (opener && raw[i].trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    const m = raw[i].match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i });
  }
  const lineEnd = (line: number) =>
    line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : textLen;
  const build = (from: number, level: number, depth: number): {
    nodes: StructureNode[];
    next: number;
  } => {
    const nodes: StructureNode[] = [];
    let k = from;
    while (k < heads.length && heads[k].level >= level) {
      if (heads[k].level > level) {
        // A deeper heading with no parent at this level: attach at this depth.
        const sub = build(k, heads[k].level, depth);
        for (const node of sub.nodes) nodes.push(node);
        k = sub.next;
        continue;
      }
      const h = heads[k];
      const sub = build(k + 1, h.level + 1, depth + 1);
      // The section runs to just before the next heading of the same or a
      // higher level (`sub.next`), so it encloses its sub-headings.
      const endLine = sub.next < heads.length
        ? heads[sub.next].line - 1
        : raw.length - 1;
      nodes.push({
        kind: "section",
        label: `${"#".repeat(h.level)} ${h.title}`,
        name: h.title,
        startLine: h.line,
        endLine: Math.max(h.line, endLine),
        startCol: 0,
        endCol: cpLen(raw[Math.max(h.line, endLine)] ?? ""),
        startOffset: lineStarts[h.line],
        endOffset: lineEnd(Math.max(h.line, endLine)),
        depth,
        children: sub.nodes,
      });
      k = sub.next;
    }
    return { nodes, next: k };
  };
  return build(0, 1, 0).nodes;
}

/**
 * Heading nodes for a Markdown hunk's navigation tree. Each heading whose own
 * heading line is shown in the hunk becomes a navigable section, anchored at
 * that line (past the diff marker) and running to the last new-side line before
 * the next shown heading. The general structure remap is not used here: it
 * would fold a shown heading into an ancestor whose own heading line is NOT in
 * the diff, so navigation would land on a heading the diff never displays.
 */
export function markdownHeadingNodes(
  headings: readonly StructureNode[],
  lineToDiff: Map<number, number>,
  hunkEnd: number,
  diffLineStarts: number[],
  rawLines: string[],
): StructureNode[] {
  const shown: { node: StructureNode; diffLine: number }[] = [];
  for (const node of headings) {
    const diffLine = lineToDiff.get(node.startLine);
    if (diffLine !== undefined) shown.push({ node, diffLine });
  }
  if (shown.length === 0) return [];
  shown.sort((a, b) => a.diffLine - b.diffLine);
  // The diff lines carrying new-side content (heading or body); a section ends
  // at the last of these before the next shown heading, so it never spills onto
  // a trailing removed block or a "\ No newline at end of file" marker (which
  // the general remap, clamping to visible new-side lines, also excludes).
  const newSide = [...lineToDiff.values()].sort((a, b) => a - b);
  // Depth follows the nesting among the SHOWN headings, walked in document
  // order: the first heading under the hunk is depth 2 and no step jumps more
  // than one level — the pre-order invariant the wasd tree navigation relies
  // on. (A global minimum over the shown set would put a deeper-first window's
  // first heading below depth 2 and strand the sibling/child steps.)
  const stack: { level: number; depth: number }[] = [];
  return shown.map(({ node, diffLine }, i) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.depth) {
      stack.pop();
    }
    const depth = stack.length === 0 ? 2 : stack[stack.length - 1].depth + 1;
    stack.push({ level: node.depth, depth });

    const boundary = i + 1 < shown.length ? shown[i + 1].diffLine : hunkEnd + 1;
    let end = diffLine;
    for (const d of newSide) if (d >= diffLine && d < boundary) end = d;

    const endText = rawLines[end] ?? "";
    const startText = rawLines[diffLine] ?? "";
    const markerWidth = startText.length === 0 ? 0 : 1;
    const bomWidth = node.startLine === 0 &&
        startText[markerWidth] === "\uFEFF"
      ? 1
      : 0;
    const codeStart = markerWidth + bomWidth;
    return {
      kind: "section",
      label: node.label,
      name: node.name,
      startLine: diffLine,
      endLine: end,
      // Past the diff marker and any BOM removed before parsing.
      startCol: Math.min(codeStart, cpLen(startText)),
      endCol: cpLen(endText),
      startOffset: diffLineStarts[diffLine] +
        Math.min(codeStart, startText.length),
      endOffset: diffLineStarts[end] + endText.length,
      depth,
      children: [],
    };
  });
}

export const _internal = {
  RichLine,
  applyHtmlDeclarations,
  appendInlineTokens,
  appendTokenChildren,
  codeSpanText,
  declarationMarkupEnd,
  htmlDeclarationRanges,
  maskAstralCharacters,
  openingFence,
  renderBlockToken,
  renderBlockquoteBlock,
  renderCodeBlock,
  renderHtmlBlock,
  renderInlineLine,
  renderListBlock,
  renderMarkdownBlocks,
  renderParagraphBlock,
  renderTableBlock,
  restoreInlineTokens,
  skipAdjacentDeclarationWhitespace,
  splitRichLine,
  splitTableCells,
  stripHtmlTags,
  tableAlignment,
  tokenLineRange,
};
