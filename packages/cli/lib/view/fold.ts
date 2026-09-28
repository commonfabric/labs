/**
 * Collapsing whole files in a diff view. Each file the diff touches can be
 * hidden — replaced by a single summary line (its path, its added/removed line
 * counts, and whether it was added, deleted or renamed) — so a large diff can be
 * skimmed a file at a time. This module is pure: it turns the diff text and the
 * set of collapsed files into the per-file ranges and the collapsed line list
 * the session renders; the session owns the fold state and the key commands.
 */

import type { Line, Span, TokenClass } from "./model.ts";
import { parseDiff } from "./diff.ts";
import { languageForFile } from "./languages/language.ts";

/** One file in the diff, with the collapsed one-line summary to show for it. */
export interface DiffFileRange {
  /** 0-based index in document order — the stable key for the fold set. */
  readonly index: number;

  /** First diff-text line of the file, which is its header line. */
  readonly headerLine: number;

  /** Last such line, inclusive — the file's last hunk line. */
  readonly endLine: number;

  /** The path used for file-category detection (new side, else old side). */
  readonly path: string;

  /** Path on the diff's removed side, when it has one. */
  readonly oldPath?: string;

  /** Path on the diff's added side, when it has one. */
  readonly newPath?: string;

  /** Whether Git reports binary content instead of line changes. */
  readonly binary: boolean;

  readonly isTest: boolean;
  readonly isMarkdown: boolean;

  /** Added line count within the file's range. */
  readonly adds: number;

  /** Removed line count over the same range. */
  readonly dels: number;

  /** The one-line summary shown when the file is collapsed. */
  readonly summary: Line;
}

/** The files a diff touches, each with its line range and collapsed summary. */
export function diffFiles(text: string): DiffFileRange[] {
  const model = parseDiff(text);
  if (!model) return [];
  const raw = text.split("\n");
  return model.files.map((file, index) => {
    let adds = 0;
    let dels = 0;
    for (let i = file.headerLine; i <= file.endLine; i++) {
      const kind = model.lines[i]?.kind;
      if (kind === "add") adds++;
      else if (kind === "del") dels++;
    }
    const binary = anyBinary(raw, file.headerLine, file.endLine);
    const path = file.newPath ?? file.oldPath ?? "(unknown file)";
    return {
      index,
      headerLine: file.headerLine,
      endLine: file.endLine,
      path,
      oldPath: file.oldPath,
      newPath: file.newPath,
      binary,
      isTest: isTestPath(path),
      isMarkdown: isMarkdownPath(path),
      adds,
      dels,
      summary: summaryLine({
        oldPath: file.oldPath,
        newPath: file.newPath,
        adds,
        dels,
        binary,
      }),
    };
  });
}

/** Builds a file's collapsed summary with replacement line counts. */
export function diffFileSummary(
  file: DiffFileRange,
  adds = file.adds,
  dels = file.dels,
): Line {
  return summaryLine({
    oldPath: file.oldPath,
    newPath: file.newPath,
    adds,
    dels,
    binary: file.binary,
  });
}

function anyBinary(raw: string[], from: number, to: number): boolean {
  for (let i = from; i <= to && i < raw.length; i++) {
    if (raw[i].startsWith("Binary files") || raw[i].startsWith("GIT binary")) {
      return true;
    }
  }
  return false;
}

interface SummaryInput {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly adds: number;
  readonly dels: number;
  readonly binary: boolean;
}

/** Build the collapsed summary line: `▸ path  +A −D`, with new and deleted
 * files showing only their applicable count and status. Binary files carry a
 * `(binary)` tag, and renames show `old → new`. */
function summaryLine(f: SummaryInput): Line {
  const spans: Span[] = [];
  let text = "";
  const add = (s: string, cls: TokenClass) => {
    spans.push({ col: cpCount(text), text: s, cls });
    text += s;
  };

  add("▸ ", "punctuation");
  if (f.oldPath && f.newPath && f.oldPath !== f.newPath) {
    add(f.oldPath, "sectionHeader");
    add(" → ", "diffMeta");
    add(f.newPath, "sectionHeader");
  } else {
    add(f.newPath ?? f.oldPath ?? "(unknown file)", "sectionHeader");
  }

  if (f.binary) {
    add("  (binary)", "diffMeta");
  } else if (f.newPath === undefined) {
    add("  ", "whitespace");
    add(`−${f.dels} (deleted)`, "diffDel");
  } else if (f.oldPath === undefined) {
    add("  ", "whitespace");
    add(`+${f.adds} (new)`, "diffAdd");
  } else {
    add("  ", "whitespace");
    add(`+${f.adds}`, "diffAdd");
    add(" ", "whitespace");
    add(`−${f.dels}`, "diffDel");
  }
  return { text, spans };
}

function cpCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

//
// the collapsed line list
//

/**
 * Maps between the full document's lines and the collapsed display: a collapsed
 * file's whole range becomes its single summary line, everything else passes
 * through. Line numbers on either side are 0-based.
 */
export interface FoldPlan {
  /** The lines to render: full lines, with each collapsed file's range replaced
   * by one summary line. */
  readonly displayLines: readonly Line[];

  /** A document line → the display row it appears on (a line inside a collapsed
   * file maps to that file's summary row). */
  docToDisplay(docLine: number): number;

  /** A display row → the document line it stands for (a summary row maps to its
   * file's header line). */
  displayToDoc(displayRow: number): number;
}

/** The identity plan (nothing collapsed): display equals the document. */
export function identityFold(docLines: readonly Line[]): FoldPlan {
  const clampDoc = (n: number) => clamp(n, 0, Math.max(0, docLines.length - 1));
  return {
    displayLines: docLines,
    docToDisplay: clampDoc,
    displayToDoc: clampDoc,
  };
}

export function buildFoldPlan(
  docLines: readonly Line[],
  files: readonly DiffFileRange[],
  collapsed: ReadonlySet<number>,
): FoldPlan {
  const hidden = files.filter((f) => collapsed.has(f.index));
  if (hidden.length === 0) return identityFold(docLines);

  // For each document line: the summary line to emit here (a collapsed file's
  // header line), or "skip" (a collapsed file's inner line), or pass-through.
  const summaryAt = new Map<number, Line>();
  const skip = new Set<number>();
  for (const f of hidden) {
    summaryAt.set(f.headerLine, f.summary);
    for (let i = f.headerLine + 1; i <= f.endLine; i++) skip.add(i);
  }

  const displayLines: Line[] = [];
  const docToDisplay = new Array<number>(docLines.length);
  const displayToDoc: number[] = [];
  // A skipped line points at the summary row emitted for its file's header.
  let lastDisplay = 0;
  for (let i = 0; i < docLines.length; i++) {
    if (skip.has(i)) {
      docToDisplay[i] = lastDisplay;
      continue;
    }
    const row = displayLines.length;
    displayLines.push(summaryAt.get(i) ?? docLines[i]);
    displayToDoc.push(i);
    docToDisplay[i] = row;
    lastDisplay = row;
  }

  // Both arrays are fully populated over their valid index range (every document
  // line sets a display row; every display row records its document line), so a
  // clamped lookup always hits a value.
  const clampDisplay = (n: number) =>
    clamp(n, 0, Math.max(0, displayLines.length - 1));
  const clampDoc = (n: number) => clamp(n, 0, Math.max(0, docLines.length - 1));
  return {
    displayLines,
    docToDisplay: (docLine) => docToDisplay[clampDoc(docLine)],
    displayToDoc: (row) => displayToDoc[clampDisplay(row)],
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

//
// file-category detection
//

/** Whether a path selects the pager's Markdown language. */
export function isMarkdownPath(path: string): boolean {
  return languageForFile(path).id === "markdown";
}

const TEST_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "testdata",
  "fixtures",
  "fixture",
  "mocks",
  "__mocks__",
  "__snapshots__",
  "baselines",
  "integration",
  "e2e",
]);

/** Whether a directory segment conventionally holds tests or test support:
 * one of `TEST_SEGMENTS`, a suite like `browser-tests`, or a helper library
 * like `test-utils`. */
function isTestSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  return TEST_SEGMENTS.has(s) || /[-_.]tests$/.test(s) ||
    /^test[-_]?(support|utils?|helpers?)$/.test(s);
}

/** Whether a path names a test or test-support file: one under a test-ish
 * directory, or a basename like `x.test.ts`, `x.spec.js`, `x.test.d.ts`,
 * `x_test.go`, `x_spec.rb`, `x-fixture.ts`, `x-fixtures.ts`, `x.stories.tsx`,
 * `test_x.py`, `test-helpers.ts`, `conftest.py`, or `x.golden`. The marker
 * must precede the final extension, so data about a test, such as
 * `x.test.ts.jsonl`, does not qualify. A `test-` prefix names tooling about
 * tests as often as tests, as in `test-runner.ts`, so only pytest's
 * `test_*.py` and helper libraries qualify by prefix. Likewise `_spec` also
 * names specification documents, so only RSpec's `*_spec.rb` qualifies by that
 * suffix. */
export function isTestPath(path: string): boolean {
  const segs = path.split(/[\\/]/);
  const base = (segs.pop() ?? "").toLowerCase();
  if (segs.some(isTestSegment)) return true;
  return /(\.(test|spec|stories)|[-_]test|[-_]fixtures?)(\.d)?\.[^.]+$/
    .test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_spec\.rb$/.test(base) ||
    /^test[-_]?(support|utils?|helpers?)\./.test(base) ||
    base === "conftest.py" ||
    base.endsWith(".golden");
}
