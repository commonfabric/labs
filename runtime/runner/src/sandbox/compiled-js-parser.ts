import {
  readIdentifierEnd,
  SIMPLE_IDENTIFIER_RE,
  startsWithStatementWord,
} from "./compiled-js-identifiers.ts";

export interface SourceRange {
  start: number;
  end: number;
}

export interface StatementChunk extends SourceRange {}

export interface ParsedBlock extends SourceRange {
  statements: StatementChunk[];
}

export interface ParsedFunction extends SourceRange {
  params: string[];
  body: ParsedBlock;
}

export class CompiledJsParseError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "CompiledJsParseError";
  }
}

interface ScanState {
  parenDepth: number;
  braceDepth: number;
  bracketDepth: number;
  regexAllowed: boolean;
}

export function stripJsTrivia(
  source: string,
  start = 0,
  end = source.length,
): string {
  for (let cursor = start; cursor < end; cursor++) {
    const charCode = source.charCodeAt(cursor);
    if (isWhitespaceCode(charCode)) {
      break;
    }
    if (
      charCode === 47 &&
      (source.charCodeAt(cursor + 1) === 47 ||
        source.charCodeAt(cursor + 1) === 42)
    ) {
      break;
    }
    if (cursor === end - 1) {
      return source.slice(start, end);
    }
  }

  let cursor = start;
  let output = "";
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  while (cursor < end) {
    const tokenStart = skipTrivia(source, cursor, end);
    if (tokenStart >= end) break;
    const tokenEnd = advanceScanner(source, tokenStart, end, state);
    output += source.slice(tokenStart, tokenEnd);
    cursor = tokenEnd;
  }

  return output;
}

export function parseFunctionText(
  source: string,
  start: number,
  end: number,
): ParsedFunction {
  const trimmed = trimRange(source, start, end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  const functionStart = inner.start;
  const firstWord = readLeadingIdentifier(source, functionStart, inner.end);
  let functionKeyword = firstWord;
  if (firstWord?.text === "async") {
    const asyncEnd = skipTrivia(source, firstWord.end, inner.end);
    const maybeFunction = readLeadingIdentifier(source, asyncEnd, inner.end);
    if (maybeFunction?.text === "function") {
      functionKeyword = maybeFunction;
    }
  }

  if (functionKeyword?.text === "function") {
    const paramsStart = skipTrivia(source, functionKeyword.end, inner.end);
    const openParen = expectChar(source, paramsStart, inner.end, "(");
    const closeParen = findMatchingDelimiter(source, openParen, "(", ")");
    const bodyStart = skipTrivia(source, closeParen + 1, inner.end);
    const openBrace = expectChar(source, bodyStart, inner.end, "{");
    const parsedBody = parseBraceDelimitedBlock(source, openBrace, inner.end);
    const afterBody = skipTrivia(source, parsedBody.closeBrace + 1, inner.end);
    if (afterBody !== inner.end) {
      throw new CompiledJsParseError(
        afterBody,
        "Function expression contains trailing tokens",
      );
    }
    return {
      start: inner.start,
      end: inner.end,
      params: parseParameterNames(
        source.slice(openParen + 1, closeParen),
        openParen + 1,
      ),
      body: parsedBody.block,
    };
  }

  const arrowIndex = findTopLevelArrow(source, inner.start, inner.end);
  if (arrowIndex === undefined) {
    throw new CompiledJsParseError(
      inner.start,
      "Expected a direct function expression",
    );
  }
  const params = parseArrowParameterNames(
    source,
    inner.start,
    arrowIndex,
  );
  const bodyStart = skipTrivia(source, arrowIndex + 2, inner.end);
  const openBrace = expectChar(source, bodyStart, inner.end, "{");
  const parsedBody = parseBraceDelimitedBlock(source, openBrace, inner.end);
  const afterBody = skipTrivia(source, parsedBody.closeBrace + 1, inner.end);
  if (afterBody !== inner.end) {
    throw new CompiledJsParseError(
      afterBody,
      "Arrow function must use a block body",
    );
  }
  return {
    start: inner.start,
    end: inner.end,
    params,
    body: parsedBody.block,
  };
}

export function splitTopLevelCommaList(
  source: string,
  start: number,
  end: number,
): SourceRange[] {
  const parts: SourceRange[] = [];
  let cursor = skipTrivia(source, start, end);
  let segmentStart = cursor;
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  while (cursor < end) {
    if (
      source.charCodeAt(cursor) === 44 &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0
    ) {
      const part = trimRange(source, segmentStart, cursor);
      if (part.start < part.end) {
        parts.push(part);
      }
      cursor++;
      cursor = skipTrivia(source, cursor, end);
      segmentStart = cursor;
      state.regexAllowed = true;
      continue;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }

  const tail = trimRange(source, segmentStart, end);
  if (tail.start < tail.end) {
    parts.push(tail);
  }
  return parts;
}

export function findTopLevelEquals(
  source: string,
  start: number,
  end: number,
): number | undefined {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = start; cursor < end;) {
    const charCode = source.charCodeAt(cursor);
    if (
      charCode === 61 &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0 &&
      source.charCodeAt(cursor + 1) !== 61 &&
      source.charCodeAt(cursor + 1) !== 62 &&
      source.charCodeAt(cursor - 1) !== 43 &&
      source.charCodeAt(cursor - 1) !== 45 &&
      source.charCodeAt(cursor - 1) !== 42 &&
      source.charCodeAt(cursor - 1) !== 47 &&
      source.charCodeAt(cursor - 1) !== 37 &&
      source.charCodeAt(cursor - 1) !== 94 &&
      source.charCodeAt(cursor - 1) !== 38 &&
      source.charCodeAt(cursor - 1) !== 124 &&
      source.charCodeAt(cursor - 1) !== 63 &&
      source.charCodeAt(cursor - 1) !== 33 &&
      source.charCodeAt(cursor - 1) !== 60 &&
      source.charCodeAt(cursor - 1) !== 62
    ) {
      return cursor;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }

  return undefined;
}

export function locationFromOffset(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function parseBraceDelimitedBlock(
  source: string,
  openBrace: number,
  end: number,
): { closeBrace: number; block: ParsedBlock } {
  const statements: StatementChunk[] = [];
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 1,
    bracketDepth: 0,
    regexAllowed: true,
  };
  let cursor = skipTrivia(source, openBrace + 1, end);
  let statementStart = cursor;
  let blockKeyword = cursor < end
    ? readLeadingBlockTerminatedKeyword(source, cursor, end)
    : undefined;
  let blockTerminated = blockKeyword !== undefined;

  while (cursor < end) {
    const beforeBraceDepth = state.braceDepth;
    const before = cursor;
    const charCode = source.charCodeAt(cursor);
    cursor = advanceScanner(source, cursor, end, state);

    if (
      charCode === 125 &&
      beforeBraceDepth === 1 &&
      state.parenDepth === 0 &&
      state.bracketDepth === 0 &&
      state.braceDepth === 0
    ) {
      const tail = trimRange(source, statementStart, before);
      if (tail.start < tail.end) {
        statements.push({
          start: statementStart,
          end: tail.end,
        });
      }
      return {
        closeBrace: before,
        block: {
          start: openBrace + 1,
          end: before,
          statements,
        },
      };
    }

    if (
      charCode === 59 &&
      state.parenDepth === 0 &&
      state.braceDepth === 1 &&
      state.bracketDepth === 0
    ) {
      statements.push({
        start: statementStart,
        end: cursor,
      });
      cursor = skipTrivia(source, cursor, end);
      statementStart = cursor;
      blockKeyword = cursor < end
        ? readLeadingBlockTerminatedKeyword(source, cursor, end)
        : undefined;
      blockTerminated = blockKeyword !== undefined;
      continue;
    }

    if (
      blockTerminated &&
      charCode === 125 &&
      beforeBraceDepth === 2 &&
      state.parenDepth === 0 &&
      state.braceDepth === 1 &&
      state.bracketDepth === 0 &&
      blockKeyword !== undefined &&
      shouldTerminateAfterBlock(source, cursor, end, blockKeyword)
    ) {
      statements.push({
        start: statementStart,
        end: cursor,
      });
      cursor = skipTrivia(source, cursor, end);
      statementStart = cursor;
      blockKeyword = cursor < end
        ? readLeadingBlockTerminatedKeyword(source, cursor, end)
        : undefined;
      blockTerminated = blockKeyword !== undefined;
      continue;
    }

    if (cursor === before) {
      throw new CompiledJsParseError(
        cursor,
        "Parser did not make progress",
      );
    }
  }

  throw new CompiledJsParseError(openBrace, "Unterminated '{}' pair");
}

function readLeadingBlockTerminatedKeyword(
  source: string,
  start: number,
  end: number,
): string | undefined {
  switch (source.charCodeAt(start)) {
    case 99: // c
      return startsWithStatementWord(source, start, end, "class")
        ? "class"
        : undefined;
    case 100: // d
      return startsWithStatementWord(source, start, end, "do")
        ? "do"
        : undefined;
    case 102: // f
      if (startsWithStatementWord(source, start, end, "for")) {
        return "for";
      }
      return startsWithStatementWord(source, start, end, "function")
        ? "function"
        : undefined;
    case 105: // i
      return startsWithStatementWord(source, start, end, "if")
        ? "if"
        : undefined;
    case 115: // s
      return startsWithStatementWord(source, start, end, "switch")
        ? "switch"
        : undefined;
    case 116: // t
      return startsWithStatementWord(source, start, end, "try")
        ? "try"
        : undefined;
    case 119: // w
      return startsWithStatementWord(source, start, end, "while")
        ? "while"
        : undefined;
    default:
      return undefined;
  }
}

function shouldTerminateAfterBlock(
  source: string,
  cursor: number,
  end: number,
  keyword: string,
): boolean {
  if (keyword !== "if") {
    return true;
  }
  const next = tryReadIdentifier(source, skipTrivia(source, cursor, end), end);
  return next?.text !== "else";
}

function parseArrowParameterNames(
  source: string,
  start: number,
  arrowIndex: number,
): string[] {
  const paramsRange = trimRange(source, start, arrowIndex);
  const stripped = stripWholeParentheses(
    source,
    paramsRange.start,
    paramsRange.end,
  );
  const raw = source.slice(stripped.start, stripped.end).trim();
  if (!raw) return [];
  const simple = extractSimpleParameterName(raw);
  if (SIMPLE_IDENTIFIER_RE.test(simple)) {
    return [simple];
  }
  return parseParameterNames(raw, stripped.start);
}

function parseParameterNames(
  sourceOrSlice: string,
  baseOffset: number,
): string[] {
  const params = splitTopLevelCommaList(
    sourceOrSlice,
    0,
    sourceOrSlice.length,
  );
  return params.map((range) => {
    const name = extractSimpleParameterName(
      sourceOrSlice.slice(range.start, range.end).trim(),
    );
    if (!SIMPLE_IDENTIFIER_RE.test(name)) {
      throw new CompiledJsParseError(
        baseOffset + range.start,
        "Factory parameters must be simple identifiers",
      );
    }
    return name;
  });
}

function extractSimpleParameterName(param: string): string {
  const equals = findTopLevelEquals(param, 0, param.length);
  const candidate = equals === undefined
    ? param
    : param.slice(0, equals).trim();
  return candidate;
}

export function isStringLiteralRange(
  source: string,
  start: number,
  end: number,
): boolean {
  return exactStringLiteralRange(source, start, end) !== undefined;
}

function exactStringLiteralRange(
  source: string,
  start: number,
  end: number,
): SourceRange | undefined {
  try {
    const literalStart = skipTrivia(source, start, end);
    const quoteCode = source.charCodeAt(literalStart);
    if (quoteCode !== 34 && quoteCode !== 39) return undefined;
    const literalEnd = scanStringLiteral(source, literalStart, quoteCode, end);
    return skipTrivia(source, literalEnd, end) === end
      ? { start: literalStart, end: literalEnd }
      : undefined;
  } catch {
    return undefined;
  }
}

export function tryParseCallExpression(
  source: string,
  start: number,
  end: number,
): {
  start: number;
  end: number;
  callee: string;
  args: SourceRange[];
} | undefined {
  let trimmed = trimRange(source, start, end);
  if (source[trimmed.end - 1] === ";") {
    trimmed = trimRange(source, trimmed.start, trimmed.end - 1);
  }
  let openParen: number | undefined;
  let closeParen: number | undefined;
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };
  for (let cursor = trimmed.start; cursor < trimmed.end;) {
    const charCode = source.charCodeAt(cursor);
    if (
      charCode === 40 &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0
    ) {
      const matchedCloseParen = findMatchingDelimiter(source, cursor, "(", ")");
      if (
        skipTrivia(source, matchedCloseParen + 1, trimmed.end) === trimmed.end
      ) {
        openParen = cursor;
        closeParen = matchedCloseParen;
        break;
      }
      cursor = matchedCloseParen + 1;
      state.regexAllowed = false;
      continue;
    }
    cursor = advanceScanner(source, cursor, trimmed.end, state);
  }
  if (openParen === undefined || closeParen === undefined) {
    return undefined;
  }
  const callee = source.slice(trimmed.start, openParen).trim();
  return {
    start: trimmed.start,
    end: trimmed.end,
    callee,
    args: splitTopLevelCommaList(source, openParen + 1, closeParen),
  };
}

function expectChar(
  source: string,
  start: number,
  end: number,
  expected: string,
): number {
  const cursor = skipTrivia(source, start, end);
  if (source[cursor] !== expected) {
    throw new CompiledJsParseError(
      cursor,
      `Expected '${expected}'`,
    );
  }
  return cursor;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openChar: "(" | "[" | "{",
  closeChar: ")" | "]" | "}",
): number {
  let depth = 0;
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = openIndex; cursor < source.length;) {
    const char = source[cursor];
    if (char === openChar) {
      depth++;
      if (char === "(") {
        state.parenDepth++;
      } else if (char === "[") {
        state.bracketDepth++;
      } else {
        state.braceDepth++;
      }
      state.regexAllowed = true;
    } else if (char === closeChar) {
      depth--;
      if (char === ")") {
        state.parenDepth = Math.max(0, state.parenDepth - 1);
      } else if (char === "]") {
        state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      } else {
        state.braceDepth = Math.max(0, state.braceDepth - 1);
      }
      state.regexAllowed = false;
      if (depth === 0) {
        return cursor;
      }
    }

    if (char === openChar || char === closeChar) {
      cursor++;
      continue;
    }

    cursor = advanceScanner(source, cursor, source.length, state);
  }

  throw new CompiledJsParseError(
    openIndex,
    `Unterminated '${openChar}${closeChar}' pair`,
  );
}

export function stripWholeParentheses(
  source: string,
  start: number,
  end: number,
): SourceRange {
  let range = trimRange(source, start, end);
  while (source[range.start] === "(") {
    const close = findMatchingDelimiter(source, range.start, "(", ")");
    if (skipTrivia(source, close + 1, range.end) !== range.end) {
      break;
    }
    range = trimRange(source, range.start + 1, close);
  }
  return range;
}

export function trimRange(
  source: string,
  start: number,
  end: number,
): SourceRange {
  if (start >= end) {
    return { start: end, end };
  }

  const firstCode = source.charCodeAt(start);
  const lastCode = source.charCodeAt(end - 1);
  if (
    !isWhitespaceCode(firstCode) &&
    firstCode !== 47 &&
    !isWhitespaceCode(lastCode) &&
    lastCode !== 47
  ) {
    return { start, end };
  }

  const trimmedStart = skipTrivia(source, start, end);
  if (trimmedStart >= end) {
    return { start: end, end };
  }

  return {
    start: trimmedStart,
    end: skipTrailingTrivia(source, trimmedStart, end),
  };
}

function skipTrivia(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (cursor < end) {
    const charCode = source.charCodeAt(cursor);
    if (isWhitespaceCode(charCode)) {
      cursor++;
      continue;
    }
    if (charCode === 47 && source.charCodeAt(cursor + 1) === 47) {
      cursor += 2;
      while (cursor < end && source.charCodeAt(cursor) !== 10) cursor++;
      continue;
    }
    if (charCode === 47 && source.charCodeAt(cursor + 1) === 42) {
      cursor += 2;
      while (
        cursor + 1 < end &&
        !(source.charCodeAt(cursor) === 42 &&
          source.charCodeAt(cursor + 1) === 47)
      ) {
        cursor++;
      }
      if (cursor + 1 >= end) {
        throw new CompiledJsParseError(
          start,
          "Unterminated block comment",
        );
      }
      cursor += 2;
      continue;
    }
    break;
  }
  return cursor;
}

function skipTrailingTrivia(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = end;

  outer:
  while (cursor > start) {
    const charCode = source.charCodeAt(cursor - 1);
    if (isWhitespaceCode(charCode)) {
      cursor--;
      continue;
    }

    if (
      charCode === 47 &&
      cursor - 2 >= start &&
      source.charCodeAt(cursor - 2) === 42
    ) {
      for (let open = cursor - 3; open > start; open--) {
        if (
          source.charCodeAt(open - 1) === 47 &&
          source.charCodeAt(open) === 42
        ) {
          cursor = open - 1;
          continue outer;
        }
      }
      throw new CompiledJsParseError(
        cursor - 2,
        "Unterminated block comment",
      );
    }

    let lineStart = cursor - 1;
    while (
      lineStart > start &&
      source.charCodeAt(lineStart - 1) !== 10 &&
      source.charCodeAt(lineStart - 1) !== 13
    ) {
      lineStart--;
    }
    if (
      lineStart + 1 < cursor &&
      source.charCodeAt(lineStart) === 47 &&
      source.charCodeAt(lineStart + 1) === 47
    ) {
      cursor = lineStart;
      continue;
    }

    break;
  }

  return cursor;
}

function advanceScanner(
  source: string,
  start: number,
  end: number,
  state: ScanState,
): number {
  const cursor = start;
  if (cursor >= end) return cursor;

  const charCode = source.charCodeAt(cursor);

  // Trivia is transparent to regex-vs-division classification: the previous
  // significant token decides whether the next `/` opens a regex literal, so
  // skipping it leaves `regexAllowed` unchanged. Leading whitespace consumes any
  // following comments through skipTrivia, mirroring how a leading comment (in
  // the `/` branch below) already consumes following whitespace — a run of mixed
  // whitespace and comments is skipped the same way regardless of its order.
  if (isWhitespaceCode(charCode)) {
    return skipTrivia(source, cursor, end);
  }

  if (charCode === 39 || charCode === 34) {
    state.regexAllowed = false;
    return scanStringLiteral(source, cursor, charCode, end);
  }

  if (charCode === 96) {
    state.regexAllowed = false;
    return scanTemplateLiteral(source, cursor, end);
  }

  if (charCode === 47) {
    const nextCode = source.charCodeAt(cursor + 1);
    if (nextCode === 47 || nextCode === 42) {
      return skipTrivia(source, cursor, end);
    }
    if (state.regexAllowed || looksLikeRegexStart(source, cursor)) {
      state.regexAllowed = false;
      return scanRegexLiteral(source, cursor, end);
    }
    state.regexAllowed = true;
    return cursor + (nextCode === 61 ? 2 : 1);
  }

  const identifierEnd = readIdentifierEnd(source, cursor, end);
  if (identifierEnd !== undefined) {
    state.regexAllowed = isRegexPrefixKeyword(source, cursor, identifierEnd);
    return identifierEnd;
  }

  if (
    isDigitCode(charCode) ||
    (charCode === 46 && isDigitCode(source.charCodeAt(cursor + 1)))
  ) {
    state.regexAllowed = false;
    return scanNumberLiteral(source, cursor, end);
  }

  switch (charCode) {
    case 40: // (
      state.parenDepth++;
      state.regexAllowed = true;
      return cursor + 1;
    case 41: // )
      state.parenDepth = Math.max(0, state.parenDepth - 1);
      state.regexAllowed = false;
      return cursor + 1;
    case 91: // [
      state.bracketDepth++;
      state.regexAllowed = true;
      return cursor + 1;
    case 93: // ]
      state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      state.regexAllowed = false;
      return cursor + 1;
    case 123: // {
      state.braceDepth++;
      state.regexAllowed = true;
      return cursor + 1;
    case 125: // }
      state.braceDepth = Math.max(0, state.braceDepth - 1);
      state.regexAllowed = false;
      return cursor + 1;
    case 46: // .
      state.regexAllowed = false;
      return cursor + 1;
    case 43: // +
    case 45: // -
      state.regexAllowed = true;
      if (source.charCodeAt(cursor + 1) === charCode) return cursor + 2;
      return cursor + 1;
    case 61: // =
      state.regexAllowed = true;
      if (
        source.charCodeAt(cursor + 1) === 62 ||
        source.charCodeAt(cursor + 1) === 61
      ) {
        return cursor + 2 + Number(source.charCodeAt(cursor + 2) === 61);
      }
      return cursor + 1;
    case 33: // !
    case 60: // <
    case 62: // >
      state.regexAllowed = true;
      if (source.charCodeAt(cursor + 1) === 61) {
        return cursor + 2 + Number(source.charCodeAt(cursor + 2) === 61);
      }
      return cursor + 1;
    case 38: // &
    case 124: // |
      state.regexAllowed = true;
      if (source.charCodeAt(cursor + 1) === charCode) return cursor + 2;
      return cursor + 1;
    case 44: // ,
    case 58: // :
    case 59: // ;
    case 63: // ?
    case 42: // *
    case 37: // %
    case 94: // ^
    case 126: // ~
      state.regexAllowed = true;
      return cursor + 1;
    default:
      state.regexAllowed = false;
      return cursor + 1;
  }
}

function looksLikeRegexStart(source: string, cursor: number): boolean {
  let index = cursor - 1;
  while (index >= 0 && isWhitespaceCode(source.charCodeAt(index))) {
    index--;
  }

  if (index < 0) {
    return true;
  }

  return isRegexPrefixPunctuation(source.charCodeAt(index));
}

function scanStringLiteral(
  source: string,
  start: number,
  quoteCode: number,
  end: number,
): number {
  let cursor = start + 1;
  while (cursor < end) {
    const charCode = source.charCodeAt(cursor);
    if (charCode === 92) {
      cursor += 2;
      continue;
    }
    if (charCode === quoteCode) {
      return cursor + 1;
    }
    if (charCode === 10 || charCode === 13) {
      throw new CompiledJsParseError(start, "Unterminated string literal");
    }
    cursor++;
  }
  throw new CompiledJsParseError(start, "Unterminated string literal");
}

function scanTemplateLiteral(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start + 1;
  while (cursor < end) {
    const charCode = source.charCodeAt(cursor);
    if (charCode === 92) {
      cursor += 2;
      continue;
    }
    if (charCode === 96) {
      return cursor + 1;
    }
    if (charCode === 36 && source.charCodeAt(cursor + 1) === 123) {
      cursor = scanTemplateExpression(source, cursor + 2, end);
      continue;
    }
    cursor++;
  }
  throw new CompiledJsParseError(start, "Unterminated template literal");
}

function scanTemplateExpression(
  source: string,
  start: number,
  end: number,
): number {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 1,
    bracketDepth: 0,
    regexAllowed: true,
  };
  let cursor = start;
  while (cursor < end) {
    const charCode = source.charCodeAt(cursor);
    if (
      charCode === 125 &&
      state.parenDepth === 0 &&
      state.bracketDepth === 0 &&
      state.braceDepth === 1
    ) {
      return cursor + 1;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }
  throw new CompiledJsParseError(start, "Unterminated template expression");
}

function scanRegexLiteral(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start + 1;
  let inClass = false;
  while (cursor < end) {
    const charCode = source.charCodeAt(cursor);
    if (charCode === 92) {
      cursor += 2;
      continue;
    }
    if (charCode === 10 || charCode === 13) {
      throw new CompiledJsParseError(start, "Unterminated regular expression");
    }
    if (charCode === 91) {
      inClass = true;
      cursor++;
      continue;
    }
    if (charCode === 93) {
      inClass = false;
      cursor++;
      continue;
    }
    if (charCode === 47 && !inClass) {
      cursor++;
      while (cursor < end && isAsciiLetterCode(source.charCodeAt(cursor))) {
        cursor++;
      }
      return cursor;
    }
    cursor++;
  }
  throw new CompiledJsParseError(start, "Unterminated regular expression");
}

function scanNumberLiteral(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (
    cursor < end &&
    isNumberLiteralCode(source.charCodeAt(cursor))
  ) {
    cursor++;
  }
  return cursor;
}

function readLeadingIdentifier(
  source: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } | undefined {
  return tryReadIdentifier(source, skipTrivia(source, start, end), end);
}

function tryReadIdentifier(
  source: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } | undefined {
  const identifierEnd = readIdentifierEnd(source, start, end);
  if (identifierEnd === undefined) {
    return undefined;
  }
  return {
    text: source.slice(start, identifierEnd),
    start,
    end: identifierEnd,
  };
}

export function findTopLevelArrow(
  source: string,
  start: number,
  end: number,
): number | undefined {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = start; cursor < end;) {
    if (
      source.charCodeAt(cursor) === 61 &&
      source.charCodeAt(cursor + 1) === 62 &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0
    ) {
      return cursor;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }
  return undefined;
}

function isRegexPrefixKeyword(
  source: string,
  start: number,
  end: number,
): boolean {
  const length = end - start;
  switch (length) {
    case 2:
      return source.startsWith("in", start);
    case 3:
      return source.startsWith("new", start);
    case 4:
      return source.startsWith("case", start) ||
        source.startsWith("else", start) ||
        source.startsWith("void", start);
    case 5:
      return source.startsWith("throw", start) ||
        source.startsWith("yield", start);
    case 6:
      return source.startsWith("delete", start) ||
        source.startsWith("return", start) ||
        source.startsWith("typeof", start);
    case 10:
      return source.startsWith("instanceof", start);
    default:
      return false;
  }
}

function isDigitCode(charCode: number): boolean {
  return charCode >= 48 && charCode <= 57;
}

function isAsciiLetterCode(charCode: number): boolean {
  return (charCode >= 65 && charCode <= 90) ||
    (charCode >= 97 && charCode <= 122);
}

function isWhitespaceCode(charCode: number): boolean {
  return charCode === 9 ||
    charCode === 10 ||
    charCode === 11 ||
    charCode === 12 ||
    charCode === 13 ||
    charCode === 32 ||
    charCode === 160 ||
    charCode === 5760 ||
    (charCode >= 8192 && charCode <= 8202) ||
    charCode === 8232 ||
    charCode === 8233 ||
    charCode === 8239 ||
    charCode === 8287 ||
    charCode === 12288 ||
    charCode === 65279;
}

function isRegexPrefixPunctuation(charCode: number): boolean {
  switch (charCode) {
    case 61: // =
    case 40: // (
    case 91: // [
    case 123: // {
    case 44: // ,
    case 58: // :
    case 59: // ;
    case 33: // !
    case 63: // ?
    case 42: // *
    case 37: // %
    case 94: // ^
    case 38: // &
    case 124: // |
    case 60: // <
    case 62: // >
      return true;
    default:
      return false;
  }
}

function isNumberLiteralCode(charCode: number): boolean {
  return isDigitCode(charCode) ||
    isAsciiLetterCode(charCode) ||
    charCode === 95 || // _
    charCode === 46 || // .
    charCode === 36; // $
}
