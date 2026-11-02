/**
 * Computes alternative added and removed line counts for unified diffs. The
 * normal mode reports the diff as written. The other modes remove changes
 * that leave source text unchanged after comments and whitespace are removed.
 */

import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { type DiffFile, type DiffLine, parseDiff } from "./diff.ts";
import { type DiffFileLanguages, diffLanguages } from "./diffdoc.ts";
import type { Language } from "./languages/language.ts";
import type { Line, TokenClass } from "./model.ts";

/** The line-count policies available in the diff jump list. */
export type DiffCountMode = "normal" | "whitespace" | "comments";

/** Count policies in the order the jump-list key cycles through them. */
export const DIFF_COUNT_MODES: readonly DiffCountMode[] = [
  "normal",
  "whitespace",
  "comments",
];

/** Added and removed line counts. */
export interface DiffLineCounts {
  /** Added lines which remain under the selected policy. */
  readonly adds: number;

  /** Removed lines which remain under the selected policy. */
  readonly dels: number;
}

/** Counts for the whole diff and for each file in document order. */
export interface DiffCounts {
  /** Counts summed across every file. */
  readonly totals: DiffLineCounts;

  /** Counts by diff-file index. */
  readonly files: readonly DiffLineCounts[];
}

/**
 * What the diff view knows about one file beyond the diff text: the languages
 * of its sides, and complete file text to resolve syntax across omitted diff
 * lines.
 */
export interface DiffCountFileContext {
  readonly languages: DiffFileLanguages;
  readonly oldLines?: readonly Line[];
  readonly newLines?: readonly Line[];
}

interface ChangedLine {
  /** Diff-file index containing the line. */
  readonly file: number;

  /** Side of the diff containing the line. */
  readonly kind: "add" | "del";

  /** Source text after the diff marker. */
  readonly text: string;

  /** Text with fallback-language comments removed, when fallback scanning ran. */
  readonly fallbackText?: string;

  /** Highlighted diff line, used to identify comment spans. */
  readonly line: Line;
}

interface MutableCounts {
  /** Added lines which have not been discounted. */
  adds: number;

  /** Removed lines which have not been discounted. */
  dels: number;
}

/**
 * Computes added and removed counts under `mode`. A file without a context
 * reads its sides in the languages the diff's own paths and content decide.
 */
export function diffCounts(
  text: string,
  lines: readonly Line[],
  mode: DiffCountMode,
  contexts?: readonly DiffCountFileContext[],
): DiffCounts {
  const model = parseDiff(text);
  if (!model) return { totals: { adds: 0, dels: 0 }, files: [] };

  const raw = text.split("\n");
  const counts: MutableCounts[] = model.files.map(() => ({ adds: 0, dels: 0 }));
  const byFile: ChangedLine[][] = model.files.map(() => []);
  const changed: ChangedLine[] = [];
  let decided: readonly DiffFileLanguages[] | undefined;
  for (const [fileIndex, file] of model.files.entries()) {
    const context = contexts?.[fileIndex];
    const fallback = mode === "comments"
      ? fallbackCommentLines(
        raw,
        model.lines,
        lines,
        file,
        context?.languages ??
          (decided ??= diffLanguages(text, model))[fileIndex],
        context,
      )
      : new Map<number, string>();
    for (let i = file.headerLine; i <= file.endLine; i++) {
      const kind = model.lines[i]?.kind;
      if (kind !== "add" && kind !== "del") continue;
      if (kind === "add") counts[fileIndex].adds++;
      else counts[fileIndex].dels++;
      const line = {
        file: fileIndex,
        kind,
        text: (raw[i] ?? "").slice(1),
        fallbackText: fallback.get(i),
        line: lines[i] ?? { text: raw[i] ?? "", spans: [] },
      };
      changed.push(line);
      byFile[fileIndex].push(line);
    }
  }

  if (mode === "whitespace") {
    for (let file = 0; file < model.files.length; file++) {
      discountPairs(
        byFile[file],
        counts,
        (line) => withoutWhitespace(line.text),
      );
    }
  } else if (mode === "comments") {
    const remaining: ChangedLine[] = [];
    for (const line of changed) {
      const normalized = withoutWhitespace(withoutComments(line));
      if (normalized.length === 0) decrement(counts[line.file], line.kind);
      else remaining.push(line);
    }
    discountPairs(
      remaining,
      counts,
      (line) => withoutWhitespace(withoutComments(line)),
    );
  }

  return {
    totals: sumDiffLineCounts(counts),
    files: counts,
  };
}

/**
 * Whether each file, by diff-file index, changes lines without changing its
 * code, judged from the complete files of both sides in `contexts`. A file
 * qualifies only when both complete sides are the Git objects that its diff's
 * `index` line names, and when its header records nothing more than its path
 * and those objects, so that a rename, a mode change, or a new file does not.
 */
export function commentOnlyFiles(
  text: string,
  contexts: readonly DiffCountFileContext[],
): boolean[] {
  const model = parseDiff(text);
  if (!model) return [];

  const raw = text.split("\n");
  return model.files.map((file, fileIndex) => {
    const [hunk] = file.hunks;
    const context = contexts[fileIndex];
    if (
      !hunk || !context?.oldLines || !context.newLines ||
      file.oldObject === undefined || file.newObject === undefined ||
      file.oldPath !== file.newPath ||
      !raw.slice(file.headerLine, hunk.headerLine).every((line) =>
        /^(?:diff |index |--- |\+\+\+ )/.test(line)
      )
    ) {
      return false;
    }
    const oldMark = byteOrderMark(context.oldLines, file.oldObject);
    if (
      oldMark === undefined ||
      oldMark !== byteOrderMark(context.newLines, file.newObject)
    ) {
      return false;
    }
    const { oldLanguage, newLanguage } = context.languages;
    const oldCode = sideCode(context.oldLines, oldLanguage);
    return oldCode !== undefined &&
      oldCode === sideCode(context.newLines, newLanguage);
  });
}

/**
 * The byte order mark that makes `lines`, as a file's text, the Git blob whose
 * SHA-1 or SHA-256 object name starts with `object`: `""` when the blob has
 * none, and undefined when the lines are not that blob either way.
 */
function byteOrderMark(
  lines: readonly Line[],
  object: string,
): string | undefined {
  const text = lines.map((line) => line.text).join("\n");
  const encoder = new TextEncoder();
  return ["", "\uFEFF"].find((mark) => {
    const content = encoder.encode(mark + text);
    const header = encoder.encode(`blob ${content.length}\0`);
    const blob = new Uint8Array(header.length + content.length);
    blob.set(header);
    blob.set(content, header.length);
    return [sha1, sha256].some((hash) =>
      bytesToHex(hash(blob)).startsWith(object)
    );
  });
}

/**
 * What a comment reads as in a side's code: a character that text sources do
 * not hold, so that removing a comment between two tokens, or between two runs
 * of text, changes the code. The whitespace that ends a comment's span, such
 * as a carriage return, follows it.
 */
const COMMENT_CODE = "\0";

/**
 * The code of one complete file side: its lines with each comment read as
 * {@link COMMENT_CODE}, leaving out lines that held only comments and
 * whitespace where the language says such lines are inert. A line that follows
 * one ending with a backslash continues it, so it is kept exactly as written.
 * Undefined when a line holds {@link COMMENT_CODE} itself, or when its
 * highlighting does not cover its text.
 */
function sideCode(
  lines: readonly Line[],
  language: Language,
): string | undefined {
  const code: string[] = [];
  let continued = false;
  for (const line of lines) {
    if (
      line.text.includes(COMMENT_CODE) ||
      line.spans.map((span) => span.text).join("") !== line.text
    ) {
      return undefined;
    }
    const wasContinued = continued;
    continued = /\\\r?$/.test(line.text);
    if (wasContinued) {
      code.push(line.text);
      continue;
    }
    const comments = new Set(
      line.spans.filter((span) => isCommentSpan(span.cls, span.text)),
    );
    if (
      language.commentLinesAreInert && comments.size > 0 &&
      line.spans.every((span) =>
        comments.has(span) || span.cls === "whitespace"
      )
    ) {
      continue;
    }
    code.push(
      line.spans.map((span) =>
        comments.has(span)
          ? COMMENT_CODE + span.text.slice(span.text.trimEnd().length)
          : span.text
      ).join(""),
    );
  }
  return code.join("\n");
}

/** Short label for a count policy in the jump-list summary. */
export function diffCountModeLabel(mode: DiffCountMode): string {
  switch (mode) {
    case "normal":
      return "normal";
    case "whitespace":
      return "ignore whitespace-only changes";
    case "comments":
      return "ignore comments and whitespace";
  }
}

/** Discounts matching additions and removals according to `keyOf`. */
function discountPairs(
  lines: readonly ChangedLine[],
  counts: MutableCounts[],
  keyOf: (line: ChangedLine) => string,
): void {
  const deletions = new Map<
    string,
    { readonly lines: ChangedLine[]; next: number }
  >();
  for (const line of lines) {
    if (line.kind !== "del") continue;
    const key = keyOf(line);
    const bucket = deletions.get(key) ?? { lines: [], next: 0 };
    bucket.lines.push(line);
    deletions.set(key, bucket);
  }
  for (const addition of lines) {
    if (addition.kind !== "add") continue;
    const bucket = deletions.get(keyOf(addition));
    const deletion = bucket?.lines[bucket.next];
    if (!bucket || !deletion) continue;
    bucket.next++;
    decrement(counts[deletion.file], "del");
    decrement(counts[addition.file], "add");
  }
}

function decrement(counts: MutableCounts, kind: "add" | "del"): void {
  if (kind === "add") counts.adds--;
  else counts.dels--;
}

/** Sums any set of per-file counts. */
export function sumDiffLineCounts(
  counts: readonly DiffLineCounts[],
): DiffLineCounts {
  let adds = 0;
  let dels = 0;
  for (const file of counts) {
    adds += file.adds;
    dels += file.dels;
  }
  return { adds, dels };
}

function withoutWhitespace(text: string): string {
  return text.replace(/\s/gu, "");
}

/** Returns one changed line with comment-classified spans removed. */
function withoutComments(line: ChangedLine): string {
  if (line.fallbackText !== undefined) return line.fallbackText;
  let text = line.text;
  if (
    line.line.spans.length > 0 &&
    line.line.spans.map((span) => span.text).join("") === line.line.text
  ) {
    let first = true;
    text = "";
    for (const span of line.line.spans) {
      let part = span.text;
      if (first) {
        part = [...part].slice(1).join("");
        first = false;
      }
      if (!isCommentSpan(span.cls, part)) text += part;
    }
  }
  return text;
}

function isCommentSpan(cls: TokenClass, text: string): boolean {
  return cls === "comment" || cls === "docComment" ||
    (cls === "sectionHeader" && /^\s*\/\/\s*transformed:/.test(text));
}

interface CommentSyntax {
  readonly lines: readonly string[];
  readonly blocks: readonly (readonly [string, string])[];
  readonly nestedBlocks: boolean;
  readonly skipHighlightedCode: boolean;
  readonly heredocs: boolean;
}

interface HeredocState {
  readonly end: string;
  readonly stripTabs: boolean;
}

interface CommentState {
  block?: {
    readonly open: string;
    readonly close: string;
    depth: number;
    readonly nested: boolean;
  };
  literalClose?: string;
  heredocs?: HeredocState[];
}

/** Scans each file side so multiline syntax carries across diff hunks. */
function fallbackCommentLines(
  raw: readonly string[],
  diffLines: readonly DiffLine[],
  renderedLines: readonly Line[],
  file: DiffFile,
  { oldLanguage, newLanguage }: DiffFileLanguages,
  context: DiffCountFileContext | undefined,
): ReadonlyMap<number, string> {
  const oldSyntax = fallbackSyntaxFor(file.oldPath, oldLanguage);
  const newSyntax = fallbackSyntaxFor(file.newPath, newLanguage);
  if (!oldSyntax && !newSyntax) return new Map();

  const result = new Map<number, string>();
  const oldState: CommentState = {};
  const newState: CommentState = {};
  let oldNextLine = 0;
  let newNextLine = 0;
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const oldStart = sideStart(hunk.oldStart, hunk.oldCount);
    const newStart = sideStart(hunk.newStart, hunk.newCount);
    if (context?.oldLines && oldSyntax) {
      scanCompleteLines(
        context.oldLines,
        oldNextLine,
        oldStart,
        oldSyntax,
        oldState,
      );
    } else if (hunkIndex > 0) {
      const previous = file.hunks[hunkIndex - 1];
      const remaining = file.hunks.slice(hunkIndex);
      reconcileStateAfterGap(
        raw,
        diffLines,
        previous,
        remaining,
        oldState,
        oldSyntax,
        "old",
      );
    }
    if (context?.newLines && newSyntax) {
      scanCompleteLines(
        context.newLines,
        newNextLine,
        newStart,
        newSyntax,
        newState,
      );
    } else if (hunkIndex > 0) {
      const previous = file.hunks[hunkIndex - 1];
      const remaining = file.hunks.slice(hunkIndex);
      reconcileStateAfterGap(
        raw,
        diffLines,
        previous,
        remaining,
        newState,
        newSyntax,
        "new",
      );
    }
    for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
      const kind = diffLines[i]?.kind;
      const text = (raw[i] ?? "").slice(1);
      if (kind === "ctx") {
        if (
          oldSyntax && shouldScanFallback(oldSyntax, renderedLines[i], oldState)
        ) {
          stripCommonComments(text, oldSyntax, oldState);
        }
        if (
          newSyntax && shouldScanFallback(newSyntax, renderedLines[i], newState)
        ) {
          stripCommonComments(text, newSyntax, newState);
        }
      } else if (kind === "del" && oldSyntax) {
        if (shouldScanFallback(oldSyntax, renderedLines[i], oldState)) {
          result.set(i, stripCommonComments(text, oldSyntax, oldState));
        }
      } else if (kind === "add" && newSyntax) {
        if (shouldScanFallback(newSyntax, renderedLines[i], newState)) {
          result.set(i, stripCommonComments(text, newSyntax, newState));
        }
      }
    }
    oldNextLine = oldStart + hunk.oldCount;
    newNextLine = newStart + hunk.newCount;
  }
  return result;
}

function sideStart(start: number, count: number): number {
  return count === 0 ? start : Math.max(0, start - 1);
}

function scanCompleteLines(
  lines: readonly Line[],
  start: number,
  end: number,
  syntax: CommentSyntax,
  state: CommentState,
): void {
  for (let i = start; i < end && i < lines.length; i++) {
    if (shouldScanFallback(syntax, lines[i], state, false)) {
      stripCommonComments(lines[i].text, syntax, state);
    }
  }
}

/** Keeps multiline state only when this hunk proves the construct stayed open. */
function reconcileStateAfterGap(
  raw: readonly string[],
  diffLines: readonly DiffLine[],
  previous: DiffFile["hunks"][number],
  remaining: readonly DiffFile["hunks"][number][],
  state: CommentState,
  syntax: CommentSyntax | undefined,
  side: "old" | "new",
): void {
  const current = remaining[0];
  const previousEnd = side === "old"
    ? previous.oldStart + previous.oldCount
    : previous.newStart + previous.newCount;
  const currentStart = side === "old" ? current.oldStart : current.newStart;
  if (previousEnd === currentStart) return;

  const texts: string[] = [];
  for (const hunk of remaining) {
    for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
      const kind = diffLines[i]?.kind;
      if (
        kind === "ctx" || side === "old" && kind === "del" ||
        side === "new" && kind === "add"
      ) {
        texts.push((raw[i] ?? "").slice(1));
      }
    }
  }
  const block = state.block;
  if (
    block &&
    !texts.some((text) => hasVisibleClose(text, block.close, syntax))
  ) {
    state.block = undefined;
  }
  const literalClose = state.literalClose;
  if (
    literalClose &&
    !texts.some((text) => hasVisibleClose(text, literalClose, syntax))
  ) {
    state.literalClose = undefined;
  }
  const heredocs = state.heredocs;
  if (heredocs) {
    const firstVisibleEnd = heredocs.findIndex((heredoc) =>
      texts.some((text) => isHeredocEnd(text, heredoc))
    );
    state.heredocs = firstVisibleEnd < 0
      ? undefined
      : heredocs.slice(firstVisibleEnd);
  }
}

function hasVisibleClose(
  text: string,
  token: string,
  syntax: CommentSyntax | undefined,
): boolean {
  let quote = "";
  let tokenInsideCurrentQuote = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (quote) {
      if (text.startsWith(token, i)) tokenInsideCurrentQuote = true;
      if (ch === "\\") {
        if (text.startsWith(token, i + 1)) tokenInsideCurrentQuote = true;
        i += 2;
      } else {
        if (ch === quote) {
          quote = "";
          tokenInsideCurrentQuote = false;
        }
        i++;
      }
    } else {
      if (
        syntax?.lines.some((marker) => startsLineComment(text, i, marker))
      ) {
        return false;
      }
      if (text.startsWith(token, i)) return true;
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        tokenInsideCurrentQuote = false;
      }
      i++;
    }
  }
  return quote !== "" && tokenInsideCurrentQuote;
}

/** Whether `offset` lies inside a `((` that `text` has not closed before it. */
function insideArithmetic(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  return before.split("((").length > before.split("))").length;
}

function isHeredocEnd(text: string, heredoc: HeredocState): boolean {
  const candidate = heredoc.stripTabs ? text.replace(/^\t+/u, "") : text;
  return candidate === heredoc.end;
}

function shouldScanFallback(
  syntax: CommentSyntax,
  line: Line | undefined,
  state: CommentState,
  hasDiffMarker = true,
): boolean {
  if (!syntax.skipHighlightedCode || state.block !== undefined || !line) {
    return true;
  }
  const source = hasDiffMarker ? [...line.text].slice(1).join("") : line.text;
  if (/^(?: {4}|\t)/u.test(source)) return false;

  let first = true;
  let foundCode = false;
  for (const span of line.spans) {
    let text = span.text;
    if (first && hasDiffMarker) {
      text = [...text].slice(1).join("");
    }
    first = false;
    if (withoutWhitespace(text).length === 0) continue;
    if (span.cls !== "string" && span.cls !== "template") return true;
    foundCode = true;
  }
  return !foundCode;
}

function fallbackSyntaxFor(
  path: string | undefined,
  language: Language,
): CommentSyntax | undefined {
  // Shell's highlighting colors each hunk on its own, and this scanner carries
  // a heredoc across the lines between hunks.
  if (!["plain-text", "markdown", "shell"].includes(language.id)) {
    return undefined;
  }
  const syntax = commentSyntaxFor(path ?? "", language);
  return syntax.lines.length > 0 || syntax.blocks.length > 0
    ? syntax
    : undefined;
}

/** Removes common comment forms while updating multiline scanning state. */
function stripCommonComments(
  text: string,
  syntax: CommentSyntax,
  state: CommentState,
): string {
  const activeHeredocs = state.heredocs;
  const activeHeredoc = activeHeredocs?.[0];
  if (activeHeredoc) {
    if (isHeredocEnd(text, activeHeredoc)) {
      activeHeredocs.shift();
      if (activeHeredocs.length === 0) state.heredocs = undefined;
    }
    return text;
  }

  let start = 0;
  let result = "";
  if (state.literalClose) {
    const end = text.indexOf(state.literalClose);
    if (end < 0) return text;
    result = text.slice(0, end + state.literalClose.length);
    start = result.length;
    state.literalClose = undefined;
  }

  let quote = "";
  const heredocs: HeredocState[] = [];
  for (let i = start; i < text.length;) {
    if (state.block) {
      if (state.block.nested && text.startsWith(state.block.open, i)) {
        state.block.depth++;
        i += state.block.open.length;
      } else if (text.startsWith(state.block.close, i)) {
        state.block.depth--;
        i += state.block.close.length;
        if (state.block.depth === 0) state.block = undefined;
      } else {
        i++;
      }
      continue;
    }
    const ch = text[i];
    if (quote) {
      result += ch;
      if (ch === "\\" && i + 1 < text.length) {
        result += text[++i];
      } else if (ch === quote) {
        quote = "";
      }
      i++;
      continue;
    }
    if (
      (ch === '"' || ch === "'" || ch === "`") &&
      closingQuote(text, i, ch) >= 0
    ) {
      quote = ch;
      result += ch;
      i++;
      continue;
    }
    const rawString = rustRawStringAt(text, i);
    if (rawString) {
      const end = text.indexOf(rawString.close, i + rawString.open.length);
      if (end < 0) {
        result += text.slice(i);
        state.literalClose = rawString.close;
        break;
      }
      const after = end + rawString.close.length;
      result += text.slice(i, after);
      i = after;
      continue;
    }
    // `<<<` is a here-string, and `<<` inside `((` is a shift.
    if (syntax.heredocs && text[i - 1] !== "<" && !insideArithmetic(text, i)) {
      const match = /^<<(-)?\s*\\?(['"]?)([A-Za-z_]\w*)\2/u.exec(
        text.slice(i),
      );
      if (match) {
        heredocs.push({ end: match[3], stripTabs: match[1] === "-" });
      }
    }
    const block = syntax.blocks.find(([open]) => text.startsWith(open, i));
    if (block) {
      state.block = {
        open: block[0],
        close: block[1],
        depth: 1,
        nested: syntax.nestedBlocks,
      };
      i += block[0].length;
      continue;
    }
    if (syntax.lines.some((marker) => startsLineComment(text, i, marker))) {
      break;
    }
    result += ch;
    i++;
  }
  if (heredocs.length > 0) state.heredocs = heredocs;
  return result;
}

function rustRawStringAt(
  text: string,
  index: number,
): { readonly open: string; readonly close: string } | undefined {
  const match = /^(?:br|r)(#*)"/.exec(text.slice(index));
  if (!match) return undefined;
  return { open: match[0], close: `"${match[1]}` };
}

function startsLineComment(
  text: string,
  index: number,
  marker: string,
): boolean {
  if (!text.startsWith(marker, index)) return false;
  if (marker === "//" && text[index - 1] === ":") return false;
  if (marker === "#" && index > 0 && !/\s/u.test(text[index - 1])) return false;
  return true;
}

function closingQuote(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * The comment forms of a file's syntax. Shell's come from its language, which
 * a shebang can select for a path with no extension; the rest come from the
 * path's extension or name.
 */
function commentSyntaxFor(path: string, language: Language): CommentSyntax {
  const lower = path.toLowerCase();
  const shell = language.id === "shell";
  const lines: string[] = [];
  const blocks: [string, string][] = [];
  let nestedBlocks = false;
  let skipHighlightedCode = false;
  let heredocs = false;
  const addLine = (marker: string) => {
    if (!lines.includes(marker)) lines.push(marker);
  };
  const addBlock = (open: string, close: string) => {
    blocks.push([open, close]);
  };

  if (
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|java|go|rs|swift|kt|kts|scala|groovy|cs|fs|fsx|dart|php|scss|sass|less|proto|sol|zig|vue|svelte)$/
      .test(
        lower,
      )
  ) {
    addLine("//");
    addBlock("/*", "*/");
  }
  if (/\.css$/.test(lower)) addBlock("/*", "*/");
  if (/\.(?:html?|xml|svg|md|markdown|mdown|mkd|mdx|vue|svelte)$/.test(lower)) {
    addBlock("<!--", "-->");
  }
  if (/\.(?:md|markdown|mdown|mkd|mdx)$/.test(lower)) {
    skipHighlightedCode = true;
  }
  if (
    /\.(?:py|pyi|pyw|ya?ml|sh|bash|zsh|fish|rb|pl|pm|r|ex|exs|php|tf|hcl|toml|ini|cfg|conf|properties)$/
      .test(
        lower,
      ) ||
    /(?:^|\/)(?:dockerfile|makefile|gnumakefile)(?:\..*)?$/.test(lower) ||
    shell
  ) {
    addLine("#");
  }
  if (shell || /\.(?:sh|bash|zsh)$/.test(lower)) heredocs = true;
  if (/\.sql$/.test(lower)) {
    addLine("--");
    addBlock("/*", "*/");
  }
  if (/\.lua$/.test(lower)) addLine("--");
  if (/\.(?:hs|lhs)$/.test(lower)) {
    addLine("--");
    addBlock("{-", "-}");
    nestedBlocks = true;
  }
  if (/\.rs$/.test(lower)) nestedBlocks = true;
  if (/\.(?:lisp|cl|clj|cljs|edn|scm|rkt|el)$/.test(lower)) addLine(";");
  return { lines, blocks, nestedBlocks, skipHighlightedCode, heredocs };
}
