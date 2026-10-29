/**
 * Parses transformed TypeScript text into the {@link Document} model used by the
 * pager.
 *
 * Parsing reuses `npm:typescript` — the exact parser the ts-transformers and
 * js-compiler packages run — so token boundaries, block extents, closures and
 * type positions match what the compiler sees. Nothing here type-checks. The
 * filename selects TypeScript or TSX syntax. A parser failure returns verbatim
 * plain text so the pager remains usable.
 *
 * Three products come out of one parse:
 *   1. Per-line colored {@link Span}s (full-fidelity: every character is
 *      classified, via a deep token walk plus trivia gap-filling).
 *   2. A {@link StructureNode} tree (sections, functions, closures, builders,
 *      schemas, bindings) for navigation and folding.
 *   3. A name -> {@link Definition} index for go-to-definition peeks.
 */

import ts from "typescript";
import type {
  Definition,
  Document,
  Line,
  NodeMeta,
  SchemaField,
  SchemaMeta,
  Span,
  StructureKind,
  StructureNode,
  TokenClass,
  TypeMember,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { cpLen } from "../../ansi.ts";
import { computeLineStarts, lineIndexOf } from "../../lines.ts";
import type { Highlighter } from "../language.ts";
import { plainTextDocument, plainTextLines } from "../plain-text/plain-text.ts";
import {
  describeSynthetic,
  isBuilderName,
  isCallName,
  isSyntheticName,
} from "./vocab.ts";

const SK = ts.SyntaxKind;
const DEFAULT_FILE_NAME = "transformed.tsx";

const STORAGE_KEYWORDS = new Set<ts.SyntaxKind>([
  SK.ConstKeyword,
  SK.LetKeyword,
  SK.VarKeyword,
  SK.FunctionKeyword,
  SK.ClassKeyword,
  SK.InterfaceKeyword,
  SK.EnumKeyword,
  SK.ImportKeyword,
  SK.ExportKeyword,
  SK.TypeKeyword,
  SK.NamespaceKeyword,
  SK.ModuleKeyword,
  SK.DeclareKeyword,
  SK.AbstractKeyword,
  SK.ReadonlyKeyword,
  SK.StaticKeyword,
  SK.PublicKeyword,
  SK.PrivateKeyword,
  SK.ProtectedKeyword,
  SK.AsyncKeyword,
]);

const CONTROL_KEYWORDS = new Set<ts.SyntaxKind>([
  SK.ReturnKeyword,
  SK.IfKeyword,
  SK.ElseKeyword,
  SK.ForKeyword,
  SK.WhileKeyword,
  SK.DoKeyword,
  SK.SwitchKeyword,
  SK.CaseKeyword,
  SK.DefaultKeyword,
  SK.BreakKeyword,
  SK.ContinueKeyword,
  SK.ThrowKeyword,
  SK.TryKeyword,
  SK.CatchKeyword,
  SK.FinallyKeyword,
  SK.AwaitKeyword,
  SK.YieldKeyword,
  SK.NewKeyword,
  SK.InKeyword,
  SK.OfKeyword,
  SK.InstanceOfKeyword,
  SK.TypeOfKeyword,
  SK.DeleteKeyword,
]);

const TYPE_KEYWORDS = new Set<ts.SyntaxKind>([
  SK.StringKeyword,
  SK.NumberKeyword,
  SK.BooleanKeyword,
  SK.AnyKeyword,
  SK.UnknownKeyword,
  SK.ObjectKeyword,
  SK.VoidKeyword,
  SK.NeverKeyword,
  SK.SymbolKeyword,
  SK.BigIntKeyword,
  SK.UndefinedKeyword,
]);

const BRACKET_KINDS = new Set<ts.SyntaxKind>([
  SK.OpenParenToken,
  SK.CloseParenToken,
  SK.OpenBracketToken,
  SK.CloseBracketToken,
  SK.OpenBraceToken,
  SK.CloseBraceToken,
]);

const OPEN_BRACKETS = new Set<ts.SyntaxKind>([
  SK.OpenParenToken,
  SK.OpenBracketToken,
  SK.OpenBraceToken,
]);

// Punctuation that should read as quiet structure, not as operators.
const QUIET_PUNCT = new Set<ts.SyntaxKind>([
  SK.SemicolonToken,
  SK.CommaToken,
  SK.DotToken,
  SK.QuestionDotToken,
  SK.ColonToken,
]);

interface RawToken {
  start: number;
  end: number;
  node: ts.Node;
}

interface GlobalSpan {
  start: number;
  end: number;
  cls: TokenClass;
  bracketDepth?: number;
  exactDefinitionName?: string;
  exactDefinitionDisplayName?: string;
}

/** Parse `text` into the document model. */
export function parseDocument(
  text: string,
  fileName = DEFAULT_FILE_NAME,
): Document {
  try {
    return parseTypeScriptDocument(text, fileName);
  } catch {
    return plainTextDocument(text);
  }
}

function parseTypeScriptDocument(text: string, fileName: string): Document {
  const sf = parseSourceFile(text, fileName);
  const lineStarts = computeLineStarts(text);
  const lineOf = (offset: number) => lineIndexOf(lineStarts, offset);

  const schemaSet = collectSchemaObjects(sf);
  const lines = highlightFromSourceFile(sf, text, lineStarts, schemaSet);

  const definitions = new Map<string, Definition[]>();
  const sections = findSections(text, lineStarts);
  const baseDepth = sections.length > 0 ? 1 : 0;
  const ctx: BuildCtx = {
    sf,
    text,
    schemaSet,
    lineOf,
    lineStarts,
    definitions,
  };
  const roots: StructureNode[] = [];
  for (const stmt of childNodes(sf)) {
    if (stmt.kind === SK.EndOfFileToken || stmt.getEnd() <= stmt.getStart(sf)) {
      continue;
    }
    roots.push(buildNode(stmt, baseDepth, ctx));
  }

  const structure = sections.length > 0
    ? attachSections(roots, sections, lineStarts, text)
    : roots;
  // Comments are not AST nodes; thread them into the tree by position so they
  // are navigable too.
  insertComments(structure, collectComments(sf, text), baseDepth, ctx);
  const flatStructure = flattenStructure(structure);

  return { text, lines, structure, flatStructure, definitions };
}

/**
 * Just the colored lines for `text` — the syntax highlighting — without the
 * structure tree, definitions or comment nodes. This is the work that has to
 * stay correct on every keystroke; it is a fraction of a full {@link
 * parseDocument} (the structure build over the whole AST is the expensive part),
 * so the live editor re-highlights with this and rebuilds the structure only
 * when typing pauses.
 */
export function highlightDocument(
  text: string,
  fileName = DEFAULT_FILE_NAME,
): Line[] {
  try {
    const sf = parseSourceFile(text, fileName);
    const lineStarts = computeLineStarts(text);
    return highlightFromSourceFile(
      sf,
      text,
      lineStarts,
      collectSchemaObjects(sf),
    );
  } catch {
    return plainTextLines(text);
  }
}

function parseSourceFile(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(lower)) return ts.ScriptKind.TS;
  // Inputs without a TypeScript extension can still be transformed output
  // containing JSX.
  return ts.ScriptKind.TSX;
}

/**
 * A conventional quoted string remains one token when an edit changes only its
 * unescaped contents. Replacing only that span preserves the complete-file
 * colors and bracket depths of every other token on the line.
 */
export function highlightLineEditLocally(
  before: Line,
  after: string,
): Line | null {
  const oldText = before.text;
  if (oldText === after) return before;
  const minLength = Math.min(oldText.length, after.length);
  let prefix = 0;
  while (
    prefix < minLength &&
    oldText.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLength - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  const oldEnd = oldText.length - suffix;
  const newEnd = after.length - suffix;

  let spanStart = 0;
  for (const [spanIndex, span] of before.spans.entries()) {
    const spanEnd = spanStart + span.text.length;
    if (span.cls === "string") {
      const quote = span.text[0];
      const quoted = (quote === "'" || quote === '"') &&
        span.text.length >= 2 && span.text.at(-1) === quote;
      const content = span.text.slice(1, -1);
      const contentStart = spanStart + 1;
      const contentEnd = spanEnd - 1;
      if (
        quoted &&
        !content.includes("\\") &&
        prefix >= contentStart &&
        oldEnd <= contentEnd &&
        prefix <= oldEnd
      ) {
        const inserted = after.slice(prefix, newEnd);
        if (
          inserted.includes("\\") || inserted.includes(quote) ||
          /[\r\n\u2028\u2029]/u.test(inserted)
        ) {
          return null;
        }
        const relativeStart = prefix - spanStart;
        const relativeEnd = oldEnd - spanStart;
        const newSpanText = span.text.slice(0, relativeStart) +
          inserted +
          span.text.slice(relativeEnd);
        const columnDelta = cpLen(newSpanText) - cpLen(span.text);
        return {
          text: after,
          spans: before.spans.map((current, index) =>
            index === spanIndex
              ? {
                ...current,
                text: newSpanText,
                exactDefinitionName: current.exactDefinitionName === undefined
                  ? undefined
                  : newSpanText.slice(1, -1),
                exactDefinitionDisplayName:
                  current.exactDefinitionName === undefined
                    ? undefined
                    : quotedDefinitionDisplayName(
                      newSpanText.slice(1, -1),
                    ),
              }
              : index > spanIndex
              ? { ...current, col: current.col + columnDelta }
              : current
          ),
        };
      }
    }
    spanStart = spanEnd;
  }
  return null;
}

function highlightFromSourceFile(
  sf: ts.SourceFile,
  text: string,
  lineStarts: number[],
  schemaSet: Set<ts.Node>,
): Line[] {
  const tokens = collectLeafTokens(sf);
  const bracketDepths = computeBracketDepths(tokens);
  const spans = buildGlobalSpans(text, tokens, bracketDepths, schemaSet);
  return spansToLines(text, lineStarts, spans);
}

/**
 * An incremental highlighter. The TypeScript source file is kept warm and
 * advanced with `updateSourceFile` (which reuses unchanged subtrees), and only
 * the lines from the nearest top-level statement boundary before the edit up to
 * where the highlighting re-converges with the previous result are rebuilt. A
 * top-level statement boundary is at bracket depth zero and outside any
 * multi-line token (comment, template), so a bounded rebuild from there is
 * identical to a full parse of the whole document.
 *
 * A parsing or highlighting failure returns exact plain-text lines. The next
 * edit builds a fresh parser and restores syntax highlighting when it succeeds.
 */
export function createHighlighter(
  initial: string,
  fileName = DEFAULT_FILE_NAME,
): Highlighter {
  let text = initial;
  let highlighter = tryCreateTypeScriptHighlighter(initial, fileName);
  let lines: readonly Line[] = highlighter?.lines ?? plainTextLines(initial);

  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      if (next === text) return lines;
      text = next;
      if (highlighter) {
        try {
          lines = highlighter.update(next);
          return lines;
        } catch {
          highlighter = undefined;
        }
      }
      highlighter = tryCreateTypeScriptHighlighter(next, fileName);
      lines = highlighter?.lines ?? plainTextLines(next);
      return lines;
    },
  };
}

function tryCreateTypeScriptHighlighter(
  initial: string,
  fileName: string,
): Highlighter | undefined {
  try {
    return createTypeScriptHighlighter(initial, fileName);
  } catch {
    return undefined;
  }
}

function createTypeScriptHighlighter(
  initial: string,
  fileName: string,
): Highlighter {
  let sf = parseSourceFile(initial, fileName);
  let text = initial;
  let lineStarts = computeLineStarts(initial);
  let schemaSet = collectSchemaObjects(sf);
  const initialTokens = collectLeafTokens(sf);
  let lines: Line[] = spansToLines(
    text,
    lineStarts,
    buildGlobalSpans(
      text,
      initialTokens,
      computeBracketDepths(initialTokens),
      schemaSet,
    ),
  );
  // The global bracket depth entering each line, kept parallel to `lines`. A
  // rebuild reseeds its depth from this so a partial re-highlight matches a
  // whole-document walk even when error recovery leaves brackets unbalanced
  // across a statement boundary.
  let enter = lineEnterDepths(
    initialTokens,
    lineStarts,
    0,
    lineStarts.length,
    0,
  );

  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      const change = diffRange(text, next);
      if (!change) return lines;

      sf = ts.updateSourceFile(sf, next, change.range);
      const oldLines = lines;
      const oldEnter = enter;
      const oldCount = lineStarts.length;
      text = next;
      lineStarts = computeLineStarts(next);
      schemaSet = collectSchemaObjects(sf);
      const newCount = lineStarts.length;
      const delta = newCount - oldCount;

      const editEndLine = lineIndexOf(
        lineStarts,
        change.start + change.newLength,
      );
      // Rebuild whole lines from the start line of the top-level statement at/
      // before the edit (the whole statement re-parsed so a token whose
      // classification the edit changes — `from` losing its `m` — is
      // reclassified), backing up past any multi-line token (template, block
      // comment) that straddles that line's start.
      const fromLine = safeStartLine(sf, text, lineStarts, change.start);
      const from = lineStarts[fromLine];
      // Everything before `from` is in the unchanged common prefix, so the depth
      // entering `from` is the same as before the edit.
      const startDepth = oldEnter[fromLine] ?? 0;

      const rebuild = (
        toLine: number,
      ): { segLines: Line[]; segEnter: number[] } => {
        const to = toLine < newCount ? lineStarts[toLine] : text.length;
        const tokens = collectTokensInRange(sf, from, to);
        const spans = buildGlobalSpans(
          text,
          tokens,
          computeBracketDepths(tokens, startDepth),
          schemaSet,
          from,
          to,
        );
        return {
          segLines: spansToLinesRange(
            text,
            lineStarts,
            spans,
            fromLine,
            toLine,
          ),
          segEnter: lineEnterDepths(
            tokens,
            lineStarts,
            fromLine,
            toLine,
            startDepth,
          ),
        };
      };

      // Widen until the new highlighting re-converges with the old (shifted)
      // result at a lexically clean line past the edit — same spans, same
      // entering depth, and an empty lexer state — so from there the lines are
      // unchanged and the old tail is reused.
      let toLine = Math.min(newCount, editEndLine + 2);
      for (;;) {
        const { segLines, segEnter } = rebuild(toLine);
        for (let j = editEndLine + 1; j < toLine; j++) {
          const oldIdx = j - delta;
          if (
            oldIdx >= 0 && oldIdx < oldLines.length &&
            segEnter[j - fromLine] === oldEnter[oldIdx] &&
            lineEq(segLines[j - fromLine], oldLines[oldIdx]) &&
            isParserRestart(
              sf,
              text,
              lineStarts,
              lineStarts[j],
              segEnter[j - fromLine],
            )
          ) {
            lines = oldLines.slice(0, fromLine)
              .concat(segLines.slice(0, j - fromLine), oldLines.slice(oldIdx));
            enter = oldEnter.slice(0, fromLine)
              .concat(segEnter.slice(0, j - fromLine), oldEnter.slice(oldIdx));
            return lines;
          }
        }
        if (toLine >= newCount) {
          lines = oldLines.slice(0, fromLine).concat(segLines);
          enter = oldEnter.slice(0, fromLine).concat(segEnter);
          return lines;
        }
        toLine = Math.min(
          newCount,
          toLine + Math.max(16, (toLine - editEndLine) * 2),
        );
      }
    },
  };
}

/** The common-prefix/suffix change between two texts as a TextChangeRange, or
 * null when they are identical. */
function diffRange(
  old: string,
  next: string,
): { start: number; newLength: number; range: ts.TextChangeRange } | null {
  if (old === next) return null;
  const minLen = Math.min(old.length, next.length);
  let p = 0;
  while (p < minLen && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < minLen - p &&
    old.charCodeAt(old.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) s++;
  const oldLength = old.length - s - p;
  const newLength = next.length - s - p;
  return {
    start: p,
    newLength,
    range: { span: { start: p, length: oldLength }, newLength },
  };
}

/** The offset of the nearest top-level statement starting at or before `offset`,
 * or 0 — a bracket-depth-zero boundary. */
function topLevelStartAtOrBefore(sf: ts.SourceFile, offset: number): number {
  const stmts = sf.statements;
  let lo = 0;
  let hi = stmts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stmts[mid].getStart(sf) <= offset) {
      best = stmts[mid].getStart(sf);
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The line to begin a re-highlight at for an edit at `offset`: the line of the
 * top-level statement enclosing (or before) the edit, then walked back past any
 * multi-line token (template, block comment) whose body straddles that line's
 * start. The result's line start is at bracket depth zero and outside every
 * multi-line token, so a whole-line rebuild from it matches a full parse — and
 * starting at the statement's line, not the edit, reclassifies a token the edit
 * reshapes just before it (`from` → `f`).
 */
function safeStartLine(
  sf: ts.SourceFile,
  text: string,
  lineStarts: number[],
  offset: number,
): number {
  let line = lineIndexOf(lineStarts, topLevelStartAtOrBefore(sf, offset));
  for (let guard = 0; guard <= lineStarts.length; guard++) {
    const back = multilineStartLine(sf, text, lineStarts, lineStarts[line]);
    if (back === null || back >= line) break;
    line = back;
  }
  return line;
}

/** If `pos` is inside a multi-line token or block comment that began on an
 * earlier line, the line of the top-level statement containing that start;
 * otherwise null. */
function multilineStartLine(
  sf: ts.SourceFile,
  text: string,
  lineStarts: number[],
  pos: number,
): number | null {
  const posLine = lineIndexOf(lineStarts, pos);
  const tok = tokenAt(sf, pos);
  const tokStart = tok.getStart(sf);
  if (tokStart < pos && lineIndexOf(lineStarts, tokStart) < posLine) {
    return lineIndexOf(lineStarts, topLevelStartAtOrBefore(sf, tokStart));
  }
  // A block comment in the trivia before `tok` may straddle `pos`. The leading
  // ranges miss a comment that opens on the same line as the previous token (no
  // newline precedes it), so the trailing ranges from that point are unioned in.
  const fullStart = tok.getFullStart();
  for (
    const c of [
      ...ts.getLeadingCommentRanges(text, fullStart) ?? [],
      ...ts.getTrailingCommentRanges(text, fullStart) ?? [],
    ]
  ) {
    if (
      c.pos < pos && pos < c.end && lineIndexOf(lineStarts, c.pos) < posLine
    ) {
      return lineIndexOf(lineStarts, topLevelStartAtOrBefore(sf, c.pos));
    }
  }
  return null;
}

/**
 * Whether line `j` starting at `pos` (entered at bracket depth `enterDepth`) is
 * a point where the parser fully restarts, so the highlighting from there on
 * depends only on the text from there on. That requires bracket depth zero, no
 * multi-line comment straddling the line start, and `pos` to fall exactly on a
 * top-level statement's start (or past the last statement). The exact-start
 * requirement is what makes a tail reuse sound: a statement begun in the trivia
 * gap before `pos` could chain back across the line (a leading `.member`
 * continues the previous expression), and a match on spans and depth alone can
 * hide a differing template or brace-kind stack.
 */
function isParserRestart(
  sf: ts.SourceFile,
  text: string,
  lineStarts: number[],
  pos: number,
  enterDepth: number,
): boolean {
  if (enterDepth !== 0) return false;
  const stmts = sf.statements;
  let lo = 0;
  let hi = stmts.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stmts[mid].getStart(sf) <= pos) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Clean only at a statement's exact start, or in leading/trailing trivia
  // (before the first statement or past the last), never in a gap between two
  // statements — a statement there may open with a `.member` that chains back
  // across the line. `idx` is the last statement starting at or before `pos`.
  const atStart = idx >= 0 && stmts[idx].getStart(sf) === pos;
  const beforeFirst = idx < 0;
  const afterLast = idx >= 0 && idx === stmts.length - 1 &&
    pos >= stmts[idx].getEnd();
  if (!atStart && !beforeFirst && !afterLast) return false;
  return multilineStartLine(sf, text, lineStarts, pos) === null;
}

/** The deepest node whose range, including leading trivia, contains `pos`. */
function tokenAt(sf: ts.SourceFile, pos: number): ts.Node {
  let node: ts.Node = sf;
  for (;;) {
    const child: ts.Node | undefined = node.getChildren(sf).find((c) =>
      c.getFullStart() <= pos && pos < c.getEnd()
    );
    if (!child) return node;
    node = child;
  }
}

/** Whether `kind` is a JSDoc node. The token walk does not descend into these:
 * a `{@link Name}` tag parses `Name` as an Identifier leaf, which would split
 * the comment and leave the text after it uncolored — a JSDoc comment stays
 * trivia, colored whole by {@link classifyTrivia}. */
function isJSDocNode(kind: ts.SyntaxKind): boolean {
  return kind >= SK.FirstJSDocNode && kind <= SK.LastJSDocNode;
}

/** Leaf tokens whose start lies in [from, to). The walk prunes subtrees that do
 * not overlap the range, so it costs the range size, not the document size. */
function collectTokensInRange(
  sf: ts.SourceFile,
  from: number,
  to: number,
): RawToken[] {
  const tokens: RawToken[] = [];
  const walk = (node: ts.Node) => {
    if (node.getEnd() <= from || node.getStart(sf) >= to) return;
    if (isJSDocNode(node.kind)) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind <= SK.LastToken) {
        const start = node.getStart(sf);
        const end = node.getEnd();
        if (end > start && start >= from && start < to) {
          tokens.push({ start, end, node });
        }
      }
      return;
    }
    for (const child of children) walk(child);
  };
  walk(sf);
  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

/** Like {@link spansToLines} but only for lines [fromLine, toLine); `spans` must
 * cover exactly that line range. */
function spansToLinesRange(
  text: string,
  lineStarts: number[],
  spans: GlobalSpan[],
  fromLine: number,
  toLine: number,
): Line[] {
  const count = toLine - fromLine;
  const lineSpans: Span[][] = Array.from({ length: count }, () => []);
  const lineCol = new Array(count).fill(0);
  for (const span of spans) {
    let li = lineIndexOf(lineStarts, span.start);
    let pos = span.start;
    while (pos < span.end && li < toLine) {
      const lineEnd = li + 1 < lineStarts.length
        ? lineStarts[li + 1] - 1
        : text.length;
      const segEnd = Math.min(span.end, lineEnd);
      if (segEnd > pos && li >= fromLine) {
        const idx = li - fromLine;
        const segText = text.slice(pos, segEnd);
        lineSpans[idx].push({
          col: lineCol[idx],
          text: segText,
          cls: span.cls,
          bracketDepth: span.bracketDepth,
          exactDefinitionName: pos === span.start
            ? span.exactDefinitionName
            : undefined,
          exactDefinitionDisplayName: pos === span.start
            ? span.exactDefinitionDisplayName
            : undefined,
        });
        lineCol[idx] += cpLen(segText);
      }
      pos = lineEnd + 1;
      li++;
    }
  }
  const out: Line[] = [];
  for (let i = 0; i < count; i++) {
    const li = fromLine + i;
    const lineEnd = li + 1 < lineStarts.length
      ? lineStarts[li + 1] - 1
      : text.length;
    out.push({
      text: text.slice(lineStarts[li], lineEnd),
      spans: lineSpans[i],
    });
  }
  return out;
}

function lineEq(a: Line, b: Line): boolean {
  if (a.text !== b.text || a.spans.length !== b.spans.length) return false;
  for (let i = 0; i < a.spans.length; i++) {
    const x = a.spans[i];
    const y = b.spans[i];
    if (
      x.col !== y.col || x.text !== y.text || x.cls !== y.cls ||
      x.bracketDepth !== y.bracketDepth ||
      x.exactDefinitionName !== y.exactDefinitionName ||
      x.exactDefinitionDisplayName !== y.exactDefinitionDisplayName
    ) {
      return false;
    }
  }
  return true;
}

//
// Tokenisation
//

function collectLeafTokens(sf: ts.SourceFile): RawToken[] {
  const tokens: RawToken[] = [];
  const walk = (node: ts.Node) => {
    if (isJSDocNode(node.kind)) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      // A leaf. Keep only real lexical tokens (kind <= LastToken excludes
      // SyntaxList and node kinds); skip zero-width tokens (EOF).
      if (node.kind <= SK.LastToken) {
        const start = node.getStart(sf);
        const end = node.getEnd();
        if (end > start) tokens.push({ start, end, node });
      }
      return;
    }
    for (const child of children) walk(child);
  };
  walk(sf);
  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

function computeBracketDepths(
  tokens: RawToken[],
  startDepth = 0,
): Map<RawToken, number> {
  const depths = new Map<RawToken, number>();
  let depth = startDepth;
  for (const token of tokens) {
    const kind = token.node.kind;
    if (!BRACKET_KINDS.has(kind)) continue;
    if (OPEN_BRACKETS.has(kind)) {
      depths.set(token, depth);
      depth++;
    } else {
      depth = Math.max(0, depth - 1);
      depths.set(token, depth);
    }
  }
  return depths;
}

/** The global bracket depth entering each line in [fromLine, toLine), indexed
 * from zero. `tokens` must be those at or after `lineStarts[fromLine]`, and
 * `startDepth` the depth entering that first line — so the result is the same
 * depth a whole-document walk would assign. */
function lineEnterDepths(
  tokens: RawToken[],
  lineStarts: number[],
  fromLine: number,
  toLine: number,
  startDepth: number,
): number[] {
  const out = new Array(Math.max(0, toLine - fromLine)).fill(startDepth);
  let depth = startDepth;
  let li = fromLine;
  for (const token of tokens) {
    while (li < toLine && lineStarts[li] <= token.start) {
      out[li - fromLine] = depth;
      li++;
    }
    if (li >= toLine) break;
    const kind = token.node.kind;
    if (!BRACKET_KINDS.has(kind)) continue;
    if (OPEN_BRACKETS.has(kind)) depth++;
    else depth = Math.max(0, depth - 1);
  }
  while (li < toLine) {
    out[li - fromLine] = depth;
    li++;
  }
  return out;
}

function buildGlobalSpans(
  text: string,
  tokens: RawToken[],
  bracketDepths: Map<RawToken, number>,
  schemaSet: Set<ts.Node>,
  from = 0,
  to = text.length,
): GlobalSpan[] {
  const spans: GlobalSpan[] = [];
  let prevEnd = from;
  for (const token of tokens) {
    if (token.start < prevEnd) continue; // defensive against overlap
    if (token.start > prevEnd) {
      classifyTrivia(text, prevEnd, token.start, spans);
    }
    const cls = classifyToken(token.node, schemaSet);
    const definitionTarget = callTargetDefinition(token.node);
    spans.push({
      start: token.start,
      end: token.end,
      cls,
      bracketDepth: cls === "bracket" ? bracketDepths.get(token) : undefined,
      exactDefinitionName: definitionTarget?.name,
      exactDefinitionDisplayName: definitionTarget?.displayName,
    });
    prevEnd = token.end;
  }
  if (prevEnd < to) classifyTrivia(text, prevEnd, to, spans);
  return spans;
}

/** Classify a trivia gap (only whitespace and comments live here). */
function classifyTrivia(
  text: string,
  start: number,
  end: number,
  out: GlobalSpan[],
): void {
  let i = start;
  while (i < end) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < end && text[j] !== "\n") j++;
      const comment = text.slice(i, j);
      const cls: TokenClass = /^\/\/\s*transformed:/.test(comment)
        ? "sectionHeader"
        : "comment";
      out.push({ start: i, end: j, cls });
      i = j;
    } else if (ch === "/" && text[i + 1] === "*") {
      let j = i + 2;
      while (j < end && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j = Math.min(end, j + 2);
      const isDoc = text.startsWith("/**", i) && text[i + 3] !== "/";
      out.push({ start: i, end: j, cls: isDoc ? "docComment" : "comment" });
      i = j;
    } else {
      let j = i;
      while (j < end) {
        if (text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
          break;
        }
        j++;
      }
      out.push({ start: i, end: j, cls: "whitespace" });
      i = j;
    }
  }
}

function classifyToken(node: ts.Node, schemaSet: Set<ts.Node>): TokenClass {
  const kind = node.kind;
  if (TYPE_KEYWORDS.has(kind)) return "typeKeyword";
  if (kind === SK.TrueKeyword || kind === SK.FalseKeyword) return "boolean";
  if (kind === SK.NullKeyword) return "boolean";
  if (kind >= SK.FirstKeyword && kind <= SK.LastKeyword) {
    if (STORAGE_KEYWORDS.has(kind)) return "storageKeyword";
    if (CONTROL_KEYWORDS.has(kind)) return "controlKeyword";
    return "keyword";
  }
  if (BRACKET_KINDS.has(kind)) return "bracket";
  if (kind >= SK.FirstPunctuation && kind <= SK.LastPunctuation) {
    return QUIET_PUNCT.has(kind) ? "punctuation" : "operator";
  }
  if (kind === SK.StringLiteral) return "string";
  if (kind === SK.NumericLiteral || kind === SK.BigIntLiteral) return "number";
  if (kind === SK.RegularExpressionLiteral) return "regex";
  if (
    kind === SK.NoSubstitutionTemplateLiteral ||
    kind === SK.TemplateHead ||
    kind === SK.TemplateMiddle ||
    kind === SK.TemplateTail
  ) {
    return "template";
  }
  if (kind === SK.Identifier || kind === SK.PrivateIdentifier) {
    return classifyIdentifier(node as ts.Identifier, schemaSet);
  }
  return "plain";
}

function classifyIdentifier(
  node: ts.Identifier,
  schemaSet: Set<ts.Node>,
): TokenClass {
  const name = node.text;
  const p = node.parent;

  if (isTypePosition(node)) {
    return isSyntheticName(name) ? "cfHelper" : "typeName";
  }

  // Declaration names.
  if (ts.isFunctionDeclaration(p) && p.name === node) return "functionName";
  if (ts.isFunctionExpression(p) && p.name === node) return "functionName";
  if (ts.isMethodDeclaration(p) && p.name === node) return "functionName";
  if (ts.isMethodSignature(p) && p.name === node) return "functionName";
  if (ts.isInterfaceDeclaration(p) && p.name === node) return "interfaceName";
  if (
    (ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === node
  ) {
    return "typeName";
  }
  if (ts.isTypeAliasDeclaration(p) && p.name === node) return "typeName";
  if (ts.isEnumDeclaration(p) && p.name === node) return "typeName";
  if (ts.isParameter(p) && p.name === node) return "parameter";
  if (ts.isBindingElement(p) && p.name === node) return "binding";
  if (ts.isVariableDeclaration(p) && p.name === node) {
    return isSyntheticName(name) ? "cfHelper" : "binding";
  }
  // A shorthand `{ url }` is both a key and a reference to the variable `url`,
  // so treat it as a reference (it can be a dependency / use site).
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) {
    return isSyntheticName(name) ? "cfHelper" : "identifier";
  }
  if (ts.isPropertyAssignment(p) && p.name === node) {
    return inSchema(node, schemaSet) ? "schemaKey" : "propertyName";
  }
  if (ts.isPropertySignature(p) && p.name === node) return "propertyName";
  if (ts.isPropertyDeclaration(p) && p.name === node) return "propertyName";
  if (ts.isEnumMember(p) && p.name === node) return "propertyName";

  // Property access: `recv.name`.
  if (ts.isPropertyAccessExpression(p) && p.name === node) {
    if (isCalleeOfCall(p)) {
      if (isBuilderName(name) || isCallName(name)) return "builderCall";
    }
    if (isSyntheticName(name)) return "cfHelper";
    return "propertyName";
  }

  // Call / new callee (bare identifier).
  if (ts.isCallExpression(p) && p.expression === node) {
    if (isBuilderName(name) || isCallName(name)) return "builderCall";
    if (isSyntheticName(name)) return "cfHelper";
    return "callName";
  }
  if (ts.isNewExpression(p) && p.expression === node) {
    return isSyntheticName(name) ? "cfHelper" : "callName";
  }

  // Plain reference.
  if (isSyntheticName(name)) return "cfHelper";
  if (isBuilderName(name)) return "builderCall";
  return "identifier";
}

function isCalleeOfCall(node: ts.Expression): boolean {
  let expression = node;
  let p = expression.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isExpressionWithTypeArguments(p)) &&
    p.expression === expression
  ) {
    expression = p;
    p = expression.parent;
  }
  return !!p &&
    (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
    p.expression === expression;
}

function callTargetDefinition(
  node: ts.Node,
): { name: string; displayName: string } | undefined {
  const p = node.parent;
  if (
    ts.isPropertyAccessExpression(p) && p.name === node &&
    isCalleeOfCall(p)
  ) {
    const name = (node as ts.Identifier | ts.PrivateIdentifier).text;
    return { name, displayName: name };
  }
  if (
    ts.isElementAccessExpression(p) && p.argumentExpression === node &&
    isCalleeOfCall(p) &&
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isNumericLiteral(node))
  ) {
    return {
      name: node.text,
      displayName: ts.isNumericLiteral(node)
        ? node.text
        : quotedDefinitionDisplayName(node.text),
    };
  }
  if (
    ts.isNumericLiteral(node) && ts.isPrefixUnaryExpression(p) &&
    p.operand === node &&
    (p.operator === SK.PlusToken || p.operator === SK.MinusToken)
  ) {
    const access = p.parent;
    if (
      ts.isElementAccessExpression(access) &&
      access.argumentExpression === p &&
      isCalleeOfCall(access)
    ) {
      const name = `${p.operator === SK.MinusToken ? "-" : "+"}${node.text}`;
      return { name, displayName: name };
    }
  }
  return undefined;
}

function quotedDefinitionDisplayName(text: string): string {
  return JSON.stringify(text)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** True when `node` sits inside a type annotation/argument (vs an expression). */
function isTypePosition(node: ts.Node): boolean {
  let p = node.parent;
  // Climb through qualified/entity names so `a.B` in a type resolves.
  while (ts.isQualifiedName(p)) {
    p = p.parent;
  }
  // ts.isTypeNode covers type references, `typeof X` queries, and heritage-
  // clause expression types (e.g. `extends Foo`), so they need no separate arm.
  if (ts.isTypeNode(p)) return true;
  if (ts.isTypeParameterDeclaration(p)) return true;
  return false;
}

function inSchema(node: ts.Node, schemaSet: Set<ts.Node>): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isObjectLiteralExpression(p) && schemaSet.has(p)) return true;
    if (ts.isSatisfiesExpression(p)) {
      return /Schema/.test(p.type.getText());
    }
    if (isFunctionLike(p)) return false;
    p = p.parent;
  }
  return false;
}

/** Object literals that materialize a `… satisfies …JSONSchema`. */
function collectSchemaObjects(sf: ts.SourceFile): Set<ts.Node> {
  const set = new Set<ts.Node>();
  const walk = (node: ts.Node) => {
    if (ts.isSatisfiesExpression(node) && /Schema/.test(node.type.getText())) {
      const obj = unwrapToObject(node.expression);
      if (obj) set.add(obj);
    }
    node.forEachChild(walk);
  };
  walk(sf);
  return set;
}

function unwrapToObject(
  expr: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  let e: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return ts.isObjectLiteralExpression(e) ? e : undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}

//
// Structure tree
//

interface BuildCtx {
  sf: ts.SourceFile;
  text: string;
  schemaSet: Set<ts.Node>;
  lineOf: (offset: number) => number;
  lineStarts: number[];
  definitions: Map<string, Definition[]>;
}

/**
 * One classification result. `recurseInto` lists the *child source nodes*
 * {@link buildNode} descends into for sub-structure — chosen explicitly rather
 * than taken from `forEachChild`. A recognized shape narrows or suppresses its
 * children: an import, schema, type alias, interface or enum lists none; a
 * builder lists only its arguments; a closure or function its body. A generic
 * (unclassified) node lists all its children, so the whole AST stays navigable.
 */
interface Desc {
  kind: StructureKind;
  label: string;
  name?: string;

  /** Char offset of the declared identifier, when the node names one. */
  nameOffset?: number;

  recurseInto: readonly ts.Node[];
  meta?: NodeMeta;
}

/**
 * Build a structure node for `node` and, recursively, every AST node beneath it
 * — the whole tree is navigable. Special shapes (functions, schemas, builders,
 * patterns, …) keep their rich label and card metadata via {@link classify};
 * everything else becomes a generic node labeled by its source. Nodes that
 * share `node`'s exact source range are merged into this one (so the user never
 * lands on two nodes that look identical), and every merged AST kind is recorded
 * for the info card.
 */
function buildNode(node: ts.Node, depth: number, ctx: BuildCtx): StructureNode {
  const layers: ts.Node[] = [node];
  let inner = node;
  for (;;) {
    const kids = childNodes(inner);
    if (kids.length === 1 && sameRange(kids[0], node, ctx.sf)) {
      layers.push(kids[0]);
      inner = kids[0];
      continue;
    }
    break;
  }

  const desc = describeMerged(layers, ctx);
  const start = node.getStart(ctx.sf);
  const end = node.getEnd();
  const startLine = ctx.lineOf(start);
  const endLine = ctx.lineOf(Math.max(start, end - 1));
  const sn: StructureNode = {
    kind: desc.kind,
    label: desc.label,
    name: desc.name,
    nameOffset: desc.nameOffset,
    startLine,
    endLine,
    startCol: cpLen(ctx.text.slice(ctx.lineStarts[startLine], start)),
    endCol: cpLen(ctx.text.slice(ctx.lineStarts[endLine], end)),
    startOffset: start,
    endOffset: end,
    depth,
    children: [],
    meta: desc.meta,
    astKinds: layers.map(syntaxKindName),
    generatedOrigin: generatedOriginOf(desc),
  };
  if (desc.name) registerDefinition(ctx, desc, sn);
  // Descend only into the child source nodes the classification chose. A
  // recognized shape narrows or suppresses its children here — an import,
  // schema, type literal or other fold lists no children, a builder lists only
  // its arguments — so the navigable tree stops at the fold instead of
  // expanding into raw AST. A generic (unclassified) node lists all its
  // children, keeping the whole AST reachable.
  for (const child of desc.recurseInto) {
    if (child.getEnd() <= child.getStart(ctx.sf)) continue; // skip empty tokens
    sn.children.push(buildNode(child, depth + 1, ctx));
  }
  return sn;
}

function sameRange(a: ts.Node, b: ts.Node, sf: ts.SourceFile): boolean {
  return a.getStart(sf) === b.getStart(sf) && a.getEnd() === b.getEnd();
}

/** The origin description for a node whose name (or builder) matches the
 * transformer's own vocabulary — those are certainly generated. Undefined for
 * anything else: with no source map back, authored-vs-generated is unknowable,
 * so no claim is made. The info card renders whatever this returns. */
function generatedOriginOf(desc: Desc): string | undefined {
  const probe = desc.name ??
    (desc.meta?.kind === "contract" ? desc.meta.builder : undefined);
  return probe ? describeSynthetic(probe) ?? undefined : undefined;
}

/**
 * The classification for a merged chain: the most specific recognized shape
 * among the layers (outermost first), else a generic node labeled by its first
 * source line.
 */
function describeMerged(layers: ts.Node[], ctx: BuildCtx): Desc {
  for (const n of layers) {
    const d = classify(n, ctx);
    if (d) return d;
  }
  // Prefer the innermost layer for the label: in an exact-range merge it is the
  // most specific node (e.g. the call inside an expression statement). A generic
  // node has no fold, so it recurses into every child of that innermost layer,
  // keeping the whole AST navigable.
  const innermost = layers[layers.length - 1];
  return {
    kind: "node",
    label: genericLabel(innermost, ctx.sf),
    recurseInto: childNodes(innermost),
  };
}

/**
 * A short label for a generic AST node. Chained calls and member accesses are
 * labeled by the distinguishing segment (`.version(…)`, `.name`) rather than
 * the shared left-hand prefix, which a raw first-line slice would show for every
 * link in a fluent chain.
 */
function genericLabel(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const callee = node.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? `.${callee.name.text}`
      : ts.isIdentifier(callee)
      ? callee.text
      : nodeFirstLine(callee, sf, 24);
    const lead = ts.isNewExpression(node) ? "new " : "";
    return `${lead}${name}(…)`;
  }
  if (ts.isPropertyAccessExpression(node)) return `.${node.name.text}`;
  if (ts.isElementAccessExpression(node)) {
    return `${nodeFirstLine(node.expression, sf, 24)}[…]`;
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    return `${nameText(node.name, sf)}:`;
  }
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  return nodeFirstLine(node, sf, 48) || syntaxKindName(node);
}

/** SyntaxKind values to their real name. `ts.SyntaxKind[kind]` reverse-maps an
 * aliased value to its `First*`/`Last*` range-marker name (NumericLiteral reads
 * as "FirstLiteralToken", VariableStatement as "FirstStatement"); this prefers
 * the meaningful name. */
const KIND_NAMES: ReadonlyMap<number, string> = (() => {
  const m = new Map<number, string>();
  for (const [key, val] of Object.entries(ts.SyntaxKind)) {
    if (typeof val !== "number") continue;
    if (key.startsWith("First") || key.startsWith("Last")) continue;
    if (!m.has(val)) m.set(val, key);
  }
  return m;
})();

function syntaxKindName(node: ts.Node): string {
  return KIND_NAMES.get(node.kind) ?? ts.SyntaxKind[node.kind];
}

interface CommentRange {
  start: number;
  end: number;
  text: string;
}

/** Every line and block comment in the source, read from each node's leading
 * and trailing trivia. Going through the parsed tree (rather than a standalone
 * scanner) means strings, templates and regexes are already consumed, so a
 * comment-like sequence inside one is never mistaken for a comment. */
function collectComments(sf: ts.SourceFile, text: string): CommentRange[] {
  const seen = new Set<number>();
  const out: CommentRange[] = [];
  const add = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      out.push({ start: r.pos, end: r.end, text: text.slice(r.pos, r.end) });
    }
  };
  // Walk the full child tree, tokens included: a comment can be the leading
  // trivia of a punctuation token (the `.` mid-chain) that forEachChild skips.
  const walk = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    for (const child of node.getChildren(sf)) walk(child);
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
  };
  walk(sf);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Thread comments into the structure tree as navigable nodes, each placed under
 * the deepest node whose range contains it, in source order. Section divider
 * comments are skipped — they are already their own section node.
 *
 * Done in two passes so it stays near-linear even when many comments land in one
 * sibling array (e.g. a trailing `// …` on every line of a large file): first
 * assign each comment to its host's children array by a binary-search descent
 * over the as-yet-unmodified tree, then merge each batch into its array in a
 * single ordered pass — rather than a per-comment scan-and-splice that is
 * quadratic.
 */
function insertComments(
  roots: StructureNode[],
  comments: CommentRange[],
  baseDepth: number,
  ctx: BuildCtx,
): void {
  const batches = new Map<StructureNode[], StructureNode[]>();
  for (const c of comments) {
    if (/^\/\/\s*transformed:/.test(c.text)) continue;
    let list = roots;
    let depth = baseDepth;
    for (;;) {
      const host = containingChild(list, c.start);
      if (!host) break;
      list = host.children;
      depth = host.depth + 1;
    }
    const batch = batches.get(list) ?? [];
    batch.push(commentNode(c, depth, ctx));
    batches.set(list, batch);
  }
  // `comments` is sorted by start, so each batch is already in source order.
  for (const [list, batch] of batches) mergeByStart(list, batch);
}

/** The child of `list` (siblings sorted ascending, non-overlapping) whose range
 * contains `pos`, by binary search, or undefined. */
function containingChild(
  list: readonly StructureNode[],
  pos: number,
): StructureNode | undefined {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].startOffset <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && pos < list[found].endOffset ? list[found] : undefined;
}

/** Merge `additions` (sorted by startOffset) into `list` (also sorted) in place,
 * one pass. */
function mergeByStart(list: StructureNode[], additions: StructureNode[]): void {
  const merged: StructureNode[] = [];
  let a = 0;
  let b = 0;
  while (a < list.length || b < additions.length) {
    if (
      b >= additions.length ||
      (a < list.length && list[a].startOffset <= additions[b].startOffset)
    ) {
      merged.push(list[a++]);
    } else {
      merged.push(additions[b++]);
    }
  }
  list.length = merged.length;
  for (let i = 0; i < merged.length; i++) list[i] = merged[i];
}

function commentNode(
  c: CommentRange,
  depth: number,
  ctx: BuildCtx,
): StructureNode {
  const startLine = ctx.lineOf(c.start);
  const endLine = ctx.lineOf(Math.max(c.start, c.end - 1));
  return {
    kind: "comment",
    label: firstLine(c.text.trim(), 56),
    startLine,
    endLine,
    startCol: cpLen(ctx.text.slice(ctx.lineStarts[startLine], c.start)),
    endCol: cpLen(ctx.text.slice(ctx.lineStarts[endLine], c.end)),
    startOffset: c.start,
    endOffset: c.end,
    depth,
    children: [],
    astKinds: ["Comment"],
  };
}

function registerDefinition(
  ctx: BuildCtx,
  desc: Desc,
  node: StructureNode,
): void {
  // The sole caller invokes this only when desc.name is set.
  const name = desc.name!;
  const list = ctx.definitions.get(name) ?? [];
  list.push({
    name,
    kind: desc.kind,
    startLine: node.startLine,
    endLine: node.endLine,
    startOffset: node.startOffset,
    endOffset: node.endOffset,
  });
  ctx.definitions.set(name, list);
}

/**
 * Decide whether `node` becomes a structure node, and how. One coherent rule:
 *
 *   - Every statement is a node, its kind refined by its content.
 *   - In expression position, the reactive/structural shapes (closures,
 *     recognized builder/pattern/registered/synthetic calls, JSON-schema object
 *     literals) are nodes too.
 *
 * `recurseInto` chooses each shape's child source nodes: a recognized shape
 * narrows or suppresses them (an import or schema lists none, a builder lists
 * its arguments), while a statement wrapping an expression lists that
 * expression so the call or closure inside stays its own node.
 */
function classify(node: ts.Node, ctx: BuildCtx): Desc | null {
  const { sf } = ctx;

  // declarations (also statements)
  if (ts.isImportDeclaration(node)) {
    return {
      kind: "import",
      label: nodeFirstLine(node, sf, 48),
      recurseInto: [],
      meta: importMeta(node, sf),
    };
  }
  if (ts.isFunctionDeclaration(node)) {
    const name = node.name?.text ?? "ƒ";
    return {
      kind: "function",
      label: `ƒ ${name}`,
      name,
      nameOffset: node.name?.getStart(sf),
      recurseInto: bodyChildren(node),
      meta: closureMeta(node, sf),
    };
  }
  if (
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  ) {
    const name = ts.isConstructorDeclaration(node)
      ? "constructor"
      : nameText(node.name, sf);
    return {
      kind: "method",
      label: `ƒ ${name}`,
      name: ts.isConstructorDeclaration(node) ? undefined : name,
      nameOffset: ts.isConstructorDeclaration(node)
        ? undefined
        : node.name.getStart(sf),
      recurseInto: bodyChildren(node),
      meta: closureMeta(node, sf),
    };
  }
  if (ts.isClassDeclaration(node)) {
    const name = node.name?.text ?? "class";
    return {
      kind: "class",
      label: `class ${name}`,
      name,
      recurseInto: [...node.members],
    };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return {
      kind: "interface",
      label: `interface ${node.name.text}`,
      name: node.name.text,
      recurseInto: [],
      meta: typeMeta(node, sf),
    };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return {
      kind: "typeAlias",
      label: `type ${node.name.text}`,
      name: node.name.text,
      recurseInto: [],
      meta: typeMeta(node, sf),
    };
  }
  if (ts.isEnumDeclaration(node)) {
    return {
      kind: "typeAlias",
      label: `enum ${node.name.text}`,
      name: node.name.text,
      recurseInto: [],
    };
  }
  if (ts.isExportAssignment(node)) {
    return {
      kind: "export",
      label: nodeFirstLine(node, sf, 48),
      recurseInto: [node.expression],
    };
  }
  if (ts.isExportDeclaration(node) || ts.isNamespaceExportDeclaration(node)) {
    return {
      kind: "export",
      label: nodeFirstLine(node, sf, 48),
      recurseInto: [],
    };
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return {
      kind: "import",
      label: nodeFirstLine(node, sf, 48),
      recurseInto: [],
    };
  }
  if (ts.isModuleDeclaration(node)) {
    const body = node.body;
    return {
      kind: "class",
      label: `namespace ${nameText(node.name, sf)}`,
      name: ts.isIdentifier(node.name) ? node.name.text : undefined,
      recurseInto: body ? [body] : [],
    };
  }

  // variable statements & declarations: A single binding is represented by the
  // whole statement (so the `variable` node covers `export const … ;`); a
  // multi-declarator statement stays generic and each declaration becomes its
  // own binding node. The single declaration itself stays generic to avoid
  // labeling one binding at two nesting levels.
  if (ts.isVariableStatement(node)) {
    const decls = node.declarationList.declarations;
    if (decls.length === 1) return bindingDesc(decls[0], ctx);
    return null;
  }
  if (ts.isVariableDeclaration(node)) {
    const list = node.parent;
    if (ts.isVariableDeclarationList(list) && list.declarations.length === 1) {
      return null;
    }
    return bindingDesc(node, ctx);
  }

  // other statements
  if (ts.isExpressionStatement(node)) {
    return expressionStatementDesc(node.expression, ctx);
  }
  if (ts.isReturnStatement(node)) {
    return {
      kind: "return",
      label: `return${returnSuffix(node.expression, sf)}`,
      recurseInto: node.expression ? [node.expression] : [],
    };
  }
  if (ts.isThrowStatement(node)) {
    return {
      kind: "statement",
      label: `throw ${nodeFirstLine(node.expression, sf, 40)}`,
      recurseInto: [node.expression],
    };
  }
  if (isControlStatement(node)) {
    return {
      kind: "control",
      label: controlLabel(node, sf),
      recurseInto: childNodes(node),
    };
  }
  if (ts.isLabeledStatement(node)) {
    return {
      kind: "statement",
      label: `${node.label.text}:`,
      recurseInto: [node.statement],
    };
  }
  if (
    ts.isBreakStatement(node) || ts.isContinueStatement(node) ||
    ts.isEmptyStatement(node) || node.kind === SK.DebuggerStatement
  ) {
    return {
      kind: "statement",
      label: nodeFirstLine(node, sf, 32),
      recurseInto: [],
    };
  }

  // Any other node sitting in a statement list stays reachable as a plain
  // statement, so navigation never skips a line of source.
  if (isInStatementList(node)) {
    return {
      kind: "statement",
      label: nodeFirstLine(node, sf, 40),
      recurseInto: childNodes(node),
    };
  }

  // significant expressions (in argument / body / return position)
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return {
      kind: "closure",
      label: `λ${paramList(node, sf)}`,
      recurseInto: bodyChildren(node),
      meta: closureMeta(node, sf),
    };
  }
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node, sf);
    if (isReactiveCallee(callee)) {
      return callDesc(node, callee, undefined, undefined, ctx);
    }
    return null; // ordinary call: descend to find any reactive call inside
  }
  if (ts.isObjectLiteralExpression(node) && ctx.schemaSet.has(node)) {
    return {
      kind: "schema",
      label: `schema {${objectKeys(node)}}`,
      recurseInto: [],
      meta: schemaNodeMeta(node),
    };
  }
  return null;
}

/** Refine a single binding (`name = init`) by its initializer. */
function bindingDesc(node: ts.VariableDeclaration, ctx: BuildCtx): Desc {
  const { sf } = ctx;
  const name = nameText(node.name, sf);
  const nameOffset = node.name.getStart(sf);
  const init = node.initializer;
  if (!init) {
    return {
      kind: "variable",
      label: name,
      name,
      nameOffset,
      recurseInto: [],
      meta: variableMeta(node, sf),
    };
  }
  const e = peelExpr(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    return {
      kind: "closure",
      label: `λ ${name}`,
      name,
      nameOffset,
      recurseInto: bodyChildren(e),
      meta: closureMeta(e, sf),
    };
  }
  if (ts.isCallExpression(e)) {
    const callee = calleeName(e, sf);
    if (isReactiveCallee(callee)) {
      return callDesc(e, callee, name, nameOffset, ctx);
    }
    // A non-reactive call (e.g. `input.key(…)`, a `.for(…)` chain): a plain
    // binding, but descend into it so any reactive call inside is reached.
    return {
      kind: "variable",
      label: `${name} = ${callee}(…)`,
      name,
      nameOffset,
      recurseInto: [e],
      meta: variableMeta(node, sf),
    };
  }
  if (ts.isObjectLiteralExpression(e)) {
    if (ctx.schemaSet.has(e)) {
      return {
        kind: "schema",
        label: `schema ${name} {${objectKeys(e)}}`,
        name,
        nameOffset,
        recurseInto: [],
        meta: schemaNodeMeta(e),
      };
    }
    return {
      kind: "object",
      label: `${name} {${objectKeys(e)}}`,
      name,
      nameOffset,
      recurseInto: [e],
    };
  }
  return {
    kind: "variable",
    label: name,
    name,
    nameOffset,
    recurseInto: [init],
    meta: variableMeta(node, sf),
  };
}

/** Refine an expression statement by its (peeled) expression. */
function expressionStatementDesc(expr: ts.Expression, ctx: BuildCtx): Desc {
  const { sf } = ctx;
  const e = peelExpr(expr);
  if (ts.isCallExpression(e)) {
    const callee = calleeName(e, sf);
    if (isReactiveCallee(callee)) {
      return callDesc(e, callee, undefined, undefined, ctx);
    }
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    return {
      kind: "closure",
      label: `λ${paramList(e, sf)}`,
      recurseInto: bodyChildren(e),
      meta: closureMeta(e, sf),
    };
  }
  return {
    kind: "statement",
    label: nodeFirstLine(expr, sf, 48),
    recurseInto: [expr],
  };
}

/** Build a builder/pattern node from a recognized reactive call. */
function callDesc(
  call: ts.CallExpression,
  callee: string,
  boundName: string | undefined,
  nameOffset: number | undefined,
  ctx: BuildCtx,
): Desc {
  const suffix = boundName ? ` ${boundName}` : "";
  const synthetic = !!boundName && isSyntheticName(boundName);
  const isPattern = callee === "pattern";
  return {
    kind: isPattern ? "pattern" : "builder",
    label: isPattern ? `pattern${suffix}` : `${callee}${suffix}`,
    name: boundName,
    nameOffset,
    recurseInto: [...call.arguments],
    meta: contractMeta(call, isPattern ? "pattern" : callee, synthetic, ctx),
  };
}

function isReactiveCallee(callee: string): boolean {
  return callee === "pattern" || isBuilderName(callee) || isCallName(callee) ||
    isSyntheticName(callee);
}

/** The body (block or concise expression) of a function-like node, if any. */
function bodyChildren(fn: ts.SignatureDeclaration): ts.Node[] {
  const body = (fn as { body?: ts.Node }).body;
  return body ? [body] : [];
}

/** Direct children of a node, collected (used for control-flow descent). */
function childNodes(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  // The callback must return void: `forEachChild` stops on a truthy return, and
  // `Array.push` returns the new length.
  node.forEachChild((c) => {
    out.push(c);
  });
  return out;
}

/** True when `node` is an entry in some statement list (block, file, …). */
function isInStatementList(node: ts.Node): boolean {
  // Any statement, by kind — O(1). Testing membership in the parent's
  // `.statements` array (the previous approach) is O(n) per node and so
  // quadratic over a file's top-level statement list. Every statement kind is
  // contiguous between `FirstStatement` and `LastStatement`, and the specific
  // statement branches in `classify` run before this fallback.
  return node.kind >= SK.FirstStatement && node.kind <= SK.LastStatement;
}

function isControlStatement(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isForStatement(node) ||
    ts.isForOfStatement(node) || ts.isForInStatement(node) ||
    ts.isWhileStatement(node) || ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) || ts.isTryStatement(node);
}

function controlLabel(node: ts.Node, sf: ts.SourceFile): string {
  const cond = (e: ts.Expression) => nodeFirstLine(e, sf, 32);
  if (ts.isIfStatement(node)) return `if (${cond(node.expression)})`;
  if (ts.isWhileStatement(node)) return `while (${cond(node.expression)})`;
  if (ts.isDoStatement(node)) return "do … while";
  if (ts.isSwitchStatement(node)) return `switch (${cond(node.expression)})`;
  if (ts.isForStatement(node)) return "for (…)";
  if (ts.isForOfStatement(node)) return "for (… of …)";
  if (ts.isForInStatement(node)) return "for (… in …)";
  // The only remaining control kind (see isControlStatement) is try/catch.
  return "try";
}

/** A compact tail for a `return` label, e.g. ` { url }` or ` value`. */
function returnSuffix(
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
): string {
  if (!expr) return "";
  const e = peelExpr(expr);
  if (ts.isObjectLiteralExpression(e)) {
    const keys = objectKeys(e);
    return keys ? ` { ${keys} }` : " {}";
  }
  return ` ${nodeFirstLine(expr, sf, 32)}`;
}

/** Peel transparent expression wrappers down to the meaningful expression. */
function peelExpr(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(e) || ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function calleeName(call: ts.CallExpression, sf: ts.SourceFile): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return nodeFirstLine(e, sf, 16);
}

//
// Metadata extraction (best-effort; never throws)
//

type FnLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function importMeta(
  node: ts.ImportDeclaration,
  sf: ts.SourceFile,
): NodeMeta | undefined {
  return safe(() => {
    const module = ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : node.moduleSpecifier.getText(sf);
    const names: string[] = [];
    const clause = node.importClause;
    if (clause?.name) names.push(clause.name.text);
    const nb = clause?.namedBindings;
    if (nb) {
      if (ts.isNamespaceImport(nb)) names.push(`* as ${nb.name.text}`);
      else if (ts.isNamedImports(nb)) {
        for (const el of nb.elements) names.push(el.name.text);
      }
    }
    return { kind: "import", names, module };
  });
}

function typeMeta(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
): NodeMeta | undefined {
  return safe(() => {
    if (ts.isInterfaceDeclaration(node)) {
      return {
        kind: "type",
        form: "interface",
        members: membersOf(node.members, sf),
      };
    }
    if (ts.isTypeLiteralNode(node.type)) {
      return {
        kind: "type",
        form: "alias",
        members: membersOf(node.type.members, sf),
      };
    }
    return {
      kind: "type",
      form: "alias",
      members: [],
      aliasText: nodeFirstLine(node.type, sf, 64),
    };
  });
}

function membersOf(
  members: ts.NodeArray<ts.TypeElement>,
  sf: ts.SourceFile,
): TypeMember[] {
  const out: TypeMember[] = [];
  for (const m of members) {
    if (ts.isPropertySignature(m) && m.name) {
      out.push({
        name: nameText(m.name, sf),
        type: m.type ? nodeFirstLine(m.type, sf, 40) : "any",
        optional: !!m.questionToken,
      });
    } else if (ts.isMethodSignature(m) && m.name) {
      out.push({
        name: nameText(m.name, sf),
        type: "() => …",
        optional: !!m.questionToken,
      });
    } else if (ts.isIndexSignatureDeclaration(m)) {
      out.push({
        name: "[index]",
        type: m.type ? nodeFirstLine(m.type, sf, 32) : "any",
        optional: false,
      });
    }
  }
  return out;
}

function schemaNodeMeta(obj: ts.ObjectLiteralExpression): NodeMeta | undefined {
  const schema = safe(() => parseSchemaObject(obj));
  return schema ? { kind: "schema", schema } : undefined;
}

function parseSchemaObject(obj: ts.ObjectLiteralExpression): SchemaMeta {
  const props = readSchemaProps(obj);
  const fields: SchemaField[] = [];
  if (props.properties) {
    for (const p of props.properties.properties) {
      if (!ts.isPropertyAssignment(p) || !p.name) continue;
      if (!ts.isObjectLiteralExpression(p.initializer)) continue;
      const fname = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
        ? p.name.text
        : p.name.getText();
      const ft = fieldType(p.initializer);
      fields.push({
        name: fname,
        type: ft.type,
        required: props.required.includes(fname),
        fields: ft.fields,
      });
    }
  }
  const rootType = props.type ??
    (props.items || props.prefixItems
      ? "array"
      : props.properties
      ? "object"
      : "any");
  return { rootType, required: props.required, fields };
}

function fieldType(
  o: ts.ObjectLiteralExpression,
): { type: string; fields?: readonly SchemaField[] } {
  const props = readSchemaProps(o);
  if (props.type === "array") {
    // Tuples (prefixItems) render as TS tuple types; an `items` schema
    // alongside becomes a rest element. An absent (or non-false) `items`
    // leaves the tail open in JSON Schema, so it renders `...unknown[]` —
    // only `items: false` closes the tuple (PR #4969 review).
    if (props.prefixItems) {
      const slots = props.prefixItems.elements.map((el) =>
        ts.isObjectLiteralExpression(el) ? fieldType(el).type : "any"
      );
      if (props.items) {
        slots.push(`...${fieldType(props.items).type}[]`);
      } else if (!props.itemsFalse) {
        slots.push("...unknown[]");
      }
      return { type: `[${slots.join(", ")}]` };
    }
    if (props.items) {
      const it = fieldType(props.items);
      return { type: `${it.type}[]`, fields: it.fields };
    }
    return { type: "array" };
  }
  if (props.type === "object" && props.properties) {
    return { type: "object", fields: parseSchemaObject(o).fields };
  }
  if (!props.type) {
    for (const key of ["anyOf", "oneOf", "allOf", "enum", "const"]) {
      if (hasProp(o, key)) return { type: key };
    }
    return { type: "any" };
  }
  return { type: props.type };
}

interface SchemaProps {
  type?: string;
  properties?: ts.ObjectLiteralExpression;
  required: string[];
  items?: ts.ObjectLiteralExpression;

  /** True when the literal spells `items: false` (a closed tuple). */
  itemsFalse?: boolean;

  prefixItems?: ts.ArrayLiteralExpression;
}

function readSchemaProps(obj: ts.ObjectLiteralExpression): SchemaProps {
  const result: SchemaProps = { required: [] };
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
      ? p.name.text
      : undefined;
    if (key === "type" && ts.isStringLiteral(p.initializer)) {
      result.type = p.initializer.text;
    } else if (
      key === "properties" && ts.isObjectLiteralExpression(p.initializer)
    ) {
      result.properties = p.initializer;
    } else if (key === "items" && ts.isObjectLiteralExpression(p.initializer)) {
      result.items = p.initializer;
    } else if (
      key === "items" && p.initializer.kind === ts.SyntaxKind.FalseKeyword
    ) {
      result.itemsFalse = true;
    } else if (
      key === "prefixItems" && ts.isArrayLiteralExpression(p.initializer)
    ) {
      result.prefixItems = p.initializer;
    } else if (
      key === "required" && ts.isArrayLiteralExpression(p.initializer)
    ) {
      for (const el of p.initializer.elements) {
        if (ts.isStringLiteral(el)) result.required.push(el.text);
      }
    }
  }
  return result;
}

function hasProp(obj: ts.ObjectLiteralExpression, key: string): boolean {
  return obj.properties.some((p) =>
    !!p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
    p.name.text === key
  );
}

function contractMeta(
  call: ts.CallExpression,
  builder: string,
  synthetic: boolean,
  ctx: BuildCtx,
): NodeMeta | undefined {
  return safe(() => {
    const schemas: SchemaMeta[] = [];
    let callback: FnLike | undefined;
    let configArg: ts.ObjectLiteralExpression | undefined;
    for (const arg of call.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        callback ??= arg;
        continue;
      }
      const obj = unwrapToObject(arg);
      if (obj && ctx.schemaSet.has(obj)) schemas.push(parseSchemaObject(obj));
      else if (obj) configArg ??= obj; // a plain object arg, e.g. fetchJson({…})
    }
    const typeArgs = call.typeArguments?.map((t) =>
      normalizeType(t.getText(ctx.sf))
    ) ?? [];
    const args = configArg ? objectKeyList(configArg) : [];
    return {
      kind: "contract",
      builder,
      synthetic,
      captures: callback ? paramNames(callback, ctx.sf) : [],
      input: schemas[0],
      output: schemas[1],
      returns: callback ? returnedKeys(callback) : undefined,
      typeArgs: typeArgs.length > 0 ? typeArgs : undefined,
      args: args.length > 0 ? args : undefined,
      // Scan the arguments (callback + object args), never the callee, so a
      // call like fetchJson({…}) is not reported as "containing" itself.
      innerBuilders: innerBuilderNames(call.arguments, ctx.sf),
    };
  });
}

/** Collapse a type's source text to a compact single line. */
function normalizeType(text: string): string {
  const compact = text.replace(/\s+/g, " ").replace(/;\s*}/g, " }").trim();
  return compact.length > 72 ? `${compact.slice(0, 71)}…` : compact;
}

function closureMeta(fn: FnLike, sf: ts.SourceFile): NodeMeta | undefined {
  return safe(() => ({
    kind: "closure",
    params: paramNames(fn, sf),
    returns: returnedKeys(fn),
    signature: signatureText(fn, sf),
  }));
}

/**
 * A syntactic type signature: each parameter with its annotation, plus the
 * return type when annotated. We have only the parser (no checker), so this
 * reflects what is written in the source — `undefined` when nothing is typed,
 * leaving the plainer parameter-name view to speak for itself.
 */
function signatureText(fn: FnLike, sf: ts.SourceFile): string | undefined {
  const typed = fn.parameters.some((p) => p.type) || !!fn.type;
  if (!typed) return undefined;
  const params = fn.parameters.map((p) => {
    const dots = p.dotDotDotToken ? "..." : "";
    const name = nameText(p.name, sf);
    const opt = p.questionToken ? "?" : "";
    const type = p.type ? `: ${normalizeType(p.type.getText(sf))}` : "";
    const init = p.initializer && !p.type ? " = …" : "";
    return `${dots}${name}${opt}${type}${init}`;
  });
  const ret = fn.type ? ` → ${normalizeType(fn.type.getText(sf))}` : "";
  return `(${params.join(", ")})${ret}`;
}

function variableMeta(
  node: ts.VariableDeclaration,
  sf: ts.SourceFile,
): NodeMeta | undefined {
  return safe(() => ({
    kind: "variable",
    bindsTo: describeInitializer(node.initializer, sf),
    typeText: variableType(node, sf),
  }));
}

/**
 * Best-effort type for a binding, from what the parser alone can see: an
 * explicit annotation wins; otherwise the type from a cast, a constructor, or a
 * literal. `undefined` when nothing is certain (e.g. a plain call result) —
 * there is no checker, so we never guess.
 */
function variableType(
  node: ts.VariableDeclaration,
  sf: ts.SourceFile,
): string | undefined {
  if (node.type) return normalizeType(node.type.getText(sf));
  return node.initializer ? inferExprType(node.initializer, sf) : undefined;
}

function inferExprType(
  expr: ts.Expression,
  sf: ts.SourceFile,
): string | undefined {
  // Written-down types: a cast or `satisfies` states the type outright.
  if (ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return normalizeType(expr.type.getText(sf));
  }
  if (ts.isAsExpression(expr)) {
    const t = expr.type.getText(sf).trim();
    // `x as const` asserts immutability, not a useful named type: see through it.
    return t === "const"
      ? inferExprType(expr.expression, sf)
      : normalizeType(t);
  }
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    return inferExprType(expr.expression, sf);
  }
  if (ts.isNewExpression(expr)) {
    const args = expr.typeArguments?.length
      ? `<${
        expr.typeArguments.map((t) => normalizeType(t.getText(sf))).join(", ")
      }>`
      : "";
    return normalizeType(expr.expression.getText(sf) + args);
  }
  // Literals carry their type syntactically.
  if (ts.isStringLiteralLike(expr) || ts.isTemplateExpression(expr)) {
    return "string";
  }
  if (ts.isNumericLiteral(expr)) return "number";
  if (ts.isBigIntLiteral(expr)) return "bigint";
  if (ts.isRegularExpressionLiteral(expr)) return "RegExp";
  switch (expr.kind) {
    case SK.TrueKeyword:
    case SK.FalseKeyword:
      return "boolean";
    case SK.NullKeyword:
      return "null";
  }
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  return undefined;
}

function describeInitializer(
  init: ts.Expression | undefined,
  sf: ts.SourceFile,
): string {
  if (!init) return "(uninitialized)";
  return nodeFirstLine(init, sf, 56);
}

function paramNames(fn: FnLike, sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const p of fn.parameters) {
    if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        names.push(el.name.getText(sf));
      }
    } else {
      names.push(p.name.getText(sf));
    }
  }
  return names;
}

function returnedKeys(fn: FnLike): string[] | undefined {
  const body = fn.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) {
    const expr = ts.isParenthesizedExpression(body) ? body.expression : body;
    return ts.isObjectLiteralExpression(expr) ? objectKeyList(expr) : undefined;
  }
  let keys: string[] | undefined;
  const visit = (n: ts.Node) => {
    if (keys) return;
    if (isFunctionLike(n) && n !== fn) return; // skip nested functions
    if (ts.isReturnStatement(n) && n.expression) {
      const e = ts.isParenthesizedExpression(n.expression)
        ? n.expression.expression
        : n.expression;
      if (ts.isObjectLiteralExpression(e)) {
        keys = objectKeyList(e);
        return;
      }
    }
    n.forEachChild(visit);
  };
  visit(body);
  return keys;
}

function objectKeyList(obj: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p)) {
      keys.push(p.name.text);
    } else if (
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ) {
      keys.push(p.name.text);
    }
  }
  return keys;
}

function innerBuilderNames(
  nodes: readonly ts.Node[],
  sf: ts.SourceFile,
): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n, sf);
      if (name === "pattern" || isBuilderName(name) || isCallName(name)) {
        found.add(name);
      }
    }
    n.forEachChild(visit);
  };
  for (const node of nodes) visit(node);
  return [...found].slice(0, 8);
}

function paramList(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sf: ts.SourceFile,
): string {
  const params = fn.parameters.map((p) => nameText(p.name, sf));
  if (params.length === 0) return "()";
  return `(${params.join(", ")})`;
}

function objectKeys(obj: ts.ObjectLiteralExpression): string {
  const keys = obj.properties
    .map((p) => (p.name && ts.isIdentifier(p.name)) ? p.name.text : null)
    .filter((k): k is string => k !== null);
  const shown = keys.slice(0, 4).join(", ");
  return keys.length > 4 ? `${shown}, …` : shown;
}

function nameText(name: ts.Node, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name)) return name.text;
  return nodeFirstLine(name, sf, 24);
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n", 1)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The first source line of a node, trimmed and capped at `max`, read straight
 * from the source between the node's offsets. Unlike `node.getText()` it never
 * materializes the whole (possibly multi-line, possibly huge) node text, so
 * labeling every node in the full-AST tree stays linear instead of quadratic.
 */
function nodeFirstLine(node: ts.Node, sf: ts.SourceFile, max: number): string {
  const text = sf.text;
  const start = node.getStart(sf);
  const limit = Math.min(node.getEnd(), start + max + 4);
  let stop = limit;
  for (let i = start; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      stop = i;
      break;
    }
  }
  return firstLine(text.slice(start, stop), max);
}

//
// Sections
//

interface SectionMark {
  name: string;
  startLine: number;
  startOffset: number;
}

function findSections(text: string, lineStarts: number[]): SectionMark[] {
  const marks: SectionMark[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\/\/\s*transformed:\s*(.*)$/);
    if (m) {
      marks.push({
        name: m[1].trim() || "(unnamed)",
        startLine: i,
        startOffset: lineStarts[i],
      });
    }
  }
  return marks;
}

function attachSections(
  roots: StructureNode[],
  sections: SectionMark[],
  lineStarts: number[],
  text: string,
): StructureNode[] {
  const lastLine = lineStarts.length - 1;
  const sectionNodes: StructureNode[] = sections.map((s, i) => {
    const endLine = i + 1 < sections.length
      ? sections[i + 1].startLine - 1
      : lastLine;
    const endOffset = i + 1 < sections.length
      ? sections[i + 1].startOffset - 1
      : text.length;
    return {
      kind: "section",
      label: `▸ ${s.name}`,
      name: s.name,
      startLine: s.startLine,
      endLine,
      startCol: 0,
      endCol: cpLen(text.slice(lineStarts[endLine], endOffset)),
      startOffset: s.startOffset,
      endOffset,
      depth: 0,
      children: [],
    };
  });
  for (const root of roots) {
    const section = sectionNodes.find((s) =>
      root.startLine >= s.startLine && root.startLine <= s.endLine
    ) ?? sectionNodes[sectionNodes.length - 1];
    section.children.push(root);
  }
  return sectionNodes;
}

//
// Lines
//

function spansToLines(
  text: string,
  lineStarts: number[],
  spans: GlobalSpan[],
): Line[] {
  const rawLines = text.split("\n");
  const lineSpans: Span[][] = rawLines.map(() => []);
  // Running display column (code points) per line. Spans arrive left-to-right
  // (global spans are sorted and gapless), so this stays accurate.
  const lineCol = rawLines.map(() => 0);
  // Every character is covered (tokens + trivia), so each line's spans are
  // gapless and concatenate back to the verbatim line text.
  for (const span of spans) {
    let li = lineIndexOf(lineStarts, span.start);
    let pos = span.start;
    while (pos < span.end && li < lineStarts.length) {
      const lineEnd = li + 1 < lineStarts.length
        ? lineStarts[li + 1] - 1
        : text.length;
      const segEnd = Math.min(span.end, lineEnd);
      if (segEnd > pos) {
        const segText = text.slice(pos, segEnd);
        lineSpans[li].push({
          col: lineCol[li],
          text: segText,
          cls: span.cls,
          bracketDepth: span.bracketDepth,
          exactDefinitionName: pos === span.start
            ? span.exactDefinitionName
            : undefined,
          exactDefinitionDisplayName: pos === span.start
            ? span.exactDefinitionDisplayName
            : undefined,
        });
        lineCol[li] += cpLen(segText);
      }
      pos = lineEnd + 1;
      li++;
    }
  }
  return rawLines.map((t, i) => ({ text: t, spans: lineSpans[i] }));
}

/** Internals exposed for tests only. `safe` wraps the best-effort metadata
 * extractors so a throw degrades to `undefined` rather than failing the parse. */
export const _internal = { safe };
