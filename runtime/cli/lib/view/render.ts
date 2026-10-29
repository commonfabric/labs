/**
 * Pure renderer: maps a {@link Document} plus the current {@link ViewState} to
 * an array of terminal rows (ANSI strings). Holds no terminal state and writes
 * nothing — the pager owns I/O — which keeps every frame snapshot testable.
 *
 * Composition is cell-based: each visible content row is built as an array of
 * (char, style) cells so overlays layer with a clear precedence
 * (search match > node selection > schema/closure region tint > token color),
 * then run-length encoded into ANSI. Horizontal scrolling, the line-number
 * gutter and the structure guide bar are all column maths over that grid.
 */

import { diffContentRowCount, maxPagerTop, maxTop } from "./actions.ts";
import {
  cpLen,
  LEADING_ESCAPE,
  paint,
  RESET,
  stripAnsi,
  type Style,
  term,
  visibleWidth,
} from "./ansi.ts";
import { BLAME_WIDTH, blameLabel, type BlameLine } from "./blame.ts";
import type { Document, Line, StructureNode, ViewMode } from "./model.ts";
import {
  type DisplayCell,
  displayLine,
  type DisplayMode,
  displayWidth,
  glyphFor,
} from "./display.ts";
import { overlaySpanStyle, spanStyle } from "./highlight.ts";
import { lineBg, styleFor, ui } from "./theme.ts";
import {
  buildWrapPlan,
  fitViewLayout,
  type WrapDecoration,
  type WrapMode,
  type WrappedRow,
  wrappedRowAt,
  wrappedRowForPosition,
  type WrapPlan,
} from "./wrap.ts";

/** Maximum columns used by the Ctrl-L label and its diff-edge marker. */
export const DIFF_MARGIN_WIDTH = 3;

/** Downward-pointing fleuron end marks for wide, compact, and narrow areas. */
const END_MARK_ROWS = {
  wide: ["☙   ❦   ❧", "☙   ❧", "❦"],
  compact: ["☙ ❦ ❧", "☙ ❧", "❦"],
  narrow: ["❦"],
} as const;

function endMarkRows(width: number, availableRows: number): readonly string[] {
  if (availableRows >= 3 && width >= 9) return END_MARK_ROWS.wide;
  if (availableRows >= 3 && width >= 5) return END_MARK_ROWS.compact;
  if (availableRows >= 2 && width >= 9) return END_MARK_ROWS.wide.slice(1);
  if (availableRows >= 2 && width >= 5) return END_MARK_ROWS.compact.slice(1);
  if (width >= 9) return [END_MARK_ROWS.wide[0]];
  if (width >= 5) return [END_MARK_ROWS.compact[0]];
  return END_MARK_ROWS.narrow;
}

export type DiffAnnotationKind =
  | "expandUp"
  | "expandDown"
  | "diffMetadata";

export interface DiffAnnotation {
  /** Folded logical line carrying the annotation. */
  readonly line: number;

  readonly kind: DiffAnnotationKind;
}

/** Wrapped source widths reserved by one diff annotation. */
export function diffAnnotationDecoration(
  kind: DiffAnnotationKind,
  width: number,
  labelMetadata = true,
): WrapDecoration {
  const available = Math.max(0, width - 1);
  return {
    firstWidth: Math.min(
      kind === "diffMetadata" && labelMetadata ? 3 : 1,
      available,
    ),
    firstContinuationWidth: Math.min(
      kind === "expandDown" ? 3 : kind === "expandUp" ? 0 : 1,
      available,
    ),
    continuationWidth: Math.min(
      kind === "expandUp" ? 0 : 1,
      available,
    ),
  };
}

/** Whole-diff added and removed line totals. */
export interface DiffTotals {
  readonly adds: number;
  readonly dels: number;
}

/** One right-edge annotation cell: its glyph, and its style when it differs
 * from the wrap-marker style. */
interface SuffixCell {
  readonly ch: string;
  readonly style?: Style;
}

function plainSuffix(text: string): SuffixCell[] {
  return [...text].map((ch) => ({ ch }));
}

/** The two segments of the corner label for the whole-diff totals, e.g.
 * `+345 ` and `−12`: the added count and the removed count. */
function diffTotalsSegments(totals: DiffTotals): [string, string] {
  return [`+${totals.adds} `, `−${totals.dels}`];
}

/** The corner label's cells: the added count in the addition color, the
 * removed count in the removal color. */
function diffTotalsCells(totals: DiffTotals): SuffixCell[] {
  const [add, del] = diffTotalsSegments(totals);
  return [
    ...[...add].map((ch) => ({ ch, style: styleFor("diffAdd") })),
    ...[...del].map((ch) => ({ ch, style: styleFor("diffDel") })),
  ];
}

/** Columns the whole-diff totals label occupies. */
export function diffTotalsWidth(totals: DiffTotals): number {
  const [add, del] = diffTotalsSegments(totals);
  return cpLen(add) + cpLen(del);
}

/** Wrapped source widths reserved by the totals label on the first line,
 * layered over any annotation decoration that line already carries. */
export function diffTotalsDecoration(
  labelWidth: number,
  width: number,
  annotation?: WrapDecoration,
): WrapDecoration {
  const available = Math.max(0, width - 1);
  return {
    firstWidth: Math.min(
      (annotation?.firstWidth ?? 0) + labelWidth,
      available,
    ),
    firstContinuationWidth: annotation?.firstContinuationWidth ??
      annotation?.continuationWidth ?? 0,
    continuationWidth: annotation?.continuationWidth ?? 0,
  };
}

/** The metadata line that carries the Ctrl-L label in this wrapped layout. */
export function labeledDiffMetadataLine(
  lines: readonly Line[],
  mode: DisplayMode,
  width: number,
  annotations: readonly DiffAnnotation[],
  totalsWidth = 0,
): number | null {
  const metadata = annotations.find((annotation) =>
    annotation.kind === "diffMetadata"
  );
  if (!metadata) return null;
  const downward = annotations.find((annotation) =>
    annotation.kind === "expandDown"
  );
  if (!downward || metadata.line !== downward.line + 1) return metadata.line;
  const line = lines[downward.line];
  if (!line) return metadata.line;
  const decoration = diffAnnotationDecoration("expandDown", width);
  const firstWidth = downward.line === 0 && totalsWidth > 0
    ? diffTotalsDecoration(totalsWidth, width, decoration).firstWidth
    : decoration.firstWidth;
  return displayWidth(line, mode) > Math.max(1, width) - firstWidth
    ? null
    : metadata.line;
}

/** A key suggestion for the status line: the key (already capitalised for
 * display, e.g. `Q`, `^X^S`, `WASD`) and what it does. Drawn Turbo-Pascal style,
 * the key highlighted and the label plain. */
export interface KeyHint {
  readonly key: string;
  readonly label: string;
}

export interface ViewState {
  top: number;
  left: number;
  width: number;
  height: number;
  color: boolean;

  /** Whether the source is a diff. */
  isDiff?: boolean;

  showLineNumbers: boolean;

  /** How long logical lines continue on later screen rows. */
  wrapMode: WrapMode;

  /** A precomputed wrapping layout for `doc`, when the session has one. */
  wrapPlan?: WrapPlan | null;

  /** The number to show in the gutter on each display row, or null there for a
   * blank gutter. Absent → the legacy 1-based display-row number. Only consulted
   * when `showLineNumbers` is set. */
  lineNumbers?: readonly (number | null)[] | null;

  /** The blame column: the attribution it shows on each display line in view,
   * or null there for none, and the time its ages are measured to, in
   * milliseconds since the epoch. Null or absent when the column is hidden. */
  blame?: {
    readonly lines: readonly (BlameLine | null)[];
    readonly now: number;
  } | null;

  /** How the non-printable characters in the content are shown. */
  displayMode: DisplayMode;

  /** The selected structure node (WASD navigation), or null. */
  selected: StructureNode | null;

  /** Visible search matches, display-ordered; null when no active search. */
  matches: readonly Match[] | null;

  /** Index into `matches` of the focused match. */
  currentMatch: number;

  /** Transient status text (e.g. "Pattern not found"). */
  message: string;

  /** Command/search input line, e.g. "/token"; null in normal mode. */
  inputLine: string | null;

  overlay: OverlayState | null;

  /** A modal prompt drawn as a centered Turbo Vision dialog (the save, revert and
   * amend confirmations). Covers the content like an overlay; the two never
   * coexist. */
  dialog?: DialogState | null;

  /** The text cursor, in document coordinates (line + display column), when
   * edit mode has it visible. The pager positions the real terminal cursor. */
  cursor?: { line: number; col: number } | null;

  /** Edit-mode key hints, shown on the status line in place of the navigation
   * help while the text cursor is active. */
  editHint?: readonly KeyHint[] | null;

  /** Whether Ctrl-L can reveal more context here (a diff), so the navigation
   * help advertises it. */
  canExpand?: boolean;

  /** Whether this pager can draw diff annotations. */
  expandMargin?: boolean;

  /** Per-line annotations drawn against the right edge. */
  diffAnnotations?: readonly DiffAnnotation[];

  /** Whole-diff added/removed totals, drawn at the top right corner of the
   * first line. */
  diffTotals?: DiffTotals | null;

  /** Absolute display row of the diff edge the next Ctrl-L will expand. */
  expandRow?: number | null;

  /** Whether the marked edge expands upward. False means downward. */
  expandUp?: boolean | null;

  /** Absolute display rows occupied by metadata adjacent to the expansion edge. */
  diffMetadataRows?: readonly number[];

  /** Whether the view is editable, so the navigation help advertises `e`. */
  canEdit?: boolean;

  /** Whether this source offers an alternate rendered representation. */
  canRender?: boolean;

  /** The representation currently shown. */
  viewMode?: ViewMode;

  /** Whether the content holds non-printable characters, so the navigation help
   * advertises the display-mode key `C`. */
  hasNonPrintables?: boolean;

  /** Lines shown just above the status/prompt bar (e.g. the list of files an
   * edited diff would save), overwriting the bottom content rows. */
  notice?: readonly string[] | null;

  /** The file currently in view — the diff file or source under the viewport, or
   * the file being edited — shown on the right of the status bar. Null when
   * there is none (a bare pipe). */
  currentFile?: string | null;
}

/** The line-number gutter width: 0 when off, else wide enough for the largest
 * number it shows (in "file" mode a diff line's file number can exceed the
 * number of lines the diff spans). */
function gutterWidth(doc: Document, view: ViewState): number {
  if (!view.showLineNumbers) return 0;
  const max = view.lineNumbers
    ? view.lineNumbers.reduce<number>((m, n) => n !== null && n > m ? n : m, 0)
    : doc.lines.length;
  return Math.max(4, String(Math.max(1, max)).length + 1);
}

/** The width of the blame column at the right of a `width`-column screen: its
 * full width when it is `shown` and leaves at least as much for the rest of the
 * row, else zero. */
export function blameColumnWidth(width: number, shown: boolean): number {
  return shown && width >= 2 * BLAME_WIDTH ? BLAME_WIDTH : 0;
}

/** Layout widths the content area is laid out with, for cursor placement. */
function layout(
  doc: Document,
  view: ViewState,
): {
  gutterWidth: number;
  guideWidth: number;
  contentWidth: number;
  blameWidth: number;
} {
  const blameWidth = blameColumnWidth(view.width, !!view.blame);
  const fitted = fitViewLayout(
    view.width - blameWidth,
    gutterWidth(doc, view),
    view.selected ? 1 : 0,
    view.expandMargin ? DIFF_MARGIN_WIDTH : 0,
    view.wrapMode !== "off",
  );
  return {
    gutterWidth: fitted.gutterWidth,
    guideWidth: fitted.guideWidth,
    contentWidth: fitted.contentWidth + fitted.marginWidth,
    blameWidth,
  };
}

/**
 * 1-based terminal (row, col) for the text cursor, or null when there is no
 * cursor, it is scrolled off screen, or an overlay or dialog covers the content.
 * Mirrors the layout `renderFrame` uses, including a wrapped continuation's
 * screen row and display-column offset.
 */
export function cursorScreenPos(
  doc: Document,
  view: ViewState,
): { row: number; col: number } | null {
  if (!view.cursor || view.overlay || view.dialog) return null;
  const { line, col } = view.cursor;
  if (line < 0 || line >= doc.lines.length) return null;
  const { gutterWidth, guideWidth, contentWidth } = layout(doc, view);
  let screenLine = line;
  let contentCol = col - view.left;
  if (view.wrapMode !== "off") {
    const plan = view.wrapPlan ??
      buildWrapPlan(
        doc.lines,
        view.displayMode,
        contentWidth,
        new Map(),
        view.wrapMode,
      );
    const row = wrappedRowForPosition(plan, line, col);
    screenLine = row?.row ?? plan.firstRow[line];
    contentCol = (row?.prefixWidth ?? 0) + col - (row?.offset ?? 0);
  }
  const contentHeight = view.height - 1;
  const r = screenLine - view.top;
  if (r < 0 || r >= contentHeight) return null;
  if (contentCol < 0 || contentCol >= contentWidth) return null;
  return { row: r + 1, col: gutterWidth + guideWidth + contentCol + 1 };
}

export interface Match {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface OverlayState {
  readonly title: string;
  readonly lines: readonly Line[];
  readonly scroll: number;
  readonly footer: string;

  /** Index into `lines` of the selected (highlighted) reference, if any. */
  readonly selectedLine?: number;

  /** The overlay shows source code, so it is drawn as a blue editor window
   * rather than a gray dialog. */
  readonly sourceView?: boolean;
}

/** A push-button in a modal dialog. Its {@link kind} sets where the Tab focus
 * starts ("default") and which button Esc activates ("cancel"); its first letter
 * matching {@link hotkey} is drawn highlighted and activates it directly. A
 * lowercase hotkey answers its letter typed in either case; an uppercase one
 * answers only the uppercase letter. */
export interface DialogButton {
  readonly label: string;
  readonly hotkey: string;
  readonly kind?: "default" | "cancel" | "normal";
}

/** A centered modal prompt: a title, one or more body lines, and a button row. */
export interface DialogState {
  readonly title: string;
  readonly body: readonly string[];
  readonly buttons: readonly DialogButton[];

  /** Whether the body is program output, which starts at the left margin
   * rather than being centered. */
  readonly output?: boolean;

  /** The width the box gives the body, in columns, when that is fixed rather
   * than fitted to the body's lines. */
  readonly width?: number;

  /** Index of the focused button — the one Space and Enter activate, drawn
   * highlighted. When absent, the default button (if any) is highlighted. */
  readonly focus?: number;

  /** Index of a button drawn mid-press: shifted one column right with its
   * shadow hidden, for the brief animation after it is activated. */
  readonly pushed?: number;
}

interface Cell {
  ch: string;
  style: Style;
}

const EMPTY_STYLE: Style = {};

interface LineMatches {
  readonly matches: readonly Match[];
  readonly from: number;
  readonly to: number;
  readonly currentIndex: number;
  blockPrefixMaxEnd?: Float64Array;
}

type MarginMarker =
  | "expandUp"
  | "expandDown"
  | "diffMetadata"
  | "diffEnd"
  | null;

function marginAnnotation(marker: MarginMarker, width: number): string {
  if (marker === null) return "";
  const text = marker === "expandUp"
    ? "◥"
    : marker === "expandDown"
    ? "◢"
    : "█";
  return clipAnnotation(text, width);
}

/** Keep at least one source cell when an annotation meets a narrow view. */
function clipAnnotation(text: string, width: number): string {
  const capacity = Math.max(0, width - 1);
  return capacity === 0 ? "" : [...text].slice(-capacity).join("");
}

function clipConnectorAnnotation(text: string, width: number): string {
  const capacity = Math.max(0, width);
  return capacity === 0 ? "" : [...text].slice(-capacity).join("");
}

/** Keep at least one source cell when a styled suffix meets a narrow view. */
function clipSuffixCells(
  cells: readonly SuffixCell[],
  width: number,
): SuffixCell[] {
  const capacity = Math.max(0, width - 1);
  return capacity === 0 ? [] : cells.slice(-capacity);
}

const MATCH_BLOCK_SIZE = 64;

/** The contiguous slice of document-ordered matches on one visible line. */
function matchesOnLine(
  view: ViewState,
  line: number,
): LineMatches | null {
  const matches = view.matches;
  if (!matches || matches.length === 0) return null;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  if (matches[from]?.line !== line) return null;
  hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].line <= line) lo = mid + 1;
    else hi = mid;
  }
  const to = lo;
  const currentIndex = view.currentMatch >= from && view.currentMatch < to
    ? view.currentMatch
    : -1;
  return { matches, from, to, currentIndex };
}

/** Render a complete frame: exactly `view.height` rows. */
export function renderFrame(doc: Document, view: ViewState): string[] {
  const rows: string[] = [];
  const contentHeight = view.height - 1;
  const {
    gutterWidth: gw,
    guideWidth,
    contentWidth,
    blameWidth,
  } = layout(doc, view);
  const annotations = new Map(
    (view.diffAnnotations ?? []).map((annotation) => [
      annotation.line,
      annotation.kind,
    ]),
  );
  const totalsCells = view.diffTotals ? diffTotalsCells(view.diffTotals) : [];
  const metadataLabelLine = view.wrapMode !== "off"
    ? labeledDiffMetadataLine(
      doc.lines,
      view.displayMode,
      contentWidth,
      view.diffAnnotations ?? [],
      totalsCells.length,
    )
    : view.diffAnnotations?.find((annotation) =>
      annotation.kind === "diffMetadata"
    )?.line ?? null;
  const decorations = new Map<number, WrapDecoration>();
  for (const [line, kind] of annotations) {
    decorations.set(
      line,
      diffAnnotationDecoration(
        kind,
        contentWidth,
        kind !== "diffMetadata" || line === metadataLabelLine,
      ),
    );
  }
  if (totalsCells.length > 0) {
    decorations.set(
      0,
      diffTotalsDecoration(
        totalsCells.length,
        contentWidth,
        decorations.get(0),
      ),
    );
  }
  const wrapPlan = view.wrapMode !== "off"
    ? view.wrapPlan ??
      buildWrapPlan(
        doc.lines,
        view.displayMode,
        contentWidth,
        decorations,
        view.wrapMode,
      )
    : null;
  const documentRowCount = wrapPlan?.rowCount ?? doc.lines.length;
  const hasTrailingEmptyLine = view.isDiff === true &&
    doc.lines.at(-1)?.text.length === 0;
  const diffEndRow = diffContentRowCount(
    documentRowCount,
    hasTrailingEmptyLine,
  );
  const lastDiffLine = doc.lines.length - (hasTrailingEmptyLine ? 2 : 1);
  const finalTriangleRow = annotations.get(lastDiffLine) === "expandDown"
    ? wrapPlan?.firstRow[lastDiffLine] ?? lastDiffLine
    : null;
  const hasDiffEndConnector = view.isDiff === true &&
    view.expandMargin === true &&
    finalTriangleRow !== null;
  const labelDiffEnd = finalTriangleRow !== null &&
    finalTriangleRow + 1 === diffEndRow;
  const diffEndSuffix = (width: number) =>
    clipConnectorAnnotation(labelDiffEnd ? "^L█" : "█", width);
  let endMarkStart = diffEndRow + (hasDiffEndConnector ? 1 : 0);
  const availableEndRows = contentHeight - Math.max(0, endMarkStart - view.top);
  const showEndMark = view.isDiff === true && !view.cursor;
  // End-mark rows span the screen up to the blame column.
  const endWidth = Math.max(1, view.width - blameWidth);
  let endRows = showEndMark ? endMarkRows(endWidth, availableEndRows) : [];
  if (
    showEndMark && hasDiffEndConnector && availableEndRows <= 0 &&
    diffEndRow >= view.top && diffEndRow < view.top + contentHeight
  ) {
    endMarkStart = diffEndRow;
    endRows = END_MARK_ROWS.narrow;
  }
  let displayedLine = -1;
  let displayedCells: readonly DisplayCell[] | undefined;
  let displayedSelection: SelectionSpan | null = null;
  let displayedMatches: LineMatches | null = null;
  let blameStartLine = -1;

  for (let r = 0; r < contentHeight; r++) {
    const rowIdx = view.top + r;
    const endMark = endRows[rowIdx - endMarkStart] ?? null;
    if (endMark !== null) {
      const suffix = plainSuffix(
        hasDiffEndConnector && rowIdx === diffEndRow
          ? diffEndSuffix(endWidth)
          : "",
      );
      rows.push(
        composeContent(
          undefined,
          view,
          0,
          endWidth,
          endWidth,
          endWidth,
          0,
          false,
          null,
          undefined,
          null,
          endMark,
          suffix,
        ) + blameCell(null, 0, false, blameWidth, view.color),
      );
      continue;
    }
    const wrappedRow: WrappedRow | undefined = wrapPlan
      ? wrappedRowAt(wrapPlan, rowIdx)
      : undefined;
    const lineIdx = wrappedRow?.line ?? rowIdx;
    const firstOfLine = !wrapPlan || wrappedRow === undefined ||
      wrapPlan.firstRow[wrappedRow.line] === rowIdx;
    if (lineIdx < doc.lines.length && lineIdx !== displayedLine) {
      displayedLine = lineIdx;
      const line = doc.lines[displayedLine];
      displayedCells = line ? displayLine(line, view.displayMode) : undefined;
      displayedSelection = selectionSpan(view, displayedLine, line);
      displayedMatches = view.color ? matchesOnLine(view, displayedLine) : null;
    } else if (lineIdx >= doc.lines.length) {
      displayedCells = undefined;
      displayedSelection = null;
      displayedMatches = null;
    }
    // A line's blame label goes on the first of its rows on screen, unless the
    // line above it is on screen and comes from the same commit, so each run of
    // lines from one commit is labeled once.
    const startsOnScreen = firstOfLine || r === 0;
    const labelsBlame = startsOnScreen &&
      !(blameStartLine === lineIdx - 1 &&
        view.blame?.lines[lineIdx - 1]?.commit ===
          view.blame?.lines[lineIdx]?.commit);
    if (startsOnScreen) blameStartLine = lineIdx;
    const annotation = annotations.get(lineIdx);
    const labelsWrappedExpansion = annotation === "expandDown" &&
      wrapPlan !== null &&
      wrappedRow !== undefined &&
      rowIdx === wrapPlan.firstRow[lineIdx] + 1;
    // Row 0 reserves the leading cells of its suffix for the totals label, so
    // the plain block marker only marks a width reserved beyond the label.
    const reservedTotals = rowIdx === 0 ? totalsCells.length : 0;
    const marginMarker: MarginMarker = firstOfLine && annotation
      ? annotation
      : wrappedRow && wrappedRow.suffixWidth > reservedTotals
      ? "diffMetadata"
      : hasDiffEndConnector && rowIdx === diffEndRow
      ? "diffEnd"
      : null;
    const annotationSuffix = firstOfLine && annotation === "diffMetadata" &&
        lineIdx === metadataLabelLine
      ? clipAnnotation("^L█", contentWidth)
      : labelsWrappedExpansion
      ? clipAnnotation("^L█", contentWidth)
      : hasDiffEndConnector && rowIdx === diffEndRow
      ? diffEndSuffix(contentWidth)
      : marginAnnotation(marginMarker, contentWidth);
    const suffix = reservedTotals > 0
      ? clipSuffixCells(
        [...totalsCells, ...plainSuffix(annotationSuffix)],
        contentWidth,
      )
      : plainSuffix(annotationSuffix);
    const sourceWidth = wrappedRow?.sourceWidth ??
      Math.max(1, contentWidth - suffix.length);
    rows.push(
      renderContentRow(
        doc,
        view,
        lineIdx,
        wrappedRow?.offset ?? view.left,
        sourceWidth,
        wrappedRow?.sourceEnd ?? Number.POSITIVE_INFINITY,
        wrappedRow?.prefixWidth ?? 0,
        wrappedRow?.wrapMarker ?? false,
        displayedCells,
        displayedSelection,
        displayedMatches,
        firstOfLine,
        gw,
        guideWidth,
        contentWidth,
        wrapPlan,
        suffix,
      ) + blameCell(view.blame, lineIdx, labelsBlame, blameWidth, view.color),
    );
  }
  rows.push(renderStatus(doc, view, wrapPlan));

  if (view.notice && view.notice.length > 0) {
    const start = Math.max(0, contentHeight - view.notice.length);
    for (let i = 0; start + i < contentHeight; i++) {
      rows[start + i] = paintIf(
        padTo(view.notice[i] ?? "", view.width),
        ui.noticeBar,
        view.color,
      );
    }
  }

  if (view.overlay) applyOverlay(rows, view, view.overlay);
  if (view.dialog) applyDialog(rows, view, view.dialog);
  return rows;
}

function renderContentRow(
  doc: Document,
  view: ViewState,
  lineIdx: number,
  offset: number,
  sourceWidth: number,
  sourceEnd: number,
  prefixWidth: number,
  wrapMarker: boolean,
  display: readonly DisplayCell[] | undefined,
  selection: SelectionSpan | null,
  matches: LineMatches | null,
  firstOfLine: boolean,
  gutterWidth: number,
  guideWidth: number,
  contentWidth: number,
  wrapPlan: WrapPlan | null,
  suffix: readonly SuffixCell[],
): string {
  const line: Line | undefined = doc.lines[lineIdx];
  const inSelRange = !!view.selected &&
    lineIdx >= view.selected.startLine && lineIdx <= view.selected.endLine;

  let gutter = "";
  if (gutterWidth > 0) {
    const num = !firstOfLine
      ? null
      : view.lineNumbers
      ? view.lineNumbers[lineIdx] ?? null
      : (line ? lineIdx + 1 : null);
    const label = num !== null ? String(num) : "";
    const style = inSelRange ? ui.lineNumberCurrent : ui.lineNumber;
    gutter = paintIf(label.padStart(gutterWidth - 1) + " ", style, view.color);
  }

  let guide = "";
  if (guideWidth > 0) {
    // guideWidth > 0 only when view.selected is set (see guideWidth above).
    guide = paintIf(
      view.wrapMode !== "off"
        ? wrappedGuideChar(
          view.selected!,
          lineIdx,
          line,
          offset,
          wrapPlan!,
          selection,
          display,
        )
        : guideChar(view.selected!, lineIdx),
      ui.guide,
      view.color,
    );
  }

  const content = composeContent(
    line,
    view,
    offset,
    contentWidth,
    sourceWidth,
    sourceEnd,
    prefixWidth,
    wrapMarker,
    selection,
    display,
    matches,
    null,
    suffix,
  );
  return gutter + guide + content;
}

/** A `width`-column cell of the `blame` column for a row showing display
 * line `lineIdx`, carrying the line's label when `labeled`. */
function blameCell(
  blame: ViewState["blame"],
  lineIdx: number,
  labeled: boolean,
  width: number,
  color: boolean,
): string {
  if (width === 0) return "";
  const line = blame?.lines[lineIdx];
  const label = blame && line && labeled
    ? truncate(showControls(blameLabel(line, blame.now)), width - 1, true)
    : "";
  // The label's alignment padding stays outside its link.
  const text = label.trimStart();
  const linked = color && line?.url && text
    ? " ".repeat(label.length - text.length) + term.hyperlink(line.url, text)
    : label;
  return paintIf(" " + padTo(linked, width - 1), ui.lineNumber, color);
}

function guideChar(
  selected: StructureNode,
  lineIdx: number,
): string {
  if (lineIdx < selected.startLine || lineIdx > selected.endLine) return " ";
  if (selected.startLine === selected.endLine) return "▶";
  if (lineIdx === selected.startLine) return "╭";
  if (lineIdx === selected.endLine) return "╰";
  return "│";
}

/** Guide character for a selected node on one wrapped continuation row. */
function wrappedGuideChar(
  selected: StructureNode,
  lineIdx: number,
  line: Line | undefined,
  offset: number,
  plan: WrapPlan,
  span: SelectionSpan | null,
  display: readonly DisplayCell[] | undefined,
): string {
  if (lineIdx < selected.startLine || lineIdx > selected.endLine || !line) {
    return " ";
  }
  const bounds = selectionRowBounds(
    span,
    display ?? [],
    plan,
    lineIdx,
  );
  if (offset < bounds.first || offset > bounds.last) return " ";
  const first = lineIdx === selected.startLine && offset === bounds.first;
  const last = lineIdx === selected.endLine && offset === bounds.last;
  if (first && last) return "▶";
  if (first) return "╭";
  if (last) return "╰";
  return "│";
}

function selectionRowBounds(
  span: SelectionSpan | null,
  display: readonly DisplayCell[],
  plan: WrapPlan,
  line: number,
): { first: number; last: number } {
  if (display.length === 0) return { first: 0, last: 0 };
  const lo = span ? displayIndexAtOrAfter(display, span.lo) : 0;
  const hi = span ? displayIndexAtOrAfter(display, span.hi) : display.length;
  const firstCell = Math.min(lo, display.length - 1);
  const lastCell = Math.max(firstCell, hi - 1);
  return {
    first: wrappedRowForPosition(plan, line, firstCell)?.offset ?? 0,
    last: wrappedRowForPosition(plan, line, lastCell)?.offset ?? 0,
  };
}

function displayIndexAtOrAfter(
  display: readonly DisplayCell[],
  sourceCol: number,
): number {
  let lo = 0;
  let hi = display.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (display[mid].col < sourceCol) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface SelectionSpan {
  lo: number;
  hi: number;
  bg: Style;
}

/**
 * Column range to tint for the selected node on `lineIdx`, or null. Covers only
 * the node's actual extent — its character span on this line, extended over
 * leading indentation and trailing whitespace but not the rest of the line.
 */
function selectionSpan(
  view: ViewState,
  lineIdx: number,
  line: Line | undefined,
): SelectionSpan | null {
  const sel = view.selected;
  if (!sel) return null;
  if (lineIdx < sel.startLine || lineIdx > sel.endLine) return null;
  const text = line ? line.text : "";
  const lineLen = cpLen(text);
  let lo = lineIdx === sel.startLine ? sel.startCol : 0;
  let hi = lineIdx === sel.endLine ? sel.endCol : lineLen;
  lo = Math.max(0, Math.min(lo, lineLen));
  hi = Math.max(0, Math.min(hi, lineLen));
  if (lo > 0 && codePointRangeIsWhitespace(text, 0, lo)) lo = 0;
  if (hi < lineLen && codePointRangeIsWhitespace(text, hi, lineLen)) {
    hi = lineLen;
  }
  if (hi <= lo) return null;
  const bg: Style = sel.kind === "schema"
    ? { bg: ui.schemaRegionBg }
    : sel.kind === "closure"
    ? { bg: ui.closureRegionBg }
    : { bg: ui.selectionBg };
  return { lo, hi, bg };
}

function codePointRangeIsWhitespace(
  text: string,
  from: number,
  to: number,
): boolean {
  let col = 0;
  for (const codePoint of text) {
    if (col >= to) break;
    if (col >= from && codePoint.trim() !== "") return false;
    col++;
  }
  return true;
}

function composeContent(
  line: Line | undefined,
  view: ViewState,
  offset: number,
  width: number,
  sourceWidth: number,
  sourceEnd: number,
  prefixWidth: number,
  showWrapMarker: boolean,
  sel: SelectionSpan | null,
  display: readonly DisplayCell[] | undefined,
  lineMatches: LineMatches | null,
  endMark: string | null,
  suffix: readonly SuffixCell[],
): string {
  const { color } = view;
  // Every content cell sits on the blue editor background; a diff line carries a
  // full-row add/removed tint instead. Syntax colors paint on top, and the
  // selection background still wins inside its range.
  const rowBg: Style = color
    ? { bg: line?.bg ? lineBg(line.bg) : ui.editorBg }
    : EMPTY_STYLE;
  const cells: Cell[] = new Array(width);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = { ch: " ", style: rowBg };
  }
  if (line && display) {
    // The display list may hold fewer cells than the line has code points —
    // ANSI sequences are hidden and runs of control codes collapse — so cells
    // are placed by their position in this list, not by their source column.
    // Each cell still knows the source column it stands for, which is what the
    // selection and search ranges are stated in.
    const styleCell = (dc: DisplayCell): Style => {
      if (!color) return EMPTY_STYLE;
      const hit = lineMatches ? matchStyle(lineMatches, dc.col) : null;
      if (hit) return hit;
      const base = mergeBg(dc.ansi ?? dc.syntax, rowBg);
      const inSel = sel !== null &&
        dc.col >= sel.lo && dc.col < sel.hi;
      return inSel ? mergeBg(base, sel.bg) : base;
    };
    for (let d = 0; d < prefixWidth && d < display.length; d++) {
      const dc = display[d];
      cells[d] = { ch: dc.ch, style: styleCell(dc) };
    }
    const end = Math.min(
      display.length,
      sourceEnd,
      offset + sourceWidth,
    );
    for (let d = offset; d < end; d++) {
      const idx = prefixWidth + d - offset;
      const dc = display[d];
      cells[idx] = { ch: dc.ch, style: styleCell(dc) };
    }
  }

  if (showWrapMarker) {
    cells[prefixWidth + sourceWidth] = {
      ch: "\\",
      style: color ? mergeBg(ui.wrapMarker, rowBg) : EMPTY_STYLE,
    };
  }
  if (endMark !== null) {
    const ornament = [...endMark];
    const centeredStart = Math.floor((width - ornament.length) / 2);
    const suffixStart = cells.length - suffix.length;
    const start = centeredStart + ornament.length <= suffixStart
      ? centeredStart
      : Math.floor((suffixStart - ornament.length) / 2);
    if (start >= 0) {
      for (let i = 0; i < ornament.length; i++) {
        cells[start + i] = {
          ch: ornament[i],
          style: color ? mergeBg(ui.endMark, rowBg) : EMPTY_STYLE,
        };
      }
    }
  }
  if (suffix.length > 0) {
    const start = cells.length - suffix.length;
    for (let i = 0; i < suffix.length; i++) {
      cells[start + i] = {
        ch: suffix[i].ch,
        style: color
          ? mergeBg(suffix[i].style ?? ui.wrapMarker, rowBg)
          : EMPTY_STYLE,
      };
    }
  }

  return cellsToAnsi(cells, color);
}

/** The search-match style for a cell at source column `col`, or null when the
 * column is in no match. The focused match wins over an ordinary one. */
function matchStyle(
  line: LineMatches,
  col: number,
): Style | null {
  const { matches, from, to, currentIndex } = line;
  const current = matches[currentIndex];
  if (current && col >= current.start && col < current.end) {
    return ui.searchCurrent;
  }
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start <= col) lo = mid + 1;
    else hi = mid;
  }
  const candidate = lo - 1;
  if (candidate < from) return null;
  const relative = candidate - from;
  const block = Math.floor(relative / MATCH_BLOCK_SIZE);
  const blockStart = from + block * MATCH_BLOCK_SIZE;
  for (let i = candidate; i >= blockStart; i--) {
    if (col < matches[i].end) return ui.searchMatch;
  }
  if (block === 0) return null;
  const prefix = line.blockPrefixMaxEnd ??= matchBlockPrefix(line);
  return prefix[block - 1] > col ? ui.searchMatch : null;
}

/** Largest match end through each fixed-size block of one logical line. */
function matchBlockPrefix(line: LineMatches): Float64Array {
  const { matches, from, to } = line;
  const blocks = Math.ceil((to - from) / MATCH_BLOCK_SIZE);
  const prefix = new Float64Array(blocks);
  let maxEnd = -Infinity;
  for (let i = from; i < to; i++) {
    maxEnd = Math.max(maxEnd, matches[i].end);
    const relative = i - from;
    if (
      relative % MATCH_BLOCK_SIZE === MATCH_BLOCK_SIZE - 1 || i === to - 1
    ) {
      prefix[Math.floor(relative / MATCH_BLOCK_SIZE)] = maxEnd;
    }
  }
  return prefix;
}

function renderStatus(
  doc: Document,
  view: ViewState,
  wrapPlan: WrapPlan | null,
): string {
  if (view.inputLine !== null) {
    return view.color
      ? paint(padTo(view.inputLine, view.width), ui.statusBar)
      : padTo(view.inputLine, view.width);
  }
  const hasTrailingEmptyDiffRow = view.isDiff === true && !view.cursor &&
    doc.lines.at(-1)?.text.length === 0;
  const total = diffContentRowCount(
    doc.lines.length,
    hasTrailingEmptyDiffRow,
  );
  const rowCount = diffContentRowCount(
    wrapPlan?.rowCount ?? doc.lines.length,
    hasTrailingEmptyDiffRow,
  );
  const lastRow = Math.min(
    Math.max(0, rowCount - 1),
    view.top + view.height - 2,
  );
  const first = total === 0
    ? 0
    : wrapPlan
    ? (wrappedRowAt(wrapPlan, view.top)?.line ?? 0) + 1
    : Math.min(total, view.top + 1);
  const last = total === 0
    ? 0
    : wrapPlan
    ? (wrappedRowAt(wrapPlan, lastRow)?.line ?? 0) + 1
    : Math.min(total, lastRow + 1);
  const pct = rowCount <= 1
    ? 100
    : Math.round((view.top / (rowCount - 1)) * 100);
  const endTop = view.cursor || view.isDiff !== true
    ? maxTop(rowCount, view.height)
    : maxPagerTop(rowCount, view.height);
  const atEnd = view.top >= endTop;

  // The left of the bar is either a message / selected-node label (plain text)
  // or a row of key hints (keys highlighted, Turbo Pascal style).
  let hints: readonly KeyHint[] | null = null;
  let text = "";
  if (view.dialog) {
    // A modal prompt owns every key, so the bar shows its buttons rather than
    // the navigation hints, which are inert while the dialog is up.
    hints = view.dialog.buttons.map((b) => ({
      key: b.hotkey.toUpperCase(),
      label: b.label,
    }));
  } else if (view.message) {
    text = view.message;
  } else if (view.editHint) {
    hints = view.editHint;
  } else if (view.selected) {
    text = `${kindGlyph(view.selected.kind)} ${view.selected.label}`;
  } else {
    hints = browseHints(view);
  }

  const pos = view.matches && view.matches.length > 0
    ? `match ${view.currentMatch + 1}/${view.matches.length}  ${
      lineInfo(first, last, total, pct, atEnd)
    }`
    : lineInfo(first, last, total, pct, atEnd);

  // The right of the bar carries the current file (bold) then the position; the
  // file is capped so it never crowds out the position or the left hints.
  const fileMax = Math.max(
    8,
    Math.floor(view.width / 2) - visibleWidth(pos) - 2,
  );
  const file = view.currentFile
    ? truncate(showControls(view.currentFile), fileMax, false)
    : "";
  const rightPlain = file ? `${file}  ${pos}` : pos;
  const rightW = visibleWidth(rightPlain);

  // The left is truncated to whatever space the right leaves it.
  const leftBudget = Math.max(0, view.width - rightW - 2);
  const leftHints = hints ? fitHints(hints, leftBudget) : null;
  const leftPlain = leftHints
    ? hintsPlain(leftHints)
    : truncate(text, leftBudget, true);

  if (!view.color) {
    return padTo(`${leftPlain}  ${rightPlain}`, view.width);
  }
  const leftAnsi = leftHints
    ? hintsAnsi(leftHints)
    : paint(leftPlain, ui.statusBar);
  const rightAnsi =
    (file ? paint(file, ui.statusFile) + paint("  ", ui.statusBar) : "") +
    paint(pos, ui.statusBar);
  const leftW = visibleWidth(leftPlain);
  const space = Math.max(1, view.width - leftW - rightW);
  const line = leftAnsi + paint(" ".repeat(space), ui.statusBar) + rightAnsi;
  const pad = view.width - (leftW + space + rightW);
  return pad > 0 ? line + paint(" ".repeat(pad), ui.statusBar) : line;
}

/** Keep the leading key hints that fit within `budget` visible columns. */
function fitHints(
  hints: readonly KeyHint[],
  budget: number,
): readonly KeyHint[] {
  const out: KeyHint[] = [];
  for (const h of hints) {
    if (visibleWidth(hintsPlain([...out, h])) > budget) break;
    out.push(h);
  }
  return out;
}

/** Replace the control characters in `text` with their Control Pictures glyphs,
 * the same substitution the content rows use. This is applied to the strings
 * that reach the terminal outside `displayLine` — the status bar's file name and
 * the dialog body — which can carry a file name a user chose. One code point in
 * gives one code point out, so the callers' width arithmetic is unchanged. */
function showControls(text: string): string {
  let out = "";
  for (const cp of text) out += glyphFor(cp);
  return out;
}

/** Truncate `text` to `max` columns with an ellipsis. `dropTail` keeps the head
 * (a trailing `…`); otherwise it keeps the tail (a leading `…`, for a path whose
 * file name matters most). */
function truncate(text: string, max: number, dropTail: boolean): string {
  const cps = [...text];
  if (cps.length <= max) return text;
  if (max <= 1) return "…";
  return dropTail
    ? cps.slice(0, max - 1).join("") + "…"
    : "…" + cps.slice(cps.length - (max - 1)).join("");
}

/** The default browsing key hints, in priority order (most important first) so
 * that {@link fitHints} drops the least important when the bar runs short of
 * room. The conditional keys appear only where they would do something. */
function browseHints(view: ViewState): KeyHint[] {
  const hints: KeyHint[] = [
    { key: "?", label: "Help" },
    { key: "Q", label: "Quit" },
    { key: "/", label: "Search" },
    { key: "WASD", label: "Tree" },
  ];
  if (view.canExpand) hints.push({ key: "^L", label: "Expand" });
  if (view.canRender) {
    hints.push({
      key: "V",
      label: view.viewMode === "rendered" ? "Source" : "Rendered",
    });
  }
  if (view.canEdit) hints.push({ key: "e", label: "Edit" });
  if (view.hasNonPrintables) hints.push({ key: "C", label: "Chars" });
  const wrapLabel = view.wrapMode === "off"
    ? "Hard wrap"
    : view.wrapMode === "hard"
    ? "Word wrap"
    : "Unwrap";
  hints.push({ key: "\\", label: wrapLabel });
  hints.push({ key: "#", label: "Lines" });
  return hints;
}

/** `key label  key label …` as plain text, for the monochrome bar and widths. */
function hintsPlain(hints: readonly KeyHint[]): string {
  return hints.map((h) => `${h.key} ${h.label}`).join("  ");
}

/** The same, colored: each key highlighted, the labels plain, on the bar bg. */
function hintsAnsi(hints: readonly KeyHint[]): string {
  let out = "";
  hints.forEach((h, i) => {
    out += paint(h.key, ui.statusKey);
    out += paint(
      ` ${h.label}${i < hints.length - 1 ? "  " : ""}`,
      ui.statusBar,
    );
  });
  return out;
}

function lineInfo(
  first: number,
  last: number,
  total: number,
  pct: number,
  atEnd: boolean,
): string {
  const where = atEnd ? "END" : `${pct}%`;
  return `${first}-${last}/${total}  ${where}`;
}

//
// Overlay (info card / definition peek)
//

export interface OverlayBox {
  x: number;
  y: number;
  boxW: number;
  boxH: number;
  innerW: number;
  innerH: number;
}

/** Geometry of the centered overlay box for the given terminal size. The box is
 * clamped to fit inside the terminal, so on a terminal too small to hold the box
 * the dimensions collapse to the terminal size rather than going negative. Inner
 * dimensions never go below 0, which keeps {@link applyOverlay}'s repeat/slice
 * maths safe. A box narrower or shorter than the 2-cell border chrome cannot be
 * drawn; `applyOverlay` checks for that. */
export function overlayBox(width: number, height: number): OverlayBox {
  const boxW = Math.max(
    0,
    Math.min(width - 4, Math.max(40, Math.floor(width * 0.8))),
  );
  const boxH = Math.max(
    0,
    Math.min(height - 4, Math.max(6, Math.floor(height * 0.7))),
  );
  return {
    x: Math.max(0, Math.floor((width - boxW) / 2)),
    y: Math.max(0, Math.floor((height - boxH) / 2)),
    boxW,
    boxH,
    innerW: Math.max(0, boxW - 2),
    innerH: Math.max(0, boxH - 2),
  };
}

function applyOverlay(
  rows: string[],
  view: ViewState,
  overlay: OverlayState,
): void {
  const { x, y, boxW, boxH, innerW, innerH } = overlayBox(
    view.width,
    view.height,
  );
  // A terminal smaller than the 2-cell border chrome leaves no room to draw the
  // box; show the underlying content rather than indexing rows out of range.
  if (boxW < 2 || boxH < 2) return;

  // An overlay showing source code is a blue editor window; everything else is
  // a gray dialog. The border carries the same background as the body, so the
  // panel reads as one solid block rather than a frame over the content behind.
  const source = !!overlay.sourceView;
  const panelBg = source ? ui.editorBg : ui.overlayBg;
  const styler = source ? spanStyle : overlaySpanStyle;
  const border = view.color
    ? { ...(source ? ui.overlaySourceBorder : ui.overlayBorder), bg: panelBg }
    : EMPTY_STYLE;
  const bg: Style = { bg: panelBg };
  const selBg: Style = { bg: ui.overlayHighlightBg };

  // Double-line frame, after the Turbo Pascal window border.
  const top = `╔${truncCenter(` ${overlay.title} `, boxW - 2, "═")}╗`;
  const bottom = `╚${truncCenter(` ${overlay.footer} `, boxW - 2, "═")}╝`;
  rows[y] = overlayRow(rows[y], x, paintIf(top, border, view.color));
  rows[y + boxH - 1] = overlayRow(
    rows[y + boxH - 1],
    x,
    paintIf(bottom, border, view.color),
  );

  for (let i = 0; i < innerH; i++) {
    const lineIdx = overlay.scroll + i;
    const srcLine = overlay.lines[lineIdx];
    const rowBg = lineIdx === overlay.selectedLine ? selBg : bg;
    const cells: Cell[] = new Array(innerW);
    for (let c = 0; c < innerW; c++) cells[c] = { ch: " ", style: rowBg };
    if (srcLine) {
      const display = displayLine(srcLine, view.displayMode, styler);
      // One blank column of margin sits inside each border, so content is drawn
      // into cells[1 … innerW-2].
      for (let idx = 0; idx < display.length; idx++) {
        const col = idx + 1;
        if (col >= innerW - 1) break;
        const dc = display[idx];
        const style = view.color ? mergeBg(dc.ansi ?? dc.syntax, rowBg) : rowBg;
        cells[col] = { ch: dc.ch, style };
      }
    }
    const body = cellsToAnsi(cells, view.color);
    const rowText = paintIf("║", border, view.color) + body +
      paintIf("║", border, view.color);
    rows[y + 1 + i] = overlayRow(rows[y + 1 + i], x, rowText);
  }

  if (view.color) castShadow(rows, view, x, y, boxW, boxH);
}

/** The Turbo Pascal drop shadow: the content two columns to the right of the box
 * (from one row below its top) and one row below it (offset two columns in) is
 * repainted dark, so the dialog appears to float above the screen. */
function castShadow(
  rows: string[],
  view: ViewState,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
): void {
  for (let r = y + 1; r <= y + boxH; r++) {
    darkenSpan(rows, view, r, x + boxW, 2);
  }
  darkenSpan(rows, view, y + boxH, x + 2, boxW);
}

/** Repaint `count` cells at visible column `from` of row `r` in the shadow
 * color, keeping whatever characters were there. Clamped to the row and the
 * terminal width so the fixed row width is preserved. */
function darkenSpan(
  rows: string[],
  view: ViewState,
  r: number,
  from: number,
  count: number,
): void {
  if (r < 0 || r >= rows.length || from < 0) return;
  const n = Math.min(count, view.width - from);
  if (n <= 0) return;
  const chars = stripAnsi(sliceVisible(rows[r], from, from + n))
    .padEnd(n, " ").slice(0, n);
  rows[r] = overlayRow(rows[r], from, paint(chars, ui.overlayShadow));
}

//
// Modal dialog (save / revert / amend prompt)
//

/** Blank columns between adjacent buttons in a dialog's button row. */
const BUTTON_GAP = 3;

/** Blank columns of margin inside each side border of a dialog, between the
 * border and the widest line of content. */
const DIALOG_HMARGIN = 2;

/** The drawn face of a button: its label with one space of padding each side. */
function faceText(b: DialogButton): string {
  return ` ${b.label} `;
}

function faceWidth(b: DialogButton): number {
  return cpLen(faceText(b));
}

/** The face plus the one column of right-hand shadow it casts. */
function slotWidth(b: DialogButton): number {
  return faceWidth(b) + 1;
}

/** Width of the whole button row: every button slot plus the gaps between. */
function buttonsWidth(buttons: readonly DialogButton[]): number {
  if (buttons.length === 0) return 0;
  return buttons.reduce((w, b) => w + slotWidth(b), 0) +
    BUTTON_GAP * (buttons.length - 1);
}

export interface DialogBox {
  x: number;
  y: number;
  boxW: number;
  boxH: number;
  innerW: number;
  innerH: number;
}

/** Geometry of the centered dialog box, sized to its content (title, body and
 * button row) or to the body's fixed width, and clamped to leave two cells for
 * the drop shadow. */
export function dialogBox(
  view: Pick<ViewState, "width" | "height">,
  dialog: DialogState,
): DialogBox {
  const titleW = cpLen(dialog.title) + 4; // the padding spaces and some fill
  const bodyW = dialog.width ??
    dialog.body.reduce((m, l) => Math.max(m, cpLen(l)), 0);
  const btnW = buttonsWidth(dialog.buttons);
  const contentW = Math.max(titleW, bodyW, btnW);
  // The margin columns each side, then the two borders.
  // Inner rows: a blank under the title, the body, a blank, the buttons, and the
  // buttons' shadow.
  const boxW = Math.max(
    0,
    Math.min(contentW + 2 * DIALOG_HMARGIN + 2, view.width - 2),
  );
  const boxH = Math.max(0, Math.min(dialog.body.length + 6, view.height - 1));
  return {
    x: Math.max(0, Math.floor((view.width - boxW) / 2)),
    y: Math.max(0, Math.floor((view.height - boxH) / 2)),
    boxW,
    boxH,
    innerW: Math.max(0, boxW - 2),
    innerH: Math.max(0, boxH - 2),
  };
}

/** The top border of a dialog: the title centered in the width and filled with
 * the double rule. */
function titleBar(title: string, width: number): string {
  if (width <= 0) return "";
  return truncCenter(` ${title} `, width, "═");
}

interface ButtonPos {
  b: DialogButton;
  start: number;
  faceW: number;
}

/** Left-to-right positions of the buttons, as a block centered in `innerW`. */
function layoutButtons(
  buttons: readonly DialogButton[],
  innerW: number,
): ButtonPos[] {
  let cx = Math.max(1, Math.floor((innerW - buttonsWidth(buttons)) / 2));
  const out: ButtonPos[] = [];
  for (const b of buttons) {
    const faceW = faceWidth(b);
    out.push({ b, start: cx, faceW });
    cx += faceW + 1 + BUTTON_GAP;
  }
  return out;
}

/**
 * Returns the inner row of a dialog box of `innerH` rows that the buttons are
 * drawn on, or -1 when the box is too short to show them below the body.
 */
function buttonRowOf(dialog: DialogState, innerH: number): number {
  const row = innerH - 2; // the buttons' shadow takes the last row
  return row > dialog.body.length ? row : -1;
}

/**
 * Returns the index of the button drawn at the zero-based screen cell `x`, `y`,
 * at rest or pushed one column right, or -1 when no button is drawn there.
 */
export function dialogButtonAt(
  view: Pick<ViewState, "width" | "height">,
  dialog: DialogState,
  x: number,
  y: number,
): number {
  const box = dialogBox(view, dialog);
  const buttonRow = buttonRowOf(dialog, box.innerH);
  const col = x - box.x - 1;
  if (
    box.boxW < 2 || buttonRow < 0 || y !== box.y + 1 + buttonRow ||
    col >= box.innerW
  ) return -1;
  return layoutButtons(dialog.buttons, box.innerW).findIndex((
    { start, faceW },
  ) => col >= start && col <= start + faceW);
}

/** The face index of the highlighted shortcut letter, or -1 if the hotkey does
 * not appear in the label. Offset by one for the leading pad space. */
function hotkeyFaceIndex(b: DialogButton): number {
  const hk = b.hotkey.toLowerCase();
  const idx = [...b.label].findIndex((c) => c.toLowerCase() === hk);
  return idx < 0 ? -1 : idx + 1;
}

function applyDialog(
  rows: string[],
  view: ViewState,
  dialog: DialogState,
): void {
  const { x, y, boxW, boxH, innerW, innerH } = dialogBox(view, dialog);
  if (boxW < 2 || boxH < 2) return;

  const border = view.color
    ? { ...ui.overlayBorder, bg: ui.overlayBg }
    : EMPTY_STYLE;
  const panelBg: Style = { bg: ui.overlayBg };
  const textStyle = view.color ? mergeBg(ui.dialogText, panelBg) : panelBg;

  const top = `╔${titleBar(dialog.title, boxW - 2)}╗`;
  const bottom = `╚${"═".repeat(Math.max(0, boxW - 2))}╝`;
  rows[y] = overlayRow(rows[y], x, paintIf(top, border, view.color));
  rows[y + boxH - 1] = overlayRow(
    rows[y + boxH - 1],
    x,
    paintIf(bottom, border, view.color),
  );

  const layout = layoutButtons(dialog.buttons, innerW);
  const buttonRow = buttonRowOf(dialog, innerH);
  // The focused button is drawn highlighted; without an explicit focus, the
  // default button is. A pushed button is drawn mid-press.
  const focusIdx = dialog.focus ??
    dialog.buttons.findIndex((b) => b.kind === "default");
  const pushedIdx = dialog.pushed ?? -1;
  for (let i = 0; i < innerH; i++) {
    const cells: Cell[] = new Array(innerW);
    for (let c = 0; c < innerW; c++) cells[c] = { ch: " ", style: panelBg };
    const bodyIdx = i - 1; // one blank row sits under the title
    if (bodyIdx >= 0 && bodyIdx < dialog.body.length) {
      placeText(cells, dialog.body[bodyIdx], textStyle, dialog.output);
    } else if (i === buttonRow) {
      placeButtonFaces(cells, layout, view.color, panelBg, focusIdx, pushedIdx);
    } else if (buttonRow >= 0 && i === buttonRow + 1 && view.color) {
      placeButtonShadows(cells, layout, panelBg, pushedIdx);
    }
    const rowText = paintIf("║", border, view.color) +
      cellsToAnsi(cells, view.color) + paintIf("║", border, view.color);
    rows[y + 1 + i] = overlayRow(rows[y + 1 + i], x, rowText);
  }

  if (view.color) castShadow(rows, view, x, y, boxW, boxH);
}

/** Write `text` in `cells`, centered or starting after the dialog's margin,
 * and clipped to leave one blank column inside each edge. */
function placeText(
  cells: Cell[],
  text: string,
  style: Style,
  leftAligned = false,
): void {
  const innerW = cells.length;
  const chars = [...showControls(text)];
  const start = leftAligned
    ? DIALOG_HMARGIN
    : 1 + Math.max(0, Math.floor((innerW - 2 - chars.length) / 2));
  for (let j = 0; j < chars.length; j++) {
    const col = start + j;
    if (col >= 1 && col <= innerW - 2) cells[col] = { ch: chars[j], style };
  }
}

function placeButtonFaces(
  cells: Cell[],
  layout: ButtonPos[],
  color: boolean,
  panelBg: Style,
  focus: number,
  pushed: number,
): void {
  layout.forEach(({ b, start, faceW }, idx) => {
    const chars = [...faceText(b)];
    const face = !color
      ? panelBg
      : idx === focus
      ? ui.buttonDefault
      : ui.button;
    const keyStyle = color ? ui.buttonKey : panelBg;
    const hk = hotkeyFaceIndex(b);
    // A pressed button slides one column right, into the space its shadow held.
    const shift = idx === pushed ? 1 : 0;
    for (let j = 0; j < chars.length; j++) {
      const col = start + shift + j;
      if (col >= 0 && col < cells.length) {
        cells[col] = { ch: chars[j], style: j === hk ? keyStyle : face };
      }
    }
    const rightShadow = start + faceW;
    if (
      color && idx !== pushed && rightShadow >= 0 && rightShadow < cells.length
    ) {
      // A lower half-block in the column beside the face, matching the band
      // beneath, so the shadow reads as a thin edge along the bottom.
      cells[rightShadow] = {
        ch: "▄",
        style: mergeBg(ui.buttonShadow, panelBg),
      };
    }
  });
}

/** The buttons' drop shadow row: an upper half-block band under each face,
 * shifted one column right so it lines up with the right-hand shadow. */
function placeButtonShadows(
  cells: Cell[],
  layout: ButtonPos[],
  panelBg: Style,
  pushed: number,
): void {
  const style = mergeBg(ui.buttonShadow, panelBg);
  layout.forEach(({ start, faceW }, idx) => {
    if (idx === pushed) return; // a pressed button casts no shadow
    for (let k = 0; k < faceW; k++) {
      const col = start + 1 + k;
      if (col >= 0 && col < cells.length) {
        cells[col] = { ch: "▀", style };
      }
    }
  });
}

/** Splice `insert` into `base` starting at visible column `x`. */
function overlayRow(base: string, x: number, insert: string): string {
  const left = sliceVisible(base, 0, x);
  const insertW = visibleWidth(insert);
  const right = sliceVisible(base, x + insertW, Number.MAX_SAFE_INTEGER);
  return left + RESET + insert + RESET + right;
}

//
// Cell / style helpers
//

function cellsToAnsi(cells: Cell[], color: boolean): string {
  if (!color) return cells.map((c) => c.ch).join("");
  let out = "";
  let curKey: string | null = null;
  let curOpen = "";
  for (const cell of cells) {
    const open = sgrInline(cell.style);
    if (open !== curKey) {
      if (curKey !== null) out += RESET;
      out += open;
      curKey = open;
      curOpen = open;
    }
    out += cell.ch;
  }
  if (curOpen !== "") out += RESET;
  return out;
}

function sgrInline(style: Style): string {
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.strikethrough) codes.push(9);
  if (style.fg) codes.push(38, 2, style.fg[0], style.fg[1], style.fg[2]);
  if (style.bg) codes.push(48, 2, style.bg[0], style.bg[1], style.bg[2]);
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function mergeBg(style: Style, bg: Style): Style {
  if (!bg.bg) return style;
  return { ...style, bg: bg.bg };
}

function paintIf(text: string, style: Style, color: boolean): string {
  return color ? paint(text, style) : text;
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case "section":
      return "▸";
    case "pattern":
      return "◆";
    case "builder":
      return "◇";
    case "closure":
      return "λ";
    case "schema":
      return "▦";
    case "function":
    case "method":
      return "ƒ";
    case "interface":
    case "typeAlias":
    case "class":
      return "𝑻";
    case "return":
      return "⏎";
    case "control":
      return "⎇";
    case "hunk":
      return "±";
    case "comment":
      return "#";
    default:
      return "·";
  }
}

//
// Visible-width string ops (ANSI-aware)
//

function padTo(text: string, width: number): string {
  const len = visibleWidth(text);
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

/** Slice by visible columns (code points), keeping ANSI escapes before kept
 * text. A non-BMP code point counts as one column. */
function sliceVisible(text: string, from: number, to: number): string {
  let out = "";
  let col = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = text.slice(i).match(LEADING_ESCAPE);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (col >= from && col < to) out += ch;
    col += 1;
    i += ch.length;
  }
  return out;
}

function truncCenter(text: string, width: number, fill: string): string {
  const len = cpLen(text);
  if (len >= width) {
    let out = "";
    let c = 0;
    for (const ch of text) {
      if (c >= width) break;
      out += ch;
      c += 1;
    }
    return out;
  }
  const total = width - len;
  const leftN = Math.floor(total / 2);
  return fill.repeat(leftN) + text + fill.repeat(total - leftN);
}

export const _internal = {
  sliceVisible,
  padTo,
  cellsToAnsi,
  mergeBg,
  darkenSpan,
};
