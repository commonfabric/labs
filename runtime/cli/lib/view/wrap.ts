/**
 * Screen-row layout for wrapped pager content. A wrapped row identifies
 * the logical line it draws and the display-column offset where that row starts.
 */

import {
  type DisplayCell,
  displayLine,
  type DisplayMode,
  displayWidth,
  visitDisplayCellSources,
} from "./display.ts";
import type { Line } from "./model.ts";

/** How the pager lays out logical lines. */
export type WrapMode = "off" | "hard" | "word";

/** A mode that produces wrapped screen rows. */
export type ActiveWrapMode = Exclude<WrapMode, "off">;

export interface WrappedRow {
  /** Absolute screen row in the complete wrapped document. */
  readonly row: number;

  /** Index of the logical line in the displayed document. */
  readonly line: number;

  /** Display-column offset where this screen row starts. */
  readonly offset: number;

  /** Display-column offset where this logical line's final screen row starts. */
  readonly lastOffset: number;

  /** Source cells available on this row. */
  readonly sourceWidth: number;

  /** Exclusive display-column end of the source cells drawn on this row. */
  readonly sourceEnd: number;

  /** Cells copied from the logical line's prefix before this row's source. */
  readonly prefixWidth: number;

  /** Whether source content continues on the following row. */
  readonly continues: boolean;

  /** Whether this row has room for a continuation marker. */
  readonly wrapMarker: boolean;

  /** Cells reserved at the right edge for a line annotation. */
  readonly suffixWidth: number;
}

export interface WrapDecoration {
  /** Cells reserved on the logical line's first screen row. */
  readonly firstWidth: number;

  /** Cells reserved on the first screen row after the logical line wraps. */
  readonly firstContinuationWidth?: number;

  /** Cells reserved on later screen rows of the logical line. */
  readonly continuationWidth: number;
}

export interface WrapPlan {
  readonly rowCount: number;

  /** Total number of content columns available on each screen row. */
  readonly rowWidth: number;

  /** Display columns consumed by each row that carries a continuation marker. */
  readonly rowStride: number;

  /** First screen row occupied by each logical line. */
  readonly firstRow: readonly number[];

  /** Last screen row occupied by each logical line. */
  readonly lastRow: readonly number[];

  /** Source cells consumed by a continued first row. */
  readonly firstSourceWidth: readonly number[];

  /** Source cells consumed by each continued row after the first. */
  readonly continuationStride: readonly number[];

  /** Source cells consumed by the first continuation when it wraps again. */
  readonly firstContinuationStride: readonly number[];

  /** Annotation width on each logical line's first row. */
  readonly firstSuffixWidth: readonly number[];

  /** Annotation width on each logical line's first continuation row. */
  readonly firstContinuationSuffixWidth: readonly number[];

  /** Annotation width on later rows of each logical line. */
  readonly continuationSuffixWidth: readonly number[];

  /** Display width of each logical line. */
  readonly lineWidth: readonly number[];

  /** Variable word-wrap boundaries, or null entries for fixed-width rows. */
  readonly wordRows: readonly (WordWrapLine | null)[] | null;
}

/** Source boundaries and the repeated prefix for one word-wrapped line. */
export interface WordWrapLine {
  readonly offsets: Uint32Array;
  readonly prefixWidth: number;
}

export interface ViewLayout {
  readonly gutterWidth: number;
  readonly guideWidth: number;
  readonly contentWidth: number;
  readonly marginWidth: number;
}

/** Fit pager chrome around at least one source cell. Wrapped rows retain a
 * second content cell for their continuation marker when the terminal has room.
 * The expansion margin is kept ahead of optional left-side chrome. */
export function fitViewLayout(
  totalWidth: number,
  gutterWidth: number,
  guideWidth: number,
  marginWidth: number,
  wrapLines: boolean,
): ViewLayout {
  const width = Math.max(1, totalWidth);
  const margin = Math.min(Math.max(0, marginWidth), width - 1);
  const availableWidth = width - margin;
  const minContentWidth = wrapLines && availableWidth > 1 ? 2 : 1;
  let gutter = Math.max(0, gutterWidth);
  let guide = Math.max(0, guideWidth);
  if (availableWidth - gutter - guide < minContentWidth) gutter = 0;
  if (availableWidth - gutter - guide < minContentWidth) guide = 0;
  return {
    gutterWidth: gutter,
    guideWidth: guide,
    contentWidth: availableWidth - gutter - guide,
    marginWidth: margin,
  };
}

/** Fit optional left-side chrome while retaining two content columns whenever
 * the terminal has room for both source text and a continuation marker. */
export function fitWrapChrome(
  totalWidth: number,
  gutterWidth: number,
  guideWidth: number,
): { gutterWidth: number; guideWidth: number } {
  const { gutterWidth: gutter, guideWidth: guide } = fitViewLayout(
    totalWidth,
    gutterWidth,
    guideWidth,
    0,
    true,
  );
  return { gutterWidth: gutter, guideWidth: guide };
}

/** Resolve one screen row without storing an object for every continuation in
 * the document. */
export function wrappedRowAt(
  plan: WrapPlan,
  row: number,
): WrappedRow | undefined {
  if (row < 0 || row >= plan.rowCount) return undefined;
  let lo = 0;
  let hi = plan.firstRow.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (plan.firstRow[mid] <= row) lo = mid;
    else hi = mid - 1;
  }
  const within = row - plan.firstRow[lo];
  const lastWithin = plan.lastRow[lo] - plan.firstRow[lo];
  const firstSource = plan.firstSourceWidth[lo];
  const firstContinuationStride = plan.firstContinuationStride[lo];
  const stride = plan.continuationStride[lo];
  const wordRows = plan.wordRows?.[lo];
  const offset = wordRows
    ? wordRows.offsets[within]
    : within === 0
    ? 0
    : within === 1
    ? firstSource
    : firstSource + firstContinuationStride + (within - 2) * stride;
  const lastOffset = wordRows
    ? wordRows.offsets[lastWithin]
    : lastWithin === 0
    ? 0
    : lastWithin === 1
    ? firstSource
    : firstSource + firstContinuationStride + (lastWithin - 2) * stride;
  const suffixWidth = within === 0
    ? plan.firstSuffixWidth[lo]
    : within === 1
    ? plan.firstContinuationSuffixWidth[lo]
    : plan.continuationSuffixWidth[lo];
  const continues = within < lastWithin;
  const available = plan.rowWidth - suffixWidth;
  const wrapMarker = continues && available > 1;
  const prefixWidth = wordRows
    ? repeatedPrefixWidth(
      wordRows.prefixWidth,
      within,
      offset,
      available,
      wrapMarker ? 1 : 0,
      continues ? 1 : plan.lineWidth[lo] - offset,
    )
    : 0;
  const sourceWidth = Math.max(
    0,
    available - prefixWidth - (wrapMarker ? 1 : 0),
  );
  return {
    row,
    line: lo,
    offset,
    lastOffset,
    sourceWidth,
    sourceEnd: wordRows && continues
      ? wordRows.offsets[within + 1]
      : Math.min(plan.lineWidth[lo], offset + sourceWidth),
    prefixWidth,
    continues,
    wrapMarker,
    suffixWidth,
  };
}

/** Resolve the wrapped row containing a display column on one logical line. */
export function wrappedRowForPosition(
  plan: WrapPlan,
  line: number,
  displayCol: number,
): WrappedRow | undefined {
  if (line < 0 || line >= plan.firstRow.length) return undefined;
  const first = plan.firstRow[line];
  const last = plan.lastRow[line];
  const col = Math.max(0, displayCol);
  const wordRows = plan.wordRows?.[line];
  if (wordRows) {
    let lo = 0;
    let hi = wordRows.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (wordRows.offsets[mid] <= col) lo = mid;
      else hi = mid - 1;
    }
    return wrappedRowAt(plan, first + lo);
  }
  let row = first;
  const firstSource = plan.firstSourceWidth[line];
  if (first < last && col >= firstSource) {
    const firstContinuationStride = plan.firstContinuationStride[line];
    const afterFirst = col - firstSource;
    row = first + 1;
    if (first + 1 < last && afterFirst >= firstContinuationStride) {
      row = first + 2 +
        Math.floor(
          (afterFirst - firstContinuationStride) /
            plan.continuationStride[line],
        );
    }
  }
  return wrappedRowAt(plan, Math.min(row, last));
}

/** Lay logical lines out as fixed-width screen rows. Rows whose content
 * continues reserve their final column for a marker. Empty lines still occupy
 * one row, while a line ending exactly at the edge does not add a blank row. */
export function buildWrapPlan(
  lines: readonly Line[],
  mode: DisplayMode,
  width: number,
  decorations: ReadonlyMap<number, WrapDecoration> = new Map(),
  wrapMode: ActiveWrapMode = "hard",
): WrapPlan {
  const rowWidth = Math.max(1, width);
  const rowStride = Math.max(1, rowWidth - 1);
  let rowCount = 0;
  const firstRow: number[] = new Array(lines.length);
  const lastRow: number[] = new Array(lines.length);
  const firstSourceWidth: number[] = new Array(lines.length);
  const continuationStride: number[] = new Array(lines.length);
  const firstContinuationStride: number[] = new Array(lines.length);
  const firstSuffixWidth: number[] = new Array(lines.length);
  const firstContinuationSuffixWidth: number[] = new Array(lines.length);
  const continuationSuffixWidth: number[] = new Array(lines.length);
  const lineWidth: number[] = new Array(lines.length);
  const wordRows: (WordWrapLine | null)[] | null = wrapMode === "word"
    ? new Array(lines.length)
    : null;
  for (let line = 0; line < lines.length; line++) {
    firstRow[line] = rowCount;
    const decoration = decorations.get(line);
    const firstSuffix = Math.min(
      Math.max(0, decoration?.firstWidth ?? 0),
      rowWidth - 1,
    );
    const continuationSuffix = Math.min(
      Math.max(0, decoration?.continuationWidth ?? 0),
      rowWidth - 1,
    );
    const firstContinuationSuffix = Math.min(
      Math.max(
        0,
        decoration?.firstContinuationWidth ?? continuationSuffix,
      ),
      rowWidth - 1,
    );
    const firstAvailable = rowWidth - firstSuffix;
    const firstContinuationAvailable = rowWidth - firstContinuationSuffix;
    const continuationAvailable = rowWidth - continuationSuffix;
    const firstStride = firstAvailable > 1
      ? firstAvailable - 1
      : firstAvailable;
    const nextStride = firstContinuationAvailable > 1
      ? firstContinuationAvailable - 1
      : firstContinuationAvailable;
    const laterStride = continuationAvailable > 1
      ? continuationAvailable - 1
      : continuationAvailable;
    const displayLineWidth = displayWidth(lines[line], mode);
    lineWidth[line] = displayLineWidth;
    let count = 1;
    if (wordRows) {
      const rows = rowWidth > 1 &&
          displayLineWidth > firstAvailable &&
          needsVariableWordLayout(lines[line].text) &&
          wordWrapDiffersFromHard(
            lines[line].text,
            mode,
            displayLineWidth,
            rowWidth,
            firstSuffix,
            firstContinuationSuffix,
            continuationSuffix,
          )
        ? buildWordWrapLine(
          lines[line],
          mode,
          rowWidth,
          firstSuffix,
          firstContinuationSuffix,
          continuationSuffix,
        )
        : null;
      wordRows[line] = rows;
      if (rows) count = rows.offsets.length;
    }
    if (count === 1 && displayLineWidth > firstAvailable) {
      const afterFirst = displayLineWidth - firstStride;
      if (afterFirst <= firstContinuationAvailable) {
        count = 2;
      } else {
        const afterNext = afterFirst - nextStride;
        const middle = Math.max(
          0,
          Math.ceil(
            (afterNext - continuationAvailable) / laterStride,
          ),
        );
        count = 3 + middle;
      }
    }
    rowCount += count;
    lastRow[line] = rowCount - 1;
    firstSourceWidth[line] = count === 1 ? firstAvailable : firstStride;
    firstContinuationStride[line] = nextStride;
    continuationStride[line] = laterStride;
    firstSuffixWidth[line] = firstSuffix;
    firstContinuationSuffixWidth[line] = firstContinuationSuffix;
    continuationSuffixWidth[line] = continuationSuffix;
  }
  return {
    rowCount,
    rowWidth,
    rowStride,
    firstRow,
    lastRow,
    firstSourceWidth,
    continuationStride,
    firstContinuationStride,
    firstSuffixWidth,
    firstContinuationSuffixWidth,
    continuationSuffixWidth,
    lineWidth,
    wordRows,
  };
}

/** Lay out one line at word boundaries and copy its leading punctuation and
 * whitespace onto continuation rows. Long words still make forward progress by
 * using the hard-wrap boundary. */
function buildWordWrapLine(
  line: Line,
  mode: DisplayMode,
  rowWidth: number,
  firstSuffixWidth: number,
  firstContinuationSuffixWidth: number,
  continuationSuffixWidth: number,
): WordWrapLine | null {
  const cells = displayLine(line, mode);
  const characterClasses = classifyDisplayCells(line.text, cells);
  let prefixWidth = 0;
  while (
    prefixWidth < cells.length &&
    (characterClasses[prefixWidth] & PREFIX_CHARACTER) !== 0
  ) {
    prefixWidth++;
  }
  if (prefixWidth === cells.length) prefixWidth = 0;

  const offsets: number[] = [];
  let offset = 0;
  let copiedAnyPrefix = false;

  do {
    const row = offsets.length;
    const suffixWidth = row === 0
      ? firstSuffixWidth
      : row === 1
      ? firstContinuationSuffixWidth
      : continuationSuffixWidth;
    const available = rowWidth - suffixWidth;
    const remaining = cells.length - offset;
    let copiedPrefix = repeatedPrefixWidth(
      prefixWidth,
      row,
      offset,
      available,
      0,
      remaining,
    );
    if (remaining <= available - copiedPrefix) {
      copiedAnyPrefix ||= copiedPrefix > 0;
      offsets.push(offset);
      break;
    }

    const markerWidth = available > 1 ? 1 : 0;
    copiedPrefix = repeatedPrefixWidth(
      prefixWidth,
      row,
      offset,
      available,
      markerWidth,
      1,
    );
    copiedAnyPrefix ||= copiedPrefix > 0;
    const sourceWidth = Math.max(
      1,
      available - copiedPrefix - markerWidth,
    );
    const nextOffset = wordBoundary(
      characterClasses,
      offset,
      sourceWidth,
      prefixWidth,
    );
    offsets.push(offset);
    offset = nextOffset;
  } while (offset < cells.length);

  if (
    !copiedAnyPrefix &&
    hasFixedWrapOffsets(
      offsets,
      cells.length,
      rowWidth,
      firstSuffixWidth,
      firstContinuationSuffixWidth,
      continuationSuffixWidth,
    )
  ) {
    return null;
  }
  return { offsets: Uint32Array.from(offsets), prefixWidth };
}

function hasFixedWrapOffsets(
  offsets: readonly number[],
  lineWidth: number,
  rowWidth: number,
  firstSuffixWidth: number,
  firstContinuationSuffixWidth: number,
  continuationSuffixWidth: number,
): boolean {
  let offset = 0;
  for (let row = 0; row < offsets.length; row++) {
    if (offsets[row] !== offset) return false;
    const suffixWidth = row === 0
      ? firstSuffixWidth
      : row === 1
      ? firstContinuationSuffixWidth
      : continuationSuffixWidth;
    const available = rowWidth - suffixWidth;
    if (lineWidth - offset <= available) {
      return row === offsets.length - 1;
    }
    offset += available > 1 ? available - 1 : available;
  }
  return false;
}

/** Choose the last whitespace-delimited boundary that fits. */
function wordBoundary(
  characterClasses: Uint8Array,
  offset: number,
  sourceWidth: number,
  prefixWidth: number,
): number {
  const hardEnd = Math.min(characterClasses.length, offset + sourceWidth);
  let boundary = -1;
  let i = Math.max(offset, prefixWidth);
  while (i < hardEnd) {
    if ((characterClasses[i] & BREAK_WHITESPACE) === 0) {
      i++;
      continue;
    }
    while (
      i < hardEnd &&
      (characterClasses[i] & BREAK_WHITESPACE) !== 0
    ) {
      i++;
    }
    boundary = Math.min(i, hardEnd);
  }
  return boundary >= 0 ? boundary : hardEnd;
}

const PREFIX_CHARACTER = 1;
const BREAK_WHITESPACE = 2;
const WHITE_SPACE_CHARACTER = /^\p{White_Space}$/u;
const ASCII_PUNCTUATION =
  /^[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]$/u;
const UNICODE_PUNCTUATION = /^\p{Punctuation}$/u;

function classifyDisplayCells(
  text: string,
  cells: readonly DisplayCell[],
): Uint8Array {
  const classes = new Uint8Array(cells.length);
  classes.fill(PREFIX_CHARACTER);
  let displayCol = 0;
  let sourceCol = 0;
  for (const codePoint of text) {
    while (
      displayCol < cells.length &&
      sourceCol >= cells[displayCol].sourceEnd
    ) {
      displayCol++;
    }
    if (
      displayCol < cells.length &&
      sourceCol >= cells[displayCol].col
    ) {
      if (!isPrefixCharacter(codePoint)) {
        classes[displayCol] &= ~PREFIX_CHARACTER;
      }
      if (isBreakWhitespaceCharacter(codePoint)) {
        classes[displayCol] |= BREAK_WHITESPACE;
      }
    }
    sourceCol++;
  }
  return classes;
}

function needsVariableWordLayout(text: string): boolean {
  let leadingPrefix = true;
  let hasPrefix = false;
  let sawBreakWhitespace = false;
  for (const codePoint of text) {
    if (isBreakWhitespaceCharacter(codePoint)) {
      sawBreakWhitespace = true;
    } else if (sawBreakWhitespace) {
      return true;
    }
    if (leadingPrefix) {
      if (isPrefixCharacter(codePoint)) {
        hasPrefix = true;
        continue;
      }
      if (isNonPrintableCharacter(codePoint)) return true;
      if (hasPrefix) return true;
      leadingPrefix = false;
    }
  }
  return false;
}

/** Determine whether word wrapping changes fixed wrapping without retaining
 * per-cell state for lines whose final layout stays fixed. */
function wordWrapDiffersFromHard(
  text: string,
  mode: DisplayMode,
  lineWidth: number,
  rowWidth: number,
  firstSuffixWidth: number,
  firstContinuationSuffixWidth: number,
  continuationSuffixWidth: number,
): boolean {
  let prefixWidth = 0;
  visitDisplayCellSources(text, mode, (start, end) => {
    if (
      (classifySourceRange(text, start, end) & PREFIX_CHARACTER) === 0
    ) {
      return false;
    }
    prefixWidth++;
    return true;
  });
  if (prefixWidth === lineWidth) prefixWidth = 0;

  let row = 0;
  let offset = 0;
  let hardEnd = 0;
  let relevantStart = 0;
  let continues = false;
  let sawBreak = false;
  let lastWasBreak = false;

  const prepareRow = (): boolean => {
    const suffixWidth = row === 0
      ? firstSuffixWidth
      : row === 1
      ? firstContinuationSuffixWidth
      : continuationSuffixWidth;
    const available = rowWidth - suffixWidth;
    const remaining = lineWidth - offset;
    continues = remaining > available;
    const markerWidth = continues && available > 1 ? 1 : 0;
    if (
      repeatedPrefixWidth(
        prefixWidth,
        row,
        offset,
        available,
        markerWidth,
        continues ? 1 : remaining,
      ) > 0
    ) {
      return true;
    }
    hardEnd = continues ? offset + available - markerWidth : lineWidth;
    relevantStart = Math.max(offset, prefixWidth);
    sawBreak = false;
    lastWasBreak = false;
    return false;
  };

  prepareRow();
  let displayCol = 0;
  let differs = false;
  visitDisplayCellSources(text, mode, (start, end) => {
    while (displayCol >= hardEnd) {
      if (continues && sawBreak && !lastWasBreak) {
        differs = true;
        return false;
      }
      offset = hardEnd;
      row++;
      if (prepareRow()) {
        differs = true;
        return false;
      }
      if (!continues) return false;
    }

    if (displayCol >= relevantStart) {
      lastWasBreak =
        (classifySourceRange(text, start, end) & BREAK_WHITESPACE) !== 0;
      sawBreak ||= lastWasBreak;
    }
    displayCol++;
    return true;
  });
  return differs || continues && sawBreak && !lastWasBreak;
}

function classifySourceRange(
  text: string,
  start: number,
  end: number,
): number {
  let classes = PREFIX_CHARACTER;
  for (let i = start; i < end;) {
    const value = text.codePointAt(i)!;
    const codePoint = String.fromCodePoint(value);
    if (!isPrefixCharacter(codePoint)) classes &= ~PREFIX_CHARACTER;
    if (isBreakWhitespaceCharacter(codePoint)) {
      classes |= BREAK_WHITESPACE;
    }
    i += value > 0xffff ? 2 : 1;
  }
  return classes;
}

function repeatedPrefixWidth(
  prefixWidth: number,
  row: number,
  offset: number,
  available: number,
  markerWidth: number,
  requiredSourceWidth: number,
): number {
  if (row === 0 || prefixWidth === 0 || offset < prefixWidth) return 0;
  return available - prefixWidth - markerWidth >= requiredSourceWidth
    ? prefixWidth
    : 0;
}

function isBreakWhitespaceCharacter(codePoint: string): boolean {
  return isWhitespaceCharacter(codePoint) &&
    codePoint !== "\u00a0" &&
    codePoint !== "\u2007" &&
    codePoint !== "\u202f" &&
    codePoint !== "\ufeff";
}

function isNonPrintableCharacter(codePoint: string): boolean {
  const value = codePoint.codePointAt(0) ?? 0x20;
  return value < 0x20 || (value >= 0x7f && value <= 0x9f);
}

function isWhitespaceCharacter(codePoint: string): boolean {
  return WHITE_SPACE_CHARACTER.test(codePoint) || codePoint === "\ufeff";
}

/** ASCII punctuation includes symbols outside Unicode's punctuation category. */
function isPrefixCharacter(codePoint: string): boolean {
  return codePoint.length > 0 && (isWhitespaceCharacter(codePoint) ||
    ASCII_PUNCTUATION.test(codePoint) ||
    UNICODE_PUNCTUATION.test(codePoint));
}

export const _internal = {
  buildWordWrapLine,
  hasFixedWrapOffsets,
};
