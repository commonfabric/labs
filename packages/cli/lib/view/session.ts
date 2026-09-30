/**
 * The pager's state machine, with no terminal I/O. {@link Session} holds the
 * scroll/selection/search/overlay state and turns {@link Key} events into state
 * changes; {@link Session.view} projects that state into a {@link ViewState} for
 * the renderer. `pager.ts` drives it against a real TTY, but it is fully
 * exercisable from tests by feeding keys and inspecting `view()`.
 */

import type {
  Document,
  Line,
  Span,
  StructureNode,
  TokenClass,
  ViewMode,
} from "./model.ts";
import type { Key } from "./keys.ts";
import { cpLen } from "./ansi.ts";
import {
  type DialogButton,
  type DialogState,
  DIFF_MARGIN_WIDTH,
  type DiffAnnotation,
  diffAnnotationDecoration,
  type DiffTotals,
  diffTotalsDecoration,
  diffTotalsWidth,
  type KeyHint,
  labeledDiffMetadataLine,
  type Match,
  overlayBox,
  type OverlayState,
  type ViewState,
} from "./render.ts";
import {
  clamp,
  diffContentRowCount,
  findMatches,
  frameTop,
  maxPagerTop,
  maxTop,
  nextMatchIndex,
  nodeAtLine,
  scrollToAnchor,
  treeChild,
  treeNextSibling,
  treeParent,
  treePreOrderNext,
  treePreOrderPrev,
  treePrevSibling,
} from "./actions.ts";
import { buildPeekCard, type CardTarget } from "./card.ts";
import {
  DISPLAY_MODES,
  displayColumnOf,
  displayLine,
  type DisplayMode,
  displayModeLabel,
  displayWidth,
  hasNonPrintable,
  sourceColumnOf,
} from "./display.ts";
import {
  DIFF_COUNT_MODES,
  type DiffCountMode,
  diffCountModeLabel,
  type DiffCounts,
  diffCounts,
  type DiffLineCounts,
  sumDiffLineCounts,
} from "./diffcounts.ts";
import {
  buildFoldPlan,
  type DiffFileRange,
  diffFiles,
  diffFileSummary,
  type FoldPlan,
  identityFold,
} from "./fold.ts";
import { type DiffHunk, type DiffModel, parseDiff } from "./diff.ts";
import {
  type CommitHeader,
  commitSubjects,
  findCommitHeaders,
  findCommitMessages,
} from "./commitmsg.ts";
import type { Highlighter, Semantics } from "./languages/language.ts";
import { EditBuffer, type LineEndingProvenance } from "./editbuffer.ts";
import type {
  EditableSource,
  ExpandResult,
  HunkRoom,
  RevertScope,
  SaveOptions,
} from "./editsource.ts";
import type { DirEntry, FileGateway } from "./filegateway.ts";
import {
  type ActiveWrapMode,
  buildWrapPlan,
  fitViewLayout,
  type WrapDecoration,
  type WrapMode,
  wrappedRowAt,
  wrappedRowForPosition,
  type WrapPlan,
} from "./wrap.ts";

export interface SessionOptions {
  color: boolean;
  showLineNumbers: boolean;

  /** Initial representation, falling back to source when none is available. */
  viewMode?: ViewMode;
}

type Mode =
  | "normal"
  | "search"
  | "deflookup"
  | "savePrompt"
  | "amendPrompt"
  | "revertPrompt"
  | "filePicker"
  | "jumpList";

/**
 * Overlay content. A peek carries both an info card and the verbatim source and
 * can toggle between them; the help overlay carries only `info`. The card's
 * cross-reference lines are selectable {@link CardTarget}s that jump the main
 * view to a definition or use.
 */
interface PeekOverlay {
  title: string;
  info: readonly Line[];
  source?: readonly Line[];
  mode: "info" | "source";
  targets: readonly CardTarget[];

  /** Index into `targets` of the highlighted reference, or -1. */
  cardSel: number;

  /** The node this card describes (its subject), for `z` to reveal. */
  node?: StructureNode;

  /** Footer for overlays without a toggle (e.g. help). */
  staticFooter?: string;

  /** The `info` lines are verbatim source (a definition peek, an opened file),
   * not a structured card, so the overlay is drawn as a blue editor window even
   * in "info" mode. */
  infoIsSource?: boolean;
}

const HORIZONTAL_STEP = 8;
const MOUSE_WHEEL_STEP = 3;

/** Whether two search matches occupy the same displayed range. */
function sameDisplayedMatch(a: Match, b: Match): boolean {
  return a.line === b.line && a.start === b.start && a.end === b.end;
}

// Messages shown when a diff's edit policy refuses an edit.
const NOT_EDITABLE_MSG =
  "This line isn't editable (a removed line or diff structure).";
const MARKER_MSG = "The diff marker column isn't editable.";
const MULTILINE_MSG =
  "Pasting or killing across lines isn't supported while editing a diff.";
const JOIN_MSG =
  "To remove a line in a diff, press Backspace at the start of it.";

/** What the line-number gutter shows: nothing, the position in the piped input
 * (the diff/document line), or the line of the underlying file (a diff line's
 * new-file line) or commit message. */
type LineNumberMode = "off" | "input" | "file";

interface ViewportAnchor {
  readonly docLine: number;
  readonly foldedLine: number;
  readonly displayCol: number;
}

interface ExpansionLayoutCache {
  readonly decoratedPlan: WrapPlan;
  readonly decoratedTop: number;
  readonly basePlan: WrapPlan;
  readonly baseTop: number;
}

interface ExpandOffer {
  /** Screen row in the undecorated layout. */
  readonly row: number | null;

  /** Document line carrying the expansion triangle. */
  readonly markerLine: number | null;

  /** Document line passed to the context expander. */
  readonly line: number;

  readonly up: boolean;
}

interface ExpandEdge extends ExpandOffer {
  readonly aimRow: number;
  readonly room: HunkRoom;
}

interface FoldAnchor {
  readonly docLine: number;
  readonly sourceCol: number;

  /** Display column within a collapsed summary that remains collapsed. */
  readonly syntheticDisplayCol?: number;
}

/** One row of the jump list (the `i` dialog): a file the diff touches or a
 * commit whose message it carries, with where selecting it moves the view. */
interface JumpEntry {
  /** Document line the jump lands the viewport on (a file header or a `commit`
   * header line). */
  readonly line: number;

  /** Last document line belonging to this file or commit, inclusive. */
  readonly endLine: number;

  /** The styled row shown in the list. */
  readonly display: Line;

  /** Lower-cased text the filter matches against. */
  readonly filterText: string;

  /** Short name for the "Jumped to …" confirmation. */
  readonly name: string;

  /** Diff-file index for file rows; absent on commit rows. */
  readonly fileIndex?: number;
}

export class Session {
  /** The parsed source document used for editing, offsets, and source cards. */
  #sourceDoc: Document;

  #currentDoc: Document;
  #viewMode: ViewMode = "source";
  #color: boolean;
  #lineNumberMode: LineNumberMode = "off";

  /** How long logical lines continue on later screen rows. */
  #wrapMode: WrapMode = "off";

  /** How non-printable characters are shown; edit mode forces the first mode. */
  #displayMode: DisplayMode = DISPLAY_MODES[0];

  /** Indices (document order) of the diff files collapsed to a summary line.
   * Cleared when the text cursor is revealed, since hidden lines cannot be
   * edited. `this.top` is a display row while any file is collapsed. */
  #collapsed = new Set<number>();

  /** Bumped whenever `collapsed` changes, to invalidate the fold-plan cache. */
  #foldVersion = 0;

  #foldFileCache?: { doc: Document; files: DiffFileRange[] };
  #foldPlanCache?: { doc: Document; version: number; plan: FoldPlan };
  #wrapPlanCache?: {
    lines: readonly Line[];
    mode: DisplayMode;
    wrapMode: ActiveWrapMode;
    width: number;
    decorations: string;
    plan: WrapPlan;
  };
  #baseWrapPlanCache?: {
    lines: readonly Line[];
    mode: DisplayMode;
    wrapMode: ActiveWrapMode;
    width: number;
    plan: WrapPlan;
  };
  #expansionLayoutCache?: ExpansionLayoutCache;
  #wrapDecorations = new Map<number, WrapDecoration>();
  #wrapDecorationKey = "";
  #displayColumnCache?: {
    doc: Document;
    mode: DisplayMode;
    columns: Map<number, Uint32Array>;
  };

  get #wrapLines(): boolean {
    return this.#wrapMode !== "off";
  }

  get #activeWrapMode(): ActiveWrapMode {
    return this.#wrapMode === "word" ? "word" : "hard";
  }
  #maxDisplayWidthCache?: {
    lines: readonly Line[];
    mode: DisplayMode;
    width: number;
  };
  #nonPrintCache?: { doc: Document; value: boolean };
  #fileLineCache?: { doc: Document; value: (number | null)[] | null };

  /** Diff metadata lines, cached against the parsed document. */
  #diffMetadataCache?: { doc: Document; lines: readonly number[] };

  width: number;
  height: number;
  top = 0;
  left = 0;
  #selectedIndex: number | null = null;
  #query = "";
  #matches: Match[] = [];
  #currentMatch = 0;

  /** Where an edit-mode search (Ctrl-S) began, so its focused match is the
   * first at or after the cursor and Enter lands the cursor there. Null for a
   * normal-mode `/` search. */
  #searchAnchor: { row: number; col: number } | null = null;

  #message = "";
  #mode: Mode = "normal";
  #input = "";
  #overlay: PeekOverlay | null = null;
  #overlayScroll = 0;

  /** The overlays followed to reach the current one, so Esc walks back through
   * the chain of cards and file peeks. Empty when the current overlay is the
   * first one opened from the main view. */
  #overlayStack: Array<{ overlay: PeekOverlay; scroll: number }> = [];

  #semantics?: Semantics;
  quit = false;

  /** An edit patched only the changed lines for speed; a full re-parse (for
   * structure, cross-references, and multi-line token colors) is owed. The
   * driver runs it on a short idle, so typing stays responsive. */
  needsReparse = false;

  /** What the last key revealed (Ctrl-L in pager mode), for the driver to walk
   * the lines in a few at a time with {@link revealFrame}: the display row they
   * start at, how many there are, and whether they came from above the hunk (so
   * the viewport holds still) or below it (so it slides as they land). The next
   * key clears it. */
  pendingReveal: { row: number; count: number; up: boolean } | null = null;

  /** A prompt button was just activated. Holds the frame that shows it pushed —
   * the dialog with that button drawn mid-press — so the driver can play the
   * press for a moment before the action's result appears. The next key clears
   * it. */
  pendingPush: { doc: Document; view: ViewState } | null = null;

  /** The last key set a message that takes itself away again rather than sitting
   * in the bar — Ctrl-L pressed where it is not offered, which changed nothing
   * else. The driver leaves it up for a moment and then calls
   * {@link expireMessage}; the next key takes it away too. */
  transientMessage = false;

  /** How much context each hunk can reveal, cached against the document. */
  #roomCache?: { doc: Document; room: ReadonlyMap<number, HunkRoom> };

  //
  // editing
  //

  #source?: EditableSource;
  #buffer?: EditBuffer;

  /** Incremental highlighter for the current buffer, created lazily on the first
   * edit and discarded (re-baselined) on each deferred re-parse and file swap. */
  #highlighter?: Highlighter;

  /** Row of the added line a context-line split produced, so undoing that edit
   * collapses the pair back — even after moving the cursor away and back — while
   * editing an author-written -/+ pair to match does not. Overwritten by the
   * next split, cleared on a collapse or when the buffer text is replaced. */
  #splitRow: number | null = null;

  #cursorOn = false;

  /** Pending C-x prefix (Emacs chord), reset by the next key. */
  #chord: "ctrl-x" | null = null;

  /** Which button the active prompt's Tab focus rests on — an index into its
   * button row. Space and Enter activate it; it is reset to the default button
   * each time a prompt opens. */
  #dialogFocus = 0;

  /** What the active save prompt does on confirm. */
  #savePromptThen: "quit" | null = null;

  /** Filenames a save would write, computed when the quit prompt opens and
   * listed above it. */
  #editedFiles: string[] = [];

  //
  // file picker (C-x C-f)
  //

  readonly #files?: FileGateway;
  #pickerDir = "";
  #pickerFilter = "";
  #pickerEntries: DirEntry[] = [];
  #pickerSel = 0;

  //
  // jump list (i)
  //

  /** Every file and commit in the diff, in document order; the filter narrows
   * this into the shown `#jumpEntries`. */
  #jumpAll: JumpEntry[] = [];

  #jumpEntries: JumpEntry[] = [];
  #jumpFilter = "";
  #jumpSel = 0;
  #jumpSearching = false;
  #jumpCountMode: DiffCountMode = "normal";
  #commitHeaderCache?: {
    readonly doc: Document;
    readonly headers: readonly CommitHeader[];
  };

  #jumpCountCache?: {
    readonly doc: Document;
    readonly mode: DiffCountMode;
    readonly counts: DiffCounts;
  };

  constructor(
    doc: Document,
    options: SessionOptions,
    size: { width: number; height: number },
    semantics?: Semantics,
    source?: EditableSource,
    files?: FileGateway,
  ) {
    this.#sourceDoc = doc;
    this.#currentDoc = doc;
    this.#color = options.color;
    this.#lineNumberMode = options.showLineNumbers ? "input" : "off";
    this.width = size.width;
    this.height = size.height;
    this.#semantics = semantics;
    this.#source = source;
    this.#files = files;
    // The edit buffer mirrors the document text; for an editable file the two
    // stay in lock-step (the document is a re-parse of the buffer).
    if (source) {
      this.#buffer = new EditBuffer(
        doc.text,
        source.lineEndingProvenance?.(doc.text),
      );
    }
    const initialViewMode = options.viewMode ?? source?.defaultViewMode;
    if (initialViewMode === "rendered" && source?.render) {
      this.#viewMode = "rendered";
      this.#setSourceDocument(doc);
    }
  }

  /**
   * The edit buffer and the steps of this session that a test drives
   * directly: selection and navigation, overlay keys, diff editing, layout
   * of diff metadata, and the file picker.
   */
  get accessForTestingOnly(): {
    readonly buffer: EditBuffer | undefined;
    selectNode(idx: number): void;
    moveCardSelection(delta: number): void;
    jumpToTarget(target: CardTarget): void;
    revealMatch(): void;
    handleOverlayKey(key: Key): void;
    prepareContextEdit(): void;
    adjustHunkCounts(
      oldDelta: number,
      newDelta: number,
      hunkHeader?: number | null,
    ): boolean;
    editStart(): number | null;
    ensureCursorVisible(): void;
    computeEditedFiles(): string[];
    displayAdjacentDiffMetadataRows(
      expand: ExpandOffer | null,
    ): readonly number[];
    displayDiffAnnotations(expand: ExpandOffer | null): DiffAnnotation[];
    refreshPicker(): void;
    pickerUp(): void;
    activatePicked(): void;
    openPickedFile(absPath: string): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get buffer() {
        return outerThis.#buffer;
      },
      selectNode: (idx) => this.#selectNode(idx),
      moveCardSelection: (delta) => this.#moveCardSelection(delta),
      jumpToTarget: (target) => this.#jumpToTarget(target),
      revealMatch: () => this.#revealMatch(),
      handleOverlayKey: (key) => this.#handleOverlayKey(key),
      prepareContextEdit: () => this.#prepareContextEdit(),
      adjustHunkCounts: (oldDelta, newDelta, hunkHeader) =>
        this.#adjustHunkCounts(oldDelta, newDelta, hunkHeader),
      editStart: () => this.#editStart(),
      ensureCursorVisible: () => this.#ensureCursorVisible(),
      computeEditedFiles: () => this.#computeEditedFiles(),
      displayAdjacentDiffMetadataRows: (expand) =>
        this.#displayAdjacentDiffMetadataRows(expand),
      displayDiffAnnotations: (expand) => this.#displayDiffAnnotations(expand),
      refreshPicker: () => this.#refreshPicker(),
      pickerUp: () => this.#pickerUp(),
      activatePicked: () => this.#activatePicked(),
      openPickedFile: (absPath) => this.#openPickedFile(absPath),
    };
  }

  get doc(): Document {
    return this.#currentDoc;
  }

  /** Install a newly parsed source document in the active representation. */
  #setSourceDocument(doc: Document): void {
    this.#sourceDoc = doc;
    if (this.#viewMode === "rendered" && this.#source?.render) {
      const rendered = this.#source.render(doc);
      this.#currentDoc = { ...doc, lines: rendered.lines };
    } else {
      this.#viewMode = "source";
      this.#currentDoc = doc;
    }
  }

  /** Change representation while keeping the same source line at the top. */
  #setViewMode(mode: ViewMode, announce = true): boolean {
    if (mode === this.#viewMode) return false;
    if (mode === "rendered" && !this.#source?.render) return false;
    const anchor = this.#viewportAnchor();
    this.#viewMode = mode;
    this.#setSourceDocument(this.#sourceDoc);
    if (this.#wrapLines) {
      this.#restoreWrappedAnchor({ ...anchor, displayCol: 0 });
    } else {
      this.top = anchor.foldedLine;
      this.left = 0;
      this.#clampScroll();
    }
    if (this.#query.length > 0) {
      this.#matches = findMatches(this.#currentDoc, this.#query);
      this.#currentMatch = clamp(
        this.#currentMatch,
        0,
        Math.max(0, this.#matches.length - 1),
      );
    }
    if (announce) {
      this.#message = `View: ${this.#viewMode}`;
    }
    return true;
  }

  #toggleViewMode(): void {
    if (this.#source?.renderLineTopology === "independent") {
      this.#message = "This rendered view has no line-aligned source view.";
      return;
    }
    const changed = this.#setViewMode(
      this.#viewMode === "source" ? "rendered" : "source",
    );
    if (!changed && this.#viewMode === "source") {
      this.#message = "Rendered view isn't available here.";
    }
  }

  //
  // file folding
  //

  /** The diff's files (with collapsed summaries), or [] for a non-diff view.
   * Cached against the current document. */
  #foldFiles(): DiffFileRange[] {
    if (!this.#source?.isDiff) return []; // only a diff has foldable files
    if (this.#foldFileCache?.doc !== this.#currentDoc) {
      this.#foldFileCache = {
        doc: this.#currentDoc,
        files: diffFiles(this.#currentDoc.text),
      };
    }
    return this.#foldFileCache.files;
  }

  /** Whole-diff totals for the corner label on the first line, summed over the
   * diff's files. Null when the source is not a diff, when the text parses to
   * no diff files, or while the text cursor is active (edit mode reflows the
   * content the label would cover). */
  #activeDiffTotals(): DiffTotals | null {
    if (this.#cursorOn || this.#source?.isDiff !== true) return null;
    const files = this.#foldFiles();
    if (files.length === 0) return null;
    let adds = 0;
    let dels = 0;
    for (const file of files) {
      adds += file.adds;
      dels += file.dels;
    }
    return { adds, dels };
  }

  /** Columns the whole-diff totals label occupies, 0 when hidden. */
  #cornerTotalsWidth(): number {
    const totals = this.#activeDiffTotals();
    return totals ? diffTotalsWidth(totals) : 0;
  }

  /** Whether the document holds any non-printable character, so cycling the
   * display mode would change what is shown. Cached against the document. */
  #hasNonPrintables(): boolean {
    if (this.#nonPrintCache?.doc !== this.#currentDoc) {
      this.#nonPrintCache = {
        doc: this.#currentDoc,
        value: this.#currentDoc.lines.some((l) => hasNonPrintable(l.text)),
      };
    }
    return this.#nonPrintCache.value;
  }

  /** The current collapse plan: the display line list and the maps between
   * document lines and display rows. The identity plan when nothing is hidden. */
  #foldPlan(): FoldPlan {
    if (this.#collapsed.size === 0) return identityFold(this.#currentDoc.lines);
    if (
      this.#foldPlanCache?.doc !== this.#currentDoc ||
      this.#foldPlanCache.version !== this.#foldVersion
    ) {
      this.#foldPlanCache = {
        doc: this.#currentDoc,
        version: this.#foldVersion,
        plan: buildFoldPlan(
          this.#currentDoc.lines,
          this.#foldFiles(),
          this.#collapsed,
        ),
      };
    }
    return this.#foldPlanCache.plan;
  }

  /** The document as rendered: full lines, with each collapsed file replaced by
   * its one-line summary. The renderer and cursor placement use this. */
  displayDoc(): Document {
    if (this.#collapsed.size === 0) return this.#currentDoc;
    return { ...this.#currentDoc, lines: this.#foldPlan().displayLines };
  }

  /** The screen-row layout while wrapping is on. */
  #wrapPlan(): WrapPlan {
    const lines = this.#foldPlan().displayLines;
    const width = this.#contentWidth();
    if (
      this.#wrapPlanCache?.lines !== lines ||
      this.#wrapPlanCache.mode !== this.#displayMode ||
      this.#wrapPlanCache.wrapMode !== this.#activeWrapMode ||
      this.#wrapPlanCache.width !== width ||
      this.#wrapPlanCache.decorations !== this.#wrapDecorationKey
    ) {
      this.#wrapPlanCache = {
        lines,
        mode: this.#displayMode,
        wrapMode: this.#activeWrapMode,
        width,
        decorations: this.#wrapDecorationKey,
        plan: buildWrapPlan(
          lines,
          this.#displayMode,
          width,
          this.#wrapDecorations,
          this.#activeWrapMode,
        ),
      };
    }
    return this.#wrapPlanCache.plan;
  }

  /** Wrapped text layout without transient right-edge annotations. */
  #baseWrapPlan(): WrapPlan {
    const lines = this.#foldPlan().displayLines;
    const width = this.#contentWidth();
    if (
      this.#baseWrapPlanCache?.lines !== lines ||
      this.#baseWrapPlanCache.mode !== this.#displayMode ||
      this.#baseWrapPlanCache.wrapMode !== this.#activeWrapMode ||
      this.#baseWrapPlanCache.width !== width
    ) {
      this.#baseWrapPlanCache = {
        lines,
        mode: this.#displayMode,
        wrapMode: this.#activeWrapMode,
        width,
        plan: buildWrapPlan(
          lines,
          this.#displayMode,
          width,
          new Map(),
          this.#activeWrapMode,
        ),
      };
    }
    return this.#baseWrapPlanCache.plan;
  }

  /** Number of screen rows after file folding and optional line wrapping. */
  #displayCount(): number {
    return this.#wrapLines
      ? this.#wrapPlan().rowCount
      : this.#foldPlan().displayLines.length;
  }

  /** A frame part way through the last reveal: the finished document with only
   * the first `shown` of the revealed lines in it, and a viewport holding the
   * same line still as the finished frame will. `shown` of `count` is the
   * finished frame; 0 is the picture the reveal started from. Null when the last
   * key revealed nothing. */
  revealFrame(shown: number): { doc: Document; view: ViewState } | null {
    const rev = this.pendingReveal;
    if (!rev || this.#wrapLines) return null;
    const waiting = rev.count - clamp(shown, 0, rev.count);
    // The lines still to come are the ones furthest from the hunk, so what is on
    // screen is always a run of the file that meets the hunk's edge rather than
    // a jump across the lines that have not arrived.
    const from = rev.up ? rev.row : rev.row + rev.count - waiting;
    const to = from + waiting;
    // Rows past the ones still to come sit `waiting` lower in the finished
    // document than in this frame; rows before them are in the same place.
    const back = (n: number) => n >= to ? n - waiting : n;
    const drop = <T>(xs: readonly T[]) => [
      ...xs.slice(0, from),
      ...xs.slice(to),
    ];
    const doc = this.displayDoc();
    const view = this.view();
    const sel = view.selected;
    const expandRow = view.expandRow;
    const diffAnnotations = view.diffAnnotations;
    const projectedAnnotations = diffAnnotations?.flatMap(
      (annotation): DiffAnnotation[] => {
        if (annotation.line < from || annotation.line >= to) {
          return [{ ...annotation, line: back(annotation.line) }];
        }
        if (annotation.kind === "diffMetadata") return [];
        return [{
          ...annotation,
          line: rev.up ? from : Math.max(0, from - 1),
        }];
      },
    );
    const projectedTriangle = projectedAnnotations?.find((annotation) =>
      annotation.kind !== "diffMetadata"
    );
    const frameAnnotations = projectedAnnotations?.filter((annotation) =>
      annotation.kind !== "diffMetadata" ||
      (projectedTriangle !== undefined &&
        Math.abs(annotation.line - projectedTriangle.line) === 1)
    );
    return {
      doc: { ...doc, lines: drop(doc.lines) },
      view: {
        ...view,
        top: rev.up ? view.top : Math.max(0, view.top - waiting),
        lineNumbers: view.lineNumbers
          ? drop(view.lineNumbers)
          : view.lineNumbers,
        selected: sel
          ? {
            ...sel,
            startLine: back(sel.startLine),
            endLine: back(sel.endLine),
          }
          : null,
        // A match on a line that has not landed yet has nowhere to be drawn.
        matches: view.matches
          ? view.matches.filter((m) => m.line < from || m.line >= to)
            .map((m) => ({ ...m, line: back(m.line) }))
          : null,
        // A downward reveal's next edge can sit among the lines still to land.
        // Until they arrive, mark the hunk-side row that currently bounds them.
        expandRow: expandRow === null || expandRow === undefined
          ? expandRow
          : expandRow < from
          ? expandRow
          : expandRow >= to
          ? expandRow - waiting
          : rev.up
          ? from
          : Math.max(0, from - 1),
        diffMetadataRows: frameAnnotations
          ?.filter((annotation) => annotation.kind === "diffMetadata")
          .map((annotation) => annotation.line),
        diffAnnotations: frameAnnotations,
      },
    };
  }

  /** A document line to its logical row after collapsed files are replaced. */
  #toFolded(docLine: number): number {
    return this.#foldPlan().docToDisplay(docLine);
  }

  /** A document position to its screen row. A hidden line maps to its file's
   * summary, and a wrapped line maps to the segment containing `displayCol`. */
  #toDisplay(docLine: number, displayCol = 0): number {
    return this.#toDisplayWithPlan(
      docLine,
      displayCol,
      this.#wrapLines ? this.#wrapPlan() : null,
    );
  }

  /** Map a document position through a specific wrapped layout. */
  #toDisplayWithPlan(
    docLine: number,
    displayCol: number,
    plan: WrapPlan | null,
  ): number {
    const fold = this.#foldPlan();
    const folded = fold.docToDisplay(docLine);
    const col = fold.displayLines[folded] === this.#currentDoc.lines[docLine]
      ? displayCol
      : 0;
    return this.#foldedPositionToDisplayWithPlan(folded, col, plan);
  }

  /** A folded logical line and display column to its screen row. */
  #foldedPositionToDisplay(folded: number, displayCol = 0): number {
    return this.#foldedPositionToDisplayWithPlan(
      folded,
      displayCol,
      this.#wrapLines ? this.#wrapPlan() : null,
    );
  }

  /** Map a folded position through a specific wrapped layout. */
  #foldedPositionToDisplayWithPlan(
    folded: number,
    displayCol: number,
    plan: WrapPlan | null,
  ): number {
    if (!plan) return folded;
    return wrappedRowForPosition(plan, folded, displayCol)?.row ??
      plan.firstRow[folded] ?? 0;
  }

  /** The last screen row occupied by a document line. */
  #toDisplayEnd(docLine: number): number {
    return this.#toDisplayEndWithPlan(
      docLine,
      this.#wrapLines ? this.#wrapPlan() : null,
    );
  }

  /** Last screen row for a document line in a specific wrapped layout. */
  #toDisplayEndWithPlan(
    docLine: number,
    plan: WrapPlan | null,
  ): number {
    const folded = this.#toFolded(docLine);
    return plan ? plan.lastRow[folded] ?? 0 : folded;
  }

  /** A screen row to the document line it stands for. */
  #toDoc(displayRow: number): number {
    let folded = displayRow;
    if (this.#wrapLines) {
      const plan = this.#wrapPlan();
      const row = wrappedRowAt(
        plan,
        clamp(displayRow, 0, Math.max(0, plan.rowCount - 1)),
      );
      folded = row?.line ?? 0;
    }
    return this.#foldPlan().displayToDoc(folded);
  }

  /** The selected node with its line range mapped into display rows (a node in a
   * collapsed file collapses onto that file's summary row). */
  #displaySelected(): StructureNode | null {
    const selected = this.#selectedNode();
    if (!selected) return null;
    const node = this.#viewMode === "rendered"
      ? {
        ...selected,
        startCol: this.#renderedLineChangesColumns(selected.startLine)
          ? 0
          : selected.startCol,
        endCol: this.#renderedLineChangesColumns(selected.endLine)
          ? codePointLength(
            this.#currentDoc.lines[selected.endLine]?.text ?? "",
          )
          : selected.endCol,
      }
      : selected;
    if (this.#collapsed.size === 0) return node;
    const fold = this.#foldPlan();
    const startLine = fold.docToDisplay(node.startLine);
    const endLine = fold.docToDisplay(node.endLine);
    const startSynthetic = fold.displayLines[startLine] !==
      this.#currentDoc.lines[node.startLine];
    const endSynthetic = fold.displayLines[endLine] !==
      this.#currentDoc.lines[node.endLine];
    return {
      ...node,
      startLine,
      endLine,
      startCol: startSynthetic ? 0 : node.startCol,
      endCol: endSynthetic
        ? codePointLength(fold.displayLines[endLine]?.text ?? "")
        : node.endCol,
    };
  }

  /** Maps a source match into the folded display. */
  #displayMatch(match: Match, fold: FoldPlan): Match {
    const line = fold.docToDisplay(match.line);
    if (fold.displayLines[line] === this.#currentDoc.lines[match.line]) {
      return { ...match, line };
    }
    return {
      ...match,
      line,
      start: 0,
      end: codePointLength(fold.displayLines[line]?.text ?? ""),
    };
  }

  /** The visible search matches and the focused index among them. */
  #displaySearch(): { matches: Match[]; currentMatch: number } {
    if (this.#collapsed.size === 0) {
      return { matches: this.#matches, currentMatch: this.#currentMatch };
    }
    const fold = this.#foldPlan();
    const matches: Match[] = [];
    let currentMatch = 0;
    for (
      let sourceIndex = 0;
      sourceIndex < this.#matches.length;
      sourceIndex++
    ) {
      const match = this.#displayMatch(this.#matches[sourceIndex], fold);
      const previous = matches.at(-1);
      const duplicate = previous && sameDisplayedMatch(previous, match);
      if (!duplicate) matches.push(match);
      if (sourceIndex === this.#currentMatch) currentMatch = matches.length - 1;
    }
    return { matches, currentMatch };
  }

  /** The file currently in view: the diff file or transformed-output section
   * under the viewport (or the cursor, when editing), else the single file the
   * view is of, else null (a bare pipe). */
  #currentFile(): string | null {
    const line = this.#cursorOn && this.#buffer
      ? this.#buffer.row
      : this.#toDoc(this.top);
    // The innermost file/section node whose range holds the line (diff file
    // nodes and `// transformed:` blocks are both `section` kind).
    let section: StructureNode | null = null;
    for (const n of this.doc.flatStructure) {
      if (n.kind === "section" && line >= n.startLine && line <= n.endLine) {
        section = n;
      }
    }
    if (section) return section.name ?? section.label.replace(/^[▸▾]\s*/, "");
    return this.#source?.label ?? null;
  }

  get #maxLineLen(): number {
    let m = 0;
    for (const l of this.#currentDoc.lines) m = Math.max(m, l.text.length);
    return m;
  }

  /** The folded line and display column at the viewport's top-left content. */
  #viewportAnchor(): ViewportAnchor {
    const fold = this.#foldPlan();
    let foldedLine = clamp(
      this.top,
      0,
      Math.max(0, fold.displayLines.length - 1),
    );
    let displayCol = this.left;
    if (this.#wrapLines) {
      const plan = this.#wrapPlan();
      const row = wrappedRowAt(
        plan,
        clamp(this.top, 0, Math.max(0, plan.rowCount - 1)),
      );
      foldedLine = row?.line ?? 0;
      displayCol = row?.offset ?? 0;
    }
    return {
      docLine: fold.displayToDoc(foldedLine),
      foldedLine,
      displayCol,
    };
  }

  /** Restore an anchor after the width or display layout changes. */
  #restoreWrappedAnchor(anchor: ViewportAnchor): void {
    const plan = this.#wrapPlan();
    const line = clamp(
      anchor.foldedLine,
      0,
      Math.max(0, plan.firstRow.length - 1),
    );
    this.top = wrappedRowForPosition(plan, line, anchor.displayCol)?.row ?? 0;
    this.#clampScroll();
  }

  /** Source column at an anchor under the current non-printable display mode. */
  #anchorSourceCol(anchor: ViewportAnchor): number {
    const line = this.#foldPlan().displayLines[anchor.foldedLine];
    return line
      ? sourceColumnOf(line, this.#displayMode, anchor.displayCol)
      : 0;
  }

  resize(width: number, height: number): void {
    const anchor = this.#wrapLines ? this.#viewportAnchor() : null;
    this.width = width;
    this.height = height;
    if (anchor) this.#restoreWrappedAnchor(anchor);
    else this.#clampScroll();
  }

  view(): ViewState {
    const search = this.#query.length > 0 ? this.#displaySearch() : null;
    const o = this.#overlay;
    const expand = this.#mode === "normal" && !this.#overlay &&
        !this.#cursorOn && this.#chord === null && this.#source?.expandContext
      ? this.#expandOffer()
      : null;
    const offeredExpand = expand && !("blocked" in expand) ? expand : null;
    const diffMargin = this.#hasDiffMargin();
    let diffAnnotations = diffMargin
      ? this.#displayDiffAnnotations(offeredExpand)
      : [];
    diffAnnotations = this.#syncWrapDecorations(diffAnnotations);
    if (!this.#wrapLines) {
      this.left = clamp(this.left, 0, this.#maxLeft(diffAnnotations));
    }
    const expandRow = offeredExpand?.markerLine === null ||
        offeredExpand?.markerLine === undefined
      ? null
      : this.#toDisplay(offeredExpand.markerLine);
    const ov: OverlayState | null = this.#mode === "filePicker"
      ? this.#pickerOverlay()
      : this.#mode === "jumpList"
      ? this.#jumpOverlay()
      : o
      ? {
        title: o.title,
        lines: this.#activeOverlayLines(o),
        scroll: this.#overlayScroll,
        footer: this.#overlayFooter(o),
        selectedLine: o.mode === "info" && o.cardSel >= 0
          ? o.targets[o.cardSel]?.cardLine
          : undefined,
        // Source (the toggled-to source view, or a peek that is itself source)
        // is drawn as a blue editor window; a structured card is a gray dialog.
        sourceView: o.mode === "source" ||
          (o.mode === "info" && !!o.infoIsSource),
      }
      : null;
    return {
      top: this.top,
      left: this.left,
      width: this.width,
      height: this.height,
      color: this.#color,
      isDiff: this.#source?.isDiff === true,
      showLineNumbers: this.#lineNumberMode !== "off",
      wrapMode: this.#wrapMode,
      wrapPlan: this.#wrapLines ? this.#wrapPlan() : null,
      lineNumbers: this.#lineNumberMode === "off"
        ? null
        : this.#gutterNumbers(),
      displayMode: this.#displayMode,
      selected: this.#displaySelected(),
      matches: search?.matches ?? null,
      currentMatch: search?.currentMatch ?? this.#currentMatch,
      message: this.#message,
      inputLine: this.#mode === "search"
        ? `/${this.#input}`
        : this.#mode === "deflookup"
        ? `definition: ${this.#input}`
        : this.#mode === "filePicker"
        ? `find file: ${this.#files?.join(this.#pickerDir, this.#pickerFilter)}`
        : this.#mode === "jumpList" && this.#jumpSearching
        ? `jump to: ${this.#jumpFilter}`
        : null,
      dialog: this.#promptDialog(),
      overlay: ov,
      cursor: this.#cursorOn && this.#buffer
        ? { line: this.#toFolded(this.#buffer.row), col: this.#buffer.col }
        : null,
      editHint: this.#cursorOn ? this.#editHint() : null,
      canExpand: offeredExpand !== null,
      expandMargin: diffMargin,
      diffAnnotations,
      diffTotals: this.#activeDiffTotals(),
      expandRow,
      expandUp: offeredExpand?.up ?? null,
      diffMetadataRows: diffMargin
        ? this.#displayAdjacentDiffMetadataRows(offeredExpand)
        : [],
      canEdit: !this.#cursorOn && !!this.#source?.editable,
      canRender: !!this.#source?.render &&
        this.#source.renderLineTopology !== "independent",
      viewMode: this.#viewMode,
      hasNonPrintables: this.#hasNonPrintables(),
      notice: null,
      currentFile: this.#currentFile(),
    };
  }

  /** The edit-mode key hints for the status line. */
  #editHint(): KeyHint[] {
    const hints: KeyHint[] = [
      { key: "Esc", label: "Done" },
      { key: "^S", label: "Search" },
      { key: "^R", label: "Revert" },
    ];
    if (this.#canResurrectRemovedLine()) {
      hints.splice(1, 0, { key: "R", label: "Resurrect" });
    }
    if (this.#source?.policy) hints.push({ key: "^L", label: "Expand" });
    hints.push({ key: "^X^S", label: "Save" }, { key: "^X^F", label: "Open" });
    return hints;
  }

  /** The modal dialog for whichever confirmation prompt is open, or null when no
   * prompt is up. Rebuilt each frame from the current buffer and source. */
  #promptDialog(): DialogState | null {
    let dialog: DialogState | null = null;
    if (this.#mode === "savePrompt") dialog = this.#saveDialog();
    else if (this.#mode === "amendPrompt") dialog = this.#amendDialog();
    else if (this.#mode === "revertPrompt") dialog = this.#revertDialog();
    if (!dialog) return null;
    // -1 means no button is focused (a prompt with no default, before Tab).
    const focus = this.#dialogFocus < 0
      ? -1
      : clamp(this.#dialogFocus, 0, Math.max(0, dialog.buttons.length - 1));
    return { ...dialog, focus };
  }

  /** Rest the current prompt's Tab focus on its default button, called as each
   * prompt opens. A prompt with no default button (the diff revert) starts with
   * no focus — an index of -1 — so Space and Enter do nothing until Tab picks a
   * button, keeping a stray Enter from reverting. */
  #focusDefaultButton(): void {
    const buttons = this.#promptDialog()?.buttons ?? [];
    this.#dialogFocus = buttons.findIndex((b) => b.kind === "default");
  }

  /** The save-changes confirmation: names what a save writes, lists the files
   * when there is more than one, and offers save / discard / cancel. */
  #saveDialog(): DialogState {
    const files = this.#editedFiles;
    const n = files.length;
    const amend = this.#source && this.#buffer
      ? this.#source.pendingAmend?.(
        this.#buffer.baseline(),
        this.#buffer.text(),
      )
      : null;
    const what = n === 0
      ? (amend ? "the commit message" : "your edits")
      : n === 1
      ? files[0]
      : `${n} files`;
    const body = [`Save changes to ${what}?`];
    if (n > 1) {
      const max = 6;
      body.push("");
      for (const f of files.slice(0, max)) body.push(`  ${f}`);
      if (n > max) body.push(`  … and ${n - max} more`);
    }
    return {
      title: "Save Changes",
      body,
      buttons: [
        { label: "Save", hotkey: "s", kind: "default" },
        { label: "Discard", hotkey: "d" },
        { label: "Cancel", hotkey: "c", kind: "cancel" },
      ],
    };
  }

  /** The amend-commit confirmation, naming the commit and its subject. */
  #amendDialog(): DialogState {
    const amend = this.#source && this.#buffer
      ? this.#source.pendingAmend?.(
        this.#buffer.baseline(),
        this.#buffer.text(),
      )
      : null;
    const sha = amend?.sha.slice(0, 9) ?? "";
    const full = amend?.subject ?? "";
    const subject = full.length > 46 ? `${full.slice(0, 45)}…` : full;
    return {
      title: "Amend Commit",
      body: [`Amend commit ${sha}, or save files only?`, `“${subject}”`],
      buttons: [
        { label: "Amend commit", hotkey: "a", kind: "default" },
        { label: "Save files only", hotkey: "s" },
        { label: "Cancel", hotkey: "c", kind: "cancel" },
      ],
    };
  }

  /** The revert confirmation. A diff offers only the scopes that apply where the
   * cursor sits — the hunk and/or file it is in, or the commit message — plus
   * all; a plain file reverts wholesale. */
  #revertDialog(): DialogState {
    if (!this.#source?.policy) {
      return {
        title: "Revert",
        body: ["Revert all edits?"],
        buttons: [
          { label: "Yes", hotkey: "y", kind: "default" },
          { label: "Cancel", hotkey: "c", kind: "cancel" },
        ],
      };
    }
    const s = this.#revertScopesAt();
    const buttons: DialogButton[] = [];
    if (s.chunk) buttons.push({ label: "Hunk", hotkey: "h" });
    if (s.file) buttons.push({ label: "File", hotkey: "f" });
    if (s.message) buttons.push({ label: "Message", hotkey: "m" });
    buttons.push({ label: "All", hotkey: "a" });
    buttons.push({ label: "Cancel", hotkey: "c", kind: "cancel" });
    return { title: "Revert", body: ["Revert which changes?"], buttons };
  }

  handleKey(key: Key, beforeButtonAction?: () => void): void {
    // A reveal is animated by the driver over the frames after the key that
    // caused it, so the next key ends it whatever it was. A message that takes
    // itself away goes now rather than waiting out its moment, before this key
    // has the chance to set one of its own.
    this.pendingReveal = null;
    this.pendingPush = null;
    this.expireMessage();
    if (key.name === "wheel-up" || key.name === "wheel-down") {
      this.#chord = null;
      this.#handleWheel(key.name === "wheel-up" ? -1 : 1);
      return;
    }
    if (this.#handleDialogNavigation(key)) return;
    if (
      this.#mode === "savePrompt" || this.#mode === "amendPrompt" ||
      this.#mode === "revertPrompt"
    ) {
      this.#handleDialogKey(key, beforeButtonAction);
      return;
    }
    if (this.#mode === "filePicker") {
      this.#handleFilePicker(key);
      return;
    }
    if (this.#mode === "jumpList") {
      this.#handleJumpList(key);
      return;
    }
    if (this.#mode === "search" || this.#mode === "deflookup") {
      this.#handleInputKey(key);
      return;
    }
    if (this.#chord === "ctrl-x") {
      this.#handleChord(key);
      return;
    }
    if (this.#overlay) {
      this.#handleOverlayKey(key);
      return;
    }
    this.#handleNormalKey(key);
  }

  //
  // internals
  //

  #contentRows(): number {
    return Math.max(1, this.height - 1);
  }

  /** Applies the shared navigation keys to the active dialog's content or focus. */
  #handleDialogNavigation(key: Key): boolean {
    const picker = this.#mode === "filePicker";
    const jump = this.#mode === "jumpList";
    const prompt = this.#mode === "savePrompt" ||
      this.#mode === "amendPrompt" ||
      this.#mode === "revertPrompt";
    const overlay = this.#mode === "normal" && !this.#chord
      ? this.#overlay
      : null;
    if (!picker && !jump && !prompt && !overlay) return false;
    if (
      (picker || (jump && this.#jumpSearching)) && !key.ctrl &&
      (key.name.length === 1 || key.name === "space" ||
        (key.char !== undefined && key.char >= " "))
    ) return false;

    const rows = overlayBox(this.width, this.height).innerH;
    const page = Math.max(1, rows - 1);
    let delta = 0;
    let byLine = false;
    let edge: "first" | "last" | null = null;
    switch (key.name) {
      case "down":
      case "ctrl-n":
      case "j":
      case "J":
        delta = 1;
        byLine = true;
        break;
      case "up":
      case "ctrl-p":
      case "k":
      case "K":
        delta = -1;
        byLine = true;
        break;
      case "left":
      case "right":
        if (!prompt) return false;
        delta = key.name === "left" ? -1 : 1;
        break;
      case "space":
        if (prompt) return false;
        delta = page;
        break;
      case "pagedown":
      case "ctrl-f":
        delta = page;
        break;
      case "pageup":
      case "ctrl-b":
      case "b":
      case "B":
        delta = -page;
        break;
      case "ctrl-d":
      case "ctrl-u":
        delta = Math.max(1, Math.floor(rows / 2)) *
          (key.name === "ctrl-d" ? 1 : -1);
        break;
      case "g":
      case "home":
        edge = "first";
        break;
      case "G":
      case "end":
        edge = "last";
        break;
      default:
        return false;
    }
    const move = (position: number, last: number): number =>
      clamp(
        edge === "first" ? 0 : edge === "last" ? last : position + delta,
        0,
        Math.max(0, last),
      );
    this.#message = "";
    if (picker) {
      this.#pickerSel = move(this.#pickerSel, this.#pickerEntries.length - 1);
      this.#scrollListToSelection(this.#pickerSel);
    } else if (jump) {
      this.#jumpSel = move(this.#jumpSel, this.#jumpEntries.length - 1);
      this.#scrollJumpToSelection(this.#jumpSel);
    } else if (prompt) {
      this.#dialogFocus = move(
        this.#dialogFocus,
        this.#promptDialog()!.buttons.length - 1,
      );
    } else if (overlay) {
      if (
        byLine && overlay.mode === "info" &&
        overlay.targets.length > 0
      ) {
        this.#moveCardSelection(delta);
      } else {
        this.#overlayScroll = move(
          this.#overlayScroll,
          this.#overlayMaxScroll(overlay),
        );
        if (edge) overlay.cardSel = -1;
      }
    }
    return true;
  }

  /** Scrolls the active document or list without moving the edit cursor. */
  #handleWheel(direction: -1 | 1): void {
    this.#message = "";
    const delta = direction * MOUSE_WHEEL_STEP;
    if (
      this.#mode === "savePrompt" || this.#mode === "amendPrompt" ||
      this.#mode === "revertPrompt"
    ) return;
    if (this.#mode === "filePicker") {
      const last = Math.max(0, this.#pickerEntries.length - 1);
      this.#pickerSel = clamp(this.#pickerSel + delta, 0, last);
      this.#scrollListToSelection(this.#pickerSel);
      return;
    }
    if (this.#mode === "jumpList") {
      const last = Math.max(0, this.#jumpEntries.length - 1);
      this.#jumpSel = clamp(this.#jumpSel + delta, 0, last);
      this.#scrollJumpToSelection(this.#jumpSel);
      return;
    }
    if (this.#overlay) {
      this.#overlayScroll = clamp(
        this.#overlayScroll + delta,
        0,
        this.#overlayMaxScroll(this.#overlay),
      );
      return;
    }
    this.top = clamp(this.top + delta, 0, this.#lastTop());
  }

  #clampScroll(): void {
    this.top = clamp(this.top, 0, this.#lastTop());
    this.left = this.#wrapLines ? 0 : clamp(this.left, 0, this.#maxLeft());
  }

  /** Furthest vertical position for the current pager or editor mode. */
  #lastTop(): number {
    return this.#cursorOn
      ? maxTop(this.doc.lines.length, this.height)
      : this.#pagerLastTop(this.#displayCount());
  }

  /** Furthest pager position, allowing every commit header to reach the top. */
  #pagerLastTop(
    rowCount: number,
    plan: WrapPlan | null = this.#wrapLines ? this.#wrapPlan() : null,
  ): number {
    if (!this.#source?.isDiff) return maxTop(rowCount, this.height);
    const hasTrailingEmptyLine =
      this.#foldPlan().displayLines.at(-1)?.text.length === 0;
    const lastCommit = this.#commitHeaders().at(-1);
    return Math.max(
      maxPagerTop(
        diffContentRowCount(rowCount, hasTrailingEmptyLine),
        this.height,
      ),
      lastCommit ? this.#toDisplayWithPlan(lastCommit.line, 0, plan) : 0,
    );
  }

  #selectedNode(): StructureNode | null {
    return this.#selectedIndex !== null
      ? this.doc.flatStructure[this.#selectedIndex] ?? null
      : null;
  }

  #renderedLineChangesColumns(line: number): boolean {
    return this.#viewMode === "rendered" &&
      this.#sourceDoc.lines[line]?.text !== this.#currentDoc.lines[line]?.text;
  }

  /** Screen row containing the first character of a structure node. */
  #nodeStartRow(node: StructureNode): number {
    return this.#nodeStartRowWithPlan(
      node,
      this.#wrapLines ? this.#wrapPlan() : null,
    );
  }

  /** First row of a structure node in a specific wrapped layout. */
  #nodeStartRowWithPlan(
    node: StructureNode,
    plan: WrapPlan | null,
  ): number {
    const col = this.#renderedLineChangesColumns(node.startLine)
      ? 0
      : node.startCol;
    return this.#toDisplayWithPlan(
      node.startLine,
      this.#displayCol(node.startLine, col),
      plan,
    );
  }

  /** Screen row containing the last character of a structure node. */
  #nodeEndRow(node: StructureNode): number {
    return this.#nodeEndRowWithPlan(
      node,
      this.#wrapLines ? this.#wrapPlan() : null,
    );
  }

  /** Last row of a structure node in a specific wrapped layout. */
  #nodeEndRowWithPlan(
    node: StructureNode,
    plan: WrapPlan | null,
  ): number {
    const fold = this.#foldPlan();
    const folded = fold.docToDisplay(node.endLine);
    if (fold.displayLines[folded] !== this.#currentDoc.lines[node.endLine]) {
      return plan ? plan.lastRow[folded] ?? 0 : folded;
    }
    const endCol = this.#renderedLineChangesColumns(node.endLine)
      ? codePointLength(this.#currentDoc.lines[node.endLine]?.text ?? "")
      : node.endCol;
    return this.#toDisplayWithPlan(
      node.endLine,
      this.#displayCol(node.endLine, Math.max(0, endCol - 1)),
      plan,
    );
  }

  #selectNode(idx: number): void {
    if (idx < 0 || idx >= this.doc.flatStructure.length) return;
    const viewport = this.#wrapLines ? this.#viewportAnchor() : null;
    this.#selectedIndex = idx;
    const node = this.doc.flatStructure[idx];
    if (viewport) this.#restoreWrappedAnchor(viewport);
    // Keep the viewport stable: only scroll if the selection's anchor (its first
    // line, where the block opens) would otherwise be off screen. Horizontal
    // scroll is left untouched for the same reason. Anchors are in display rows,
    // since a collapsed file's lines share its summary row.
    this.top = clamp(
      scrollToAnchor(
        this.#nodeStartRow(node),
        this.top,
        this.height,
        this.#displayCount(),
      ),
      0,
      this.#lastTop(),
    );
    this.#message = "";
  }

  /** Remember the current overlay so a later Esc returns to it, before a link
   * opens a new one over the top. */
  #pushOverlay(): void {
    if (this.#overlay) {
      this.#overlayStack.push({
        overlay: this.#overlay,
        scroll: this.#overlayScroll,
      });
    }
  }

  /** Close the overlay and discard the whole navigation stack. */
  #closeOverlay(): void {
    this.#overlay = null;
    this.#overlayScroll = 0;
    this.#overlayStack = [];
  }

  #openPeek(node: StructureNode, expanded = false): void {
    const card = buildPeekCard(
      this.#sourceDoc,
      node,
      this.#semantics,
      expanded,
    );
    this.#overlay = {
      title: card.title,
      info: card.info,
      source: card.source,
      mode: "info",
      targets: card.targets,
      cardSel: -1,
      node,
    };
    this.#overlayScroll = 0;
  }

  /** Rebuild the open card with every truncated list shown in full, keeping the
   * scroll position so the newly revealed entries appear where "… N more" was. */
  #expandCard(node: StructureNode): void {
    const scroll = this.#overlayScroll;
    const card = buildPeekCard(this.#sourceDoc, node, this.#semantics, true);
    this.#overlay = {
      ...this.#overlay!,
      info: card.info,
      source: card.source,
      targets: card.targets,
      cardSel: -1,
    };
    this.#overlayScroll = scroll;
  }

  #lookupDefinition(name: string): void {
    const defs = this.doc.definitions.get(name);
    if (!defs || defs.length === 0) {
      this.#message = `No definition found for "${name}"`;
      return;
    }
    const def = defs[defs.length - 1];
    // Prefer the structure node for this declaration so the card is available.
    const node = this.doc.flatStructure.find((n) =>
      n.startOffset === def.startOffset && n.endOffset === def.endOffset
    );
    if (node) {
      const card = buildPeekCard(this.#sourceDoc, node, this.#semantics);
      this.#overlay = {
        title: `definition: ${card.title}`,
        info: card.info,
        source: card.source,
        mode: "info",
        targets: card.targets,
        cardSel: -1,
        node,
      };
    } else {
      this.#overlay = {
        title: `definition: ${name}  (${def.kind})`,
        info: this.#sourceDoc.lines.slice(def.startLine, def.endLine + 1),
        mode: "info",
        targets: [],
        cardSel: -1,
        staticFooter: "↑/↓ scroll · esc close",
        infoIsSource: true,
      };
    }
    this.#overlayScroll = 0;
  }

  #activeOverlayLines(overlay: PeekOverlay): readonly Line[] {
    return overlay.mode === "source" && overlay.source
      ? overlay.source
      : overlay.info;
  }

  #overlayFooter(overlay: PeekOverlay): string {
    if (overlay.staticFooter) return overlay.staticFooter;
    const parts: string[] = [];
    if (overlay.mode === "info" && overlay.targets.length > 0) {
      parts.push("↑/↓ select", "enter open");
    } else {
      parts.push("↑/↓ scroll");
    }
    if (overlay.node) parts.push("z reveal");
    if (overlay.source) {
      parts.push(overlay.mode === "info" ? "tab source" : "tab card");
    }
    // Esc walks back through followed links; only closes at the bottom.
    if (this.#overlayStack.length > 0) parts.push("esc back", "q close");
    else parts.push("esc close");
    return parts.join(" · ");
  }

  /** Move the card's reference selection and keep it visible. */
  #moveCardSelection(delta: number): void {
    const o = this.#overlay;
    if (!o || o.mode !== "info" || o.targets.length === 0) return;
    if (delta > 0) {
      o.cardSel = Math.min(o.cardSel + 1, o.targets.length - 1);
    } else {
      if (o.cardSel <= 0) {
        o.cardSel = -1;
        this.#overlayScroll = 0;
        return;
      }
      o.cardSel -= 1;
    }
    const line = o.targets[o.cardSel].cardLine;
    this.#scrollListToSelection(line);
  }

  /** Open an external definition file in a read-only overlay, framed at the
   * definition line. */
  #openExternalFile(target: CardTarget): void {
    const lines = this.#semantics?.fileLines(target.filePath!);
    if (!lines) {
      this.#message = `Cannot open ${target.filePath}`;
      return;
    }
    // Lead the title with the filename and line: the overlay centers and
    // left-truncates titles, so a raw absolute path would keep only its shared
    // workspace prefix and drop the identifying part.
    const name = target.filePath!.split(/[\\/]/).pop() ?? target.filePath!;
    this.#overlay = {
      title: `${name}  ·  line ${target.destLine + 1}, column ${
        target.destCol + 1
      }`,
      info: lines,
      mode: "info",
      targets: [],
      cardSel: -1,
      infoIsSource: true,
    };
    this.#overlayScroll = clamp(
      target.destLine - 2,
      0,
      Math.max(0, lines.length - 1),
    );
  }

  /** Index of the node a definition target denotes. Nested nodes can share a
   * start offset (diff views clamp them), so a matching end offset wins. */
  #findTargetIndex(target: CardTarget): number {
    if (target.defOffset === undefined) return -1;
    if (target.defEndOffset !== undefined) {
      const exact = this.doc.flatStructure.findIndex((n) =>
        n.startOffset === target.defOffset &&
        n.endOffset === target.defEndOffset
      );
      if (exact >= 0) return exact;
    }
    return this.doc.flatStructure.findIndex((n) =>
      n.startOffset === target.defOffset
    );
  }

  /** Jump the main view to a card target, selecting the relevant node. This
   * leaves the overlay for the main view, so the whole navigation stack goes. */
  #jumpToTarget(target: CardTarget): void {
    this.#overlay = null;
    this.#overlayScroll = 0;
    this.#overlayStack = [];
    let idx = this.#findTargetIndex(target);
    if (idx < 0) idx = nodeAtLine(this.doc.flatStructure, target.destLine);
    this.#selectedIndex = idx >= 0 ? idx : null;
    const node = idx >= 0 ? this.doc.flatStructure[idx] : null;
    const sourceCol = this.#renderedLineChangesColumns(target.destLine)
      ? 0
      : target.destCol;
    const destCol = this.#displayCol(target.destLine, sourceCol);
    const destRow = this.#toDisplay(target.destLine, destCol);
    // Frame the resolved node and destination together when they fit. Otherwise
    // center the destination row so the referenced text is visible.
    let start = destRow;
    let end = destRow;
    if (node) {
      start = Math.min(this.#nodeStartRow(node), destRow);
      end = Math.max(this.#nodeEndRow(node), destRow);
      if (end - start + 1 > this.#contentRows()) {
        start = destRow;
        end = destRow;
      }
    }
    this.top = clamp(
      frameTop(
        start,
        end,
        this.height,
        this.#displayCount(),
      ),
      0,
      this.#lastTop(),
    );
    this.#revealColumn(target.destLine, destCol);
    this.#message = `→ line ${target.destLine + 1}`;
  }

  /** The structure node a card target points at, if any. */
  #resolveTargetNode(target: CardTarget): StructureNode | null {
    const idx = this.#findTargetIndex(target);
    if (idx >= 0) return this.doc.flatStructure[idx];
    const at = nodeAtLine(this.doc.flatStructure, target.destLine);
    return at >= 0 ? this.doc.flatStructure[at] : null;
  }

  /** What `z` reveals: the selected reference, else the card's own subject. */
  #overlayRevealTarget(overlay: PeekOverlay): CardTarget | null {
    if (overlay.cardSel >= 0) return overlay.targets[overlay.cardSel] ?? null;
    const node = overlay.node;
    if (!node) return null;
    return {
      cardLine: 0,
      destLine: node.startLine,
      destCol: node.startCol,
      defOffset: node.startOffset,
      defEndOffset: node.endOffset,
    };
  }

  #runSearch(jumpForward: boolean): void {
    this.#matches = findMatches(this.doc, this.#query);
    if (this.#matches.length === 0) {
      this.#currentMatch = 0;
      this.#message = this.#query ? `Pattern not found: ${this.#query}` : "";
      return;
    }
    // The viewport anchor is a display row; match lines are document lines.
    const anchor = this.#toDoc(this.top) - 1;
    const idx = nextMatchIndex(this.#matches, anchor, -1, jumpForward);
    this.#currentMatch = idx < 0 ? 0 : idx;
    this.#revealMatch();
  }

  /** Begin a search from edit mode (Ctrl-S): anchor it at the cursor so the
   * focused match is the next one at or after the cursor, and seed the input
   * with the last query so a bare Ctrl-S then Enter repeats it. */
  #enterEditSearch(): void {
    this.#searchAnchor = this.#buffer
      ? { row: this.#buffer.row, col: this.#buffer.col }
      : null;
    this.#mode = "search";
    this.#input = this.#query;
    this.#refreshSearchMatches();
  }

  /** Recompute the full match set for the current query and focus one: for an
   * edit-mode search, the first editable match at or after the anchor (so the
   * cursor lands somewhere it can type); for a normal search, the first in the
   * document. `this.matches` stays the full set, so leaving the search does not
   * leave normal-mode n/N stepping a filtered subset. */
  #refreshSearchMatches(): void {
    this.#matches = findMatches(this.doc, this.#query);
    if (this.#matches.length === 0) {
      this.#currentMatch = 0;
      return;
    }
    const a = this.#searchAnchor;
    this.#currentMatch = a
      ? this.#firstEditableMatch(
        nextMatchIndex(this.#matches, a.row, a.col - 1, true),
      )
      : 0;
    this.#revealMatch();
  }

  /** The first editable match at or after index `from` (wrapping), for an
   * edit-mode search; `from` itself when none is editable. */
  #firstEditableMatch(from: number): number {
    const start = from < 0 ? 0 : from;
    for (let n = 0; n < this.#matches.length; n++) {
      const i = (start + n) % this.#matches.length;
      if (this.#isEditableLine(this.#matches[i].line)) return i;
    }
    return start;
  }

  /** Whether the cursor may edit `line` under the source's policy (a diff). A
   * file (no policy) is editable everywhere. */
  #isEditableLine(line: number): boolean {
    const pol = this.#source?.policy;
    if (!pol) return true;
    const lines = this.#buffer?.lines ?? this.doc.lines.map((l) => l.text);
    return pol.editStart(lines, line) !== null;
  }

  /** Land the edit cursor on the focused match (edit-mode search commit). */
  #placeCursorAtMatch(): void {
    const m = this.#matches[this.#currentMatch];
    if (!m || !this.#cursorOn || !this.#buffer) return;
    this.#buffer.place(m.line, m.start);
    this.#ensureCursorVisible();
  }

  #stepMatch(forward: boolean): void {
    if (this.#matches.length === 0) {
      this.#message = "No matches";
      return;
    }
    const cur = this.#matches[this.#currentMatch];
    let idx = nextMatchIndex(this.#matches, cur.line, cur.start, forward);
    if (!this.#searchAnchor && this.#collapsed.size > 0) {
      const fold = this.#foldPlan();
      const displayed = this.#displayMatch(cur, fold);
      while (
        idx !== this.#currentMatch &&
        sameDisplayedMatch(
          displayed,
          this.#displayMatch(this.#matches[idx], fold),
        )
      ) {
        const candidate = this.#matches[idx];
        idx = nextMatchIndex(
          this.#matches,
          candidate.line,
          candidate.start,
          forward,
        );
      }
    }
    // An edit-mode search (Ctrl-S) steps only between editable matches.
    if (this.#searchAnchor) idx = this.#firstEditableMatch(idx);
    this.#currentMatch = idx;
    this.#revealMatch();
  }

  #revealMatch(): void {
    const m = this.#matches[this.#currentMatch];
    if (!m) return;
    const col = this.#displayCol(m.line, m.start);
    const row = this.#toDisplay(m.line, col);
    if (row < this.top || row >= this.top + this.#contentRows()) {
      this.top = clamp(
        row - Math.floor(this.#contentRows() / 2),
        0,
        this.#lastTop(),
      );
    }
    this.#revealColumn(m.line, col);
    this.#message = "";
  }

  /** The display column a source column maps to on `line` under the current
   * mode — what horizontal scrolling counts in, since a compacting mode draws
   * fewer columns than the line has source code points. */
  #displayCol(line: number, sourceCol: number): number {
    const l = this.doc.lines[line];
    if (!l || this.#displayMode === "pictures") return sourceCol;
    if (
      this.#displayColumnCache?.doc !== this.#currentDoc ||
      this.#displayColumnCache.mode !== this.#displayMode
    ) {
      this.#displayColumnCache = {
        doc: this.#currentDoc,
        mode: this.#displayMode,
        columns: new Map(),
      };
    }
    let columns = this.#displayColumnCache.columns.get(line);
    if (!columns) {
      columns = Uint32Array.from(
        displayLine(l, this.#displayMode),
        (cell) => cell.col,
      );
      this.#displayColumnCache.columns.set(line, columns);
    }
    let lo = 0;
    let hi = columns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (columns[mid] < sourceCol) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #handleInputKey(key: Key): void {
    if (key.name === "escape") {
      this.#mode = "normal";
      this.#input = "";
      this.#searchAnchor = null;
      if (this.#query.length === 0) this.#matches = [];
      // An edit-mode search scrolled to matches while the cursor stayed put;
      // bring the viewport back so the text cursor is on screen.
      if (this.#cursorOn) this.#ensureCursorVisible();
      return;
    }
    // Ctrl-S inside a search steps to the next match (Emacs-style repeat).
    if (key.name === "ctrl-s") {
      if (this.#mode === "search") this.#stepMatch(true);
      return;
    }
    if (key.name === "enter") {
      if (this.#mode === "search") {
        this.#query = this.#input;
        // An edit-mode search lands the cursor on the focused match; a
        // normal-mode search jumps the viewport to it.
        if (this.#searchAnchor || this.#cursorOn) this.#placeCursorAtMatch();
        else this.#runSearch(true);
      } else {
        this.#lookupDefinition(this.#input.trim());
      }
      this.#mode = "normal";
      this.#input = "";
      this.#searchAnchor = null;
      return;
    }
    if (key.name === "backspace") {
      this.#input = this.#input.slice(0, -1);
      if (this.#mode === "search") {
        this.#query = this.#input;
        this.#refreshSearchMatches();
      }
      return;
    }
    if (key.char && key.char >= " ") {
      this.#input += key.char;
      if (this.#mode === "search") {
        this.#query = this.#input;
        this.#refreshSearchMatches();
      }
    }
  }

  #handleOverlayKey(key: Key): void {
    const overlay = this.#overlay;
    if (!overlay) return;
    const hasTargets = overlay.mode === "info" && overlay.targets.length > 0;
    switch (key.name) {
      case "escape":
        // Walk back through the stack of followed links; the last Esc, with an
        // empty stack, closes the overlay.
        if (this.#overlayStack.length > 0) {
          const prev = this.#overlayStack.pop()!;
          this.#overlay = prev.overlay;
          this.#overlayScroll = prev.scroll;
        } else {
          this.#overlay = null;
          this.#overlayScroll = 0;
        }
        break;
      case "q":
        this.#closeOverlay();
        break;
      case "Q":
        this.#requestQuit();
        break;
      case "t":
        this.#mode = "deflookup";
        this.#input = overlay.node?.name ?? this.#selectedNode()?.name ?? "";
        break;
      case "enter":
        // Follow the selected reference, pushing this card so Esc returns to it:
        // open the referenced node's card, or — when the definition lives in
        // another file — open that file over the top.
        if (hasTargets && overlay.cardSel >= 0) {
          const target = overlay.targets[overlay.cardSel];
          if (target.expand) {
            this.#expandCard(overlay.node!);
          } else if (target.filePath) {
            this.#pushOverlay();
            this.#openExternalFile(target);
          } else {
            const node = this.#resolveTargetNode(target);
            if (node) {
              this.#pushOverlay();
              this.#openPeek(node);
            } else this.#message = "Nothing to open for this reference";
          }
        } else {
          this.#closeOverlay();
        }
        break;
      case "z":
      case "Z": {
        // Reveal the target: an external file opens in place; an in-blob target
        // closes the card and centers the main view on it. A "… N more" line has
        // no destination to reveal.
        const reveal = this.#overlayRevealTarget(overlay);
        if (reveal?.expand) break;
        if (reveal?.filePath) {
          // Opening the file over the card: Esc returns to the card.
          this.#pushOverlay();
          this.#openExternalFile(reveal);
        } else if (reveal) {
          this.#jumpToTarget(reveal); // exits the card viewer entirely
        }
        break;
      }
      case "tab":
        if (overlay.source) {
          overlay.mode = overlay.mode === "info" ? "source" : "info";
          overlay.cardSel = -1;
          this.#overlayScroll = 0;
        }
        break;
    }
  }

  /** Furthest scroll position which keeps the overlay's last line in its box. */
  #overlayMaxScroll(overlay: PeekOverlay): number {
    const innerH = overlayBox(this.width, this.height).innerH;
    return Math.max(0, this.#activeOverlayLines(overlay).length - innerH);
  }

  #handleNormalKey(key: Key): void {
    this.#message = "";

    // Editor chords / save, available in both cursor and pager modes.
    if (key.name === "ctrl-x" && this.#source) {
      this.#chord = "ctrl-x";
      return;
    }
    if (key.name === "f3") {
      this.#requestSave();
      return;
    }
    // Alt+arrows scroll/pan — "do what the cursor keys used to do".
    if (key.alt && isArrowName(key.name)) {
      this.#scrollOrPan(key.name);
      return;
    }
    if (this.#cursorOn) {
      this.#handleEditKey(key);
      return;
    }
    // Cursor off: a bare arrow scrolls or pans the view, like the vi keys.
    if (!key.alt && isArrowName(key.name)) {
      this.#scrollOrPan(key.name);
      return;
    }

    const rows = this.#contentRows();
    const lastTop = this.#lastTop();
    switch (key.name) {
      case "q":
      case "Q":
      case "ctrl-c":
        this.#requestQuit();
        return;
      case "?":
        this.#overlay = helpOverlay(this.#commitHeaders().length > 1);
        this.#overlayScroll = 0;
        return;
      case "/":
        this.#mode = "search";
        this.#input = "";
        this.#searchAnchor = null;
        return;
      case "v":
      case "V":
        this.#toggleViewMode();
        return;
      case "e":
        // Enter edit mode: reveal the text cursor at the top of the view.
        this.#revealCursor();
        return;
      case "t":
        this.#mode = "deflookup";
        this.#input = this.#selectedNode()?.name ?? "";
        return;
      case "n":
        this.#stepMatch(true);
        return;
      case "N":
        this.#stepMatch(false);
        return;
      case "j":
      case "J":
        this.top = clamp(this.top + 1, 0, lastTop);
        return;
      case "k":
      case "K":
        this.top = clamp(this.top - 1, 0, lastTop);
        return;
      case "h":
      case "H":
        this.left = this.#wrapLines
          ? 0
          : clamp(this.left - this.#horizontalStep(), 0, this.#maxLeft());
        return;
      case "l":
      case "L":
        this.left = this.#wrapLines
          ? 0
          : clamp(this.left + this.#horizontalStep(), 0, this.#maxLeft());
        return;
      case "space":
      case "pagedown":
      case "ctrl-f":
        this.top = clamp(this.top + rows - 1, 0, lastTop);
        return;
      case "b":
      case "B":
      case "pageup":
      case "ctrl-b":
        this.top = clamp(this.top - rows + 1, 0, lastTop);
        return;
      case "ctrl-d":
        this.top = clamp(this.top + (rows >> 1), 0, lastTop);
        return;
      case "ctrl-u":
        this.top = clamp(this.top - (rows >> 1), 0, lastTop);
        return;
      case "g":
      case "home":
        this.top = 0;
        this.left = 0;
        return;
      case "G":
      case "end":
        this.top = lastTop;
        return;
      case "<":
        this.#stepCommit(false);
        return;
      case ">":
        this.#stepCommit(true);
        return;
      case "ctrl-l":
        this.#performExpand();
        return;
      case "w":
      case "W":
        this.#navigateTree(treePrevSibling);
        return;
      case "s":
      case "S":
        this.#navigateTree(treeNextSibling);
        return;
      case "a":
      case "A":
        this.#navigateTree(treeParent);
        return;
      case "d":
      case "D":
        this.#navigateTree(treeChild);
        return;
      case "tab":
        this.#navigateTree(treePreOrderNext);
        return;
      case "shift-tab":
        this.#navigateTree(treePreOrderPrev);
        return;
      case "enter": {
        const node = this.#selectedNode();
        if (node) this.#openPeek(node);
        else {
          this.#message =
            "Select a node first (wasd / tab), then Enter for its info card";
        }
        return;
      }
      case "z":
      case "Z": {
        const node = this.#selectedNode();
        if (node) {
          this.top = clamp(
            frameTop(
              this.#nodeStartRow(node),
              this.#nodeEndRow(node),
              this.height,
              this.#displayCount(),
            ),
            0,
            this.#lastTop(),
          );
        }
        return;
      }
      case "\\":
        this.#cycleLineWrapping();
        return;
      case "#":
        this.#cycleLineNumbers();
        return;
      case "c":
      case "C":
        this.#cycleDisplayMode();
        return;
      case "f":
        this.#toggleCurrentFile();
        return;
      case "i":
        this.#openJumpList();
        return;
      case "F":
        this.#collapseAllFiles();
        return;
      case "E":
        this.#expandAllFiles();
        return;
      case "T":
        this.#toggleFileCategory((file) => file.isTest, "test");
        return;
      case "M":
        this.#toggleFileCategory((file) => file.isMarkdown, "Markdown");
        return;
      case "escape": {
        const anchor = this.#wrapLines ? this.#viewportAnchor() : null;
        this.#selectedIndex = null;
        this.#query = "";
        this.#matches = [];
        this.#message = "";
        if (anchor) this.#restoreWrappedAnchor(anchor);
        else this.#clampScroll();
        return;
      }
    }
  }

  /** Step to the next non-printable display mode and report it. */
  #cycleDisplayMode(): void {
    const anchor = this.#viewportAnchor();
    const sourceCol = this.#anchorSourceCol(anchor);
    const i = DISPLAY_MODES.indexOf(this.#displayMode);
    this.#displayMode = DISPLAY_MODES[(i + 1) % DISPLAY_MODES.length];
    const line = this.#foldPlan().displayLines[anchor.foldedLine];
    const displayCol = line
      ? displayColumnOf(line, this.#displayMode, sourceCol)
      : 0;
    if (this.#wrapLines) {
      this.#restoreWrappedAnchor({ ...anchor, displayCol });
    } else {
      this.left = displayCol;
      this.#clampScroll();
    }
    this.#message = `Non-printables: ${displayModeLabel(this.#displayMode)}`;
  }

  /** Step through wrapping modes while keeping the top-left content in view. */
  #cycleLineWrapping(): void {
    const anchor = this.#viewportAnchor();
    this.#wrapMode = this.#wrapMode === "off"
      ? "hard"
      : this.#wrapMode === "hard"
      ? "word"
      : "off";
    this.#expansionLayoutCache = undefined;
    if (this.#wrapLines) {
      this.left = 0;
      this.#restoreWrappedAnchor(anchor);
    } else {
      this.top = anchor.foldedLine;
      this.left = anchor.displayCol;
      this.#clampScroll();
    }
    this.#message = `Line wrapping: ${this.#wrapMode}`;
  }

  //
  // file-fold commands
  //

  #ensureDiffForFolding(): boolean {
    if (this.#foldFiles().length === 0) {
      this.#message = "Hiding files is only available in a diff view.";
      return false;
    }
    return true;
  }

  /** The document position the fold commands keep at the top of the viewport. */
  #foldAnchor(): FoldAnchor {
    const node = this.#selectedNode();
    const anchor = this.#viewportAnchor();
    const fold = this.#foldPlan();
    if (node) {
      const folded = fold.docToDisplay(node.startLine);
      const synthetic = fold.displayLines[folded] !==
        this.#currentDoc.lines[node.startLine];
      return {
        docLine: node.startLine,
        sourceCol: this.#renderedLineChangesColumns(node.startLine)
          ? 0
          : node.startCol,
        syntheticDisplayCol: synthetic && folded === anchor.foldedLine
          ? anchor.displayCol
          : undefined,
      };
    }
    if (
      fold.displayLines[anchor.foldedLine] !==
        this.#currentDoc.lines[anchor.docLine]
    ) {
      return {
        docLine: anchor.docLine,
        sourceCol: 0,
        syntheticDisplayCol: anchor.displayCol,
      };
    }
    return {
      docLine: anchor.docLine,
      sourceCol: this.#anchorSourceCol(anchor),
    };
  }

  /** Refresh the layout after a fold changes and restore its viewport anchor. */
  #applyFoldChange(anchor: FoldAnchor): void {
    this.#markFoldChanged();
    const fold = this.#foldPlan();
    const folded = fold.docToDisplay(anchor.docLine);
    const stillSynthetic = fold.displayLines[folded] !==
      this.#currentDoc.lines[anchor.docLine];
    const row = stillSynthetic && anchor.syntheticDisplayCol !== undefined
      ? this.#foldedPositionToDisplay(folded, anchor.syntheticDisplayCol)
      : this.#toDisplay(
        anchor.docLine,
        this.#displayCol(anchor.docLine, anchor.sourceCol),
      );
    this.top = clamp(
      row,
      0,
      this.#lastTop(),
    );
    this.#clampScroll();
  }

  /** Toggle the file the viewport (or selection) is on between shown and hidden. */
  #toggleCurrentFile(): void {
    if (!this.#ensureDiffForFolding()) return;
    const files = this.#foldFiles();
    const line = this.#foldAnchor().docLine;
    const file = files.find((f) => line >= f.headerLine && line <= f.endLine) ??
      files.find((f) => f.headerLine >= line) ?? files[files.length - 1];
    this.#toggleFile(file, { docLine: file.headerLine, sourceCol: 0 });
  }

  /** Toggles one file while restoring `anchor` after its layout changes. */
  #toggleFile(file: DiffFileRange, anchor = this.#foldAnchor()): void {
    if (this.#collapsed.has(file.index)) {
      this.#collapsed.delete(file.index);
      this.#message = `Showing ${file.path}`;
    } else {
      this.#collapsed.add(file.index);
      this.#message = `Hiding ${file.path}`;
    }
    this.#applyFoldChange(anchor);
  }

  /** Hide every file (collapse all to summary lines). */
  #collapseAllFiles(): void {
    if (!this.#ensureDiffForFolding()) return;
    const anchor = this.#foldAnchor();
    let changed = false;
    for (const f of this.#foldFiles()) {
      if (!this.#collapsed.has(f.index)) {
        this.#collapsed.add(f.index);
        changed = true;
      }
    }
    if (changed) this.#applyFoldChange(anchor);
    this.#message = "Hid all files.";
  }

  /** Show every file (expand all). */
  #expandAllFiles(): void {
    if (!this.#ensureDiffForFolding()) return;
    const anchor = this.#foldAnchor();
    if (this.#collapsed.size > 0) {
      this.#collapsed.clear();
      this.#applyFoldChange(anchor);
    }
    this.#message = "Showing all files.";
  }

  /** Toggle one kind of file as a group. A mixed group is made fully hidden. */
  #toggleFileCategory(
    matches: (file: DiffFileRange) => boolean,
    label: string,
  ): void {
    if (!this.#ensureDiffForFolding()) return;
    const files = this.#foldFiles().filter(matches);
    if (files.length === 0) {
      this.#message = `No ${label} files.`;
      return;
    }
    const anchor = this.#foldAnchor();
    const expand = files.every((file) => this.#collapsed.has(file.index));
    let changed = 0;
    for (const f of files) {
      if (expand) {
        this.#collapsed.delete(f.index);
        changed++;
      } else if (!this.#collapsed.has(f.index)) {
        this.#collapsed.add(f.index);
        changed++;
      }
    }
    this.#applyFoldChange(anchor);
    this.#message = `${expand ? "Showing" : "Hid"} ${changed} ${label} file${
      changed === 1 ? "" : "s"
    }.`;
  }

  //
  // editing
  //

  #scrollOrPan(name: string): void {
    const lastTop = this.#lastTop();
    if (name === "up") this.top = clamp(this.top - 1, 0, lastTop);
    else if (name === "down") this.top = clamp(this.top + 1, 0, lastTop);
    else if (name === "left") {
      this.left = this.#wrapLines
        ? 0
        : clamp(this.left - this.#horizontalStep(), 0, this.#maxLeft());
    } else if (name === "right") {
      this.left = this.#wrapLines
        ? 0
        : clamp(this.left + this.#horizontalStep(), 0, this.#maxLeft());
    }
  }

  /** Show the text cursor at the top of the viewport, if the view is editable. */
  #revealCursor(): void {
    if (!this.#source?.editable || !this.#buffer) {
      this.#message = this.#source?.reason ??
        "This view has no underlying file to edit.";
      return;
    }
    const leftRenderedView = this.#setViewMode("source", false);
    const wasWrapped = this.#wrapLines;
    const anchor = wasWrapped ? this.#viewportAnchor() : null;
    const topDoc = anchor?.docLine ?? this.#toDoc(this.top);
    const displayedLine = anchor
      ? this.#foldPlan().displayLines[anchor.foldedLine]
      : undefined;
    const cursorCol = anchor && displayedLine === this.#currentDoc.lines[topDoc]
      ? this.#anchorSourceCol(anchor)
      : 0;
    this.#wrapMode = "off";
    this.#cursorOn = true;
    this.#selectedIndex = null;
    // Editing relies on every source column mapping to one display column, which
    // only the first mode guarantees (it hides nothing and collapses nothing).
    this.#displayMode = DISPLAY_MODES[0];
    if (anchor) this.left = cursorCol;
    // Editing works on the full text, so expand every folded file; the top
    // display row becomes its document line.
    this.#clearFolds();
    this.top = topDoc;
    this.#buffer.place(topDoc, cursorCol);
    this.#seedHighlighter();
    this.#ensureCursorVisible();
    if (leftRenderedView && wasWrapped) {
      this.#message = "Source view; line wrapping turned off for editing.";
    } else if (leftRenderedView) {
      this.#message = "Source view for editing.";
    } else if (wasWrapped) {
      this.#message = "Line wrapping turned off for editing.";
    }
  }

  #markFoldChanged(): void {
    this.#foldVersion++;
    this.#foldPlanCache = undefined;
  }

  #clearFolds(): void {
    if (this.#collapsed.size === 0) return;
    this.#collapsed.clear();
    this.#markFoldChanged();
  }

  /** Create (or re-baseline) the incremental highlighter, seeded with the
   * current document's colors at the current buffer text. Called when editing
   * starts and after the deferred re-parse — the two moments the document's
   * lines and the buffer text are known to agree — so a diff's live highlighter
   * can reuse the workspace-colored lines for everything an edit doesn't touch. */
  #seedHighlighter(): void {
    this.#highlighter = this.#source?.createHighlighter?.(
      this.#buffer!.text(),
      this.#currentDoc.lines,
      this.#buffer!.lineEndingProvenance(),
    );
  }

  #handleEditKey(key: Key): void {
    const b = this.#buffer!;
    if (key.alt) {
      switch (key.name) {
        case "f":
        case "F":
          b.moveWordForward();
          return this.#afterMove();
        case "b":
        case "B":
          b.moveWordBackward();
          return this.#afterMove();
        case "v":
          return this.#cursorPage(-1);
        case "<":
          b.moveBufferStart();
          return this.#afterMove();
        case ">":
          b.moveBufferEnd();
          return this.#afterMove();
        case "d":
          if (this.#guardForwardWordEdit()) {
            b.killWordForward();
            this.#afterEdit();
          }
          return;
        case "y":
          if (this.#source?.policy) {
            this.#message = "Yank-pop isn't available while editing a diff.";
            return;
          }
          b.yankPop();
          return this.#afterEdit();
        case "l":
        case "L":
          if (this.#allowEdit(false)) {
            b.lowercaseWord();
            this.#afterEdit();
          }
          return;
        case "u":
        case "U":
          if (this.#allowEdit(false)) {
            b.uppercaseWord();
            this.#afterEdit();
          }
          return;
        case "c":
        case "C":
          if (this.#allowEdit(false)) {
            b.capitalizeWord();
            this.#afterEdit();
          }
          return;
        case "backspace":
          if (this.#guardBackwardEdit()) {
            b.killWordBackward();
            this.#afterEdit();
          }
          return;
      }
      return; // unmodelled Alt combo
    }
    switch (key.name) {
      case "left":
        b.moveLeft();
        return this.#afterMove();
      case "right":
        this.#moveRightAcrossTransport();
        return this.#afterMove();
      case "up":
        b.moveUp();
        return this.#afterMove();
      case "down":
        b.moveDown();
        return this.#afterMove();
      case "home":
      case "ctrl-a":
        b.moveLineStart();
        return this.#afterMove();
      case "end":
      case "ctrl-e":
        b.moveLineEnd();
        return this.#afterMove();
      case "ctrl-b":
        b.moveLeft();
        return this.#afterMove();
      case "ctrl-f":
        this.#moveRightAcrossTransport();
        return this.#afterMove();
      case "ctrl-p":
        b.moveUp();
        return this.#afterMove();
      case "ctrl-n":
        b.moveDown();
        return this.#afterMove();
      case "pageup":
        return this.#cursorPage(-1);
      case "pagedown":
      case "ctrl-v":
        return this.#cursorPage(1);
      case "escape":
        this.#cursorOn = false;
        this.reparse(); // refresh structure before returning to navigation
        this.#ensureCursorVisible();
        return;
      case "ctrl-s":
        this.#enterEditSearch();
        return;
      case "ctrl-r":
        this.#openRevertPrompt();
        return;
      case "ctrl-l":
        this.#performExpand();
        return;
      case "ctrl-c":
        this.#requestQuit();
        return;
      case "r":
      case "R":
        if (this.#resurrectRemovedLine()) return;
        break;
      case "delete":
      case "ctrl-d":
        if (this.#guardForwardEdit()) {
          b.deleteForward(this.#logicalLineEnd());
          this.#afterEdit();
        }
        return;
      case "backspace":
        this.#handleBackspace();
        return;
      case "enter": {
        // A commit-message line splits into two indented message lines, plain
        // text — no diff pairing, no hunk-count bookkeeping.
        if (this.#inMessageRow()) {
          if (this.#allowEdit(false, false)) {
            b.insert(`\n${this.#source!.policy!.messageIndent}`);
            this.#afterEdit();
          }
          return;
        }
        const prefix = this.#source?.policy?.insertPrefix;
        if (prefix !== undefined) {
          if (this.#allowEdit(false, false)) {
            const hunkHeader = this.#hunkHeaderAt(b.row);
            const start = this.#editStart() ?? 1;
            const line = b.lines[b.row] ?? "";
            const onContext = line[0] === " ";
            const logicalEnd = this.#logicalLineEnd();
            const transport = logicalEnd < b.currentLineLength() ? "\r" : "";
            // Enter splits the line at the cursor. On a context line the result
            // is shown minimally: an empty half just adds a blank line and the
            // line stays unchanged context (start → blank above, end → blank
            // below); a split with content on both sides changes the line, so it
            // becomes a removed/added pair and the break divides the added line
            // into `+head` and `+tail`. An added line is already new, so it just
            // splits at the cursor. Either way the new side gains one line.
            if (onContext && b.col <= start) {
              // Empty head: the blank added line goes above and the cursor
              // follows the content onto the line below, keeping its place at
              // the line start (past the marker).
              const chars = [...line];
              const protectedPrefix = chars.slice(1, start).join("");
              if (protectedPrefix.length > 0) {
                const content = chars.slice(start, logicalEnd).join("");
                b.spliceLines(
                  b.row,
                  1,
                  [
                    `-${protectedPrefix}${content}${transport}`,
                    `${prefix}${protectedPrefix}${transport}`,
                    `${prefix}${content}${transport}`,
                  ],
                  2,
                  1,
                );
              } else {
                b.spliceLines(
                  b.row,
                  0,
                  [`${prefix}${transport}`],
                  1,
                  start,
                );
              }
              this.#splitRow = null;
            } else if (onContext && b.col < logicalEnd) {
              this.#prepareContextEdit();
              this.#splitDiffLine(prefix);
            } else if (onContext) {
              b.spliceLines(
                b.row + 1,
                0,
                [`${prefix}${transport}`],
                0,
                [...prefix].length,
              );
            } else {
              this.#splitDiffLine(prefix);
            }
            this.#adjustHunkCounts(0, 1, hunkHeader);
            this.#afterEdit();
          }
        } else {
          b.insertNewline(
            this.#logicalLineEnd(),
            this.#plainNewlineSuffix(),
          );
          this.#afterEdit();
        }
        return;
      }
      case "tab":
        if (this.#allowEdit(false)) {
          b.insert("  ");
          this.#afterEdit();
        }
        return;
      case "ctrl-k":
        if (this.#guardForwardEdit()) {
          b.killLine(this.#logicalLineEnd());
          this.#afterEdit();
        }
        return;
      case "ctrl-y": {
        const top = b.killRing[0] ?? "";
        if (this.#allowEdit(top.includes("\n"))) {
          b.yank();
          this.#afterEdit();
        }
        return;
      }
      case "ctrl-w":
        if (this.#guardRegionEdit()) {
          b.killRegion();
          this.#afterEdit();
        }
        return;
      case "ctrl-`": // C-Space (NUL) — set the mark
      case "ctrl-space":
        b.setMark();
        this.#message = "Mark set";
        return;
      case "space":
        if (this.#allowEdit(false)) {
          b.insert(" ");
          this.#afterEdit();
        }
        return;
    }
    if (key.char && key.char >= " " && !key.ctrl) {
      // A key.char carrying a newline (e.g. a future bracketed-paste handler)
      // would add lines; treat it as a line change so a diff refuses it.
      if (this.#allowEdit(key.char.includes("\n"))) {
        b.insert(key.char);
        this.#afterEdit();
      }
    }
  }

  /**
   * Before changing a context line in a diff, split it into a removed line (the
   * original) and an added line (the one about to be edited), leaving the cursor
   * on the added line at the same column. So a change to a context line shows as
   * a `-`/`+` pair, exactly as an inserted line shows as `+`. Count-neutral: a
   * context line is one old plus one new line, and so is the `-`/`+` pair, so
   * the hunk header stays valid. A no-op on an added or removed line, or a file
   * (no diff policy).
   */
  #prepareContextEdit(): void {
    if (!this.#source?.policy || !this.#buffer) return;
    // A commit-message line is plain indented text, not a diff line: editing it
    // must not split it into a removed/added pair.
    if (this.#inMessageRow()) return;
    const b = this.#buffer;
    const line = b.lines[b.row];
    if (line === undefined || line[0] !== " ") return;
    const content = line.slice(1);
    const col = b.col;
    // A single-line region's mark rides along onto the added line.
    if (b.mark && b.mark.row === b.row) {
      b.mark = { row: b.row + 1, col: b.mark.col };
    }
    b.spliceLines(b.row, 1, [`-${content}`, `+${content}`], 1, col);
    this.#splitRow = b.row; // the added line, so undoing the edit can collapse it
  }

  /** Split an added diff line while retaining its newline transport. */
  #splitDiffLine(prefix: string): void {
    const b = this.#buffer!;
    const chars = [...b.lines[b.row]];
    const logicalEnd = this.#logicalLineEnd();
    const transport = logicalEnd < chars.length ? "\r" : "";
    const split = Math.min(b.col, logicalEnd);
    const before = chars.slice(0, split).join("");
    const after = chars.slice(split, logicalEnd).join("");
    b.spliceLines(
      b.row,
      1,
      [`${before}${transport}`, `${prefix}${after}${transport}`],
      1,
      [...prefix].length,
    );
  }

  /** Whether the cursor is on a removed line in a hunk whose new side can be
   * saved back to disk. */
  #canResurrectRemovedLine(): boolean {
    const pol = this.#source?.policy;
    const b = this.#buffer;
    return !!pol && !!b && b.lines[b.row]?.[0] === "-" &&
      pol.regionKind(b.lines, b.row) === "removed";
  }

  /** Carry a removed line back onto the diff's new side. Lines whose old and
   * new encoding markers differ remain a removed/added pair. */
  #resurrectRemovedLine(): boolean {
    if (!this.#canResurrectRemovedLine()) return false;
    const b = this.#buffer!;
    const targetRow = b.row;
    const parsed = this.#parsedHunkAt(b.row);
    const hunkHeader = parsed?.hunk.headerLine ?? null;
    const line = b.lines[b.row];
    const oldHasUtf8Bom = parsed?.model.lines[b.row]?.oldLine === 0 &&
      line[1] === "\uFEFF";
    const newHasUtf8Bom = this.#source?.policy?.hasUtf8Bom?.(
      b.lines,
      b.row,
    ) === true;
    const carriesNewUtf8Bom = newHasUtf8Bom && parsed !== null &&
      this.#newSideInsertionLine(parsed.model, parsed.hunk, b.row) === 0;
    const newSideBom = carriesNewUtf8Bom && parsed
      ? this.#newSideBomCarrier(parsed.model, parsed.hunk)
      : null;
    if (!this.#adjustHunkCounts(0, 1, hunkHeader)) {
      // Cannot happen for a resurrectable line; see `#adjustHunkCounts`.
      throw new Error(
        "the hunk header of a resurrectable line did not parse",
      );
    }
    const decodedContent = [...line].slice(oldHasUtf8Bom ? 2 : 1).join("");
    const newContent = `${carriesNewUtf8Bom ? "\uFEFF" : ""}${decodedContent}`;
    const context = oldHasUtf8Bom === carriesNewUtf8Bom;
    b.spliceLines(
      targetRow,
      1,
      context ? [` ${newContent}`] : [line, `+${newContent}`],
      context ? 0 : 1,
      1 + (carriesNewUtf8Bom ? 1 : 0),
    );
    if (newSideBom !== null) {
      const carrierRow = newSideBom +
        (context || newSideBom < targetRow ? 0 : 1);
      const carrier = b.lines[carrierRow];
      if (carrier?.[0] === "+") {
        b.lines[carrierRow] = `+${[...carrier].slice(2).join("")}`;
      } else if (carrier?.[0] === " ") {
        const cursor = { row: b.row, col: b.col };
        const content = [...carrier].slice(2).join("");
        b.spliceLines(
          carrierRow,
          1,
          [`-\uFEFF${content}`, `+${content}`],
          0,
          1,
        );
        b.place(
          cursor.row + (carrierRow < cursor.row ? 1 : 0),
          cursor.col,
        );
      }
    }
    this.#afterEdit();
    this.#message = "Resurrected the removed line.";
    return true;
  }

  /** After editing a diff, collapse the added line a split just produced back
   * into a context line when its content again matches the removed line above it
   * — you undid the change. Scoped to the row {@link prepareContextEdit} created
   * (`splitRow`), so editing an author-written `-`/`+` pair to match does not
   * silently drop their removed line. Count-neutral, the inverse of the split. */
  #collapseUnchangedPair(): void {
    if (!this.#source?.policy || !this.#buffer) return;
    const b = this.#buffer;
    if (b.row !== this.#splitRow) return;
    const cur = b.lines[b.row];
    const above = b.lines[b.row - 1];
    if (
      cur && above && cur[0] === "+" && above[0] === "-" &&
      cur.slice(1) === above.slice(1)
    ) {
      b.spliceLines(b.row - 1, 2, [` ${cur.slice(1)}`], 0, b.col);
      this.#splitRow = null;
    }
  }

  /** The parsed hunk containing a body row. Structural lookup keeps body text
   * such as `--- prior` and `+++ next` from being mistaken for file headers. */
  #hunkHeaderAt(row: number): number | null {
    return this.#parsedHunkAt(row)?.hunk.headerLine ?? null;
  }

  /** The parsed hunk containing a body row. */
  #parsedHunkAt(
    row: number,
  ): { model: DiffModel; hunk: DiffHunk } | null {
    if (!this.#buffer) return null;
    const policyLookup = this.#source?.policy?.hunkAt;
    if (policyLookup) return policyLookup(this.#buffer.lines, row);
    const model = parseDiff(this.#buffer.text());
    if (!model) return null;
    for (const file of model.files) {
      for (const hunk of file.hunks) {
        if (row > hunk.headerLine && row <= hunk.endLine) {
          return { model, hunk };
        }
      }
    }
    return null;
  }

  /** The first new-side line carrying the file's decoded UTF-8 BOM. */
  #newSideBomCarrier(model: DiffModel, hunk: DiffHunk): number | null {
    for (let row = hunk.headerLine + 1; row <= hunk.endLine; row++) {
      const kind = model.lines[row]?.kind;
      if (
        (kind === "ctx" || kind === "add") &&
        model.lines[row]?.newLine === 0 &&
        this.#buffer?.lines[row]?.[1] === "\uFEFF"
      ) {
        return row;
      }
    }
    return null;
  }

  /** The new-file line where a removed row would be inserted. */
  #newSideInsertionLine(
    model: DiffModel,
    hunk: DiffHunk,
    row: number,
  ): number {
    let line = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    for (let candidate = hunk.headerLine + 1; candidate < row; candidate++) {
      const kind = model.lines[candidate]?.kind;
      if (kind === "ctx" || kind === "add") line++;
    }
    return line;
  }

  /** Grow or shrink a parsed hunk header after its body changes. A zero-count
   * unified-diff range names the line before its insertion point, so crossing
   * zero also moves the range start. Returns whether a header was rewritten:
   * false with no diff policy or buffer, with nothing to change, with no
   * header row, or with a header row the pattern does not match. */
  #adjustHunkCounts(
    oldDelta: number,
    newDelta: number,
    hunkHeader = this.#hunkHeaderAt(this.#buffer?.row ?? -1),
  ): boolean {
    if (
      !this.#source?.policy || !this.#buffer ||
      (oldDelta === 0 && newDelta === 0)
    ) {
      return false;
    }
    const b = this.#buffer;
    if (hunkHeader === null) return false;
    const m = b.lines[hunkHeader]?.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\r]*)(\r?)$/,
    );
    if (!m) return false;
    const adjust = (
      startText: string,
      countText: string | undefined,
      delta: number,
    ): { start: number; count: number } => {
      let start = parseInt(startText, 10);
      const count = countText === undefined ? 1 : parseInt(countText, 10);
      const next = Math.max(0, count + delta);
      if (count === 0 && next > 0) start++;
      if (count > 0 && next === 0) start = Math.max(0, start - 1);
      return { start, count: next };
    };
    const oldRange = adjust(m[1], m[2], oldDelta);
    const newRange = adjust(m[3], m[4], newDelta);
    b.lines[hunkHeader] =
      `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@${
        m[5] ?? ""
      }${m[6] ?? ""}`;
    return true;
  }

  /** The first editable column on the cursor's line under the source's policy
   * (a diff), or null when the line cannot be edited. No policy → column 0. */
  #editStart(): number | null {
    const pol = this.#source?.policy;
    if (!pol) return 0;
    return pol.editStart(this.#buffer!.lines, this.#buffer!.row);
  }

  /** The current line's last editable column, before source-owned transport. */
  #logicalLineEnd(row = this.#buffer!.row): number {
    const b = this.#buffer!;
    const line = b.lines[row] ?? "";
    const physicalEnd = [...line].length;
    const ordinaryEnd = line.endsWith("\r") && row < b.lines.length - 1
      ? physicalEnd - 1
      : physicalEnd;
    const end = this.#source?.logicalEnd?.(b.lines, row) ?? ordinaryEnd;
    return clamp(end, 0, physicalEnd);
  }

  /** The character before LF in the nearest newline of an ordinary file. */
  #plainNewlineSuffix(): string {
    const b = this.#buffer!;
    if (b.row < b.lines.length - 1) {
      const line = b.lines[b.row] ?? "";
      return line.endsWith("\r") ? "\r" : "";
    }
    if (b.row > 0) {
      const previous = b.lines[b.row - 1] ?? "";
      return previous.endsWith("\r") ? "\r" : "";
    }
    return "";
  }

  /** Keep a right-arrow motion able to cross a protected CRLF boundary. */
  #moveRightAcrossTransport(): void {
    const b = this.#buffer!;
    const logicalEnd = this.#logicalLineEnd();
    if (
      b.col >= logicalEnd && logicalEnd < b.currentLineLength() &&
      b.row < b.lines.length - 1
    ) {
      b.place(b.row + 1, 0);
      return;
    }
    b.moveRight();
  }

  /** Keep source-owned transport outside the text cursor. */
  #clampToLogicalLine(): void {
    const b = this.#buffer;
    if (!b) return;
    const end = this.#logicalLineEnd();
    if (b.col > end) b.place(b.row, end);
  }

  /** Whether the cursor sits in an editable commit-message line — plain indented
   * text, edited without the diff's removed/added pairing. */
  #inMessageRow(): boolean {
    const pol = this.#source?.policy;
    return !!pol && !!this.#buffer &&
      pol.regionKind(this.#buffer.lines, this.#buffer.row) === "message";
  }

  /**
   * Gate an insert-like edit under the source's policy (a diff). Refuses a
   * multi-line insert (it would add unmarked lines) and a line that is not
   * editable; otherwise nudges the cursor past the diff marker and allows it. A
   * plain file (no policy) always passes.
   */
  #allowEdit(multiline: boolean, split = true): boolean {
    if (!this.#source?.policy) return true;
    if (multiline) {
      this.#message = MULTILINE_MSG;
      return false;
    }
    const b = this.#buffer!;
    const start = this.#editStart();
    if (start === null) {
      this.#message = this.#notEditableMessage();
      return false;
    }
    this.#clampToLogicalLine();
    if (b.col < start) b.place(b.row, start);
    if (split) this.#prepareContextEdit();
    return true;
  }

  /** Gate a delete-forward edit (delete, C-k): refuse the diff marker and
   * a delete at end of line, which would join the next line — removing a line
   * is Backspace at its start instead. */
  #guardForwardEdit(): boolean {
    if (!this.#source?.policy) return true;
    const b = this.#buffer!;
    const start = this.#editStart();
    if (start === null) {
      this.#message = this.#notEditableMessage();
      return false;
    }
    this.#clampToLogicalLine();
    if (b.col < start) b.place(b.row, start);
    if (b.col >= this.#logicalLineEnd()) {
      this.#message = JOIN_MSG;
      return false;
    }
    this.#prepareContextEdit();
    return true;
  }

  /** Gate a forward word kill that would consume a diff line boundary. */
  #guardForwardWordEdit(): boolean {
    if (!this.#source?.policy) return true;
    const b = this.#buffer!;
    const start = this.#editStart();
    if (start === null) {
      this.#message = this.#notEditableMessage();
      return false;
    }
    if (b.col < start) b.place(b.row, start);
    if (b.wordEndForward().row !== b.row) {
      this.#message = JOIN_MSG;
      return false;
    }
    this.#prepareContextEdit();
    return true;
  }

  /** Backspace under the source's policy: delete a character past the marker,
   * remove the whole line when its content is empty (an added line taken back),
   * else protect the marker. A plain file just deletes backward. */
  #handleBackspace(): void {
    const b = this.#buffer!;
    if (!this.#source?.policy) {
      b.deleteBackward(
        b.row > 0 ? this.#logicalLineEnd(b.row - 1) : undefined,
      );
      return this.#afterEdit();
    }
    const start = this.#editStart();
    if (start === null) {
      this.#message = this.#notEditableMessage();
      return;
    }
    this.#clampToLogicalLine();
    if (b.col > start) {
      this.#prepareContextEdit();
      b.deleteBackward();
      return this.#afterEdit();
    }
    if (this.#logicalLineEnd() <= start && b.row > 0) {
      this.#removeDiffLine(start);
      return this.#afterEdit();
    }
    this.#message = MARKER_MSG;
  }

  /** Remove an empty added line. An empty context line becomes a removal so its
   * original old-side coordinate and content provenance remain represented. */
  #removeDiffLine(markerLen: number): void {
    const b = this.#buffer!;
    const marker = b.lines[b.row][0] ?? "";
    const context = marker === " " &&
      this.#source?.policy?.regionKind(b.lines, b.row) === "hunk";
    const parsed = this.#parsedHunkAt(b.row);
    const hunkHeader = parsed?.hunk.headerLine ?? null;
    const transportWidth = b.currentLineLength() - this.#logicalLineEnd();
    this.#transferProtectedPrefix(markerLen, parsed);
    if (context) {
      b.lines[b.row] = `-${b.lines[b.row].slice(1)}`;
      b.place(b.row, 1);
      this.#adjustHunkCounts(0, -1, hunkHeader);
      return;
    }
    const previousEnding = b.lineEndingProvenance()[b.row - 1];
    b.place(b.row, 0);
    b.deleteBackward(); // join into the previous line
    for (let i = 0; i < markerLen + transportWidth; i++) b.deleteForward();
    const lineEndings = [...b.lineEndingProvenance()];
    lineEndings[b.row] = previousEnding;
    b.setLineEndingProvenance(lineEndings);
    this.#adjustHunkCounts(
      marker === " " || marker === "-" ? -1 : 0,
      marker === " " || marker === "+" ? -1 : 0,
      hunkHeader,
    );
  }

  /** Move an encoding prefix from a removed first new-side line to its
   * successor. A context successor becomes a removed/added pair. */
  #transferProtectedPrefix(
    markerLen: number,
    parsed: { model: DiffModel; hunk: DiffHunk } | null,
  ): void {
    if (!this.#buffer || markerLen <= 1 || parsed === null) return;
    const b = this.#buffer;
    const prefix = [...b.lines[b.row]].slice(1, markerLen).join("");
    if (prefix.length === 0) return;
    const { model, hunk } = parsed;
    for (let row = b.row + 1; row <= hunk.endLine; row++) {
      const kind = model.lines[row]?.kind;
      if (kind !== "ctx" && kind !== "add") continue;
      const markerWidth = kind === "add" || b.lines[row][0] === " " ? 1 : 0;
      const body = b.lines[row].slice(markerWidth);
      if (kind === "add") {
        b.lines[row] = `+${prefix}${body}`;
      } else {
        const cursor = { row: b.row, col: b.col };
        b.spliceLines(row, 1, [`-${body}`, `+${prefix}${body}`], 0, 1);
        b.place(cursor.row, cursor.col);
      }
      return;
    }
  }

  /** Gate a backward word kill (M-Backspace): refuse reaching the marker. */
  #guardBackwardEdit(): boolean {
    if (!this.#source?.policy) return true;
    const b = this.#buffer!;
    const start = this.#editStart();
    if (start === null) {
      this.#message = this.#notEditableMessage();
      return false;
    }
    this.#clampToLogicalLine();
    if (b.col <= start) {
      this.#message = MARKER_MSG;
      return false;
    }
    const destination = b.wordStartBackward();
    if (destination.row !== b.row || destination.col < start) {
      this.#message = MARKER_MSG;
      return false;
    }
    this.#prepareContextEdit();
    return true;
  }

  /** Gate a region kill (C-w): refuse a multi-line region or one that reaches
   * into the diff marker. */
  #guardRegionEdit(): boolean {
    if (!this.#source?.policy) return true;
    const b = this.#buffer!;
    const mark = b.mark;
    if (!mark) {
      this.#message = "Set the mark first (Ctrl-Space).";
      return false;
    }
    if (mark.row !== b.row) {
      this.#message = MULTILINE_MSG;
      return false;
    }
    const start = this.#editStart();
    if (start === null) {
      this.#message = this.#notEditableMessage();
      return false;
    }
    if (Math.min(b.col, mark.col) < start) {
      this.#message = MARKER_MSG;
      return false;
    }
    if (Math.max(b.col, mark.col) > this.#logicalLineEnd()) {
      this.#message = JOIN_MSG;
      return false;
    }
    this.#prepareContextEdit();
    return true;
  }

  #notEditableMessage(): string {
    if (this.#canResurrectRemovedLine()) {
      return "This removed line isn't editable; press R to resurrect it.";
    }
    const b = this.#buffer;
    const policy = this.#source?.policy;
    return (b ? policy?.notEditableMessage?.(b.lines, b.row) : null) ??
      NOT_EDITABLE_MSG;
  }

  #afterMove(): void {
    this.#clampToLogicalLine();
    this.#ensureCursorVisible();
  }

  #afterEdit(): void {
    this.#selectedIndex = null;
    this.#collapseUnchangedPair();
    this.#clampToLogicalLine();
    if (this.#source && this.#buffer) {
      const text = this.#buffer.text();
      const lines = this.#liveHighlight(text);
      if (lines) {
        // Re-highlight on every keystroke — correct for multi-line tokens, and a
        // fraction of a full parse because it skips the structure tree. The
        // structure (navigation, cross-references) is refreshed on the deferred
        // re-parse.
        this.#sourceDoc = { ...this.#sourceDoc, text, lines };
        this.#currentDoc = this.#sourceDoc;
        this.needsReparse = true;
      } else {
        this.#setSourceDocument(
          this.#source.parse(text, this.#buffer.lineEndingProvenance()),
        );
        this.needsReparse = false;
      }
    }
    this.#clampScroll();
    this.#ensureCursorVisible();
  }

  /** Show `text` in the status line, where it stays until something replaces
   * it. */
  showMessage(text: string): void {
    this.#message = text;
    this.transientMessage = false;
  }

  /** Take away a message that was set to go away on its own, once the driver has
   * left it up for its moment. Does nothing to a message that is not one of
   * those, so a later one is never cleared out from under itself. */
  expireMessage(): void {
    if (!this.transientMessage) return;
    this.transientMessage = false;
    this.#message = "";
  }

  /** Live re-highlight `text` into rendered lines, or null when the source has
   * no live highlighter (then the caller does a full parse). Prefers the
   * incremental highlighter, created lazily and seeded with the current text so
   * the first keystroke is a full highlight and each later one is incremental. */
  #liveHighlight(text: string): readonly Line[] | null {
    if (this.#highlighter) {
      return this.#highlighter.update(
        text,
        this.#buffer?.lineEndingProvenance(),
      );
    }
    return this.#source?.highlight?.(text) ?? null;
  }

  /** Run the deferred full re-parse, refreshing the structure tree and
   * cross-references after the per-keystroke re-highlights (which keep the lines
   * current but not the structure). The incremental highlighter is discarded so
   * the next edit re-seeds it from this authoritative parse. `force` re-parses
   * when no edit asked for it, as when a language's parser has just loaded. */
  reparse({ force = false }: { force?: boolean } = {}): void {
    if (!this.#source || !this.#buffer || !(this.needsReparse || force)) return;
    this.#setSourceDocument(
      this.#source.parse(
        this.#buffer.text(),
        this.#buffer.lineEndingProvenance(),
      ),
    );
    this.needsReparse = false;
    // Re-baseline the live highlighter from this authoritative parse while still
    // editing; drop it when leaving edit mode.
    if (this.#cursorOn) this.#seedHighlighter();
    else this.#highlighter = undefined;
    this.#clampScroll();
    this.#ensureCursorVisible();
  }

  #cursorPage(dir: number): void {
    const b = this.#buffer!;
    const step = Math.max(1, this.#contentRows() - 1);
    b.place(b.row + dir * step, b.col);
    this.top = clamp(
      this.top + dir * step,
      0,
      maxTop(this.doc.lines.length, this.height),
    );
    this.#ensureCursorVisible();
  }

  #ensureCursorVisible(): void {
    if (!this.#buffer) return;
    const b = this.#buffer;
    const rows = this.#contentRows();
    if (b.row < this.top) this.top = b.row;
    else if (b.row >= this.top + rows) this.top = b.row - rows + 1;
    this.top = clamp(this.top, 0, maxTop(this.doc.lines.length, this.height));
    const cw = this.#contentWidth();
    if (b.col < this.left) this.left = b.col;
    else if (b.col >= this.left + cw) this.left = b.col - cw + 1;
    this.left = clamp(this.left, 0, this.#maxLeft());
  }

  #contentWidth(): number {
    const fitted = fitViewLayout(
      this.width,
      this.#gutterWidth(),
      this.#selectedNode() ? 1 : 0,
      this.#hasDiffMargin() ? DIFF_MARGIN_WIDTH : 0,
      this.#wrapLines,
    );
    return fitted.contentWidth + fitted.marginWidth;
  }

  /** Pager annotations currently visible beside logical document lines. */
  #activeDiffAnnotations(): readonly DiffAnnotation[] {
    if (
      this.#mode !== "normal" || this.#overlay || this.#cursorOn ||
      this.#chord !== null || !this.#source?.expandContext
    ) {
      return [];
    }
    const expand = this.#expandOffer();
    return expand && !("blocked" in expand)
      ? this.#displayDiffAnnotations(expand)
      : [];
  }

  /** Widest folded line under the active non-printable display mode. */
  #maxDisplayWidth(): number {
    const lines = this.#foldPlan().displayLines;
    if (
      this.#maxDisplayWidthCache?.lines !== lines ||
      this.#maxDisplayWidthCache.mode !== this.#displayMode
    ) {
      let width = 0;
      for (const line of lines) {
        width = Math.max(width, displayWidth(line, this.#displayMode));
      }
      this.#maxDisplayWidthCache = { lines, mode: this.#displayMode, width };
    }
    return this.#maxDisplayWidthCache.width;
  }

  /** Source cells available on one folded line after its annotation and, on
   * the first line, the whole-diff totals label. */
  #lineContentWidth(
    foldedLine: number,
    annotations = this.#activeDiffAnnotations(),
    contentWidth = this.#contentWidth(),
  ): number {
    const annotation = annotations.find((item) => item.line === foldedLine);
    const annotationWidth = annotation
      ? diffAnnotationDecoration(annotation.kind, contentWidth).firstWidth
      : 0;
    const totalsWidth = foldedLine === 0 ? this.#cornerTotalsWidth() : 0;
    return Math.max(1, contentWidth - annotationWidth - totalsWidth);
  }

  /** Furthest horizontal offset needed by any line under its own annotation
   * or, on the first line, the whole-diff totals label. */
  #maxLeft(
    annotations: readonly DiffAnnotation[] = this.#activeDiffAnnotations(),
  ): number {
    if (!this.#hasDiffMargin()) return this.#maxLineLen;
    const contentWidth = this.#contentWidth();
    let width = this.#maxDisplayWidth() - contentWidth;
    const lines = this.#foldPlan().displayLines;
    const constrained = new Set(
      annotations.map((annotation) => annotation.line),
    );
    if (this.#cornerTotalsWidth() > 0) constrained.add(0);
    for (const lineIdx of constrained) {
      const line = lines[lineIdx];
      if (!line) continue;
      width = Math.max(
        width,
        displayWidth(line, this.#displayMode) -
          this.#lineContentWidth(lineIdx, annotations, contentWidth),
      );
    }
    return Math.max(0, width);
  }

  /** Horizontal pan distance for the current content width. */
  #horizontalStep(): number {
    if (!this.#hasDiffMargin()) return HORIZONTAL_STEP;
    const annotations = this.#activeDiffAnnotations();
    let width = this.#lineContentWidth(0, annotations);
    for (const annotation of annotations) {
      width = Math.min(
        width,
        this.#lineContentWidth(annotation.line, annotations),
      );
    }
    return Math.max(1, Math.min(HORIZONTAL_STEP, width));
  }

  /** Bring one display column into an unwrapped viewport. */
  #revealColumn(docLine: number, col: number): void {
    if (this.#wrapLines) return;
    const width = this.#lineContentWidth(this.#toFolded(docLine));
    if (col >= this.left && col < this.left + width) return;
    const leading = Math.min(4, width - 1);
    this.left = clamp(col - leading, 0, this.#maxLeft());
  }

  /** Whether this pager can draw diff annotations. */
  #hasDiffMargin(): boolean {
    return !this.#cursorOn && !!this.#source?.expandContext;
  }

  /** Cycle the line-number gutter: off → input position → file/message line. */
  #cycleLineNumbers(): void {
    const anchor = this.#wrapLines ? this.#viewportAnchor() : null;
    const order: LineNumberMode[] = ["off", "input", "file"];
    this.#lineNumberMode =
      order[(order.indexOf(this.#lineNumberMode) + 1) % order.length];
    if (anchor) this.#restoreWrappedAnchor(anchor);
    else this.#clampScroll();
    const label = this.#lineNumberMode === "off"
      ? "off"
      : this.#lineNumberMode === "input"
      ? "input position"
      : "file / message line";
    this.#message = `Line numbers: ${label}`;
  }

  /** The gutter width for the current mode: wide enough for the largest number
   * it shows (file lines can exceed the number of lines the diff spans). */
  #gutterWidth(): number {
    if (this.#lineNumberMode === "off") return 0;
    const max = this.#gutterNumbers().reduce<number>(
      (m, n) => n !== null && n > m ? n : m,
      0,
    );
    return Math.max(4, String(Math.max(1, max)).length + 1);
  }

  /** The number the gutter shows on each display row, or null for a blank
   * gutter there (a removed or structural diff line in file mode, or an
   * unmapped row). */
  #gutterNumbers(): (number | null)[] {
    const plan = this.#foldPlan();
    const rows = plan.displayLines.length;
    const fileNums = this.#lineNumberMode === "file"
      ? this.#fileLineNumbers()
      : null;
    const out: (number | null)[] = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const docLine = plan.displayToDoc(r);
      // "input" numbers, and "file" numbers for a non-diff view (where the input
      // is the file), are just the document line.
      out[r] = fileNums ? fileNums[docLine] ?? null : docLine + 1;
    }
    return out;
  }

  /** For a diff, each document line's underlying line: a context/added line's
   * new-file line, a commit-message line's position within the message, else
   * null. Null for a non-diff view (no distinct underlying file). Cached against
   * the document, since every frame draws the gutter and the map costs a parse
   * of the whole diff. */
  #fileLineNumbers(): (number | null)[] | null {
    if (this.#fileLineCache?.doc !== this.#currentDoc) {
      this.#fileLineCache = {
        doc: this.#currentDoc,
        value: this.#computeFileLineNumbers(),
      };
    }
    return this.#fileLineCache.value;
  }

  #computeFileLineNumbers(): (number | null)[] | null {
    if (!this.#source?.isDiff) return null;
    const texts = this.#currentDoc.lines.map((l) => l.text);
    const out: (number | null)[] = new Array(texts.length).fill(null);
    const model = parseDiff(this.#currentDoc.text);
    if (model) {
      for (let i = 0; i < model.lines.length && i < out.length; i++) {
        const nl = model.lines[i].newLine;
        if (nl !== undefined) out[i] = nl + 1;
      }
    }
    for (const m of findCommitMessages(texts)) {
      for (let i = m.start; i <= m.end && i < out.length; i++) {
        out[i] = i - m.start + 1;
      }
    }
    return out;
  }

  #handleChord(key: Key): void {
    this.#chord = null;
    this.#message = "";
    if (key.name === "ctrl-s") this.#requestSave();
    else if (key.name === "ctrl-c") this.#requestQuit();
    else if (key.name === "ctrl-f") this.#openFilePicker();
    else this.#message = `C-x ${key.name}: unbound`;
  }

  #requestSave(target?: "amend" | "workspace"): boolean {
    if (!this.#source || !this.#buffer) {
      this.#message = "Nothing to save.";
      return false;
    }
    if (!this.#source.editable) {
      this.#message = this.#source.reason ?? "This view is read-only.";
      return false;
    }
    const baseline = this.#buffer.baseline();
    const current = this.#buffer.text();
    if (!this.#buffer.dirty()) {
      this.#message = "Saved 0 files";
      return true;
    }
    // Saving changed commit output rewrites git history, so confirm first.
    const amend = this.#source.pendingAmend?.(baseline, current) ?? null;
    if (amend && target === undefined) {
      this.#mode = "amendPrompt";
      this.#focusDefaultButton();
      this.#message = "";
      return false;
    }
    if (amend && target === "amend" && amend.subject.trim() === "") {
      this.#message = "Refusing to amend: the commit message would be empty.";
      return false;
    }
    const options: SaveOptions | undefined = target === "workspace"
      ? { amendCommit: false }
      : undefined;
    try {
      this.#message = this.#source.save(
        current,
        this.#buffer.lineEndingProvenance(),
        baseline,
        options,
      );
      const savedBaseline = this.#source.baselineAfterSave?.(
        baseline,
        current,
        options,
      ) ?? current;
      this.#buffer.setBaseline(savedBaseline);
      const refreshedLineEndings = this.#source.lineEndingProvenance?.(current);
      if (refreshedLineEndings) {
        const retainedLineEndings = this.#buffer.lineEndingProvenance();
        this.#buffer.setLineEndingProvenance(
          this.#buffer.lines.map((_, index) =>
            refreshedLineEndings[index] ?? retainedLineEndings[index]
          ),
        );
      }
      if (target === "workspace" && this.#buffer.dirty()) {
        this.#message += "; commit message remains unsaved";
      }
      return true;
    } catch (e) {
      this.#message = `Save failed: ${e instanceof Error ? e.message : e}`;
      return false;
    }
  }

  #applyAmendButton(button: DialogButton): void {
    if (button.hotkey === "a" || button.hotkey === "s") {
      const ok = this.#requestSave(
        button.hotkey === "a" ? "amend" : "workspace",
      );
      this.#mode = "normal";
      this.#editedFiles = [];
      if (
        ok && this.#savePromptThen === "quit" && !this.#buffer?.dirty()
      ) {
        this.quit = true;
      }
      this.#savePromptThen = null;
    } else if (button.kind === "cancel") {
      this.#mode = "normal";
      this.#savePromptThen = null;
      this.#editedFiles = [];
      this.#message = "Save cancelled.";
    }
  }

  #requestQuit(): void {
    if (this.#buffer?.dirty()) {
      // A quit signal can arrive with a peek overlay still open; the modal save
      // prompt replaces it rather than drawing over it.
      this.#overlay = null;
      this.#overlayScroll = 0;
      this.#overlayStack = [];
      this.#mode = "savePrompt";
      this.#savePromptThen = "quit";
      this.#editedFiles = this.#computeEditedFiles();
      this.#focusDefaultButton();
      this.#message = "";
    } else {
      this.quit = true;
    }
  }

  /** The files a save would write — just those an edit actually touched, not
   * every file a diff spans. A diff source reports this exactly (an empty list
   * when only the commit message changed); a plain file falls back to its one
   * label. */
  #computeEditedFiles(): string[] {
    if (!this.#source || !this.#buffer) return [];
    const labels = this.#source.dirtyLabels?.(
      this.#buffer.baseline(),
      this.#buffer.text(),
    );
    if (labels !== undefined) return labels;
    return this.#source.label ? [this.#source.label] : [];
  }

  /**
   * An interrupt (SIGINT) arrived. With unsaved edits and no prompt already up,
   * raise the save prompt and return true so the driver keeps running and lets
   * the user answer it. Otherwise return false: nothing to save, or a second
   * interrupt during the prompt, so the driver should terminate.
   */
  requestQuitFromSignal(): boolean {
    if (this.#mode === "savePrompt") return false;
    const willPrompt = this.#buffer?.dirty() ?? false;
    this.#requestQuit();
    return willPrompt;
  }

  /** Keys while a modal prompt (save / amend / revert) is up. Tab and Shift-Tab
   * move the focus ring between buttons, wrapping around; Space and Enter
   * activate the focused button; Esc activates the cancel button; a button's
   * shortcut letter activates it directly. Any other key leaves the prompt up. */
  #handleDialogKey(
    key: Key,
    beforeButtonAction?: () => void,
  ): void {
    // Reached only from the prompt modes, each of which builds a dialog with at
    // least two buttons, so the dialog is present and its row is non-empty.
    const dialog = this.#promptDialog()!;
    const buttons = dialog.buttons;
    const n = buttons.length;

    // Tab moves the ring forward, Shift-Tab back, both wrapping around. From no
    // focus (-1) Tab lands on the first button and Shift-Tab on the last.
    if (key.name === "tab") {
      this.#dialogFocus = this.#dialogFocus < 0
        ? 0
        : (this.#dialogFocus + 1) % n;
      return;
    }
    if (key.name === "shift-tab") {
      this.#dialogFocus = this.#dialogFocus < 0
        ? n - 1
        : (this.#dialogFocus - 1 + n) % n;
      return;
    }

    let index = -1;
    if (key.name === "enter" || key.name === "space" || key.char === " ") {
      // The clamped focus the dialog was drawn with, so Enter always activates
      // the highlighted button. -1 means nothing is focused: a no-op.
      index = dialog.focus ?? -1;
    } else if (key.name === "escape") {
      index = buttons.findIndex((b) => b.kind === "cancel");
    } else {
      const k = (key.char ?? key.name).toLowerCase();
      index = buttons.findIndex((b) => b.hotkey.toLowerCase() === k);
    }
    if (index < 0 || index >= n) return; // an unbound key leaves the prompt up
    this.#activateButton(dialog, index, beforeButtonAction);
  }

  /** Capture a prompt button's pushed frame, let the driver paint it, then run
   * the button's action. The pressed button is drawn focused as well, so a
   * shortcut-key press shows it highlighted rather than leaving the highlight
   * on whatever Tab last chose. */
  #activateButton(
    dialog: DialogState,
    index: number,
    beforeButtonAction?: () => void,
  ): void {
    this.#dialogFocus = index;
    this.pendingPush = {
      doc: this.displayDoc(),
      view: {
        ...this.view(),
        dialog: { ...dialog, focus: index, pushed: index },
      },
    };
    beforeButtonAction?.();
    const button = dialog.buttons[index];
    if (this.#mode === "savePrompt") this.#applySaveButton(button);
    else if (this.#mode === "amendPrompt") this.#applyAmendButton(button);
    else if (this.#mode === "revertPrompt") this.#applyRevertButton(button);
  }

  #applySaveButton(button: DialogButton): void {
    if (button.hotkey === "s") {
      const ok = this.#requestSave();
      // The save may need to confirm a commit amend first; leave that prompt up
      // (keeping the quit intent) instead of forcing back to normal mode.
      if (this.#mode === "amendPrompt") return;
      this.#mode = "normal";
      this.#editedFiles = [];
      if (ok && this.#savePromptThen === "quit") this.quit = true;
      this.#savePromptThen = null;
    } else if (button.hotkey === "d") {
      this.#mode = "normal";
      this.#editedFiles = [];
      if (this.#savePromptThen === "quit") this.quit = true;
      this.#savePromptThen = null;
    } else if (button.kind === "cancel") {
      this.#mode = "normal";
      this.#savePromptThen = null;
      this.#editedFiles = [];
      this.#message = "Cancelled";
    }
  }

  /** Open the revert prompt (Ctrl-R while editing). A diff offers only the
   * scopes that apply where the cursor is — the hunk and/or file it is in, or
   * the commit message it is in — plus all; a plain file reverts wholesale. */
  #openRevertPrompt(): void {
    if (!this.#buffer?.dirty()) {
      this.#message = "Nothing to revert.";
      return;
    }
    this.#mode = "revertPrompt";
    this.#focusDefaultButton();
    this.#message = "";
  }

  /** Which revert scopes apply at the cursor: whether it sits in a hunk, in a
   * file, and in an editable commit message. Derived from the current buffer
   * text so it matches what the revert itself finds. */
  #revertScopesAt(): {
    chunk: boolean;
    file: boolean;
    message: boolean;
  } {
    const row = this.#buffer!.row;
    const message = this.#inMessageRow();
    let file = false;
    let chunk = false;
    const model = parseDiff(this.#buffer!.text());
    const f = model?.files.find((f) => row >= f.headerLine && row <= f.endLine);
    if (f) {
      file = true;
      chunk = f.hunks.some((h) => row >= h.headerLine && row <= h.endLine);
    }
    return { chunk, file, message };
  }

  #applyRevertButton(button: DialogButton): void {
    // The dialog only offers the scopes that apply where the cursor sits, so a
    // scope button that reached here is always valid.
    let scope: RevertScope | null = null;
    switch (button.hotkey) {
      case "h":
        scope = "chunk";
        break;
      case "f":
        scope = "file";
        break;
      case "m":
        scope = "message";
        break;
      case "a": // a diff's all
      case "y": // a plain file's single scope
        scope = "all";
        break;
    }
    if (scope) {
      this.#performRevert(scope);
      this.#mode = "normal";
    } else if (button.kind === "cancel") {
      this.#message = "Cancelled";
      this.#mode = "normal";
    }
  }

  /** Restore the chosen scope to its original form, keeping the dirty baseline
   * so any remaining edits still count. */
  #performRevert(scope: RevertScope): void {
    if (!this.#source?.revert || !this.#buffer) {
      this.#message = "Revert isn't available here.";
      return;
    }
    const result = this.#source.revert(
      this.#buffer.baseline(),
      this.#buffer.text(),
      this.#buffer.row,
      scope,
      this.#buffer.lineEndingProvenance(),
    );
    if (!result) {
      this.#message = "Nothing to revert there.";
      return;
    }
    this.#buffer.setText(
      result.text,
      result.cursorLine,
      0,
      result.lineEndings ?? this.#source.lineEndingProvenance?.(result.text),
    );
    this.#splitRow = null;
    this.#snapCursorToEditable();
    this.#setSourceDocument(
      this.#source.parse(result.text, this.#buffer.lineEndingProvenance()),
    );
    this.needsReparse = false;
    if (this.#cursorOn) this.#seedHighlighter();
    this.#clampScroll();
    this.#ensureCursorVisible();
    this.#message = `Reverted ${
      scope === "all" ? "all edits" : "the " + scope
    }.`;
  }

  /** Move the cursor down to the first editable line at or after it, so it does
   * not sit on a non-editable header after a revert restores a hunk or file. */
  #snapCursorToEditable(): void {
    const b = this.#buffer;
    const pol = this.#source?.policy;
    if (!b || !pol) return;
    while (
      b.row < b.lines.length - 1 && pol.editStart(b.lines, b.row) === null
    ) {
      b.place(b.row + 1, 0);
    }
  }

  /** Reveal more of the underlying file around a hunk (Ctrl-L). When the text
   * cursor is active the hunk is the one it sits in and the view follows the
   * cursor; in pager mode it is the hunk nearest one quarter down the visible
   * content, and the view holds the far edge of that hunk still so the revealed
   * lines open a gap in front of the user. The extra context is applied to the
   * baseline too, so it does not count as an unsaved edit. */
  #performExpand(): void {
    if (!this.#source?.expandContext || !this.#buffer) {
      this.#message = "Expanding context isn't available here.";
      return;
    }
    let refLine: number;
    let up: boolean | undefined;
    if (this.#cursorOn) {
      refLine = this.#buffer.row; // the cursor names a point, not an edge
    } else {
      const offer = this.#expandOffer();
      // Ctrl-L is not offered in any of these, so it changes nothing and there
      // is nothing to leave the reason standing next to: say why, and take it
      // away again once it has been read.
      if (offer === null) {
        this.#message = "Move to a hunk's edge, then Ctrl-L to expand it.";
        this.transientMessage = true;
        return;
      }
      if ("blocked" in offer) {
        this.#message = offer.blocked === "top"
          ? "Top of file."
          : offer.blocked === "bottom"
          ? "Bottom of file."
          : "No more context to show.";
        this.transientMessage = true;
        return;
      }
      refLine = offer.line;
      up = offer.up;
      if (this.#wrapLines) {
        this.#syncWrapDecorations(this.#displayDiffAnnotations(offer));
      }
    }
    const r = this.#source.expandContext(
      this.#buffer.text(),
      this.#buffer.baseline(),
      refLine,
      up,
    );
    if (!r) {
      this.#message = "No more context to show.";
      return;
    }
    // The node the selection denotes, captured before the reparse renumbers the
    // structure tree under it. The pinned line's row is captured too, before the
    // fold plan (which the reparse invalidates) changes.
    const selected = this.#cursorOn ? null : this.#selectedNode();
    // Where a line of the old text lands in the new one.
    const moved = (n: number) =>
      n + (n >= r.insertedAt ? r.inserted : 0) -
      (r.removedAt !== null && n > r.removedAt ? 1 : 0);
    const lineEndings = r.text.split("\n").map(() => undefined) as Array<
      LineEndingProvenance | undefined
    >;
    const insertedAt = r.insertedAt -
      (r.removedAt !== null && r.up ? 1 : 0);
    for (const [offset, ending] of r.insertedLineEndings.entries()) {
      lineEndings[insertedAt + offset] = ending;
    }
    for (
      let row = 0;
      row < this.#buffer.lineEndingProvenance().length;
      row++
    ) {
      if (row === r.removedAt) continue;
      const ending = this.#buffer.lineEndingProvenance()[row];
      if (ending !== undefined) lineEndings[moved(row)] = ending;
    }
    // The line held still on screen: the one just outside the edge the revealed
    // lines go in at, so they open a gap on the hunk's side of it. Expanding
    // upwards holds the hunk's header and pushes the body down; expanding
    // downwards holds what follows the hunk and lifts the body up. A join takes
    // that very header away, so what is held is the line the other side of it —
    // the neighboring hunk's body, which is what is left to hold on to.
    const pinDoc = r.removedAt !== null
      ? (r.up ? r.removedAt - 1 : r.removedAt + 1)
      : (r.up ? r.insertedAt - 1 : r.insertedAt);
    const pinRow = this.#toDisplay(pinDoc) - this.top;
    const col = this.#cursorOn ? this.#buffer.col : 0;
    this.#buffer.setBaseline(r.baseline);
    this.#buffer.setText(
      r.text,
      r.cursorLine,
      col,
      lineEndings,
    );
    this.#splitRow = null;
    this.#setSourceDocument(
      this.#source.parse(r.text, this.#buffer.lineEndingProvenance()),
    );
    this.needsReparse = false;
    this.#wrapDecorations = new Map();
    this.#wrapDecorationKey = "";
    this.#wrapPlanCache = undefined;
    this.#expansionLayoutCache = undefined;
    if (this.#cursorOn) {
      this.#seedHighlighter();
      this.#clampScroll();
      this.#ensureCursorVisible();
      this.#reportReveal(r);
      return;
    }
    // Pager mode: re-point the selection at the same node (its line moved), and
    // put the pinned line back on the row it was on.
    this.#reselectAfterExpand(selected, moved);
    const movedPin = moved(pinDoc);
    if (this.#wrapLines) {
      const basePlan = this.#baseWrapPlan();
      const basePin = this.#toDisplayWithPlan(movedPin, 0, basePlan);
      const baseTop = clamp(
        basePin - pinRow,
        0,
        this.#pagerLastTop(basePlan.rowCount, basePlan),
      );
      this.top = baseTop;
      const next = this.#expandOffer();
      const nextOffer = next && !("blocked" in next) ? next : null;
      let nextAnnotations = this.#displayDiffAnnotations(nextOffer);
      let state = this.#wrapDecorationState(nextAnnotations);
      this.#wrapDecorations = state.decorations;
      this.#wrapDecorationKey = state.key;
      this.#wrapPlanCache = undefined;
      let decoratedPlan = this.#wrapPlan();
      let decoratedTop = clamp(
        this.#toDisplayWithPlan(movedPin, 0, decoratedPlan) - pinRow,
        0,
        this.#pagerLastTop(decoratedPlan.rowCount, decoratedPlan),
      );
      const visible = this.#metadataWithVisibleTriangle(
        nextAnnotations,
        decoratedPlan,
        decoratedTop,
      );
      if (visible.length !== nextAnnotations.length) {
        nextAnnotations = visible;
        state = this.#wrapDecorationState(nextAnnotations);
        this.#wrapDecorations = state.decorations;
        this.#wrapDecorationKey = state.key;
        this.#wrapPlanCache = undefined;
        decoratedPlan = this.#wrapPlan();
        decoratedTop = clamp(
          this.#toDisplayWithPlan(movedPin, 0, decoratedPlan) - pinRow,
          0,
          this.#pagerLastTop(decoratedPlan.rowCount, decoratedPlan),
        );
      }
      this.top = decoratedTop;
      this.#expansionLayoutCache = {
        decoratedPlan,
        decoratedTop: this.top,
        basePlan,
        baseTop,
      };
    } else {
      this.top = this.#toDisplay(movedPin) - pinRow;
    }
    this.#clampScroll();
    // The revealed lines fill the gap the insertion point opened, so the driver
    // can walk them in from the held edge. A join is drawn in one step instead:
    // its frames would stand the two hunks' bodies next to each other before the
    // lines that join them had arrived, showing a file that reads nothing like
    // the one on disk.
    this.pendingReveal = r.removedAt !== null || this.#wrapLines ? null : {
      row: this.#toDisplay(r.insertedAt),
      count: r.inserted,
      up: r.up,
    };
    this.#reportReveal(r);
  }

  /** Say what a reveal showed: which way it reached, and which lines of the file
   * came back with it. Naming the lines is the point — one run of context looks
   * like any other, and the file's own numbers are what tie them to it. A reveal
   * that closed the last gap between two hunks says so too, since a header
   * disappearing is otherwise left to be puzzled over. */
  #reportReveal(r: ExpandResult): void {
    const { from, to } = r.revealed;
    const lines = from === to ? `line ${from}` : `lines ${from}-${to}`;
    const where = r.up ? "above" : "below";
    this.#message = r.removedAt !== null
      ? `Showing ${lines} ${where} — the two hunks are now one.`
      : `Showing ${lines} ${where} the hunk.`;
    this.transientMessage = true;
  }

  /** After a pager-mode expand rebuilds the structure tree, point the selection
   * back at the same node, at wherever `moved` puts its line. Cleared when the
   * node can no longer be found — a join takes one of the two hunks away, and
   * there is nothing to point at. A hunk is matched on its line alone: only one
   * hunk starts at a given header line, and its label (the `@@` counts) changes
   * as the hunk grows; other kinds keep the label, which is stable and tells
   * apart nodes sharing a start line. */
  #reselectAfterExpand(
    node: StructureNode | null,
    moved: (line: number) => number,
  ): void {
    if (!node) return;
    const startLine = moved(node.startLine);
    const idx = this.doc.flatStructure.findIndex((n) =>
      n.startLine === startLine && n.kind === node.kind &&
      (node.kind === "hunk" || n.label === node.label)
    );
    this.#selectedIndex = idx >= 0 ? idx : null;
  }

  /** Whether a node overlaps one viewport under a specific wrapped layout.
   * Nodes inside a collapsed file are excluded because their hidden lines map
   * to the visible file summary. */
  #nodeOnScreenWithLayout(
    node: StructureNode,
    plan: WrapPlan | null,
    top: number,
  ): boolean {
    const inHiddenFile = this.#foldFiles().some((f) =>
      this.#collapsed.has(f.index) &&
      node.startLine > f.headerLine && node.startLine <= f.endLine
    );
    if (inHiddenFile) return false;
    return this.#nodeEndRowWithPlan(node, plan) >= top &&
      this.#nodeStartRowWithPlan(node, plan) < top + this.#contentRows();
  }

  /** The row one quarter down the screen's content area. */
  #expansionTargetRow(top: number): number {
    return top + Math.floor((this.#contentRows() - 1) / 4);
  }

  /** Expansion layout without the annotations that the chosen edge produces. */
  #expansionLayout(): { plan: WrapPlan | null; top: number } {
    if (!this.#wrapLines) return { plan: null, top: this.top };
    const decorated = this.#wrapPlan();
    const base = this.#baseWrapPlan();
    if (
      this.#expansionLayoutCache?.decoratedPlan === decorated &&
      this.#expansionLayoutCache.basePlan === base &&
      this.#expansionLayoutCache.decoratedTop === this.top
    ) {
      return { plan: base, top: this.#expansionLayoutCache.baseTop };
    }
    const topRow = wrappedRowAt(
      decorated,
      clamp(this.top, 0, Math.max(0, decorated.rowCount - 1)),
    );
    const baseTop = topRow
      ? wrappedRowForPosition(base, topRow.line, topRow.offset)?.row ?? 0
      : 0;
    this.#expansionLayoutCache = {
      decoratedPlan: decorated,
      decoratedTop: this.top,
      basePlan: base,
      baseTop,
    };
    return { plan: base, top: baseTop };
  }

  /** How much context each hunk can still reveal, keyed by its header line.
   * Cached against the document, which the source rebuilds on every expand. */
  #expandRoom(): ReadonlyMap<number, HunkRoom> {
    if (this.#roomCache?.doc !== this.#currentDoc) {
      this.#roomCache = {
        doc: this.#currentDoc,
        room: this.#source?.expandRoom?.(this.#currentDoc.text) ?? new Map(),
      };
    }
    return this.#roomCache.room;
  }

  /** Lines classified as file or hunk metadata by the diff parser. */
  #diffMetadataLines(): readonly number[] {
    if (this.#diffMetadataCache?.doc === this.#currentDoc) {
      return this.#diffMetadataCache.lines;
    }
    const lines: number[] = [];
    const model = parseDiff(this.#currentDoc.text);
    if (model) {
      for (let line = 0; line < model.lines.length; line++) {
        const kind = model.lines[line].kind;
        if (kind === "meta" || kind === "hunk") {
          lines.push(line);
        }
      }
    }
    this.#diffMetadataCache = { doc: this.#currentDoc, lines };
    return lines;
  }

  /** Metadata line directly beyond the marked expansion edge. */
  #adjacentDiffMetadataLine(expand: ExpandOffer | null): number | null {
    if (!expand || expand.markerLine === null) return null;
    const line = expand.up ? expand.line : expand.line + 1;
    return this.#diffMetadataLines().includes(line) ? line : null;
  }

  /** Screen rows of metadata directly beyond the marked expansion edge. */
  #displayAdjacentDiffMetadataRows(
    expand: ExpandOffer | null,
  ): readonly number[] {
    const line = this.#adjacentDiffMetadataLine(expand);
    if (line === null) return [];
    const fold = this.#foldPlan();
    const folded = fold.docToDisplay(line);
    if (fold.displayLines[folded] !== this.#currentDoc.lines[line]) return [];
    const first = this.#toDisplay(line);
    const last = this.#toDisplayEnd(line);
    const rows: number[] = [];
    for (let row = first; row <= last; row++) rows.push(row);
    return rows;
  }

  /** Annotations for an expansion triangle visible in the base layout. */
  #displayDiffAnnotations(
    expand: ExpandOffer | null,
  ): DiffAnnotation[] {
    const { top } = this.#expansionLayout();
    if (
      !expand || expand.markerLine === null || expand.row === null ||
      expand.row < top || expand.row >= top + this.#contentRows()
    ) {
      return [];
    }
    const fold = this.#foldPlan();
    const marker = fold.docToDisplay(expand.markerLine);
    if (
      fold.displayLines[marker] !== this.#currentDoc.lines[expand.markerLine]
    ) {
      return [];
    }
    const annotations: DiffAnnotation[] = [{
      line: marker,
      kind: expand.up ? "expandUp" : "expandDown",
    }];
    const metadataLine = this.#adjacentDiffMetadataLine(expand);
    if (metadataLine !== null) {
      const metadata = fold.docToDisplay(metadataLine);
      if (
        fold.displayLines[metadata] === this.#currentDoc.lines[metadataLine]
      ) {
        annotations.push({ line: metadata, kind: "diffMetadata" });
      }
    }
    return annotations;
  }

  /** Apply line-specific wrap widths while keeping the viewport's source
   * position fixed. */
  #syncWrapDecorations(
    annotations: readonly DiffAnnotation[],
  ): DiffAnnotation[] {
    let visible = [...annotations];
    const baseTop = this.#wrapLines ? this.#expansionLayout().top : 0;
    const anchor = this.#wrapLines ? this.#viewportAnchor() : null;
    if (anchor) {
      const tentative = this.#wrapDecorationState(visible);
      const plan = buildWrapPlan(
        this.#foldPlan().displayLines,
        this.#displayMode,
        this.#contentWidth(),
        tentative.decorations,
        this.#activeWrapMode,
      );
      const top = this.#wrappedTopForAnchor(anchor, plan);
      visible = this.#metadataWithVisibleTriangle(visible, plan, top);
    }
    const state = this.#wrapDecorationState(visible);
    if (state.key === this.#wrapDecorationKey) return visible;
    this.#wrapDecorations = state.decorations;
    this.#wrapDecorationKey = state.key;
    this.#wrapPlanCache = undefined;
    if (anchor) {
      this.#restoreWrappedAnchor(anchor);
      this.#expansionLayoutCache = {
        decoratedPlan: this.#wrapPlan(),
        decoratedTop: this.top,
        basePlan: this.#baseWrapPlan(),
        baseTop,
      };
    }
    return visible;
  }

  /** Top row produced by restoring one source position in a wrapped plan. */
  #wrappedTopForAnchor(anchor: ViewportAnchor, plan: WrapPlan): number {
    const line = clamp(
      anchor.foldedLine,
      0,
      Math.max(0, plan.firstRow.length - 1),
    );
    const row = wrappedRowForPosition(plan, line, anchor.displayCol)?.row ?? 0;
    return clamp(row, 0, this.#pagerLastTop(plan.rowCount, plan));
  }

  /** Hide a metadata label when its reflow pushes the triangle off-screen. */
  #metadataWithVisibleTriangle(
    annotations: readonly DiffAnnotation[],
    plan: WrapPlan,
    top: number,
  ): DiffAnnotation[] {
    const triangle = annotations.find((annotation) =>
      annotation.kind !== "diffMetadata"
    );
    if (
      !triangle ||
      !annotations.some((annotation) => annotation.kind === "diffMetadata")
    ) {
      return [...annotations];
    }
    const row = plan.firstRow[triangle.line];
    if (row >= top && row < top + this.#contentRows()) {
      return [...annotations];
    }
    return annotations.filter((annotation) =>
      annotation.kind !== "diffMetadata"
    );
  }

  /** Wrap widths and cache identity for one set of diff annotations. */
  #wrapDecorationState(
    annotations: readonly DiffAnnotation[],
  ): { decorations: Map<number, WrapDecoration>; key: string } {
    const decorations = new Map<number, WrapDecoration>();
    const contentWidth = this.#contentWidth();
    const totalsWidth = this.#wrapLines ? this.#cornerTotalsWidth() : 0;
    const metadataLabelLine = this.#wrapLines
      ? labeledDiffMetadataLine(
        this.#foldPlan().displayLines,
        this.#displayMode,
        contentWidth,
        annotations,
        totalsWidth,
      )
      : null;
    if (this.#wrapLines) {
      for (const annotation of annotations) {
        decorations.set(
          annotation.line,
          diffAnnotationDecoration(
            annotation.kind,
            contentWidth,
            annotation.kind !== "diffMetadata" ||
              annotation.line === metadataLabelLine,
          ),
        );
      }
      if (totalsWidth > 0) {
        decorations.set(
          0,
          diffTotalsDecoration(totalsWidth, contentWidth, decorations.get(0)),
        );
      }
    }
    const key = this.#wrapLines
      ? `${contentWidth}|${this.#displayMode}|${
        metadataLabelLine ?? "-"
      }|${totalsWidth}|${
        annotations.map((annotation) => `${annotation.line}:${annotation.kind}`)
          .join(",")
      }`
      : "";
    return { decorations, key };
  }

  /** Every hunk boundary visible at its expansion row. `markerLine` names the
   * first or last body line and is null when the hunk has no body. */
  #visibleEdges(
    plan: WrapPlan | null,
    top: number,
  ): ExpandEdge[] {
    const room = this.#expandRoom();
    const rows = this.#contentRows();
    const onScreen = (row: number) => row >= top && row < top + rows;
    const out: ExpandEdge[] = [];
    for (const h of this.doc.flatStructure) {
      if (
        h.kind !== "hunk" || !this.#nodeOnScreenWithLayout(h, plan, top)
      ) {
        continue;
      }
      const r = room.get(h.startLine);
      if (!r) continue;
      const firstBodyLine = h.startLine + 1;
      const hasBody = firstBodyLine <= h.endLine;
      // Expansion visibility stays on the hunk boundary. A separate body-line
      // row places the marker without moving which edge Ctrl-L targets.
      for (
        const [line, markerLine, up] of [
          [h.startLine, hasBody ? firstBodyLine : null, true],
          [h.endLine, hasBody ? h.endLine : null, false],
        ] as const
      ) {
        const aimRow = this.#toDisplayEndWithPlan(line, plan);
        const row = markerLine === null
          ? null
          : this.#toDisplayWithPlan(markerLine, 0, plan);
        if (onScreen(aimRow)) {
          out.push({ row, markerLine, aimRow, line, up, room: r });
        }
      }
    }
    return out;
  }

  /** The hunk edge Ctrl-L acts on in pager mode: the visible one nearest the
   * row one quarter down the visible content, or nearest a selected node when
   * one sits in a hunk. Null when no edge is on screen. The edge is returned
   * whether or not it has room, so that the offer of Ctrl-L and what Ctrl-L
   * does agree. */
  #expandEdge(): ExpandEdge | null {
    const { plan, top } = this.#expansionLayout();
    const edges = this.#visibleEdges(plan, top);
    if (edges.length === 0) return null;
    // A selected node sitting in a hunk aims at that hunk, and its own row is
    // what the edges are measured from: the user picked a place to look.
    const sel = this.#selectedNode();
    const own = sel && this.#nodeOnScreenWithLayout(sel, plan, top)
      ? edges.filter((e) =>
        this.doc.flatStructure.some((h) =>
          h.kind === "hunk" && h.startLine <= e.line && e.line <= h.endLine &&
          sel.startLine >= h.startLine && sel.startLine <= h.endLine
        )
      )
      : [];
    const from = own.length > 0
      ? this.#nodeStartRowWithPlan(sel!, plan)
      : this.#expansionTargetRow(top);
    const pool = own.length > 0 ? own : edges;
    // Distance in display rows: a collapsed file stands on one row, and the
    // lines it hides are not distance the eye travels.
    let best = pool[0];
    for (const e of pool) {
      const distance = Math.abs(e.aimRow - from);
      const bestDistance = Math.abs(best.aimRow - from);
      const available = e.up ? e.room.up : e.room.down;
      const bestAvailable = best.up ? best.room.up : best.room.down;
      // A hunk with no body has coincident boundaries. Prefer the direction
      // with context when the other direction has none.
      if (
        distance < bestDistance ||
        (e.aimRow === best.aimRow && available > 0 && bestAvailable === 0)
      ) {
        best = e;
      }
    }
    return best;
  }

  /** Whether Ctrl-L would reveal anything, and what stops it when it would not.
   * Drives the edge marker, the status bar's offer of Ctrl-L, and the key
   * itself. */
  #expandOffer():
    | ExpandOffer
    | { blocked: "top" | "bottom" | "hunk" }
    | null {
    const edge = this.#expandEdge();
    if (!edge) return null;
    if ((edge.up ? edge.room.up : edge.room.down) > 0) {
      return {
        row: edge.row,
        markerLine: edge.markerLine,
        line: edge.line,
        up: edge.up,
      };
    }
    if (edge.up) return { blocked: edge.room.atFileTop ? "top" : "hunk" };
    return { blocked: edge.room.atFileBottom ? "bottom" : "hunk" };
  }

  //
  // file picker (C-x C-f)
  //

  #openFilePicker(): void {
    if (!this.#files) {
      this.#message = "Opening files isn't available here.";
      return;
    }
    const wasCursorOn = this.#cursorOn;
    this.#cursorOn = false;
    // Opening the picker drops the text cursor, and cancelling it returns to
    // navigation, which reads the structure tree. Refresh it here as leaving
    // edit mode by Esc does, so that return lands on a current tree.
    this.reparse();
    if (wasCursorOn) this.#ensureCursorVisible();
    else this.#clampScroll();
    this.#overlay = null;
    this.#overlayStack = [];
    this.#pickerDir = this.#pickerStartDir();
    this.#pickerFilter = "";
    this.#pickerSel = 0;
    this.#overlayScroll = 0;
    this.#mode = "filePicker";
    this.#refreshPicker();
  }

  /** Open at the current file's directory, else the gateway's cwd. */
  #pickerStartDir(): string {
    const path = this.#source?.path;
    if (path && this.#files) return this.#files.parent(path);
    return this.#files!.cwd();
  }

  /** Re-list the current directory, filtered by what has been typed. */
  #refreshPicker(): void {
    if (!this.#files) return;
    const all = this.#files.list(this.#pickerDir) ?? [];
    const f = this.#pickerFilter.toLowerCase();
    const matched = all.filter((e) => e.name.toLowerCase().includes(f));
    matched.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    );
    // A ".." entry to step up, offered when not narrowing by a filter.
    this.#pickerEntries = this.#pickerFilter.length === 0
      ? [{ name: "..", isDir: true }, ...matched]
      : matched;
    this.#pickerSel = clamp(
      this.#pickerSel,
      0,
      Math.max(0, this.#pickerEntries.length - 1),
    );
    this.#scrollListToSelection(this.#pickerSel);
  }

  /** Scroll the overlay list so row `sel` sits inside the box. Shared by the
   * file picker and the jump list, which both project a selectable list into an
   * {@link OverlayState} scrolled by `overlayScroll`. */
  #scrollListToSelection(sel: number): void {
    const innerH = overlayBox(this.width, this.height).innerH;
    if (sel < this.#overlayScroll) {
      this.#overlayScroll = sel;
    } else if (sel >= this.#overlayScroll + innerH) {
      this.#overlayScroll = sel - innerH + 1;
    }
  }

  #handleFilePicker(key: Key): void {
    this.#message = "";
    switch (key.name) {
      case "escape":
        this.#mode = "normal";
        this.#overlayScroll = 0;
        this.#message = "Cancelled";
        return;
      case "backspace":
        if (this.#pickerFilter.length > 0) {
          this.#pickerFilter = this.#pickerFilter.slice(0, -1);
          this.#pickerSel = 0;
          this.#refreshPicker();
        } else {
          this.#pickerUp();
        }
        return;
      case "tab":
      case "enter":
        this.#activatePicked();
        return;
    }
    if (key.char && key.char >= " " && !key.ctrl) {
      this.#pickerFilter += key.char;
      this.#pickerSel = 0;
      this.#refreshPicker();
    }
  }

  #pickerUp(): void {
    if (!this.#files) return;
    this.#pickerDir = this.#files.parent(this.#pickerDir);
    this.#pickerFilter = "";
    this.#pickerSel = 0;
    this.#overlayScroll = 0;
    this.#refreshPicker();
  }

  /** Act on the highlighted entry: step up, descend a directory, or open a
   * file. With nothing highlighted, treat the typed text as a filename. */
  #activatePicked(): void {
    if (!this.#files) return;
    const entry = this.#pickerEntries[this.#pickerSel];
    if (!entry) {
      if (this.#pickerFilter.length > 0) {
        this.#openPickedFile(
          this.#files.join(this.#pickerDir, this.#pickerFilter),
        );
      }
      return;
    }
    if (entry.name === "..") {
      this.#pickerUp();
      return;
    }
    const target = this.#files.join(this.#pickerDir, entry.name);
    if (entry.isDir) {
      this.#pickerDir = target;
      this.#pickerFilter = "";
      this.#pickerSel = 0;
      this.#overlayScroll = 0;
      this.#refreshPicker();
    } else {
      this.#openPickedFile(target);
    }
  }

  /** Replace the session's buffer/source/document with the chosen file. Refuses
   * when the current buffer has unsaved edits, to avoid losing them. */
  #openPickedFile(absPath: string): void {
    if (!this.#files) return;
    if (this.#buffer?.dirty()) {
      this.#mode = "normal";
      this.#message =
        "Save or discard your changes before opening another file.";
      return;
    }
    const opened = this.#files.open(absPath);
    if (!opened) {
      this.#mode = "normal";
      this.#message = `Cannot open ${absPath}`;
      return;
    }
    this.#source = opened.source;
    if (opened.source.defaultViewMode === "rendered") {
      this.#viewMode = "rendered";
    }
    this.#buffer = new EditBuffer(
      opened.text,
      opened.source.lineEndingProvenance?.(opened.text),
    );
    this.#splitRow = null;
    this.#highlighter = undefined; // the old highlighter was for the previous file
    this.#clearFolds(); // the previous file's fold indices do not carry over
    this.#setSourceDocument(
      opened.source.parse(
        opened.text,
        this.#buffer.lineEndingProvenance(),
      ),
    );
    this.#semantics = undefined; // the old service was for the previous file
    this.#mode = "normal";
    this.#cursorOn = false;
    this.#overlay = null;
    this.#overlayScroll = 0;
    this.#overlayStack = [];
    this.#selectedIndex = null;
    this.#query = "";
    this.#matches = [];
    this.#currentMatch = 0;
    this.top = 0;
    this.left = 0;
    this.#message = `Opened ${opened.source.label ?? absPath}`;
  }

  #pickerOverlay(): OverlayState {
    const lines: Line[] = this.#pickerEntries.map((e) => {
      const text = e.isDir ? `${e.name}/` : e.name;
      const cls: TokenClass = e.isDir ? "builderCall" : "plain";
      return { text, spans: [{ col: 0, text, cls }] };
    });
    if (lines.length === 0) {
      const text = "(no matching files)";
      lines.push({ text, spans: [{ col: 0, text, cls: "comment" }] });
    }
    const name = this.#files?.base(this.#pickerDir) || this.#pickerDir;
    return {
      title: `Open file — ${name}`,
      lines,
      scroll: this.#overlayScroll,
      footer: "↑/↓ select · enter open · ⌫ up · esc cancel",
      selectedLine: this.#pickerEntries.length > 0
        ? this.#pickerSel
        : undefined,
    };
  }

  //
  // jump list (i)
  //

  /** Commit headers in the current diff, cached against its document. */
  #commitHeaders(): readonly CommitHeader[] {
    if (!this.#source?.isDiff) return [];
    if (this.#commitHeaderCache?.doc !== this.#currentDoc) {
      this.#commitHeaderCache = {
        doc: this.#currentDoc,
        headers: findCommitHeaders(
          this.#currentDoc.lines.map((line) => line.text),
        ),
      };
    }
    return this.#commitHeaderCache.headers;
  }

  /** Open the list of the diff's files and commit messages, so Enter jumps the
   * view to the one chosen. Only a diff has this list; a plain source view says
   * so and stays put. */
  #openJumpList(): void {
    const entries = this.#buildJumpEntries();
    if (entries.length === 0) {
      this.#message = "The jump list is only available in a diff view.";
      return;
    }
    this.#jumpAll = entries;
    this.#jumpFilter = "";
    this.#jumpSearching = false;
    this.#overlayScroll = 0;
    this.#mode = "jumpList";
    this.#refreshJump();
    // Open focused on the file the viewport is already reading, so the list
    // starts where the eye is.
    this.#jumpSel = this.#jumpEntryAtViewport();
    this.#scrollJumpToSelection(this.#jumpSel);
  }

  /** Every file the diff touches and every commit whose message it carries, in
   * document order. Empty for a non-diff view. */
  #buildJumpEntries(): JumpEntry[] {
    if (!this.#source?.isDiff) return [];
    const texts = this.#currentDoc.lines.map((l) => l.text);
    const subjects = commitSubjects(texts);
    const counts = this.#jumpDiffCounts();
    const headers = this.#commitHeaders();
    const files = this.#foldFiles();
    const entries: JumpEntry[] = [];
    for (const [index, header] of headers.entries()) {
      const endLine = (headers[index + 1]?.line ?? texts.length) - 1;
      const commitFiles = files.filter((file) =>
        file.headerLine > header.line && file.headerLine <= endLine
      );
      const subject = subjects.get(header.sha) ?? "";
      const short = header.sha.slice(0, 9);
      entries.push({
        line: header.line,
        endLine,
        display: commitJumpLine(
          short,
          subject,
          sumDiffLineCounts(
            commitFiles.map((file) => counts.files[file.index] ?? file),
          ),
          commitFiles.length > 0 &&
            commitFiles.every((file) => this.#collapsed.has(file.index)),
        ),
        filterText: `commit ${header.sha} ${subject}`.toLowerCase(),
        name: `commit ${short}`,
      });
    }
    for (const file of files) {
      const fileCounts = counts.files[file.index] ?? file;
      entries.push({
        line: file.headerLine,
        endLine: file.endLine,
        display: fileJumpLine(
          file,
          this.#collapsed.has(file.index),
          fileCounts,
        ),
        filterText: file.path.toLowerCase(),
        name: file.path,
        fileIndex: file.index,
      });
    }
    entries.sort((a, b) => a.line - b.line);
    return entries;
  }

  /** Re-derive the shown rows from the filter, keeping the selection in range. */
  #refreshJump(): void {
    const f = this.#jumpFilter.toLowerCase();
    this.#jumpEntries = f.length === 0
      ? this.#jumpAll
      : this.#jumpAll.filter((e) => e.filterText.includes(f));
    this.#jumpSel = clamp(
      this.#jumpSel,
      0,
      Math.max(0, this.#jumpEntries.length - 1),
    );
    this.#scrollJumpToSelection(this.#jumpSel);
  }

  /** The index of the entry the viewport currently sits on: the last one whose
   * jump line is at or above the top document line. */
  #jumpEntryAtViewport(): number {
    const line = this.#toDoc(this.top);
    let idx = 0;
    for (let i = 0; i < this.#jumpEntries.length; i++) {
      if (this.#jumpEntries[i].line <= line) idx = i;
      else break;
    }
    return idx;
  }

  #handleJumpList(key: Key): void {
    this.#message = "";
    if (
      key.name === "escape" ||
      (key.name === "q" && !this.#jumpSearching)
    ) {
      if (this.#jumpSearching) {
        this.#jumpSearching = false;
        this.#jumpFilter = "";
        this.#jumpSel = 0;
        this.#refreshJump();
        return;
      }
      this.#mode = "normal";
      this.#overlayScroll = 0;
      this.#message = "Cancelled";
      return;
    }
    switch (key.name) {
      case "backspace":
        if (this.#jumpSearching && this.#jumpFilter.length > 0) {
          this.#jumpFilter = this.#jumpFilter.slice(0, -1);
          this.#jumpSel = 0;
          this.#refreshJump();
        }
        return;
      case "tab":
      case "enter":
        this.#activateJump();
        return;
    }
    if (this.#jumpSearching && key.char && key.char >= " " && !key.ctrl) {
      this.#jumpFilter += key.char;
      this.#jumpSel = 0;
      this.#refreshJump();
      return;
    }
    switch (key.name) {
      case "<":
        this.#stepCommit(false);
        return;
      case ">":
        this.#stepCommit(true);
        return;
      case "/":
        this.#jumpSearching = true;
        this.#jumpFilter = "";
        this.#jumpSel = 0;
        this.#refreshJump();
        return;
      case "f":
        this.#toggleJumpFile();
        return;
      case "F":
        this.#collapseAllFiles();
        this.#rebuildJumpEntries();
        return;
      case "E":
        this.#expandAllFiles();
        this.#rebuildJumpEntries();
        return;
      case "T":
        this.#toggleFileCategory((file) => file.isTest, "test");
        this.#rebuildJumpEntries();
        return;
      case "M":
        this.#toggleFileCategory((file) => file.isMarkdown, "Markdown");
        this.#rebuildJumpEntries();
        return;
      case "D":
        this.#cycleJumpCountMode();
        return;
    }
  }

  /** Toggles the highlighted file or all files belonging to its commit row. */
  #toggleJumpFile(): void {
    const entry = this.#jumpEntries[this.#jumpSel];
    if (!entry) return;
    if (entry.fileIndex === undefined) {
      this.#toggleFileCategory(
        (file) =>
          file.headerLine > entry.line &&
          file.headerLine <= entry.endLine,
        entry.name,
      );
    } else {
      this.#toggleFile(this.#foldFiles()[entry.fileIndex]);
    }
    this.#rebuildJumpEntries();
  }

  /** Moves to the preceding or following commit header in the active view. */
  #stepCommit(forward: boolean): void {
    const inList = this.#mode === "jumpList";
    const positions = inList
      ? this.#jumpEntries.flatMap((entry, index) =>
        entry.fileIndex === undefined ? [index] : []
      )
      : this.#commitHeaders().map((header) => this.#toDisplay(header.line));
    const current = inList ? this.#jumpSel : this.top;
    const target = forward
      ? positions.find((position) => position > current)
      : positions.findLast((position) => position < current);
    if (target === undefined) return;
    if (inList) {
      this.#jumpSel = target;
      this.#scrollJumpToSelection(target);
    } else {
      this.#jumpToLine(this.#toDoc(target));
    }
  }

  /** Keeps the selection visible and reveals the summary at the last entry. */
  #scrollJumpToSelection(selection: number): void {
    this.#scrollListToSelection(selection);
    const innerHeight = overlayBox(this.width, this.height).innerH;
    if (
      innerHeight > 0 && this.#jumpEntries.length > 0 &&
      selection === this.#jumpEntries.length - 1
    ) {
      this.#overlayScroll = Math.max(
        0,
        this.#jumpEntries.length + 3 - innerHeight,
      );
    }
  }

  /** Rebuilds jump rows after visibility or count settings change. */
  #rebuildJumpEntries(): void {
    this.#jumpAll = this.#buildJumpEntries();
    this.#refreshJump();
  }

  /** Advances to the next diff-count policy and refreshes every count shown. */
  #cycleJumpCountMode(): void {
    const index = DIFF_COUNT_MODES.indexOf(this.#jumpCountMode);
    this.#jumpCountMode = DIFF_COUNT_MODES[
      (index + 1) % DIFF_COUNT_MODES.length
    ];
    this.#rebuildJumpEntries();
  }

  /** Counts for the current source document under the selected policy. */
  #jumpDiffCounts(): DiffCounts {
    if (
      this.#jumpCountCache?.doc !== this.#sourceDoc ||
      this.#jumpCountCache.mode !== this.#jumpCountMode
    ) {
      this.#jumpCountCache = {
        doc: this.#sourceDoc,
        mode: this.#jumpCountMode,
        counts: diffCounts(
          this.#sourceDoc.text,
          this.#sourceDoc.lines,
          this.#jumpCountMode,
          this.#jumpCountMode === "comments"
            ? this.#source?.diffCountContexts?.(this.#sourceDoc.text)
            : undefined,
        ),
      };
    }
    return this.#jumpCountCache.counts;
  }

  /** Jump to the highlighted entry and close the list. A filter that matches
   * nothing leaves the list open so it can be edited. */
  #activateJump(): void {
    const entry = this.#jumpEntries[this.#jumpSel];
    if (!entry) return;
    this.#mode = "normal";
    this.#overlayScroll = 0;
    this.#jumpToLine(entry.line);
    this.#message = `Jumped to ${entry.name}`;
  }

  /** Land document line `docLine` at the top of the viewport, dropping any node
   * selection so tree navigation resumes from where the jump landed. */
  #jumpToLine(docLine: number): void {
    this.#selectedIndex = null;
    this.top = clamp(
      this.#toDisplay(docLine),
      0,
      this.#lastTop(),
    );
    this.left = 0;
  }

  #jumpOverlay(): OverlayState {
    const lines: Line[] = this.#jumpEntries.map((e) => e.display);
    if (lines.length === 0) {
      const text = "(no matches)";
      lines.push({ text, spans: [{ col: 0, text, cls: "comment" }] });
    }
    const counts = this.#jumpDiffCounts();
    const shown = sumDiffLineCounts(
      counts.files.filter((_, index) => !this.#collapsed.has(index)),
    );
    lines.push(
      { text: "", spans: [] },
      jumpCountModeLine(this.#jumpCountMode),
      jumpCountSummaryLine(counts.totals, shown),
    );
    const commitHint = this.#commitHeaders().length > 1 ? " · <> commits" : "";
    return {
      title: "Jump to file or commit",
      lines,
      scroll: this.#overlayScroll,
      footer: this.#jumpSearching
        ? "type · ↑↓ select · Space page · Enter jump · Esc list"
        : `↑↓ g G${commitHint} · / filter · f F E T M · D · Enter · Esc`,
      selectedLine: this.#jumpEntries.length > 0 ? this.#jumpSel : undefined,
    };
  }

  #navigateTree(
    step: (flat: readonly StructureNode[], idx: number) => number,
  ): void {
    if (this.doc.flatStructure.length === 0) {
      this.#message = "No structure detected";
      return;
    }
    // Navigation walks only the nodes that are on screen: a collapsed file's
    // interior (its hunks and code) is skipped, leaving just the file itself.
    const nav = this.#navigableIndices();
    const navNodes = nav.map((i) => this.doc.flatStructure[i]);
    if (this.#selectedIndex === null) {
      this.#selectNode(nav[this.#viewportNodeIndex(navNodes)]);
      return;
    }
    let cur = nav.indexOf(this.#selectedIndex);
    if (cur < 0) cur = this.#reselectAfterCollapse(navNodes); // hidden by a fold
    this.#selectNode(nav[step(navNodes, cur)]);
  }

  /** The full-flatStructure indices navigation may land on: every node except
   * the interior of a collapsed file — its `section` node stays (it represents
   * the collapsed file), its descendants are dropped. */
  #navigableIndices(): number[] {
    const flat = this.doc.flatStructure;
    if (this.#collapsed.size === 0) return flat.map((_, i) => i);
    const hidden = this.#foldFiles().filter((f) =>
      this.#collapsed.has(f.index)
    );
    const out: number[] = [];
    for (let i = 0; i < flat.length; i++) {
      const n = flat[i];
      const file = hidden.find((f) =>
        n.startLine >= f.headerLine && n.startLine <= f.endLine
      );
      // Keep the file's own section node; drop everything inside it.
      if (file && !(n.kind === "section" && n.startLine === file.headerLine)) {
        continue;
      }
      out.push(i);
    }
    return out;
  }

  /** Where to resume navigation when the selected node was folded away: the
   * navigable `section` node whose range contains the old selection. */
  #reselectAfterCollapse(navNodes: readonly StructureNode[]): number {
    const sel = this.doc.flatStructure[this.#selectedIndex!];
    const idx = navNodes.findIndex((n) =>
      n.kind === "section" && sel.startLine >= n.startLine &&
      sel.startLine <= n.endLine
    );
    return idx >= 0 ? idx : this.#viewportNodeIndex(navNodes);
  }

  /** The node to select when navigation starts with none selected: the first
   * node whose start sits on screen, else the node enclosing the viewport top,
   * else the first. Works in display rows, since a collapsed file's document
   * lines are not a contiguous on-screen span. */
  #viewportNodeIndex(nodes: readonly StructureNode[]): number {
    const bottom = this.top + this.#contentRows() - 1;
    for (let i = 0; i < nodes.length; i++) {
      const row = this.#nodeStartRow(nodes[i]);
      if (row >= this.top && row <= bottom) return i;
    }
    let enclosing = -1;
    let enclosingSpan = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const start = this.#nodeStartRow(nodes[i]);
      const end = this.#nodeEndRow(nodes[i]);
      const span = end - start;
      if (start <= this.top && end >= this.top && span <= enclosingSpan) {
        enclosing = i;
        enclosingSpan = span;
      }
    }
    if (enclosing >= 0) return enclosing;
    const onLine = nodeAtLine(nodes, this.#toDoc(this.top));
    return onLine >= 0 ? onLine : 0;
  }
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

function isArrowName(name: string): boolean {
  return name === "up" || name === "down" || name === "left" ||
    name === "right";
}

/** Builds a commit row with its total counts, muted when all files are hidden. */
function commitJumpLine(
  shortSha: string,
  subject: string,
  counts: DiffLineCounts,
  collapsed: boolean,
): Line {
  const spans: Span[] = [];
  let text = "";
  const add = (s: string, cls: TokenClass) => {
    spans.push({ col: cpLen(text), text: s, cls });
    text += s;
  };
  add("● ", "diffMeta");
  add(`commit ${shortSha}`, "sectionHeader");
  add("  ", "whitespace");
  add(`+${counts.adds}`, "diffAdd");
  add(" ", "whitespace");
  add(`−${counts.dels}`, "diffDel");
  if (subject) add(`  ${subject}`, "plain");
  return {
    text,
    spans: collapsed
      ? spans.map((span) => ({ ...span, cls: "comment" }))
      : spans,
  };
}

/** Add the category keys that affect a file to its jump-list row. Collapsed
 * rows use the dialog's muted style. */
function fileJumpLine(
  file: DiffFileRange,
  collapsed: boolean,
  counts: DiffLineCounts,
): Line {
  const flags = `${file.isMarkdown ? "M" : " "}${file.isTest ? "T" : " "}`;
  const prefix = `${flags} `;
  const summary = diffFileSummary(file, counts.adds, counts.dels);
  const spans: Span[] = [
    { col: 0, text: prefix, cls: "builderCall" },
    ...summary.spans.map((span) => ({
      ...span,
      col: span.col + 3,
    })),
  ];
  return {
    text: prefix + summary.text,
    spans: collapsed
      ? spans.map((span) => ({ ...span, cls: "comment" }))
      : spans,
  };
}

/** Builds the jump-list row naming its current count policy. */
function jumpCountModeLine(mode: DiffCountMode): Line {
  const text = `Counts: ${diffCountModeLabel(mode)}`;
  return { text, spans: [{ col: 0, text, cls: "diffMeta" }] };
}

/** Builds the styled all-files and shown-files totals row. */
function jumpCountSummaryLine(
  all: DiffLineCounts,
  shown: DiffLineCounts,
): Line {
  const spans: Span[] = [];
  let text = "";
  const add = (value: string, cls: TokenClass) => {
    spans.push({ col: cpLen(text), text: value, cls });
    text += value;
  };
  add("All files ", "plain");
  add(`+${all.adds}`, "diffAdd");
  add(" ", "whitespace");
  add(`−${all.dels}`, "diffDel");
  add(" · Shown files ", "plain");
  add(`+${shown.adds}`, "diffAdd");
  add(" ", "whitespace");
  add(`−${shown.dels}`, "diffDel");
  return { text, spans };
}

export function helpOverlay(hasMultipleCommits: boolean): {
  title: string;
  info: Line[];
  mode: "info";
  targets: readonly CardTarget[];
  cardSel: number;
  staticFooter: string;
} {
  const commitRows: Array<[string, string]> = hasMultipleCommits
    ? [["  < / >", "previous / next commit"]]
    : [];
  const rows: Array<[string, string]> = [
    ["Scrolling", ""],
    ["  mouse wheel", "scroll up / down"],
    ["  K / J", "line up / down"],
    ["  H / L", "scroll left / right"],
    ["  ↑ ↓ ← →", "scroll / pan the view"],
    ["  ⌥↑ ⌥↓ ⌥← ⌥→", "scroll / pan while editing"],
    ["  Space / B", "page down / up"],
    ["  ^D / ^U", "half page down / up"],
    ["  g / G", "top / bottom"],
    ["", ""],
    ["Search", ""],
    ["  /", "search (smartcase, incremental)"],
    ["  n / N", "next / previous match"],
    ["", ""],
    ["Diff files", ""],
    ["  f", "hide / show the current file"],
    ["  F / E", "hide all files / show all files"],
    ["  T", "hide / show test and test-support files"],
    ["  M", "hide / show Markdown files"],
    ["  i", "list the diff's files and commits, jump to one"],
    ...commitRows,
    ["", ""],
    ["Diff index", ""],
    ["  f", "hide / show a file or commit"],
    ["  /", "filter the list"],
    ["  D", "cycle its diff counts"],
    ["", ""],
    ["Structure tree", ""],
    ["  W / S", "previous / next sibling (W → parent, S → out, at ends)"],
    ["  A / D", "parent / first child"],
    ["  Tab / ⇧Tab", "next / previous node (depth-first)"],
    ["  Z", "center selected node"],
    ["  ^L", "diff: reveal more context at the marked edge"],
    ["  Esc", "clear selection / search"],
    ["", ""],
    ["Editing (a file or a diff)", ""],
    ["  e", "enter edit mode (reveal the text cursor)"],
    ["  ↑ ↓ ← →", "move the text cursor   ·   Esc leaves edit mode"],
    ["  ^A ^E  ⌥F ⌥B", "line start / end   ·   word forward / back"],
    ["  ^K ^Y  ^W ^Space", "kill line / yank   ·   kill region / set mark"],
    ["  ⌥L ⌥U ⌥C", "lower / upper / capitalise word"],
    ["  ^S", "search from the cursor (Enter lands there, ^S steps)"],
    ["  ^R", "revert: a diff's hunk / file / all, or a file's edits"],
    ["  R", "diff: resurrect the removed line under the cursor"],
    ["  ^L", "diff: reveal more of the file around the cursor's hunk"],
    ["  F3  ^X^S", "save to disk"],
    ["  ^X^F", "open another file"],
    ["", ""],
    ["Info card (Enter on a node)", ""],
    ["  Enter", "open the reference — or expand a “… N more” line"],
    ["  Esc", "back to the card you came from (or close)"],
    ["  Z", "close & center the main view on the target"],
    ["  Tab", "toggle info card ⇄ source"],
    ["  t", "look up a definition by name"],
    ["", ""],
    ["View", ""],
    ["  V", "toggle source / rendered view when the language supports it"],
    ["  #", "line numbers: off / input position / file or message line"],
    ["  \\", "line wrapping: off / hard / word"],
    ["  C", "cycle non-printables: pictures / ANSI color / hidden"],
    ["  ?", "this help   ·   Q  quit"],
  ];
  const info: Line[] = rows.map(([k, v]) => {
    const text = v ? `${k.padEnd(22)} ${v}` : k;
    const spans = v
      ? [
        { col: 0, text: k.padEnd(22), cls: "builderCall" as TokenClass },
        { col: 22, text: ` ${v}`, cls: "plain" as TokenClass },
      ]
      : [{ col: 0, text: k, cls: "sectionHeader" as TokenClass }];
    return { text, spans };
  });
  return {
    title: "cf view — keys",
    info,
    mode: "info",
    targets: [],
    cardSel: -1,
    staticFooter: "↑/↓ scroll · g/G top/bottom · esc / q close",
  };
}
