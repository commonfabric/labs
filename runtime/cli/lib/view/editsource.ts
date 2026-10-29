/**
 * Where the editor's changes come from and go back to. A view needs an
 * underlying file, or set of files for a diff, before it can be editable. A
 * language can keep a file-backed view read-only. Pipes and diffs that match no
 * workspace files are also read-only.
 *
 * For an editable plain file the editable text is the document's retained
 * source text, so re-highlighting is a re-parse and saving is a write. Its
 * displayed lines may be a rendered projection. The diff source (in
 * `diffedit.ts`) maps the single editable text back onto the files it touches.
 */

import { basename, dirname } from "@std/path";

import type { BlameTarget } from "./blame.ts";
import type { Document, Line, ViewMode } from "./model.ts";
import type { DiffHunk, DiffModel } from "./diff.ts";
import type { DiffCountFileContext } from "./diffcounts.ts";
import type { LineEndingProvenance } from "./editbuffer.ts";
import type {
  Highlighter,
  Language,
  RenderInputExtent,
} from "./languages/language.ts";
import {
  decoderFor,
  languageForFile,
  readOnlyReasonFor,
  renderedLinesFor,
} from "./languages/language.ts";

/** How much a revert restores: the cursor's hunk, the cursor's file, the commit
 * message the cursor is in, or all. */
export type RevertScope = "chunk" | "file" | "message" | "all";

/** The outcome of revealing more context (a diff only): the grown diff and its
 * matching grown baseline, where the cursor moves, and — so the pager can hold
 * its viewport and selection steady across the change — what moved where.
 *
 * `inserted` lines went in at `insertedAt`, a line of the pre-expansion text.
 * `up` tells which edge of the hunk they went in at: its top when they came from
 * above the hunk, its bottom when they came from below.
 *
 * `removedAt` is the `@@` header a join took out, also a line of the
 * pre-expansion text, or null when nothing joined. Revealing the last file line
 * between two hunks leaves them touching, and a header between lines that are
 * neighbors in the file describes nothing: the two become one hunk.
 *
 * So a line `n` of the pre-expansion text is afterwards at
 * `n + (n >= insertedAt ? inserted : 0) - (removedAt !== null && n > removedAt ?
 * 1 : 0)`, and the line at `removedAt` is gone. */
export interface ExpandResult {
  text: string;
  baseline: string;
  cursorLine: number;
  insertedAt: number;
  inserted: number;

  /** Exact workspace endings for the rows inserted into `text`. */
  insertedLineEndings: readonly (LineEndingProvenance | undefined)[];

  up: boolean;
  removedAt: number | null;

  /** Which lines of the workspace file the reveal showed, as the file numbers
   * them and counting from one: `from` to `to`, both ends included. */
  revealed: { from: number; to: number };
}

/** How much context a hunk can still reveal each way, and what stops it where it
 * cannot: `atFileTop` / `atFileBottom` say the hunk's range reaches the file's
 * first or last line, so a zero there is the file running out. A zero without
 * one is the neighboring hunk butting against it, with nothing in between. */
export interface HunkRoom {
  up: number;
  down: number;
  atFileTop: boolean;
  atFileBottom: boolean;
}

/** Which parts of an edited view a save should persist. Commit-aware sources
 * amend by default. The file-only choice writes changes backed by workspace
 * files without rewriting Git history. */
export interface SaveOptions {
  readonly amendCommit?: boolean;
}

export interface EditableSource {
  /** A short label for the backing target (the filename), or null. */
  readonly label: string | null;

  /** True for a diff view, whether or not it is editable. Absent or false for a
   * plain file or a non-diff pipe. */
  readonly isDiff?: boolean;

  /** Complete diff sides used to scan syntax hidden between visible hunks. */
  diffCountContexts?(
    text: string,
  ): readonly DiffCountFileContext[] | undefined;

  /** False when there is no underlying file to edit or the selected language
   * is read-only. `reason` is shown when a cursor move is attempted on a
   * non-editable view. */
  readonly editable: boolean;

  readonly reason?: string;

  /** Representation used when the caller did not choose one explicitly. */
  readonly defaultViewMode?: ViewMode;

  /** Whether rendered rows retain the source document's line layout. */
  readonly renderLineTopology?: "source" | "independent";

  /** Whether an empty decoded input is a complete view. */
  readonly allowsEmptyInput?: boolean;

  /** Re-parse edited text into a Document — lines, structure and definitions. */
  parse(
    text: string,
    lineEndings?: readonly (LineEndingProvenance | undefined)[],
  ): Document;

  /**
   * Build the alternate rendered representation. Rendered documents retain the
   * source text. Most renderers keep one display line per source line;
   * whole-file renderers may own an independent layout. Absent when the
   * source's languages offer no rendered view.
   */
  render?(source: Document): Document;

  /** Re-highlight the edited text into rendered lines only (no structure tree),
   * for live highlighting on every keystroke. A fraction of a full {@link
   * parse}; the structure is refreshed separately when typing pauses. When
   * absent, the session falls back to a full parse. */
  highlight?(text: string): readonly Line[];

  /** Build an incremental highlighter seeded with `text`, for live highlighting
   * whose cost tracks the size of each edit rather than the whole document. The
   * session re-baselines it on the deferred re-parse. When present it is used in
   * preference to {@link highlight}. `seedLines` is the already-rendered color
   * of `text` (the current document's lines): a source that cannot recompute a
   * line's color cheaply on its own — a diff, whose coloring needs the
   * workspace files — reuses it for the unchanged lines so only edited lines are
   * recolored. */
  createHighlighter?(
    text: string,
    seedLines?: readonly Line[],
    lineEndings?: readonly (LineEndingProvenance | undefined)[],
  ): Highlighter;

  /** Exact file-ending information for transformed editable rows. */
  lineEndingProvenance?(
    text: string,
  ): readonly (LineEndingProvenance | undefined)[];

  /** Attempt to persist the edited text. `lineEndings` carries exact source
   * endings for rows that came from a file. `baseline` is the text at the last
   * successful save. A read-only source returns its refusal reason without
   * writing. Returns a status message and throws on write failure. */
  save(
    text: string,
    lineEndings: readonly (LineEndingProvenance | undefined)[],
    baseline?: string,
    options?: SaveOptions,
  ): string;

  /** The clean baseline after a successful save. Most sources persist the
   * whole buffer and omit this method. A commit view that saves files without
   * amending keeps commit-message edits outside the returned baseline, so they
   * remain visibly unsaved. */
  baselineAfterSave?(
    baseline: string,
    current: string,
    options?: SaveOptions,
  ): string;

  /** The labels (filenames) of the targets that differ between `original` and
   * `current` — what a save would actually write. A plain file is its one label
   * when changed; a diff reports just the files whose lines an edit touched, so
   * the quit prompt names them instead of every file the diff spans. Absent →
   * the caller falls back to the single {@link label}. */
  dirtyLabels?(original: string, current: string): string[];

  /** Restore part of the text to its `original` form: the hunk or file the
   * cursor (`cursorLine`) is in, or everything. Returns the new full text and
   * where to place the cursor, or null when there is nothing to revert at that
   * scope. A plain file reverts wholesale at any scope. */
  revert?(
    original: string,
    current: string,
    cursorLine: number,
    scope: RevertScope,
    lineEndings?: readonly (LineEndingProvenance | undefined)[],
  ): {
    text: string;
    cursorLine: number;
    lineEndings?: readonly (LineEndingProvenance | undefined)[];
  } | null;

  /** Reveal more of the underlying file around the hunk `cursorLine` sits in (a
   * diff only). Returns the grown diff text, the matching grown baseline (so
   * revealing context is not itself an edit), and where the cursor moves — or
   * null when there is nothing to expand. `up` names the edge to grow, and the
   * call fails rather than growing the other one when that edge has run out;
   * without it the boundary nearest `cursorLine` grows, falling back to the
   * other. */
  expandContext?(
    current: string,
    baseline: string,
    cursorLine: number,
    up?: boolean,
  ): ExpandResult | null;

  /** How much context each hunk of `current` could still reveal, keyed by the
   * line its header sits on. The pager offers Ctrl-L only where the edge the
   * user is looking at has room, and says what stopped it where it has not. */
  expandRoom?(current: string): ReadonlyMap<number, HunkRoom>;

  /** Constrains where editing may happen. Present only for a diff, whose lines
   * map to fixed file lines: edits stay within a line, past the diff marker. A
   * plain file has no policy and is edited freely. */
  readonly policy?: EditPolicy;

  /** The last editable column on a line when the source gives a trailing
   * carriage return meaning beyond ordinary CRLF transport. */
  logicalEnd?(lines: readonly string[], row: number): number;

  /** When changed `git show` output contains the HEAD commit, the commit a save
   * would amend — for the confirmation prompt. Null when no such change is
   * pending. Absent on sources that never edit a commit. */
  pendingAmend?(
    baseline: string,
    current: string,
  ): { sha: string; subject: string } | null;

  /** The path of the backing file, when there is a single one. The file picker
   * opens in its directory. */
  readonly path?: string;

  /** What `git blame` attributes each line of `text` to, indexed by line, or
   * null for a line with no file line behind it. Absent when no line of this
   * source has one. */
  blameTargets?(text: string): readonly (BlameTarget | null)[];
}

/**
 * The editing constraints of a diff view. A line is editable past its marker
 * only when it is a context or added line inside a hunk whose new side matched
 * a file on disk — the change it would make can then be written back. A removed
 * line in such a hunk may be resurrected intact, but cannot be edited as text.
 * Hunk/file headers and any text that is not part of a savable hunk (a
 * commit-message preamble, an unverified hunk) are refused. Editability is
 * decided from the whole diff and the line's position, so it survives lines
 * being added or removed above it.
 */
export interface EditPolicy {
  /** The first editable column on the line at `row` (just past the diff marker,
   * or past a commit message's indent), or null when the line is not editable.
   * Takes the whole set of lines because editability depends on the row's
   * region. */
  editStart(lines: readonly string[], row: number): number | null;

  /** A source-specific explanation for refusing an edit at `row`, or null to
   * use the editor's general explanation. */
  notEditableMessage?(
    lines: readonly string[],
    row: number,
  ): string | null;

  /** What the row at `row` belongs to: a diff hunk's new side (edited as a
   * removed/added pair), a removed line that can be resurrected, an editable
   * commit message (edited as plain indented text), or neither. Drives how the
   * editor treats an edit there. */
  regionKind(
    lines: readonly string[],
    row: number,
  ): "hunk" | "removed" | "message" | null;

  /** The parsed diff hunk containing a body row. */
  hunkAt?(
    lines: readonly string[],
    row: number,
  ): { model: DiffModel; hunk: DiffHunk } | null;

  /** Whether the workspace file for the hunk at `row` uses a UTF-8 BOM. */
  hasUtf8Bom?(lines: readonly string[], row: number): boolean | undefined;

  /** The marker a newly inserted line is given inside a hunk (a diff adds an
   * added line, so `"+"`), keeping the diff well-formed as the user adds lines.
   * A commit message uses its own indent instead. */
  readonly insertPrefix: string;

  /** The indent a new commit-message line is given (git's four spaces). */
  readonly messageIndent: string;
}

export interface FileSourceOptions {
  /** Encoder paired with the bytes read when the source was opened. */
  readonly encode?: (text: string) => Uint8Array;

  /** Full byte size information for a bounded rendered preview. */
  readonly renderExtent?: RenderInputExtent;
}

/** An on-disk file. Writable languages persist edits to the file. Read-only
 * languages expose the document without allowing edits or writes. */
export function fileSource(
  path: string,
  language: Language = languageForFile(path),
  options: FileSourceOptions = {},
): EditableSource {
  // The language is chosen once, and every edit-time operation dispatches
  // through it.
  const render = sourceRenderer(language, path, options.renderExtent);
  const readOnlyReason = readOnlyReasonFor(language);
  const encode = options.encode ?? decoderFor(language).encode;
  return {
    label: shortName(path),
    editable: readOnlyReason === undefined,
    reason: readOnlyReason,
    defaultViewMode: language.defaultViewMode ?? "source",
    renderLineTopology: language.renderLineTopology ?? "source",
    allowsEmptyInput: language.allowsEmptyInput,
    path,
    parse: (text) => language.parseDocument(text, path),
    ...render,
    highlight: (text) => language.highlightLines(text, path),
    createHighlighter: (text) => language.createHighlighter(text, path),
    dirtyLabels: (original, current) =>
      original === current ? [] : [shortName(path)],
    // The buffer is blamed as the bytes a save would write, so each line maps
    // to itself and lines edited since the last commit read as uncommitted.
    ...(language.input.kind === "text"
      ? {
        blameTargets: (text: string) => {
          const request = {
            cwd: dirname(path),
            path: basename(path),
            contents: encode(text),
          };
          return text.split("\n").map((_, line) => ({ request, line }));
        },
      }
      : {}),
    // A plain file has no hunks, so any scope reverts the whole file.
    revert: (original, current, cursorLine) =>
      original === current ? null : {
        text: original,
        cursorLine: Math.min(cursorLine, original.split("\n").length - 1),
      },
    save: (text) => {
      if (readOnlyReason !== undefined) return readOnlyReason;
      Deno.writeFileSync(path, encode(text));
      return "Saved 1 file";
    },
  };
}

/** A non-file view (a pipe / a diff matching nothing): readable, not editable. */
export function readonlySource(
  reason: string,
  language: Language = languageForFile(undefined),
  fileName?: string,
  renderExtent?: RenderInputExtent,
): EditableSource {
  const render = sourceRenderer(language, fileName, renderExtent);
  return {
    label: null,
    editable: false,
    reason,
    defaultViewMode: language.defaultViewMode ?? "source",
    renderLineTopology: language.renderLineTopology ?? "source",
    allowsEmptyInput: language.allowsEmptyInput,
    parse: (text) => language.parseDocument(text, fileName),
    ...render,
    save: () => reason,
  };
}

function sourceRenderer(
  language: Language,
  fileName?: string,
  extent?: RenderInputExtent,
): Partial<Pick<EditableSource, "render">> {
  if (language.input.kind !== "bytes" && !language.renderLines) return {};
  return {
    render: (source: Document): Document => {
      return {
        ...source,
        lines: renderedLinesFor(language, source.text, fileName, extent)!,
      };
    },
  };
}

export function shortName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
