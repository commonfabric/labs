/**
 * Turns a source {@link Line} into the sequence of display cells the renderer
 * draws, choosing how to present the non-printable characters (control codes and
 * escape sequences) the source may carry. Three modes are offered:
 *
 *   - "pictures": every non-printable is shown as its Unicode Control Pictures
 *     glyph (U+000B → ␋, tab → ␉, ESC → ␛), one column each. Nothing is hidden
 *     and every source code point maps to exactly one display column, so the
 *     column arithmetic the editor relies on is preserved.
 *   - "ansi": runs that parse as ANSI color (SGR) sequences are consumed and
 *     their colors override the syntax highlighting of the text that follows,
 *     until the next sequence or a reset. Every other non-printable is shown as
 *     its Control Pictures glyph.
 *   - "hidden": runs that parse as ANSI control sequences are dropped entirely.
 *     Each remaining run of non-printables collapses to a single ellipsis.
 *
 * The result is a flat list of {@link DisplayCell}s in display order. Each cell
 * carries the source column it stands for, so the renderer can map selection and
 * search ranges — stated in source columns — onto the cells it draws.
 */

import type { Rgb, Style } from "./ansi.ts";
import type { Line } from "./model.ts";
import { spanStyle } from "./highlight.ts";

export type DisplayMode = "pictures" | "ansi" | "hidden";

/** The cycle order for the toggle, and the initial mode. */
export const DISPLAY_MODES: readonly DisplayMode[] = [
  "pictures",
  "ansi",
  "hidden",
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

/** One drawn column: the glyph, the source column it originates from, the token
 * color of that source column, and an ANSI color override when one is active
 * (mode "ansi"). */
export interface DisplayCell {
  readonly ch: string;
  readonly col: number;

  /** Exclusive source column represented by this display cell. */
  readonly sourceEnd: number;

  readonly syntax: Style;
  readonly ansi?: Style;
}

/** One source code point with its column and token color. */
interface SourcePoint {
  readonly cp: string;
  readonly col: number;
  readonly syntax: Style;
}

/** Expand a line's spans into its code points, each tagged with its column (a
 * code-point index) and the token color of the span it belongs to. The spans
 * are gapless and concatenate to the verbatim line, so this reconstructs the
 * whole line. */
function sourcePoints(line: Line, styler: SpanStyler): SourcePoint[] {
  const out: SourcePoint[] = [];
  for (const span of line.spans) {
    const syntax = styler(span);
    let col = span.col;
    for (const cp of span.text) {
      out.push({ cp, col, syntax });
      col += 1;
    }
  }
  return out;
}

/** Resolves the color for a span. The default is the editor palette; the
 * overlay passes the dialog palette. */
export type SpanStyler = (span: Line["spans"][number]) => Style;

/**
 * The display column a source column lands on for horizontal scrolling. In
 * "pictures" mode this is the source column unchanged (the mapping is 1:1). In
 * the compacting modes it is the display index of the first visible cell at or
 * after `col` — so a column inside a hidden sequence or a collapsed run resolves
 * to the next thing actually drawn — or the display width when nothing follows.
 */
export function displayColumnOf(
  line: Line,
  mode: DisplayMode,
  col: number,
): number {
  if (mode === "pictures") return col;
  const cells = displayLine(line, mode);
  for (let d = 0; d < cells.length; d++) {
    if (cells[d].col >= col) return d;
  }
  return cells.length;
}

/** The source column represented at a display-column offset. */
export function sourceColumnOf(
  line: Line,
  mode: DisplayMode,
  displayCol: number,
): number {
  const at = Math.max(0, displayCol);
  let sourceWidth = 0;
  for (const _ of line.text) sourceWidth++;
  if (mode === "pictures") return Math.min(at, sourceWidth);
  const cells = displayLine(line, mode);
  if (cells.length === 0) return 0;
  return at < cells.length ? cells[at].col : sourceWidth;
}

/** Number of cells a line occupies in one display mode. */
export function displayWidth(line: Line, mode: DisplayMode): number {
  let width = 0;
  visitDisplayCellSources(line.text, mode, () => {
    width++;
    return true;
  });
  return width;
}

/**
 * Visit the UTF-16 source range represented by each visible display cell.
 * Returning false from the visitor stops the scan.
 */
export function visitDisplayCellSources(
  text: string,
  mode: DisplayMode,
  visit: (start: number, end: number) => boolean,
): boolean {
  for (let i = 0; i < text.length;) {
    const sequence = mode === "pictures" ? null : matchTextCsi(text, i);
    if (sequence && (mode === "hidden" || sequence.final === "m")) {
      i = sequence.end;
      continue;
    }

    const codePoint = text.codePointAt(i)!;
    const end = i + (codePoint > 0xffff ? 2 : 1);
    if (mode !== "hidden" || !isNonPrintableCode(codePoint)) {
      if (!visit(i, end)) return false;
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
    i = runEnd;
  }
  return true;
}

export function displayLine(
  line: Line,
  mode: DisplayMode,
  styler: SpanStyler = spanStyle,
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
      return displayAnsi(src);
    case "hidden":
      return displayHidden(src);
  }
}

/** ANSI mode: consume SGR color sequences and carry their color forward as an
 * override; show every other non-printable as a Control Pictures glyph. */
function displayAnsi(src: readonly SourcePoint[]): DisplayCell[] {
  const cells: DisplayCell[] = [];
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
    cells.push({
      ch: glyphFor(s.cp),
      col: s.col,
      sourceEnd: s.col + 1,
      syntax: s.syntax,
      ansi: hasStyle(active) ? active : undefined,
    });
    i += 1;
  }
  return cells;
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
  for (const cp of text) if (isNonPrintable(cp)) return true;
  return false;
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
