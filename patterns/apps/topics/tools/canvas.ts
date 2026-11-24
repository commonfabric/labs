/**
 * A grid of character cells that a full-screen terminal view draws into
 * region by region, later regions over earlier ones, as windows, menus, and
 * dialogs overlap: each cell holds one character, its style, and what
 * clicking it does, so that a mouse report is answered by asking the cell
 * under the pointer. A shadow darkens the cells it falls on rather than
 * replacing them.
 */

import {
  CSI,
  RESET,
  type Rgb,
  sgr,
  type Style,
  term,
} from "@commonfabric/cli/view/ansi";

import { charColumns, graphemes, linkable, mix, type Span } from "./text.ts";

/** One cell of the grid. */
interface Cell<C> {
  /** The character, or `""` for the second column of a wide one. */
  char: string;
  style: Style;
  href?: string;
  click?: C;
}

/** A rectangle of the grid, in zero-based cells. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether the cell `x`, `y` lies inside `rect`. */
export function inside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y &&
    y < rect.y + rect.height;
}

/**
 * A grid `width` by `height` cells, every one blank on `bg` until drawn
 * over, whose cells may stand for commands `C`.
 */
export class Canvas<C> {
  readonly #width: number;
  readonly #height: number;
  readonly #bg: Rgb;
  readonly #cells: Cell<C>[][];

  constructor(width: number, height: number, bg: Rgb) {
    this.#width = width;
    this.#height = height;
    this.#bg = bg;
    this.#cells = Array.from(
      { length: height },
      () => Array.from({ length: width }, () => ({ char: " ", style: { bg } })),
    );
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /**
   * Draws `row` from the cell `x`, `y`, cut at `width` columns, or at the
   * grid's edge, and padded to `width` on `bg`. A wide character the cut
   * splits is drawn as a space.
   */
  put(
    x: number,
    y: number,
    row: readonly Span<C>[],
    width = this.#width - x,
    bg: Rgb = this.#bg,
  ): void {
    if (y < 0 || y >= this.#height) return;
    const end = Math.min(x + width, this.#width);
    let at = x;
    for (const s of row) {
      const style = { bg, ...s.style };
      for (const char of graphemes(s.text)) {
        const wide = charColumns(char);
        // A character of no width at the end still falls outside.
        if (at >= end || at + wide > end) {
          if (at < end) this.#set(at, y, { char: " ", style });
          at = end;
          break;
        }
        this.#set(at, y, { char, style, href: s.href, click: s.click });
        for (let more = 1; more < wide; more++) {
          this.#set(at + more, y, {
            char: "",
            style,
            href: s.href,
            click: s.click,
          });
        }
        at += wide;
      }
      if (at >= end) break;
    }
    for (; at < end; at++) this.#set(at, y, { char: " ", style: { bg } });
  }

  /** Fills `rect` with `char` in `style`, each cell running `click`. */
  fill(rect: Rect, char: string, style: Style, click?: C): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        this.#set(x, y, { char, style, click });
      }
    }
  }

  /**
   * Darkens the cells of `rect`, as a shadow falling on them does, keeping
   * what they show.
   */
  shade(rect: Rect, shadow: Rgb): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const cell = this.#cells[y]?.[x];
        if (cell === undefined) continue;
        cell.style = {
          ...cell.style,
          bg: shadow,
          fg: mix(cell.style.fg ?? shadow, shadow, 0.6),
          bold: false,
        };
        delete cell.click;
        delete cell.href;
      }
    }
  }

  /**
   * The cells joined to the cell `x`, `y` through cells that `kind` says
   * do the same, as `y * width + x`: the one thing there, however wide.
   */
  reach(
    x: number,
    y: number,
    kind: (cell: { click?: C; href?: string }) => string,
  ): Set<number> {
    const reached = new Set<number>();
    const start = this.#cells[y]?.[x];
    if (start === undefined) return reached;
    const want = kind(start);
    const todo: [number, number][] = [[x, y]];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const [cx, cy] = next;
      const cell = this.#cells[cy]?.[cx];
      const index = cy * this.width + cx;
      if (cell === undefined || reached.has(index) || kind(cell) !== want) {
        continue;
      }
      reached.add(index);
      todo.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]);
    }
    return reached;
  }

  /**
   * Draws `cells`, as {@link reach} names them, held down by the pointer,
   * their colors turned about, `fg` standing for a color a cell leaves to
   * the terminal, so that what a release there would do shows first.
   */
  press(cells: ReadonlySet<number>, fg: Rgb): void {
    for (const index of cells) {
      const cell = this.#cells[Math.floor(index / this.width)]?.[
        index % this.width
      ];
      if (cell === undefined) continue;
      cell.style = {
        ...cell.style,
        fg: cell.style.bg,
        bg: cell.style.fg ?? fg,
      };
    }
  }

  /** What clicking the cell `x`, `y` does, and where it links. */
  at(x: number, y: number): { click?: C; href?: string } {
    const cell = this.#cells[y]?.[x];
    return cell === undefined ? {} : { click: cell.click, href: cell.href };
  }

  /**
   * The grid painted, one string per row, each of which moves to the start
   * of its row and paints every cell of it, so a frame is drawn by writing
   * the rows that differ from the last one.
   */
  paint(): string[] {
    return this.#cells.map((cells, y) => {
      let out = term.moveTo(y + 1, 1);
      let run = "";
      let style: Style | undefined;
      let href: string | undefined;
      const flush = () => {
        if (run === "") return;
        out += RESET + sgr(style ?? {}) +
          (linkable(href) ? term.hyperlink(href, run) : run);
        run = "";
      };
      cells.forEach((cell, x) => {
        if (cell.char === "") {
          // After a wide character the cursor is put where the grid says the
          // next cell is, so that a terminal drawing the character another
          // width moves nothing after it.
          flush();
          out += `${CSI}${x + 2}G`;
          return;
        }
        if (cell.style !== style || cell.href !== href) {
          if (!sameStyle(cell.style, style) || cell.href !== href) flush();
          style = cell.style;
          href = cell.href;
        }
        run += cell.char;
      });
      flush();
      return out + RESET;
    });
  }

  #set(x: number, y: number, cell: Cell<C>): void {
    if (x < 0 || x >= this.#width || y < 0 || y >= this.#height) return;
    const row = this.#cells[y];
    // A wide character this cell cuts in half is blanked whole. The second
    // column of a wide character is written just after its first, which
    // stays.
    if (cell.char !== "" && row[x].char === "" && x > 0) {
      row[x - 1] = { char: " ", style: row[x - 1].style };
    }
    if (x + 1 < this.#width && row[x + 1].char === "") {
      row[x + 1] = { char: " ", style: row[x + 1].style };
    }
    row[x] = cell;
  }
}

function sameStyle(a: Style, b: Style | undefined): boolean {
  if (b === undefined) return false;
  return sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg) &&
    !!a.bold === !!b.bold && !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic && !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough;
}

function sameColor(a: Rgb | undefined, b: Rgb | undefined): boolean {
  return a === b ||
    (a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1] &&
      a[2] === b[2]);
}
