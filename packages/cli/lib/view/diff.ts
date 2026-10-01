/**
 * Unified-diff detection and parsing for `cf view`'s diff mode. Understands
 * both `git diff` output (with `diff --git` / `index` headers) and plain
 * `diff -u` output (bare `---` / `+++` / `@@` headers).
 *
 * The parser is line-oriented and lossless: every line of the input is
 * classified (file metadata, hunk header, context, addition, removal), and
 * context/addition lines carry their 0-based line number in the NEW file while
 * context/removal lines carry their position in the OLD file. Hunk bodies are
 * delimited by the `@@` counts, not by sniffing `+`/`-` prefixes, so content
 * that happens to start with those characters cannot derail the parse.
 */

export type DiffLineKind =
  | "meta" // diff --git, index, ---, +++, mode/rename lines, \ no-newline
  | "hunk" // @@ -a,b +c,d @@ …
  | "ctx" // ' ' body line (present on both sides)
  | "add" // '+' body line (new side only)
  | "del" // '-' body line (old side only)
  | "other"; // anything outside the diff grammar (e.g. surrounding noise)

export interface DiffLine {
  readonly kind: DiffLineKind;

  /** 0-based line number in the NEW file, for ctx/add lines. */
  readonly newLine?: number;

  /** 0-based line number in the OLD file, for ctx/del lines. */
  readonly oldLine?: number;
}

export interface DiffHunk {
  /** 0-based diff-text line index of the `@@` header. */
  readonly headerLine: number;

  /** 0-based diff-text line index of the last body line. */
  readonly endLine: number;

  /** 1-based start line in the old file (from the `@@` header). */
  readonly oldStart: number;

  readonly oldCount: number;

  /** 1-based start line in the new file (from the `@@` header). */
  readonly newStart: number;

  readonly newCount: number;

  /** Trailing context from the header (the enclosing function), if any. */
  readonly context: string;
}

export interface DiffFile {
  /** Path on the old side (`a/…` stripped), absent for a created file. */
  readonly oldPath?: string;

  /** Path on the new side (`b/…` stripped), absent for a deleted file. */
  readonly newPath?: string;

  /** Old blob named by a Git `index old..new` header, when present. */
  readonly oldObject?: string;

  /** 0-based diff-text line index where this file's headers begin. */
  readonly headerLine: number;

  /** 0-based diff-text line index of the file's last line. */
  readonly endLine: number;

  readonly hunks: readonly DiffHunk[];
}

export interface DiffModel {
  readonly files: readonly DiffFile[];

  /** Classification of every diff-text line, indexed by line number. */
  readonly lines: readonly DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** A line with any trailing carriage return removed, for classification only.
 * The verbatim text (CR included) is what gets rendered and counted. */
function clean(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

interface ScannedLine {
  readonly text: string;
  readonly number: number;
  readonly nextOffset?: number;
}

function lineAt(text: string, offset: number, number: number): ScannedLine {
  const end = text.indexOf("\n", offset);
  return {
    text: clean(text.slice(offset, end < 0 ? text.length : end)),
    number,
    nextOffset: end < 0 ? undefined : end + 1,
  };
}

function firstNonEmptyLine(text: string): ScannedLine | null {
  let offset = 0;
  let number = 0;
  for (;;) {
    const line = lineAt(text, offset, number);
    if (line.text.trim().length > 0) return line;
    if (line.nextOffset === undefined) return null;
    offset = line.nextOffset;
    number++;
  }
}

/**
 * Detect a raw unified-diff container and return its parsed model. The first
 * non-empty line must start the container. A Git diff must include classified
 * metadata or a hunk after its `diff --git` header. A plain unified diff must
 * start with its `---`, `+++`, and `@@` header sequence.
 */
export function detectDiff(text: string): DiffModel | null {
  const first = firstNonEmptyLine(text);
  if (!first) return null;

  const git = first.text.startsWith("diff --git ");
  const second = first.nextOffset === undefined
    ? undefined
    : lineAt(text, first.nextOffset, first.number + 1);
  const third = second?.nextOffset === undefined
    ? undefined
    : lineAt(text, second.nextOffset, second.number + 1);
  const plain = first.text.startsWith("--- ") &&
    second?.text.startsWith("+++ ") &&
    HUNK_RE.test(third?.text ?? "");
  if (!git && !plain) return null;

  const model = parseDiff(text);
  const firstFile = model?.files.find((file) =>
    file.headerLine === first.number
  );
  if (!model || !firstFile) return null;
  if (git && firstFile.endLine === firstFile.headerLine) return null;
  return model;
}

/** Whether {@link detectDiff} recognizes the text as a raw unified diff. */
export function looksLikeDiff(text: string): boolean {
  return detectDiff(text) !== null;
}

/** Parse a unified diff. Returns null when no file/hunk structure is found. */
export function parseDiff(text: string): DiffModel | null {
  const raw = text.split("\n");
  const lines: DiffLine[] = raw.map(() => ({ kind: "other" }));
  const files: DiffFile[] = [];

  interface OpenFile {
    oldPath?: string;
    newPath?: string;
    oldObject?: string;
    headerLine: number;
    hunks: DiffHunk[];
    endLine: number;

    /** A `diff --cc`/`--combined` merge section: consumed but never emitted —
     * its `@@@` hunks use a three-way format this parser does not model. */
    combined?: boolean;
  }
  let file: OpenFile | null = null;

  const closeFile = () => {
    if (
      file && !file.combined &&
      (file.hunks.length > 0 || file.oldPath || file.newPath)
    ) {
      files.push({
        oldPath: file.oldPath,
        newPath: file.newPath,
        oldObject: file.oldObject,
        headerLine: file.headerLine,
        endLine: file.endLine,
        hunks: file.hunks,
      });
    }
    file = null;
  };

  let i = 0;
  while (i < raw.length) {
    const line = clean(raw[i]);

    if (line.startsWith("diff --git ")) {
      closeFile();
      file = { headerLine: i, hunks: [], endLine: i };
      const m = line.match(/^diff --git (?:"?a\/)?(.*?)"? (?:"?b\/)(.*?)"?$/);
      if (m) {
        file.oldPath = m[1];
        file.newPath = m[2];
      }
      lines[i] = { kind: "meta" };
      i++;
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      // A combined (merge) section: keep it open so its headers read as
      // metadata, but never emit it as a file.
      closeFile();
      file = { headerLine: i, hunks: [], endLine: i, combined: true };
      lines[i] = { kind: "meta" };
      i++;
      continue;
    }

    if (line.startsWith("--- ")) {
      // In plain `diff -u` output there is no `diff --git` separator between
      // files: a `---` arriving after a file already collected hunks starts
      // the next file.
      if (file && file.hunks.length > 0) closeFile();
      if (!file) file = { headerLine: i, hunks: [], endLine: i };
      file.oldPath = stripSide(line.slice(4));
      lines[i] = { kind: "meta" };
      file.endLine = i;
      i++;
      continue;
    }
    if (file && line.startsWith("+++ ")) {
      file.newPath = stripSide(line.slice(4));
      lines[i] = { kind: "meta" };
      file.endLine = i;
      i++;
      continue;
    }

    if (file && isFileMeta(line)) {
      const objects = line.match(
        /^index ([0-9a-f]{4,64})\.\.[0-9a-f]{4,64}(?:\s|$)/,
      );
      if (objects) {
        file.oldObject = objects[1];
      }
      lines[i] = { kind: "meta" };
      file.endLine = i;
      i++;
      continue;
    }

    const hunkMatch = file && !file.combined ? line.match(HUNK_RE) : null;
    if (file && hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined
        ? parseInt(hunkMatch[2], 10)
        : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined
        ? parseInt(hunkMatch[4], 10)
        : 1;
      lines[i] = { kind: "hunk" };
      const headerLine = i;
      i++;

      // Body: consume exactly oldCount old-side and newCount new-side lines.
      // The counts are the authority; `\ No newline…` lines count for neither.
      let oldLeft = oldCount;
      let newLeft = newCount;
      let oldLine = oldStart - 1; // 0-based
      let newLine = newStart - 1;
      while (i < raw.length && (oldLeft > 0 || newLeft > 0)) {
        // CR-stripped so a CRLF diff's "empty" context line (just "\r")
        // classifies; the verbatim content keeps its CR downstream.
        const body = clean(raw[i]);
        if (body.startsWith("\\")) {
          lines[i] = { kind: "meta" };
        } else if (body.startsWith("+") && newLeft > 0) {
          lines[i] = { kind: "add", newLine };
          newLine++;
          newLeft--;
        } else if (body.startsWith("-") && oldLeft > 0) {
          lines[i] = { kind: "del", oldLine };
          oldLine++;
          oldLeft--;
        } else if (
          (body.startsWith(" ") || body === "") && oldLeft > 0 && newLeft > 0
        ) {
          // An empty body line is a context line whose content is empty (some
          // tools trim the trailing space).
          lines[i] = { kind: "ctx", newLine, oldLine };
          newLine++;
          oldLine++;
          newLeft--;
          oldLeft--;
        } else {
          break; // malformed body: stop the hunk, keep going leniently
        }
        i++;
      }
      // Trailing `\ No newline at end of file` after the last counted line.
      if (i < raw.length && raw[i].startsWith("\\")) {
        lines[i] = { kind: "meta" };
        i++;
      }
      file.hunks.push({
        headerLine,
        endLine: i - 1,
        oldStart,
        oldCount,
        newStart,
        newCount,
        // Group 5 is `(.*)`, so it always matches (at least the empty string).
        context: hunkMatch[5]!.trim(),
      });
      file.endLine = i - 1;
      continue;
    }

    // Anything else: outside the diff grammar.
    lines[i] = { kind: "other" };
    i++;
  }
  closeFile();

  return files.length > 0 ? { files, lines } : null;
}

/** Strip the `a/` / `b/` prefix (and surrounding quotes); null for /dev/null.
 * The unified-diff format separates path from timestamp with a tab, so plain
 * `diff -u` headers like `--- d/x.ts<TAB>2026-06-11 …` cut at the tab. A git
 * path containing special bytes is wrapped in double quotes with C-style
 * escapes (`\t`, `\"`, `\\`, octal `\NNN` for high/non-ASCII bytes); a quoted
 * path is decoded, an unquoted one is taken verbatim after the tab cut. */
function stripSide(path: string): string | undefined {
  const trimmed = path.trim();
  const p = trimmed.startsWith('"')
    ? decodeCStyle(trimmed)
    : trimmed.split("\t", 1)[0].trim();
  if (p === "/dev/null") return undefined;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Decode a git C-style-quoted path (`"…"`). Recognizes the single-character
 * escapes git emits (`\a \b \t \n \v \f \r \" \\`) and octal `\NNN` byte
 * escapes, reassembling consecutive octal bytes and interpreting them as UTF-8.
 * A string without a closing quote, or with an unrecognized escape, falls back
 * to the surrounding-quote strip so the path is never silently dropped. */
function decodeCStyle(quoted: string): string {
  const SIMPLE: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  const fallback = () => quoted.replace(/^"|"$/g, "");
  const out: number[] = [];
  let i = 1; // past the opening quote
  while (i < quoted.length) {
    const ch = quoted[i];
    if (ch === '"') return new TextDecoder().decode(new Uint8Array(out));
    if (ch !== "\\") {
      for (const byte of new TextEncoder().encode(ch)) out.push(byte);
      i++;
      continue;
    }
    const next = quoted[i + 1];
    if (next === undefined) return fallback();
    if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (
        j < quoted.length && oct.length < 3 &&
        quoted[j] >= "0" && quoted[j] <= "7"
      ) {
        oct += quoted[j];
        j++;
      }
      out.push(parseInt(oct, 8) & 0xff);
      i = j;
      continue;
    }
    if (next in SIMPLE) {
      out.push(SIMPLE[next]);
      i += 2;
      continue;
    }
    return fallback();
  }
  // No closing quote: not a well-formed C-style string.
  return fallback();
}

function isFileMeta(line: string): boolean {
  return line.startsWith("index ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("GIT binary patch");
}
