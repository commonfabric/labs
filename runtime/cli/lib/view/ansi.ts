/**
 * Minimal ANSI escape-sequence helpers for the `cf view` pager.
 *
 * Self-contained (no dependencies) so the viewer stays lean. Colors use
 * 24-bit truecolor (`\x1b[38;2;r;g;bm`), which every modern macOS/Linux
 * terminal we target supports. When the output stream is not a TTY (or the
 * user passes `--no-color`) styling is suppressed at the call site, never here.
 */

export type Rgb = readonly [number, number, number];

export interface Style {
  readonly fg?: Rgb;
  readonly bg?: Rgb;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

/** Operating System Command introducer. */
const OSC = `${ESC}]`;

/** The BEL terminator that closes an OSC sequence. */
const BEL = "\x07";
export const RESET = `${CSI}0m`;

/** Build the SGR escape that turns a {@link Style} on. Empty string if no-op. */
export function sgr(style: Style): string {
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.strikethrough) codes.push(9);
  if (style.fg) codes.push(38, 2, style.fg[0], style.fg[1], style.fg[2]);
  if (style.bg) codes.push(48, 2, style.bg[0], style.bg[1], style.bg[2]);
  if (codes.length === 0) return "";
  return `${CSI}${codes.join(";")}m`;
}

/** Wrap `text` in the given style, resetting afterwards. */
export function paint(text: string, style: Style): string {
  const open = sgr(style);
  if (open === "") return text;
  return `${open}${text}${RESET}`;
}

/** Parse an `#rrggbb` hex string into an {@link Rgb} triple. */
export function hex(value: string): Rgb {
  const v = value.replace(/^#/, "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** A CSI escape sequence, or an OSC one that ends with BEL. */
const ESCAPE_SOURCE = String.raw`\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*\x07`;

const ANSI_PATTERN = new RegExp(ESCAPE_SOURCE, "g");

/** An escape sequence at the start of a string. */
export const LEADING_ESCAPE = new RegExp(`^(?:${ESCAPE_SOURCE})`);

/** Strip every ANSI escape from `text`. Used for width maths and tests. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Number of Unicode code points in `s` — a non-BMP character (surrogate pair)
 * counts as one display column rather than two UTF-16 units. Column maths uses
 * this so glyphs like `𝑻` line up correctly.
 */
export function cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++; // count everything but low surrogates
  }
  return n;
}

/** Visible width of `text` (code points) once ANSI escapes are removed. */
export function visibleWidth(text: string): number {
  return cpLen(stripAnsi(text));
}

//
// Terminal control
//

export const term = {
  enterAltScreen: `${CSI}?1049h`,
  leaveAltScreen: `${CSI}?1049l`,
  enableMouse: `${CSI}?1000h${CSI}?1006h`,
  disableMouse: `${CSI}?1006l${CSI}?1000l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clearScreen: `${CSI}2J`,
  clearLine: `${CSI}2K`,
  clearToEol: `${CSI}0K`,
  home: `${CSI}H`,

  /** Move the cursor to a 1-based (row, col). */
  moveTo(row: number, col: number): string {
    return `${CSI}${row};${col}H`;
  },

  /** Set the terminal's default background color (OSC 11). This is the color
   * the terminal fills the area outside the character grid with — the sub-cell
   * padding below the last row and beside the last column — which no cell can
   * reach. */
  setDefaultBg(rgb: Rgb): string {
    const h = rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
    return `${OSC}11;#${h}${BEL}`;
  },

  /** Restore the terminal's own default background color (OSC 111). */
  resetDefaultBg: `${OSC}111${BEL}`,

  /** `text` as a link to `url` (OSC 8), which a terminal without links
   * shows as the text alone. */
  hyperlink(url: string, text: string): string {
    return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`;
  },
};
