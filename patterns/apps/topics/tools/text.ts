/**
 * Styled text for the Topics board's terminal views: runs of text in one
 * style, measured in the columns a terminal draws them in, cut, padded, and
 * wrapped to a width, and painted as rows of a full-screen frame. Every
 * character a terminal would act on rather than print is drawn as a glyph
 * standing for it, so that what the board holds cannot drive the terminal.
 */

import {
  RESET,
  type Rgb,
  sgr,
  type Style,
  term,
} from "@commonfabric/cli/view/ansi";
import { glyphFor } from "@commonfabric/cli/view/display";
import { palette as C } from "@commonfabric/cli/view/theme";
import { charColumns, columns, graphemes } from "@commonfabric/cli/view/width";

/**
 * A run of text drawn in one style, which may link to an address and may
 * stand for a command `C` that clicking it runs.
 */
export interface Span<C = never> {
  text: string;
  style: Style;

  /** Where the text links to, as a terminal hyperlink. */
  href?: string;

  /** What clicking the text does. */
  click?: C;
}

/** One row of a region, as runs of text. */
export type Row<C = never> = Span<C>[];

/** The characters that set the direction text runs in, or break a line. */
const DIRECTING =
  /[\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A run of `text` in `style`, as {@link printable} draws it, linking to
 * `href` when there is one.
 */
export function span(text: string, style: Style = {}, href?: string): Span {
  return {
    text: printable(text),
    style,
    ...(href === undefined ? {} : { href }),
  };
}

/**
 * `text` with a tab drawn as a space, and every other character a terminal
 * would act on rather than print, or that would turn the text around, drawn
 * as a glyph standing for it, so that what the board holds cannot drive the
 * terminal, and is measured as it is drawn.
 */
export function printable(text: string): string {
  let shown = "";
  for (const char of text.replaceAll("\t", " ").replace(DIRECTING, "␦")) {
    shown += glyphFor(char);
  }
  return shown;
}

export { charColumns, columns, graphemes };

/** How many columns `row` takes. */
export function rowColumns<C>(row: readonly Span<C>[]): number {
  return row.reduce((n, s) => n + columns(s.text), 0);
}

/** The longest start of `text` that fits in `width` columns. */
export function take(text: string, width: number): string {
  let used = 0;
  let out = "";
  for (const char of graphemes(text)) {
    used += charColumns(char);
    if (used > width) break;
    out += char;
  }
  return out;
}

/** `text` cut to `width` columns, ending in an ellipsis when it was cut. */
export function clip(text: string, width: number): string {
  const flat = printable(text.replace(/\s+/g, " "));
  if (columns(flat) <= width) return flat;
  return `${take(flat, Math.max(0, width - 1))}…`;
}

export function center(text: string, width: number): string {
  const cut = clip(text, width);
  return " ".repeat(Math.max(0, Math.floor((width - columns(cut)) / 2))) +
    cut;
}

/** `row` cut or padded to exactly `width` columns, padding in `bg`. */
export function fit<C>(
  row: readonly Span<C>[],
  width: number,
  bg: Rgb,
): Row<C> {
  const out: Row<C> = [];
  let used = 0;
  for (const s of row) {
    const wide = columns(s.text);
    if (used + wide <= width) {
      out.push(s);
      used += wide;
      continue;
    }
    const head = take(s.text, width - used);
    out.push({ ...s, text: head });
    used += columns(head);
    break;
  }
  if (used < width) {
    const last = out.at(-1)?.style.bg ?? bg;
    out.push(span(" ".repeat(width - used), { bg: last }));
  }
  return out;
}

/**
 * `left` and `right` at either end of a row `width` wide, on `bg`, `left`
 * cut short where both do not fit.
 */
export function spread<C>(
  left: readonly Span<C>[],
  right: readonly Span<C>[],
  width: number,
  bg: Rgb,
): Row<C> {
  const room = width - rowColumns(right);
  return fit([...fit(left, room, bg), ...right], width, bg);
}

/** Whitespace a row may break at: any but the non-breaking kinds. */
const BREAKS = /([^\S\u00a0\u2007\u202f]+)/;

/** A run of whitespace, or a word, which may span several styles. */
type Token<C> = { space: Span<C> } | { word: Span<C>[] };

/**
 * `spans` as the words and the runs of whitespace between them, a word
 * running on across a change of style until whitespace ends it.
 */
function tokens<C>(spans: readonly Span<C>[]): Token<C>[] {
  const out: Token<C>[] = [];
  for (const s of spans) {
    for (const part of s.text.split(BREAKS)) {
      if (part === "") continue;
      const piece = { ...s, text: part };
      const last = out.at(-1);
      if (BREAKS.test(part)) out.push({ space: piece });
      else if (last !== undefined && "word" in last) last.word.push(piece);
      else out.push({ word: [piece] });
    }
  }
  return out;
}

/** The words of `spans`, each as the spans it runs across. */
export function words<C>(spans: readonly Span<C>[]): Span<C>[][] {
  return tokens(spans).flatMap((token) => "word" in token ? [token.word] : []);
}

/**
 * `spans` wrapped at word boundaries into rows `width` wide, each row after
 * the first starting with `hang`, and the first with whatever whitespace
 * `spans` start with. A word wider than a row is cut where each
 * row ends, every row taking at least one character, however wide.
 */
export function wrap<C>(
  spans: readonly Span<C>[],
  width: number,
  hang: readonly Span<C>[] = [],
): Row<C>[] {
  const rows: Row<C>[] = [];
  const indent = rowColumns(hang);
  let row: Row<C> = [];
  let used = 0;
  const end = () => {
    rows.push(trimEnd(row));
    row = [...hang];
    used = indent;
  };
  // The space owed before the next word, one however much whitespace
  // came between, across runs alike.
  let space: Span<C> | undefined;
  for (const token of tokens(spans)) {
    if ("space" in token) {
      if (rows.length === 0 && row.length === 0) {
        // Indentation the first row starts with is kept.
        row.push(token.space);
        used += columns(token.space.text);
      } else {
        space = { ...token.space, text: " " };
      }
      continue;
    }
    const wide = rowColumns(token.word);
    if (space !== undefined && used > (rows.length === 0 ? 0 : indent)) {
      // A row holding no more than its indent, a list item's bullet, say,
      // is not ended, so the bullet is not left on a row of its own.
      if (used > indent && used + 1 + wide > width) {
        end();
      } else {
        row.push(space);
        used += 1;
      }
    }
    space = undefined;
    if (used > indent && used + wide > width) end();
    for (const s of token.word) {
      let piece = "";
      for (const char of graphemes(s.text)) {
        const charWide = charColumns(char);
        if (used > indent && used + charWide > width) {
          if (piece !== "") row.push({ ...s, text: piece });
          piece = "";
          end();
        }
        piece += char;
        used += charWide;
      }
      if (piece !== "") row.push({ ...s, text: piece });
    }
  }
  if (row.length > (rows.length === 0 ? 0 : hang.length)) {
    rows.push(trimEnd(row));
  }
  return rows;
}

function trimEnd<C>(row: Row<C>): Row<C> {
  const last = row.at(-1);
  return last !== undefined && last.text === " " ? row.slice(0, -1) : row;
}

/** How bright a glow `elapsed` into `duration` still is, from 1 down to 0. */
export function fade(elapsed: number, duration: number): number {
  if (elapsed >= duration) return 0;
  const t = Math.max(elapsed, 0) / duration;
  return 1 - t * t;
}

/** The color `amount` of the way from `from` to `to`. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

export function darken(color: Rgb, amount: number): Rgb {
  return mix(color, C.editorBg, 1 - amount);
}

/**
 * Whether `href` may be a terminal hyperlink: only an address on the web,
 * since a terminal opens whatever a link names, a file or an application
 * among them, and links come from what the board holds.
 */
export function linkable(href: string | undefined): href is string {
  return href !== undefined && /^https?:\/\//i.test(href);
}

/** One run of a painted row: its text, its style, and where it links. */
function paintSpan<C>(s: Span<C>, bg: Rgb): string {
  return RESET + sgr({ bg, ...s.style }) +
    (linkable(s.href) ? term.hyperlink(s.href, s.text) : s.text);
}

/**
 * `rows` painted from the top left, each padded to `width`, on `bg` wherever
 * a run names no background of its own: one string per row, each of which
 * moves to the start of its row and paints every cell of it, so a frame is
 * drawn by writing the rows that differ from the last one.
 */
export function paintRows<C>(
  rows: readonly (readonly Span<C>[])[],
  width: number,
  bg: Rgb,
): string[] {
  return rows.map((row, index) =>
    term.moveTo(index + 1, 1) + term.clearLine +
    fit(row, width, bg).map((s) => paintSpan(s, bg)).join("") + RESET
  );
}
