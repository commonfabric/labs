/**
 * YAML syntax highlighting for the pager. The scanner recognizes block and
 * flow collections, mapping keys, scalar types, comments, tags, anchors,
 * aliases, quoted strings, and block scalars. It accepts incomplete input so
 * files remain highlighted while they are being edited.
 */

import type { Document, Line, Span, TokenClass } from "../../model.ts";
import { cpLen } from "../../ansi.ts";
import type { Highlighter } from "../language.ts";

interface QuoteState {
  readonly quote: "'" | '"';
  readonly cls: TokenClass;
}

interface BlockScalarState {
  readonly baseIndent: number;
  readonly key?: boolean;
  contentIndent?: number;
}

interface PlainScalarState {
  readonly baseIndent: number;
  readonly flowDepth?: number;
  readonly key?: boolean;
}

interface ExplicitKeyState {
  readonly indent: number;
  readonly flowDepth: number;
  expectsNode: boolean;
  indentlessSequence: boolean;
}

interface HighlightState {
  /** Logical indentation of each open flow collection. */
  readonly flow: number[];

  readonly explicitKeys: ExplicitKeyState[];
  documentPrefix: boolean;
  quote?: QuoteState;
  block?: BlockScalarState;
  plain?: PlainScalarState;
  flowKeyCandidate?: {
    readonly depth: number;
    readonly indent: number;
  };
  pendingNodeIndent?: number;
}

/** Color YAML text into rendered lines. */
export function yamlHighlightLines(text: string): Line[] {
  const rawLines = text.split("\n");
  const state: HighlightState = {
    flow: [],
    explicitKeys: [],
    documentPrefix: true,
  };
  return rawLines.map((line, index) =>
    highlightLine(line, state, rawLines, index)
  );
}

/** A full YAML document. YAML currently contributes syntax color only. */
export function yamlDocument(text: string): Document {
  return {
    text,
    lines: yamlHighlightLines(text),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

/** A whole-document YAML highlighter. */
export function createYamlHighlighter(initial: string): Highlighter {
  let lines = yamlHighlightLines(initial);
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      lines = yamlHighlightLines(next);
      return lines;
    },
  };
}

function highlightLine(
  line: string,
  state: HighlightState,
  rawLines: readonly string[],
  lineIndex: number,
): Line {
  if (state.flowKeyCandidate?.depth === 0) {
    state.flowKeyCandidate = undefined;
  }
  const blockLine = highlightBlockScalarLine(line, state);
  if (blockLine) return blockLine;
  const plainLine = highlightPlainScalarContinuationLine(line, state);
  if (plainLine) return plainLine;

  const spans: Span[] = [];
  let col = 0;
  const push = (
    start: number,
    end: number,
    cls: TokenClass,
    bracketDepth?: number,
  ) => {
    if (end <= start) return;
    const segment = line.slice(start, end);
    spans.push(
      bracketDepth === undefined
        ? { col, text: segment, cls }
        : { col, text: segment, cls, bracketDepth },
    );
    col += cpLen(segment);
  };

  const markerAfterBom = line[0] === "\uFEFF" &&
    isDocumentMarker(line, 1, "---");
  const documentStart = !state.quote && line[0] === "\uFEFF" &&
      (state.documentPrefix || markerAfterBom ||
        bomStartsDocumentPrefix(rawLines, lineIndex))
    ? 1
    : 0;
  let i = 0;
  if (documentStart > 0) {
    push(0, documentStart, "plain");
    i = documentStart;
  }
  if (state.quote) {
    const quoted = scanQuoted(line, i, state.quote.quote, true);
    push(i, quoted.end, state.quote.cls);
    i = quoted.end;
    if (!quoted.closed) return { text: line, spans };
    state.quote = undefined;
    if (state.flow.length > 0) {
      state.flowKeyCandidate = {
        depth: state.flow.length,
        indent: leadingIndent(line),
      };
    }
  }

  const firstContent = skipWhitespace(line, documentStart);
  const firstIndent = firstContent - documentStart;
  const substantive = firstContent < line.length &&
    line[firstContent] !== "\r" &&
    !(line[firstContent] === "#" &&
      isLineCommentStart(line, firstContent, documentStart));
  if (substantive) {
    discardCompletedExplicitKeys(state, line, firstContent, firstIndent);
  }
  const pendingExplicitKey = substantive
    ? state.explicitKeys.at(-1)
    : undefined;
  const pendingNodeIndent = substantive ? state.pendingNodeIndent : undefined;
  const propertyOnly = substantive &&
    isPropertyOnlyLine(line, firstContent);
  const continuesExplicitKey = pendingExplicitKey?.expectsNode === true &&
    !propertyOnly;
  if (substantive) {
    state.documentPrefix = false;
    if (!propertyOnly) {
      state.pendingNodeIndent = undefined;
      if (pendingExplicitKey?.expectsNode) {
        pendingExplicitKey.expectsNode = false;
      }
    }
  }

  const flowPlain = state.plain?.flowDepth === undefined
    ? undefined
    : state.plain;
  if (flowPlain) {
    if (firstContent >= line.length) {
      if (firstContent > i) push(i, firstContent, "whitespace");
      return { text: line, spans };
    }
    if (firstContent > i) push(i, firstContent, "whitespace");
    const end = scanPlainScalar(line, firstContent, state.flow.length);
    const scalarEnd = trimTrailingWhitespace(
      line,
      firstContent,
      end,
    );
    emitPlainScalar(
      line,
      firstContent,
      scalarEnd,
      flowPlain.key === true,
      push,
      true,
    );
    i = scalarEnd;
    const continues = end === line.length &&
      flowPlainScalarContinues(rawLines, lineIndex, state.flow.length);
    state.plain = continues ? flowPlain : undefined;
  }

  let explicitKey = continuesExplicitKey;
  let mappingIndent: number | undefined;
  let nodeStart = firstContent;
  let nodeIndent = firstIndent;
  let sequenceIndent: number | undefined;
  while (i < line.length) {
    if (isWhitespace(line[i])) {
      const end = skipWhitespace(line, i);
      push(i, end, "whitespace");
      i = end;
      continue;
    }

    if (
      i === documentStart &&
      (isDocumentMarker(line, i, "---") ||
        isDocumentMarker(line, i, "..."))
    ) {
      state.flow.length = 0;
      state.explicitKeys.length = 0;
      state.flowKeyCandidate = undefined;
      state.pendingNodeIndent = undefined;
      push(i, i + 3, "sectionHeader");
      state.documentPrefix = line.startsWith("...", i);
      i += 3;
      continue;
    }

    if (i === documentStart && line[i] === "%") {
      const end = scanUntilSeparation(line, i + 1);
      push(i, end, "keyword");
      i = end;
      while (i < line.length) {
        if (isWhitespace(line[i])) {
          const tokenEnd = skipWhitespace(line, i);
          push(i, tokenEnd, "whitespace");
          i = tokenEnd;
          continue;
        }
        if (line[i] === "#" && isCommentStart(line, i)) {
          push(i, line.length, "comment");
          i = line.length;
          break;
        }
        const tokenEnd = scanUntilSeparation(line, i);
        push(i, tokenEnd, line[i] === "!" ? "keyword" : "string");
        i = tokenEnd;
      }
      continue;
    }

    if (
      line[i] === "#" &&
      isLineCommentStart(line, i, documentStart)
    ) {
      push(i, line.length, "comment");
      break;
    }

    if (line[i] === "'" || line[i] === '"') {
      state.flowKeyCandidate = undefined;
      const quote = line[i] as "'" | '"';
      const quoted = scanQuoted(line, i, quote, false);
      const after = skipWhitespace(line, quoted.end);
      const key = explicitKey ||
        (quoted.closed &&
          isMappingColon(line, after, state.flow.length, true));
      const cls: TokenClass = key ? "propertyName" : "string";
      if (key) mappingIndent = nodeIndent;
      if (quoted.closed && state.flow.length > 0) {
        state.flowKeyCandidate = {
          depth: state.flow.length,
          indent: nodeIndent,
        };
      }
      push(i, quoted.end, cls);
      i = quoted.end;
      explicitKey = false;
      if (!quoted.closed) state.quote = { quote, cls };
      continue;
    }

    const block = scanBlockScalarHeader(line, i);
    if (block) {
      state.flowKeyCandidate = undefined;
      const blockKey = explicitKey;
      explicitKey = false;
      push(i, block.end, "punctuation");
      const explicitBaseIndent = blockKey
        ? state.explicitKeys.at(-1)?.indent
        : undefined;
      const baseIndent = explicitBaseIndent ?? mappingIndent ??
        sequenceIndent ?? pendingNodeIndent ?? firstIndent;
      state.block = {
        baseIndent,
        key: blockKey || undefined,
        contentIndent: block.indent === undefined
          ? undefined
          : baseIndent + block.indent,
      };
      i = block.end;
      continue;
    }

    const c = line[i];
    if (c === "[" || c === "{") {
      state.flowKeyCandidate = undefined;
      explicitKey = false;
      push(i, i + 1, "bracket", state.flow.length);
      state.flow.push(nodeIndent);
      i++;
      continue;
    }
    if (c === "]" || c === "}") {
      const closedIndent = state.flow.pop();
      const closedFlow = closedIndent !== undefined;
      const depth = state.flow.length;
      push(i, i + 1, "bracket", depth);
      explicitKey = false;
      state.flowKeyCandidate = undefined;
      while (
        state.explicitKeys.at(-1)?.flowDepth !== undefined &&
        state.explicitKeys.at(-1)!.flowDepth > state.flow.length
      ) {
        state.explicitKeys.pop();
      }
      if (closedFlow) {
        state.flowKeyCandidate = {
          depth: state.flow.length,
          indent: closedIndent,
        };
      }
      i++;
      continue;
    }
    if (c === "," && state.flow.length > 0) {
      state.flowKeyCandidate = undefined;
      explicitKey = false;
      while (
        state.explicitKeys.at(-1)?.flowDepth === state.flow.length
      ) {
        state.explicitKeys.pop();
      }
      push(i, i + 1, "punctuation");
      i++;
      continue;
    }
    const flowKeyCandidate = state.flowKeyCandidate?.depth ===
        state.flow.length
      ? state.flowKeyCandidate
      : undefined;
    if (
      c === ":" &&
      isMappingColon(
        line,
        i,
        state.flow.length,
        flowKeyCandidate !== undefined,
      )
    ) {
      const explicitKeyState = matchingExplicitKey(
        state,
        i,
        firstContent,
        firstIndent,
      );
      if (explicitKeyState) {
        mappingIndent = explicitKeyState.indent;
        state.explicitKeys.pop();
      } else if (flowKeyCandidate) {
        mappingIndent = flowKeyCandidate.indent;
      }
      state.flowKeyCandidate = undefined;
      push(i, i + 1, "punctuation");
      const after = skipWhitespace(line, i + 1);
      const emptyKeyIndent = i === nodeStart ? nodeIndent : undefined;
      mappingIndent ??= emptyKeyIndent;
      if (explicitKey && i === nodeStart) {
        explicitKey = false;
      }
      const valueIndent = mappingIndent ?? emptyKeyIndent ??
        pendingNodeIndent;
      if (
        valueIndent !== undefined &&
        (isEmptyNodeRemainder(line, after) ||
          isPropertyOnlyLine(line, after))
      ) {
        state.pendingNodeIndent = valueIndent;
      }
      i++;
      continue;
    }
    if (
      (c === "-" || c === "?") &&
      isCollectionIndicator(line, i, firstContent)
    ) {
      state.flowKeyCandidate = undefined;
      push(i, i + 1, "punctuation");
      explicitKey = c === "?";
      if (c === "?") {
        state.explicitKeys.push({
          indent: nodeIndent,
          flowDepth: state.flow.length,
          expectsNode: isEmptyNodeRemainder(line, i + 1) ||
            isPropertyOnlyLine(line, i + 1),
          indentlessSequence: false,
        });
        nodeStart = skipWhitespace(line, i + 1);
        nodeIndent = nodeStart - documentStart;
      }
      if (c === "-") {
        if (
          continuesExplicitKey &&
          pendingExplicitKey?.flowDepth === state.flow.length &&
          i - documentStart === pendingExplicitKey.indent
        ) {
          pendingExplicitKey.indentlessSequence = true;
        }
        sequenceIndent = i - documentStart;
        nodeStart = skipWhitespace(line, i + 1);
        nodeIndent = nodeStart - documentStart;
        if (
          isEmptyNodeRemainder(line, nodeStart) ||
          isPropertyOnlyLine(line, nodeStart)
        ) {
          state.pendingNodeIndent = sequenceIndent;
        }
      }
      i++;
      continue;
    }

    if (c === "&" || c === "*" || c === "!") {
      state.flowKeyCandidate = undefined;
      const end = scanHandle(line, i);
      const after = skipWhitespace(line, end);
      if ((c === "&" || c === "!") && i === nodeStart) {
        nodeStart = after;
      }
      if (isMappingColon(line, after, state.flow.length, false)) {
        mappingIndent = nodeIndent;
      }
      if (c === "*" && explicitKey) {
        mappingIndent = nodeIndent;
        explicitKey = false;
      }
      push(i, end, "keyword");
      i = end;
      continue;
    }

    state.flowKeyCandidate = undefined;
    const end = scanPlainScalar(line, i, state.flow.length);
    const scalarEnd = trimTrailingWhitespace(line, i, end);
    const after = skipWhitespace(line, scalarEnd);
    const wasExplicitKey = explicitKey;
    const key = wasExplicitKey ||
      isMappingColon(line, after, state.flow.length, false);
    if (key) mappingIndent = nodeIndent;
    const explicitBaseIndent = wasExplicitKey
      ? state.explicitKeys.at(-1)?.indent
      : undefined;
    const baseIndent = explicitBaseIndent ?? mappingIndent ?? sequenceIndent ??
      pendingNodeIndent ?? firstIndent;
    const multiline = (!key || wasExplicitKey) && end === line.length &&
      (state.flow.length === 0
        ? plainScalarContinues(rawLines, lineIndex, baseIndent)
        : flowPlainScalarContinues(
          rawLines,
          lineIndex,
          state.flow.length,
        ));
    emitPlainScalar(line, i, scalarEnd, key, push, multiline);
    if (multiline) {
      state.plain = {
        baseIndent,
        flowDepth: state.flow.length > 0 ? state.flow.length : undefined,
        key: wasExplicitKey || undefined,
      };
    }
    explicitKey = false;
    i = scalarEnd;
  }

  return { text: line, spans };
}

function highlightPlainScalarContinuationLine(
  line: string,
  state: HighlightState,
): Line | null {
  const plain = state.plain;
  if (!plain || plain.flowDepth !== undefined) return null;
  if (line.trim().length === 0) {
    return line.length === 0 ? { text: line, spans: [] } : {
      text: line,
      spans: [{ col: 0, text: line, cls: "whitespace" }],
    };
  }

  const indent = leadingIndent(line);
  const firstContent = skipWhitespace(line, 0);
  if (indent <= plain.baseIndent || line[firstContent] === "#") {
    state.plain = undefined;
    return null;
  }

  let comment = line.length;
  for (let i = firstContent; i < line.length; i++) {
    if (line[i] === "#" && isCommentStart(line, i)) {
      comment = i;
      break;
    }
  }
  const scalarEnd = trimTrailingWhitespace(
    line,
    firstContent,
    comment,
  );
  const spans: Span[] = [];
  if (firstContent > 0) {
    spans.push({
      col: 0,
      text: line.slice(0, firstContent),
      cls: "whitespace",
    });
  }
  if (scalarEnd > firstContent) {
    spans.push({
      col: cpLen(line.slice(0, firstContent)),
      text: line.slice(firstContent, scalarEnd),
      cls: plain.key ? "propertyName" : "string",
    });
  }
  if (comment > scalarEnd) {
    spans.push({
      col: cpLen(line.slice(0, scalarEnd)),
      text: line.slice(scalarEnd, comment),
      cls: "whitespace",
    });
  }
  if (comment < line.length) {
    spans.push({
      col: cpLen(line.slice(0, comment)),
      text: line.slice(comment),
      cls: "comment",
    });
    state.plain = undefined;
  }
  return { text: line, spans };
}

function flowPlainScalarContinues(
  rawLines: readonly string[],
  lineIndex: number,
  flowDepth: number,
): boolean {
  for (let index = lineIndex + 1; index < rawLines.length; index++) {
    const line = rawLines[index];
    if (line.trim().length === 0) continue;
    const firstContent = skipWhitespace(line, 0);
    if (
      line[firstContent] === "#" ||
      line[firstContent] === "," ||
      line[firstContent] === "]" ||
      line[firstContent] === "}"
    ) {
      return false;
    }
    return scanPlainScalar(line, firstContent, flowDepth) > firstContent;
  }
  return false;
}

function plainScalarContinues(
  rawLines: readonly string[],
  lineIndex: number,
  baseIndent: number,
): boolean {
  for (let index = lineIndex + 1; index < rawLines.length; index++) {
    const line = rawLines[index];
    if (line.trim().length === 0) continue;
    const firstContent = skipWhitespace(line, 0);
    if (line[firstContent] === "#") return false;
    return leadingIndent(line) > baseIndent;
  }
  return false;
}

function highlightBlockScalarLine(
  line: string,
  state: HighlightState,
): Line | null {
  const block = state.block;
  if (!block) return null;
  const indent = leadingIndent(line);
  if (line.trim().length === 0) {
    return line.length === 0 ? { text: line, spans: [] } : {
      text: line,
      spans: [{ col: 0, text: line, cls: "whitespace" }],
    };
  }

  if (block.contentIndent === undefined) {
    if (indent <= block.baseIndent) {
      state.block = undefined;
      return null;
    }
    block.contentIndent = indent;
  } else if (indent < block.contentIndent) {
    state.block = undefined;
    return null;
  }

  const spans: Span[] = [];
  if (indent > 0) {
    spans.push({
      col: 0,
      text: line.slice(0, indent),
      cls: "whitespace",
    });
  }
  if (indent < line.length) {
    spans.push({
      col: cpLen(line.slice(0, indent)),
      text: line.slice(indent),
      cls: block.key ? "propertyName" : "string",
    });
  }
  return { text: line, spans };
}

interface QuotedResult {
  readonly end: number;
  readonly closed: boolean;
}

function scanQuoted(
  line: string,
  start: number,
  quote: "'" | '"',
  continuation: boolean,
): QuotedResult {
  let i = continuation ? start : start + 1;
  while (i < line.length) {
    if (quote === '"' && line[i] === "\\") {
      i = Math.min(line.length, i + 2);
      continue;
    }
    if (line[i] === quote) {
      if (quote === "'" && line[i + 1] === "'") {
        i += 2;
        continue;
      }
      return { end: i + 1, closed: true };
    }
    i++;
  }
  return { end: line.length, closed: false };
}

interface BlockHeader {
  readonly end: number;
  readonly indent?: number;
}

function scanBlockScalarHeader(
  line: string,
  start: number,
): BlockHeader | null {
  if (line[start] !== "|" && line[start] !== ">") return null;
  let i = start + 1;
  let indent: number | undefined;
  let chomping = false;
  for (let count = 0; count < 2 && i < line.length; count++) {
    const c = line[i];
    if (!chomping && (c === "+" || c === "-")) {
      chomping = true;
      i++;
      continue;
    }
    if (indent === undefined && c >= "1" && c <= "9") {
      indent = Number(c);
      i++;
      continue;
    }
    break;
  }
  const after = skipHorizontalWhitespace(line, i);
  if (
    after < line.length && line[after] !== "#" && line[after] !== "\r"
  ) {
    return null;
  }
  return { end: i, indent };
}

function scanPlainScalar(
  line: string,
  start: number,
  flowDepth: number,
): number {
  let i = start;
  while (i < line.length) {
    const c = line[i];
    if (c === "#" && isCommentStart(line, i)) break;
    if (c === ":" && isMappingColon(line, i, flowDepth, false)) break;
    if (
      flowDepth > 0 &&
      (c === "," || c === "[" || c === "]" || c === "{" || c === "}")
    ) {
      break;
    }
    i++;
  }
  return i;
}

function emitPlainScalar(
  line: string,
  start: number,
  end: number,
  key: boolean,
  push: (
    start: number,
    end: number,
    cls: TokenClass,
    bracketDepth?: number,
  ) => void,
  forceString = false,
): void {
  const cls = key
    ? "propertyName"
    : forceString
    ? "string"
    : scalarClass(line.slice(start, end));
  let i = start;
  while (i < end) {
    const whitespace = isWhitespace(line[i]);
    let next = i + 1;
    while (next < end && isWhitespace(line[next]) === whitespace) next++;
    push(i, next, whitespace ? "whitespace" : cls);
    i = next;
  }
}

function scalarClass(raw: string): TokenClass {
  const value = raw.trim();
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(value)) return "boolean";
  if (/^(?:null|Null|NULL|~)$/.test(value)) return "keyword";
  if (isYamlNumber(value)) return "number";
  return "string";
}

function isYamlNumber(value: string): boolean {
  if (/^[+-]?(?:\.inf|\.Inf|\.INF)$/.test(value)) return true;
  if (/^(?:\.nan|\.NaN|\.NAN)$/.test(value)) return true;
  if (/^0o[0-7]+$/.test(value)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return true;
  return /^[+-]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][+-]?[0-9]+)?$/
    .test(value);
}

function bomStartsDocumentPrefix(
  rawLines: readonly string[],
  lineIndex: number,
): boolean {
  const line = rawLines[lineIndex];
  const first = skipWhitespace(line, 1);
  if (
    first < line.length && line[first] !== "\r" &&
    !(line[first] === "#" &&
      (first === 1 || isCommentStart(line, first)))
  ) {
    return false;
  }
  for (let index = lineIndex + 1; index < rawLines.length; index++) {
    const next = rawLines[index];
    const start = next[0] === "\uFEFF" ? 1 : 0;
    const content = skipWhitespace(next, start);
    if (content >= next.length || next[content] === "\r") continue;
    if (
      next[content] === "#" &&
      (content === start || isCommentStart(next, content))
    ) {
      continue;
    }
    return content === start && isDocumentMarker(next, start, "---");
  }
  return true;
}

function discardCompletedExplicitKeys(
  state: HighlightState,
  line: string,
  firstContent: number,
  firstIndent: number,
): void {
  while (state.flow.length === 0) {
    const key = state.explicitKeys.at(-1);
    if (!key || key.flowDepth !== 0 || firstIndent > key.indent) return;
    if (firstIndent === key.indent && line[firstContent] === ":") return;
    if (
      firstIndent === key.indent &&
      line[firstContent] === "-" &&
      isCollectionIndicator(line, firstContent, firstContent) &&
      (key.expectsNode || key.indentlessSequence)
    ) {
      return;
    }
    if (
      key.expectsNode &&
      firstIndent === key.indent &&
      scanBlockScalarHeader(line, firstContent)
    ) {
      return;
    }
    state.explicitKeys.pop();
  }
}

function matchingExplicitKey(
  state: HighlightState,
  index: number,
  firstContent: number,
  firstIndent: number,
): ExplicitKeyState | undefined {
  const key = state.explicitKeys.at(-1);
  if (!key || key.flowDepth !== state.flow.length) return undefined;
  if (key.flowDepth > 0) return key;
  return index === firstContent && firstIndent === key.indent ? key : undefined;
}

function isDocumentMarker(
  line: string,
  start: number,
  marker: "---" | "...",
): boolean {
  if (!line.startsWith(marker, start)) return false;
  const next = line[start + marker.length];
  return next === undefined || isWhitespace(next);
}

function isCollectionIndicator(
  line: string,
  index: number,
  firstContent: number,
): boolean {
  const previous = line[index - 1];
  const next = line[index + 1];
  const separatedBefore = index === firstContent || isWhitespace(previous) ||
    previous === "[" || previous === "{" || previous === ",";
  return separatedBefore && (next === undefined || isWhitespace(next));
}

function isMappingColon(
  line: string,
  index: number,
  flowDepth: number,
  jsonStyleKey: boolean,
): boolean {
  if (line[index] !== ":") return false;
  const next = line[index + 1];
  if (next === undefined || isWhitespace(next)) {
    return true;
  }
  if (
    flowDepth > 0 &&
    (next === "," || next === "]" || next === "}" ||
      next === "[" || next === "{")
  ) {
    return true;
  }
  return flowDepth > 0 && jsonStyleKey;
}

function isCommentStart(line: string, index: number): boolean {
  return index === 0 || isWhitespace(line[index - 1]);
}

function isLineCommentStart(
  line: string,
  index: number,
  documentStart: number,
): boolean {
  return isCommentStart(line, index) ||
    (documentStart > 0 && index === documentStart);
}

function scanHandle(line: string, start: number): number {
  if (line[start] === "!" && line[start + 1] === "<") {
    const close = line.indexOf(">", start + 2);
    return close < 0 ? line.length : close + 1;
  }
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (
      isWhitespace(c) || c === "," || c === "[" || c === "]" ||
      c === "{" || c === "}" ||
      (c === "#" && isCommentStart(line, i))
    ) {
      break;
    }
    i++;
  }
  return i;
}

function isPropertyOnlyLine(
  line: string,
  start: number,
): boolean {
  let i = start;
  let found = false;
  while (i < line.length) {
    i = skipWhitespace(line, i);
    if (i >= line.length || line[i] === "\r") return found;
    if (line[i] === "#" && isCommentStart(line, i)) return found;
    if (line[i] !== "!" && line[i] !== "&") return false;
    found = true;
    i = scanHandle(line, i);
  }
  return found;
}

function isEmptyNodeRemainder(line: string, start: number): boolean {
  const first = skipWhitespace(line, start);
  return first >= line.length || line[first] === "\r" ||
    (line[first] === "#" && isCommentStart(line, first));
}

function scanUntilSeparation(line: string, start: number): number {
  let i = start;
  while (i < line.length && !isWhitespace(line[i])) i++;
  return i;
}

function leadingIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

function skipHorizontalWhitespace(line: string, start: number): number {
  let i = start;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

function skipWhitespace(line: string, start: number): number {
  let i = start;
  while (i < line.length && isWhitespace(line[i])) i++;
  return i;
}

function trimTrailingWhitespace(
  line: string,
  start: number,
  end: number,
): number {
  let i = end;
  while (i > start && isWhitespace(line[i - 1])) i--;
  return i;
}

function isWhitespace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r";
}
