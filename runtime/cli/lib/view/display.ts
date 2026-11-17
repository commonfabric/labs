/**
 * Turns a source {@link Line} into the sequence of display cells the renderer
 * draws, choosing how to present the non-printable characters (control codes and
 * escape sequences) the source may carry. Three modes are offered:
 *
 *   - "pictures": every non-printable is shown as its Unicode Control Pictures
 *     glyph (U+000B → ␋, tab → ␉, ESC → ␛), one column each. Nothing is hidden
 *     and every source code point is drawn in a display column of its own or
 *     shares one with the rest of its character, which is what the editor
 *     relies on.
 *   - "ansi": runs that parse as ANSI color (SGR) sequences are consumed and
 *     their colors override the syntax highlighting of the text that follows,
 *     until the next sequence or a reset. A tab advances to the next display
 *     column that is a multiple of {@link TAB_STOP}, drawn as one to
 *     {@link TAB_STOP} blank cells. Characters overstruck through backspaces,
 *     as `man` emphasizes text, are drawn as one character, bold or underlined
 *     as {@link matchOverstrike} describes. Every other non-printable is shown
 *     as its Control Pictures glyph.
 *   - "hidden": runs that parse as ANSI control sequences are dropped entirely.
 *     Each remaining run of non-printables collapses to a single ellipsis.
 *
 * The result is a flat list of {@link DisplayCell}s in display order, one for
 * each column of the terminal the line takes. The code points that draw one
 * character as a reader sees it, such as a letter and its combining marks,
 * share a cell, and a wide character's cell is followed by an empty one for
 * its second column. Each cell carries the source columns it stands for, so
 * the renderer can map selection and search ranges — stated in source columns
 * — onto the cells it draws.
 */

import { cpLen, type Rgb, type Style } from "./ansi.ts";
import type { Line } from "./model.ts";
import { spanStyle } from "./highlight.ts";
import { cells, charColumns, graphemeAt, graphemes } from "./width.ts";

export type DisplayMode = "pictures" | "ansi" | "hidden";

/** The spacing of the tab stops in "ansi" mode, in display columns. */
export const TAB_STOP = 4;

/** The cycle order for the toggle, starting with the initial mode. */
export const DISPLAY_MODES: readonly DisplayMode[] = [
  "ansi",
  "hidden",
  "pictures",
];

/** A short label for the status line when the mode changes. */
export function displayModeLabel(mode: DisplayMode): string {
  switch (mode) {
    case "pictures":
      return "control pictures";
    case "ansi":
      return "ANSI color";
    case "hidden":
      return "hidden";
  }
}

/** One drawn column: the glyph, or an empty string for the second column of a
 * wide character, the source column it originates from, the token color of
 * that source column, and an ANSI color override when one is active (mode
 * "ansi"). */
export interface DisplayCell {
  readonly ch: string;
  readonly col: number;

  /** Exclusive source column represented by this display cell. */
  readonly sourceEnd: number;

  readonly syntax: Style;
  readonly ansi?: Style;
}

/** One source code point with its column, UTF-16 index, and token color. */
interface SourcePoint {
  readonly cp: string;
  readonly col: number;
  readonly index: number;
  readonly syntax: Style;
}

/** Expand a line's spans into its code points, each tagged with its column (a
 * code-point index), its UTF-16 index in the line's text, and the token color
 * of the span it belongs to. The spans are gapless and concatenate to the
 * verbatim line, so this reconstructs the whole line. */
function sourcePoints(line: Line, styler: SpanStyler): SourcePoint[] {
  const out: SourcePoint[] = [];
  let index = 0;
  for (const span of line.spans) {
    const syntax = styler(span);
    let col = span.col;
    for (const cp of span.text) {
      out.push({ cp, col, index, syntax });
      col += 1;
      index += cp.length;
    }
  }
  return out;
}

/** Resolves the color for a span. The default is the editor palette; the
 * overlay passes the dialog palette. */
export type SpanStyler = (span: Line["spans"][number]) => Style;

/**
 * The display column a source column lands on for horizontal scrolling: the
 * display index of the first cell whose source range ends after `col`. That is
 * the cell that draws `col`, such as a character of several code points, an
 * overstrike, or a collapsed run, or for a column inside a hidden sequence the
 * next thing drawn, or the display width when nothing follows. In "pictures"
 * mode, for a line of characters that each take one code point and one column,
 * it is the source column unchanged.
 */
export function displayColumnOf(
  line: Pick<Line, "text">,
  mode: DisplayMode,
  col: number,
): number {
  const { text } = line;
  if (mode === "pictures" && textLayout(text) === "narrow") return col;
  const index = codePointIndex(text, col);
  let column = 0;
  visitDisplayCellSources(text, mode, (_start, end) => {
    if (end > index) return false;
    column++;
    return true;
  });
  return column;
}

/** The UTF-16 index in `text` of code point `col`, or the text's length when
 * `col` is past its end. */
function codePointIndex(text: string, col: number): number {
  let index = 0;
  for (let n = 0; n < col && index < text.length; n++) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

/** The source column represented at a display-column offset. */
export function sourceColumnOf(
  line: Pick<Line, "text">,
  mode: DisplayMode,
  displayCol: number,
): number {
  const at = Math.max(0, displayCol);
  const { text } = line;
  if (mode === "pictures" && textLayout(text) === "narrow") {
    return Math.min(at, cpLen(text));
  }
  let column = 0;
  let start = text.length;
  visitDisplayCellSources(text, mode, (cellStart) => {
    if (column++ < at) return true;
    start = cellStart;
    return false;
  });
  return column === 0 ? 0 : cpLen(text.slice(0, start));
}

/** Number of cells a line occupies in one display mode. */
export function displayWidth(line: Line, mode: DisplayMode): number {
  const { text } = line;
  const layout = textLayout(text);
  if (layout === "narrow" && mode === "pictures") return cpLen(text);
  if (layout !== "joined" && (mode === "pictures" || !hasNonPrintable(text))) {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i) ?? 0;
      if (code > 0xffff) i++;
      width += codePointColumns(code);
    }
    return width;
  }
  let width = 0;
  visitDisplayCellSources(text, mode, () => {
    width++;
    return true;
  });
  return width;
}

/**
 * Visit the UTF-16 source range represented by each visible display cell, in
 * display order, as {@link displayLine} draws them. A tab in "ansi" mode draws
 * several cells, so its range is visited once per cell, and so is a wide
 * character's, with `continued` true for each cell after its first. An
 * overstrike in "ansi" mode draws one character for its whole range, and the
 * visitor also receives that character as `drawn`. Returning false from the
 * visitor stops the scan.
 */
export function visitDisplayCellSources(
  text: string,
  mode: DisplayMode,
  visit: (
    start: number,
    end: number,
    drawn?: string,
    continued?: boolean,
  ) => boolean,
): boolean {
  const layout = textLayout(text);
  if (layout === "narrow") return visitCodePointCells(text, mode, visit);
  if (layout === "wide" && !hasNonPrintable(text)) {
    // Text without control characters draws a cell for each code point in
    // every mode.
    for (let i = 0; i < text.length;) {
      const code = text.codePointAt(i) ?? 0;
      const end = i + (code > 0xffff ? 2 : 1);
      for (let column = 0; column < codePointColumns(code); column++) {
        if (!visit(i, end, undefined, column > 0)) return false;
      }
      i = end;
    }
    return true;
  }
  if (text !== lastCells.text || mode !== lastCells.mode) {
    lastCells = { text, mode, cells: joinedCells(text, mode, layout) };
  }
  for (const { start, end, drawn, continued } of lastCells.cells) {
    if (!visit(start, end, drawn, continued)) return false;
  }
  return true;
}

/** A cell that {@link visitDisplayCellSources} visits. */
interface VisitedCell {
  readonly start: number;
  readonly end: number;
  readonly drawn: string | undefined;
  readonly continued: boolean;
}

/** The cells {@link visitDisplayCellSources} visits for `text` in `mode`
 * when its characters are joined or it has control characters. */
function joinedCells(
  text: string,
  mode: DisplayMode,
  layout: "wide" | "joined",
): VisitedCell[] {
  const parts: Array<{ start: number; end: number; ch: string }> = [];
  const overstruck = new Set<number>();
  visitCodePointCells(text, mode, (start, end, drawn) => {
    if (drawn !== undefined) overstruck.add(parts.length);
    parts.push({ start, end, ch: drawn ?? cellGlyph(text, start, mode) });
    return true;
  }, false);
  const cells: VisitedCell[] = [];
  let i = 0;
  for (const { length, columns } of characterSpans(parts, layout)) {
    const start = parts[i].start;
    const end = parts[i + length - 1].end;
    const drawn = length === 1 && overstruck.has(i) ? parts[i].ch : undefined;
    // Each cell of a tab is a blank of its own.
    const tab = parts[i].ch === "\t";
    for (let column = 0; column < columns; column++) {
      cells.push({ start, end, drawn, continued: column > 0 && !tab });
    }
    i += length;
  }
  return cells;
}

/** The text {@link visitDisplayCellSources} last visited the joined cells of,
 * the mode, and the cells, since the same line is usually measured several
 * times in a row. */
let lastCells: { text: string; mode: DisplayMode; cells: VisitedCell[] } = {
  text: "",
  mode: "pictures",
  cells: [],
};

/** The glyph a cell draws for the source range starting at `start` of `text`
 * that is not an overstrike, before tabs are expanded: the tab itself for a
 * tab in "ansi" mode, an ellipsis for a run of non-printables in "hidden"
 * mode, and otherwise the code point at `start`, or its picture when it is a
 * control character. */
function cellGlyph(text: string, start: number, mode: DisplayMode): string {
  const cp = String.fromCodePoint(text.codePointAt(start) ?? 0);
  if (mode === "ansi" && cp === "\t") return cp;
  return mode === "hidden" && isNonPrintable(cp) ? "…" : glyphFor(cp);
}

/**
 * Returns, for each character as a reader sees it that the glyphs of `parts`
 * draw together, how many of the parts draw it and how many columns it
 * takes, at least one, and for a tab, drawn as the tab itself, as many as
 * reach the next tab stop. Each part draws one code point, and in a "wide"
 * layout each is a character of its own.
 */
function characterSpans(
  parts: ReadonlyArray<{ readonly ch: string }>,
  layout: "wide" | "joined",
): Array<{ length: number; columns: number }> {
  const characters = layout === "wide"
    ? parts.map((part) => part.ch)
    : joinedCharacters(parts);
  const spans: Array<{ length: number; columns: number }> = [];
  let column = 0;
  let i = 0;
  for (const char of characters) {
    let length = 0;
    for (let units = 0; units < char.length; length++) {
      units += parts[i + length].ch.length;
    }
    const columns = char === "\t"
      ? tabWidthAt(column)
      : Math.max(1, characterColumns(char));
    spans.push({ length, columns });
    column += columns;
    i += length;
  }
  return spans;
}

/** The characters that the glyphs of `parts`, each of one code point, draw.
 * Only the stretches around a code point that takes no column are segmented,
 * since two code points beside each other that both take columns never join
 * each other. */
function joinedCharacters(
  parts: ReadonlyArray<{ readonly ch: string }>,
): string[] {
  const joins = (i: number) =>
    i < parts.length && codePointColumns(parts[i].ch.codePointAt(0) ?? 0) === 0;
  const characters: string[] = [];
  for (let i = 0; i < parts.length;) {
    if (!joins(i) && !joins(i + 1)) {
      characters.push(parts[i++].ch);
      continue;
    }
    let end = i + 1;
    while (joins(end) || end < parts.length && joins(end - 1)) end++;
    let text = "";
    for (let part = i; part < end; part++) text += parts[part].ch;
    for (const char of graphemes(text)) characters.push(char);
    i = end;
  }
  return characters;
}

/** How many columns the one character `char` takes. */
function characterColumns(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const single = char.length === (code > 0xffff ? 2 : 1);
  const columns = single ? codePointColumns(code) : 0;
  return columns > 0 ? columns : charColumns(char);
}

/** `cells`, each drawing one code point or a group of them, with those that
 * draw one character as a reader sees it joined into one cell, followed by an
 * empty cell for each further column the character takes. A character that
 * takes no column is drawn on a space of its own. */
function joinCharacters(
  cells: readonly DisplayCell[],
  layout: "wide" | "joined",
): DisplayCell[] {
  const out: DisplayCell[] = [];
  let i = 0;
  for (const { length, columns } of characterSpans(cells, layout)) {
    if (cells[i].ch === "\t") {
      const blank = { ...cells[i], ch: " " };
      for (let column = 0; column < columns; column++) out.push(blank);
      i += length;
      continue;
    }
    const first = cells[i];
    const last = cells[i + length - 1];
    let ch = first.ch;
    for (let part = i + 1; part < i + length; part++) ch += cells[part].ch;
    const zero = characterColumns(ch) === 0;
    const cell: DisplayCell = length === 1 && !zero
      ? first
      : { ...first, ch: zero ? ` ${ch}` : ch, sourceEnd: last.sourceEnd };
    out.push(cell);
    for (let column = 1; column < columns; column++) {
      out.push({ ...cell, ch: "" });
    }
    i += length;
  }
  return out;
}

/** Whether a character `text` draws in `mode` takes more than one column. */
export function hasWideCharacter(text: string, mode: DisplayMode): boolean {
  const layout = textLayout(text);
  if (layout === "narrow") return false;
  // An overstrike can draw a narrow character in place of a wide one.
  if (layout === "wide" && !text.includes("\b")) return true;
  let wide = false;
  visitDisplayCellSources(text, mode, (_start, _end, _drawn, continued) => {
    wide = continued === true;
    return !wide;
  });
  return wide;
}

/**
 * How the code points of `text` draw: "narrow" when each draws a cell of its
 * own one column wide, "wide" when each is a character of its own but some
 * take two columns, and "joined" when some take no column or can join the
 * code points beside them into one character.
 */
function textLayout(text: string): "narrow" | "wide" | "joined" {
  if (text === lastLayout.text) return lastLayout.layout;
  let layout: "narrow" | "wide" | "joined" = "narrow";
  if (!LATIN.test(text)) {
    for (let i = 0; i < text.length && layout !== "joined"; i++) {
      const code = text.codePointAt(i) ?? 0;
      if (code > 0xffff) i++;
      const columns = codePointColumns(code);
      if (columns === 0) layout = "joined";
      else if (columns > 1) layout = "wide";
    }
  }
  lastLayout = { text, layout };
  return layout;
}

/** The text {@link textLayout} looked at last, and its layout, since the
 * same line is usually measured several times in a row. */
let lastLayout: { text: string; layout: "narrow" | "wide" | "joined" } = {
  text: "",
  layout: "narrow",
};

/** Text of code points up to U+02FF, each of which draws a cell of its own
 * one column wide. */
const LATIN = /^[\0-\u02ff]*$/;

/** How many columns the code point `code` takes as a character of its own,
 * one for a control character, which is drawn as its picture, or 0 when it
 * takes none or can join the code points beside it into one character. */
function codePointColumns(code: number): number {
  if (code < 0x300) return 1;
  const known = code <= 0xffff ? BMP_COLUMNS[code] : 0;
  return known > 0 ? known - 1 : learnColumns(code);
}

/** {@link codePointColumns} for a code point it has not yet worked out. A
 * code point joins others when {@link graphemes} joins it to a letter or a
 * Hangul syllable on either side, or when it is a flag's letter or a Hangul
 * jamo, which join only each other and syllables. */
function learnColumns(code: number): number {
  const remembered = ASTRAL_COLUMNS.get(code);
  if (remembered !== undefined) return remembered;
  const cp = String.fromCodePoint(code);
  const joins = PAIRED.test(cp) ||
    ["a", "\uac00"].some((neighbor) =>
      graphemes(`${neighbor}${cp}`).length === 1 ||
      graphemes(`${cp}${neighbor}`).length === 1
    );
  const columns = joins ? 0 : charColumns(cp);
  if (code <= 0xffff) BMP_COLUMNS[code] = columns + 1;
  else ASTRAL_COLUMNS.set(code, columns);
  return columns;
}

/** One more than the columns {@link codePointColumns} has found for each code
 * point up to U+FFFF, or 0 for one it has not looked at. */
const BMP_COLUMNS = new Uint8Array(0x10000);

/** The columns {@link codePointColumns} has found for each code point past
 * U+FFFF. */
const ASTRAL_COLUMNS = new Map<number, number>();

/** A flag's letter or a Hangul jamo. */
const PAIRED =
  /[\p{Regional_Indicator}\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff]/u;

/** {@link visitDisplayCellSources} before characters of several code points
 * are joined: a cell for each code point, tab cell, overstrike, or collapsed
 * run. A tab is visited once unless `expandTabs` is true. */
function visitCodePointCells(
  text: string,
  mode: DisplayMode,
  visit: (start: number, end: number, drawn?: string) => boolean,
  expandTabs = true,
): boolean {
  let width = 0;
  const overstrikes = mode === "ansi" && text.includes("\b");
  for (let i = 0; i < text.length;) {
    const sequence = mode === "pictures" ? null : matchTextCsi(text, i);
    if (sequence && (mode === "hidden" || sequence.final === "m")) {
      i = sequence.end;
      continue;
    }

    const overstrike = overstrikes ? matchOverstrike(text, i) : null;
    if (overstrike) {
      if (!visit(i, overstrike.end, overstrike.ch)) return false;
      width++;
      i = overstrike.end;
      continue;
    }

    const codePoint = text.codePointAt(i)!;
    const end = i + (codePoint > 0xffff ? 2 : 1);
    if (mode !== "hidden" || !isNonPrintableCode(codePoint)) {
      const cells = mode === "ansi" && codePoint === 0x09 && expandTabs
        ? tabWidthAt(width)
        : 1;
      for (let n = 0; n < cells; n++, width++) {
        if (!visit(i, end)) return false;
      }
      i = end;
      continue;
    }

    let runEnd = end;
    while (runEnd < text.length && matchTextCsi(text, runEnd) === null) {
      const next = text.codePointAt(runEnd)!;
      if (!isNonPrintableCode(next)) break;
      runEnd += next > 0xffff ? 2 : 1;
    }
    if (!visit(i, runEnd)) return false;
    width++;
    i = runEnd;
  }
  return true;
}

/** The number of cells a tab occupies when it starts at display column
 * `col`: enough to reach the next tab stop. */
function tabWidthAt(col: number): number {
  return TAB_STOP - col % TAB_STOP;
}

export function displayLine(
  line: Line,
  mode: DisplayMode,
  styler: SpanStyler = spanStyle,
): DisplayCell[] {
  const layout = textLayout(line.text);
  const cells = codePointCells(line, mode, styler, layout === "narrow");
  return layout === "narrow" ? cells : joinCharacters(cells, layout);
}

/** {@link displayLine} before characters of several code points are joined:
 * a cell for each code point, tab cell, overstrike, or collapsed run, with a
 * tab drawn as one cell holding the tab itself unless `expandTabs` is
 * true. */
function codePointCells(
  line: Line,
  mode: DisplayMode,
  styler: SpanStyler,
  expandTabs: boolean,
): DisplayCell[] {
  const src = sourcePoints(line, styler);
  switch (mode) {
    case "pictures":
      return src.map((s) => ({
        ch: glyphFor(s.cp),
        col: s.col,
        sourceEnd: s.col + 1,
        syntax: s.syntax,
      }));
    case "ansi":
      return displayAnsi(line.text, src, expandTabs);
    case "hidden":
      return displayHidden(src);
  }
}

/** ANSI mode: consume SGR color sequences and carry their color forward as an
 * override, draw each backspace overstrike once with its emphasis, expand each
 * tab to the next tab stop, or leave it as one cell holding the tab itself
 * unless `expandTabs` is true, and show every other non-printable as a
 * Control Pictures glyph. `src` holds the code points of `text`. */
function displayAnsi(
  text: string,
  src: readonly SourcePoint[],
  expandTabs: boolean,
): DisplayCell[] {
  const cells: DisplayCell[] = [];
  const overstrikes = text.includes("\b");
  let active: Style = {};
  let i = 0;
  while (i < src.length) {
    const seq = matchCsi(src, i);
    if (seq && seq.final === "m") {
      active = applySgr(active, seq.params);
      i += seq.len;
      continue;
    }
    const s = src[i];
    const overstrike = overstrikes ? matchOverstrike(text, s.index) : null;
    if (overstrike) {
      // The emphasis adds to the escape sequence colors, or else to the
      // syntax colors.
      const { syntax } = src[i + overstrike.chOffset];
      const colored = hasStyle(active);
      const style: MutableStyle = { ...(colored ? active : syntax) };
      if (overstrike.bold) style.bold = true;
      if (overstrike.underline) style.underline = true;
      cells.push({
        ch: overstrike.ch,
        col: s.col,
        sourceEnd: s.col + overstrike.len,
        syntax,
        ansi: colored || overstrike.bold || overstrike.underline
          ? style
          : undefined,
      });
      i += overstrike.len;
      continue;
    }
    const tab = s.cp === "\t";
    const cell: DisplayCell = {
      ch: tab ? expandTabs ? " " : "\t" : glyphFor(s.cp),
      col: s.col,
      sourceEnd: s.col + 1,
      syntax: s.syntax,
      ansi: hasStyle(active) ? active : undefined,
    };
    const count = tab && expandTabs ? tabWidthAt(cells.length) : 1;
    for (let n = 0; n < count; n++) cells.push(cell);
    i += 1;
  }
  return cells;
}

interface OverstrikeMatch {
  /** The UTF-16 index just past the overstruck characters. */
  readonly end: number;

  /** Number of source code points the overstruck characters span. */
  readonly len: number;

  /** The character drawn. */
  readonly ch: string;

  /** The code-point offset of the drawn character from the start. */
  readonly chOffset: number;

  readonly bold: boolean;
  readonly underline: boolean;
}

/**
 * Match a printable character overstruck through backspaces, starting at
 * UTF-16 index `start`, or null. This is how `man` and `nroff` emphasize text
 * for a printer. The character drawn is the last one struck other than an
 * underscore, so the `+ BS o` that `man` prints for a bullet draws `o`. It is
 * bold when it was struck more than once (`X BS X`), and underlined when an
 * underscore was struck with it (`_ BS X` or `X BS _`), so `_ BS X BS X` is
 * bold and underlined.
 */
function matchOverstrike(text: string, start: number): OverstrikeMatch | null {
  const first = text.codePointAt(start)!;
  let end = start + (first > 0xffff ? 2 : 1);
  if (text.charCodeAt(end) !== 0x08 || isNonPrintableCode(first)) return null;
  let ch = String.fromCodePoint(first);
  const struck = [ch];
  let chOffset = 0;
  let len = 1;
  while (text.charCodeAt(end) === 0x08) {
    const code = text.codePointAt(end + 1);
    if (code === undefined || isNonPrintableCode(code)) break;
    const next = String.fromCodePoint(code);
    struck.push(next);
    if (next !== "_") {
      ch = next;
      chOffset = len + 1;
    }
    end += 1 + next.length;
    len += 2;
  }
  if (len === 1) return null;
  return {
    end,
    len,
    ch,
    chOffset,
    bold: struck.filter((c) => c === ch).length > 1,
    underline: ch !== "_" && struck.includes("_"),
  };
}

/** Hidden mode: drop every ANSI control sequence, and collapse each remaining
 * run of non-printables to a single ellipsis. */
function displayHidden(src: readonly SourcePoint[]): DisplayCell[] {
  const cells: DisplayCell[] = [];
  let i = 0;
  while (i < src.length) {
    const seq = matchCsi(src, i);
    if (seq) {
      i += seq.len;
      continue;
    }
    const s = src[i];
    if (!isNonPrintable(s.cp)) {
      cells.push({
        ch: s.cp,
        col: s.col,
        sourceEnd: s.col + 1,
        syntax: s.syntax,
      });
      i += 1;
      continue;
    }
    // A run of non-printables that does not open an ANSI sequence.
    const start = s.col;
    const syntax = s.syntax;
    let j = i;
    while (
      j < src.length && isNonPrintable(src[j].cp) && matchCsi(src, j) === null
    ) {
      j += 1;
    }
    cells.push({
      ch: "…",
      col: start,
      sourceEnd: src[j - 1].col + 1,
      syntax,
    });
    i = j;
  }
  return cells;
}

//
// non-printable classification & glyphs
//

/** A control code (C0 or DEL/C1) with no ordinary glyph of its own. */
function isNonPrintable(cp: string): boolean {
  return isNonPrintableCode(cp.codePointAt(0) ?? 0x20);
}

function isNonPrintableCode(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** Whether `text` holds any non-printable character — the display modes only
 * differ (control pictures vs. ANSI color vs. hidden) when it does. */
export function hasNonPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isNonPrintableCode(text.charCodeAt(i))) return true;
  }
  return false;
}

/** Whether `text` draws in `mode` exactly as in "pictures" mode: each code
 * point as its control-picture glyph, with nothing hidden. */
export function drawsAsPictures(text: string, mode: DisplayMode): boolean {
  if (mode === "pictures") return true;
  // "ansi" draws a tab blank, and "hidden" draws every non-printable as `…`.
  const redrawn = mode === "ansi"
    ? (code: number) => code === 0x09
    : isNonPrintableCode;
  let next = 0;
  return visitCodePointCells(text, mode, (start, end) => {
    const code = text.codePointAt(start) ?? 0;
    const alike = start === next &&
      end === start + (code > 0xffff ? 2 : 1) && !redrawn(code);
    next = end;
    return alike;
  }) && next === text.length;
}

/** The glyph shown for a code point: itself when printable, else its Control
 * Pictures block glyph. C0 codes map to U+2400+code (so tab → ␉, CR → ␍), DEL to
 * ␡, and the C1 codes — which have no pictures of their own — to the block's
 * substitute glyph. */
export function glyphFor(cp: string): string {
  if (!isNonPrintable(cp)) return cp;
  const c = cp.codePointAt(0)!;
  if (c < 0x20) return String.fromCodePoint(0x2400 + c);
  if (c === 0x7f) return "␡";
  return "␦";
}

/** Replace the control characters in `text` with their Control Pictures glyphs,
 * the same substitution the content rows use, for the strings that reach the
 * terminal outside `displayLine`, such as the status bar's file name and the
 * dialogs' text. Each code point becomes one code point. */
export function showControls(text: string): string {
  let out = "";
  for (const cp of text) out += glyphFor(cp);
  return out;
}

/** The cells of a terminal that `text` fills, as {@link cells} gives them
 * once {@link showControls} has replaced its control characters. */
export function shownCells(text: string): string[] {
  return cells(showControls(text));
}

/**
 * Returns the indices in `chars`, the code points of some text, at which the
 * character that holds the one at `col` starts and ends, as a reader sees
 * characters once {@link showControls} has replaced control characters, or
 * the length of `chars` for both when `col` is past its end. Only the stretch
 * around `col` is segmented, since two code points beside each other that
 * both take columns never join each other.
 */
export function characterAt(
  chars: readonly string[],
  col: number,
): { start: number; end: number } {
  if (col >= chars.length) return { start: chars.length, end: chars.length };
  const joins = (i: number) =>
    i >= 0 && i < chars.length &&
    codePointColumns(chars[i].codePointAt(0) ?? 0) === 0;
  let from = col;
  while (from > 0 && (joins(from - 1) || joins(from))) from--;
  let to = col + 1;
  while (to < chars.length && (joins(to - 1) || joins(to))) to++;
  if (to - from === 1) return { start: col, end: col + 1 };
  const shown = showControls(chars.slice(from, to).join(""));
  const found = graphemeAt(shown, chars.slice(from, col).join("").length);
  const first = from + [...shown.slice(0, found.start)].length;
  return {
    start: first,
    end: first + [...shown.slice(found.start, found.end)].length,
  };
}

/** Truncate `text` to `max` columns, as {@link shownCells} measures them,
 * with an ellipsis, keeping whole characters. `dropTail` keeps the head (a
 * trailing `…`); otherwise it keeps the tail (a leading `…`, for a path whose
 * file name matters most). */
export function truncate(text: string, max: number, dropTail: boolean): string {
  const chars = drawnCharacters(text);
  // The cells one character fills, as shownCells counts them.
  const widths = chars.map((char) =>
    Math.max(1, charColumns(showControls(char)))
  );
  if (widths.reduce((sum, width) => sum + width, 0) <= max) return text;
  if (max <= 1) return "…";
  if (!dropTail) {
    chars.reverse();
    widths.reverse();
  }
  let kept = 0;
  let used = 0;
  while (kept < chars.length && used + widths[kept] <= max - 1) {
    used += widths[kept++];
  }
  const part = chars.slice(0, kept);
  return dropTail ? part.join("") + "…" : "…" + part.reverse().join("");
}

/** The characters of `text` as a reader sees them once {@link showControls}
 * has replaced its control characters, each as `text` writes it. */
export function drawnCharacters(text: string): string[] {
  // Each control character's picture is as long as the character.
  const characters: string[] = [];
  let at = 0;
  for (const char of graphemes(showControls(text))) {
    characters.push(text.slice(at, at + char.length));
    at += char.length;
  }
  return characters;
}

//
// ANSI (CSI) recognition
//

interface CsiMatch {
  /** Number of source code points the whole sequence spans. */
  readonly len: number;

  /** The final byte, e.g. "m" for a color (SGR) sequence. */
  readonly final: string;

  /** The parameter bytes between `ESC [` and the final byte. */
  readonly params: string;
}

interface TextCsiMatch {
  readonly end: number;
  readonly final: string;
}

function matchTextCsi(text: string, start: number): TextCsiMatch | null {
  if (text.charCodeAt(start) !== 0x1b || text.charCodeAt(start + 1) !== 0x5b) {
    return null;
  }
  let i = start + 2;
  while (i < text.length && inCodeRange(text.charCodeAt(i), 0x30, 0x3f)) i++;
  while (i < text.length && inCodeRange(text.charCodeAt(i), 0x20, 0x2f)) i++;
  const final = text.charCodeAt(i);
  return inCodeRange(final, 0x40, 0x7e) ? { end: i + 1, final: text[i] } : null;
}

/** Match a CSI sequence — `ESC [` , parameter bytes (0x30–0x3F), intermediate
 * bytes (0x20–0x2F), then a final byte (0x40–0x7E) — starting at `i`, or null. */
function matchCsi(src: readonly SourcePoint[], i: number): CsiMatch | null {
  if (src[i]?.cp !== "\x1b" || src[i + 1]?.cp !== "[") return null;
  let j = i + 2;
  let params = "";
  while (j < src.length && inRange(src[j].cp, 0x30, 0x3f)) {
    params += src[j].cp;
    j += 1;
  }
  while (j < src.length && inRange(src[j].cp, 0x20, 0x2f)) j += 1;
  if (j < src.length && inRange(src[j].cp, 0x40, 0x7e)) {
    return { len: j - i + 1, final: src[j].cp, params };
  }
  return null;
}

function inRange(cp: string, lo: number, hi: number): boolean {
  const c = cp.codePointAt(0) ?? -1;
  return inCodeRange(c, lo, hi);
}

function inCodeRange(code: number, lo: number, hi: number): boolean {
  return code >= lo && code <= hi;
}

function hasStyle(style: Style): boolean {
  return style.fg !== undefined || style.bg !== undefined ||
    style.bold === true || style.dim === true || style.italic === true ||
    style.underline === true;
}

/** The 16 standard ANSI colors as RGB (Visual Studio Code's default palette). */
const ANSI_16: readonly Rgb[] = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

type MutableStyle = {
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

/** Fold an SGR parameter string into the running style. An empty parameter
 * string (a bare `ESC [ m`) and a `0` reset both clear the style. */
function applySgr(prev: Style, params: string): Style {
  const codes = (params === "" ? "0" : params).split(";").map((p) =>
    p === "" ? 0 : parseInt(p, 10)
  );
  let st: MutableStyle = { ...prev };
  for (let k = 0; k < codes.length; k++) {
    const n = codes[k];
    if (n === 0) st = {};
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 22) st.bold = st.dim = undefined;
    else if (n === 23) st.italic = undefined;
    else if (n === 24) st.underline = undefined;
    else if (n >= 30 && n <= 37) st.fg = ANSI_16[n - 30];
    else if (n === 39) st.fg = undefined;
    else if (n >= 40 && n <= 47) st.bg = ANSI_16[n - 40];
    else if (n === 49) st.bg = undefined;
    else if (n >= 90 && n <= 97) st.fg = ANSI_16[n - 90 + 8];
    else if (n >= 100 && n <= 107) st.bg = ANSI_16[n - 100 + 8];
    else if (n === 38 || n === 48) {
      const c = extendedColor(codes, k);
      if (c) {
        if (n === 38) st.fg = c.rgb;
        else st.bg = c.rgb;
        k += c.consumed;
      }
    }
  }
  return st;
}

/** Read a `38`/`48` extended-color argument beginning after index `k`: either
 * `5;<n>` (a 256-color index) or `2;<r>;<g>;<b>` (truecolor). Returns the RGB
 * and how many further parameters it consumed, or null when malformed. */
function extendedColor(
  codes: readonly number[],
  k: number,
): { rgb: Rgb; consumed: number } | null {
  const kind = codes[k + 1];
  if (kind === 5 && codes.length > k + 2) {
    return { rgb: xterm256(codes[k + 2]), consumed: 2 };
  }
  if (kind === 2 && codes.length > k + 4) {
    return {
      rgb: [byte(codes[k + 2]), byte(codes[k + 3]), byte(codes[k + 4])],
      consumed: 4,
    };
  }
  return null;
}

function byte(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

/** Map a 256-color palette index to RGB: 0–15 are the standard colors, 16–231
 * a 6×6×6 cube, 232–255 a 24-step grayscale ramp. */
function xterm256(index: number): Rgb {
  const n = byte(index);
  if (n < 16) return ANSI_16[n];
  if (n < 232) {
    const c = n - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const step = (v: number) => (v === 0 ? 0 : v * 40 + 55);
    return [step(r), step(g), step(b)];
  }
  const v = (n - 232) * 10 + 8;
  return [v, v, v];
}

export const _internal = {
  applySgr,
  matchCsi,
  xterm256,
  sourcePoints,
};
