/**
 * The parts a Turbo Vision style terminal view is built from, drawn onto a
 * {@link Canvas} in `cf view`'s palette: a menu bar and its pull-down menus,
 * windows framed in double lines when active and single lines when not,
 * each with a zoom icon and a scroll bar, dialogs with drop shadows, green
 * buttons, and a status line of the keys that matter. Every part a person
 * can click carries the command `C` clicking it runs.
 */

import type { Style } from "@commonfabric/cli/view/ansi";
import { palette as C, ui } from "@commonfabric/cli/view/theme";
import { maxOf } from "@commonfabric/collections/math";

import type { Canvas, Rect } from "./canvas.ts";
import {
  clip,
  columns,
  graphemes,
  type Row,
  rowColumns,
  type Span,
  span,
} from "./text.ts";

/** A choice in a menu. */
export interface MenuItem<C> {
  label: string;

  /** The letter of `label` that picks the item, drawn in red. */
  hotkey?: string;

  /** The key that runs the item from anywhere, shown at its right. */
  shortcut?: string;
  act: C;
}

/** A menu of the menu bar. */
export interface Menu<C> {
  label: string;
  hotkey: string;
  items: (MenuItem<C> | "-")[];
}

/** A key the status line names, and what clicking it does. */
export interface Hint<C> {
  key: string;
  label: string;
  act: C;
}

const BAR: Style = { bg: C.panel, fg: C.fg };
const HOT: Style = { bg: C.panel, fg: C.red, bold: true };
const PICKED: Style = { bg: C.button, fg: C.ink, bold: true };
const PICKED_HOT: Style = { bg: C.button, fg: C.white, bold: true };

/** `label` with its first `hotkey` drawn in `hot` and the rest in `plain`. */
export function hotLabel<C>(
  label: string,
  hotkey: string | undefined,
  plain: Style,
  hot: Style,
  act?: C,
): Span<C>[] {
  const chars = graphemes(label);
  const at = hotkey === undefined
    ? -1
    : chars.findIndex((char) => char.toLowerCase() === hotkey.toLowerCase());
  const part = (text: string, style: Style): Span<C>[] =>
    text === "" ? [] : [{
      ...span(text, style),
      ...(act === undefined ? {} : { click: act }),
    }];
  return at < 0 ? part(label, plain) : [
    ...part(chars.slice(0, at).join(""), plain),
    ...part(chars[at], hot),
    ...part(chars.slice(at + 1).join(""), plain),
  ];
}

/**
 * The menu bar along row 0: each menu's label, the one `open` names
 * highlighted, clicking a label running `open(index)`; and `right` at the
 * bar's right end.
 */
export function menuBar<C>(
  canvas: Canvas<C>,
  menus: readonly Menu<C>[],
  open: number | undefined,
  pick: (index: number) => C,
  right: Row<C>,
): void {
  const row: Row<C> = [span("  ", BAR)];
  menus.forEach((menu, index) => {
    const picked = index === open;
    const label = hotLabel(
      ` ${menu.label} `,
      menu.hotkey,
      picked ? PICKED : BAR,
      picked ? PICKED_HOT : HOT,
      pick(index),
    );
    for (const part of label) row.push(part);
  });
  // The menus come first; `right` has what room is left.
  const room = Math.max(rowColumns(row), canvas.width - rowColumns(right));
  canvas.put(0, 0, row, room, C.panel);
  canvas.put(room, 0, right, canvas.width - room, C.panel);
}

/** Where the menu `index` of `menus` drops down from. */
export function menuColumn<C>(
  menus: readonly Menu<C>[],
  index: number,
): number {
  return 2 +
    menus.slice(0, index).reduce((n, m) => n + columns(m.label) + 2, 0);
}

/**
 * The menu `menu` dropped down at the cell `x`, `y`, with the item
 * `selected` highlighted, in a single-line frame with a shadow; returns
 * where it was drawn.
 */
export function pullDown<C>(
  canvas: Canvas<C>,
  x: number,
  y: number,
  menu: Menu<C>,
  selected: number,
): Rect {
  const items = menu.items;
  const labelWidth = maxOf(
    items.map((item) => item === "-" ? 0 : columns(item.label)),
  );
  const shortcutWidth = maxOf([
    0,
    ...items.map((item) =>
      item === "-" || item.shortcut === undefined
        ? 0
        : columns(item.shortcut) + 2
    ),
  ]);
  const inner = labelWidth + shortcutWidth + 2;
  const rect = {
    x: Math.max(0, Math.min(x, canvas.width - inner - 4)),
    y,
    width: inner + 2,
    height: items.length + 2,
  };
  const frame: Style = { bg: C.panel, fg: C.fg };
  canvas.put(rect.x, y, [span(`┌${"─".repeat(inner)}┐`, frame)], rect.width);
  items.forEach((item, index) => {
    const row = y + 1 + index;
    if (item === "-") {
      canvas.put(
        rect.x,
        row,
        [span(`├${"─".repeat(inner)}┤`, frame)],
        rect.width,
      );
      return;
    }
    const picked = index === selected;
    const style = picked ? PICKED : BAR;
    const label = hotLabel(
      ` ${item.label}`,
      item.hotkey,
      style,
      picked ? PICKED_HOT : HOT,
      item.act,
    );
    const shortcut = item.shortcut ?? "";
    // The row is its border, a space, the label, the padding, the shortcut,
    // a space, and its border, `inner` columns between the borders.
    const pad = inner - 2 - columns(item.label) - columns(shortcut);
    canvas.put(rect.x, row, [
      span("│", frame),
      ...label,
      { ...span(" ".repeat(Math.max(0, pad)), style), click: item.act },
      {
        ...span(`${shortcut} `, { ...style, fg: picked ? C.ink : C.fgDim }),
        click: item.act,
      },
      span("│", frame),
    ], rect.width);
  });
  canvas.put(
    rect.x,
    y + rect.height - 1,
    [span(`└${"─".repeat(inner)}┘`, frame)],
    rect.width,
  );
  shadow(canvas, rect);
  return rect;
}

/** The status line along the last row: `hints`, then `right` at its end. */
export function statusLine<C>(
  canvas: Canvas<C>,
  hints: readonly Hint<C>[],
  right: Row<C>,
): void {
  const y = canvas.height - 1;
  // `right` comes first, cut at its end when it does not fit, and then as
  // many hints as fit whole.
  const room = Math.max(0, canvas.width - rowColumns(right));
  const row: Row<C> = [span(" ", BAR)];
  let used = 1;
  for (const hint of hints) {
    const key = { ...span(` ${hint.key}`, HOT), click: hint.act };
    const label = { ...span(` ${hint.label} `, BAR), click: hint.act };
    used += columns(key.text) + columns(label.text);
    if (used > room) break;
    row.push(key, label);
  }
  canvas.put(0, y, row, room, C.panel);
  canvas.put(room, y, right, canvas.width - room, C.panel);
}

/** The shadow a box at `rect` casts: two columns right, one row down. */
export function shadow<C>(canvas: Canvas<C>, rect: Rect): void {
  canvas.shade(
    { x: rect.x + rect.width, y: rect.y + 1, width: 2, height: rect.height },
    C.shadow,
  );
  canvas.shade(
    { x: rect.x + 2, y: rect.y + rect.height, width: rect.width, height: 1 },
    C.shadow,
  );
}

/** How a window or dialog frame is drawn. */
export interface FrameLook<C> {
  title: string;

  /** Whether the frame is the one keys go to: double lines when it is. */
  active: boolean;
  bg: Style["bg"];

  /** The window's number, shown at its top right, as Alt and it picks it. */
  number?: number;

  /** What clicking the zoom icon does; no icon without one. */
  zoom?: { zoomed: boolean; act: C };

  /** What clicking the frame does. */
  focus?: C;
}

/** A frame around `rect`, its title centered in its top edge. */
export function frame<C>(
  canvas: Canvas<C>,
  rect: Rect,
  look: FrameLook<C>,
): void {
  const { x, y, width, height } = rect;
  if (width < 2 || height < 2) return;
  const [h, v, tl, tr, bl, br] = look.active
    ? ["═", "║", "╔", "╗", "╚", "╝"]
    : ["─", "│", "┌", "┐", "└", "┘"];
  const line: Style = {
    bg: look.bg,
    fg: look.active ? C.fgBright : C.fgDim,
    bold: look.active,
  };
  const edge = (text: string): Span<C> => ({
    ...span(text, line),
    ...(look.focus === undefined ? {} : { click: look.focus }),
  });
  const right: Span<C>[] = [];
  if (look.number !== undefined) right.push(edge(`${look.number}${h}`));
  if (look.zoom !== undefined) {
    right.push({
      ...span(look.zoom.zoomed ? "[↕]" : "[↑]", {
        ...line,
        fg: look.active ? C.green : C.fgDim,
      }),
      click: look.zoom.act,
    });
  }
  const tail = rowColumns(right);
  const room = Math.max(0, width - 4 - tail);
  const shownTitle = look.title === "" || room < 3
    ? ""
    : ` ${clip(look.title, room - 2)} `;
  const before = Math.max(1, Math.floor((width - 2 - columns(shownTitle)) / 2));
  const after = Math.max(
    0,
    width - 2 - before - columns(shownTitle) - tail - 1,
  );
  canvas.put(x, y, [
    edge(tl + h.repeat(before)),
    {
      ...span(shownTitle, { ...line, fg: look.active ? C.fgBright : C.fg }),
      ...(look.focus === undefined ? {} : { click: look.focus }),
    },
    edge(h.repeat(after)),
    ...right,
    edge(h + tr),
  ], width);
  for (let row = y + 1; row < y + height - 1; row++) {
    canvas.put(x, row, [edge(v)], 1);
    canvas.put(x + width - 1, row, [edge(v)], 1);
  }
  canvas.put(x, y + height - 1, [edge(bl + h.repeat(width - 2) + br)], width);
}

/** Where a scroll bar stands: how much there is, and what shows of it. */
export interface Scroll {
  total: number;
  top: number;
  visible: number;
}

/** What clicking each part of a scroll bar does. */
export interface ScrollActs<C> {
  up: C;
  down: C;
  pageUp: C;
  pageDown: C;
  thumb: C;
}

/**
 * A vertical scroll bar `height` rows tall from the cell `x`, `y`: arrows
 * at its ends, and a thumb standing for what shows; nothing when everything
 * shows.
 */
export function scrollBar<C>(
  canvas: Canvas<C>,
  x: number,
  y: number,
  height: number,
  scroll: Scroll,
  acts: ScrollActs<C>,
  bg: Style["bg"],
): void {
  if (scroll.total <= scroll.visible || height < 3) return;
  const track = height - 2;
  const size = Math.max(1, Math.round(track * scroll.visible / scroll.total));
  const at = Math.round(
    (track - size) * scroll.top / Math.max(1, scroll.total - scroll.visible),
  );
  const arrow: Style = { bg: C.panelHi, fg: C.fgBright };
  canvas.put(x, y, [{ ...span("▲", arrow), click: acts.up }], 1);
  for (let row = 0; row < track; row++) {
    const inThumb = row >= at && row < at + size;
    canvas.put(x, y + 1 + row, [{
      ...span(inThumb ? "█" : "░", { bg, fg: inThumb ? C.fg : C.panelHi }),
      click: inThumb ? acts.thumb : row < at ? acts.pageUp : acts.pageDown,
    }], 1);
  }
  canvas.put(x, y + height - 1, [{ ...span("▼", arrow), click: acts.down }], 1);
}

/** A dialog's box: a double frame on the panel, with a shadow. */
export function dialogBox<C>(
  canvas: Canvas<C>,
  rect: Rect,
  title: string,
): void {
  canvas.fill(rect, " ", { bg: C.panel });
  frame(canvas, rect, { title, active: true, bg: C.panel });
  shadow(canvas, rect);
}

/**
 * A button reading `label` at the cell `x`, `y`, green, brighter when
 * `focused`, with its shadow, or pushed down into it while `pressed`;
 * returns how wide it is with the shadow.
 */
export function button<C>(
  canvas: Canvas<C>,
  x: number,
  y: number,
  label: string,
  focused: boolean,
  act: C,
  bg: Style["bg"] = C.panel,
  pressed = false,
  hotkey?: string,
): number {
  const text = ` ${label} `;
  const width = columns(text);
  // The letter that presses it is drawn as `cf view` draws a button's.
  const face = (fg: Style["fg"]) =>
    hotLabel(
      text,
      hotkey,
      { bg: C.button, fg, bold: true },
      ui.buttonKey,
      act,
    );
  if (pressed) {
    // Pushed down into its shadow.
    canvas.put(x, y, [
      { ...span(" ", { bg }), click: act },
      ...face(C.white),
    ], width + 1);
    canvas.put(x, y + 1, [span(" ".repeat(width + 1), { bg })], width + 1);
    return width + 1;
  }
  canvas.put(x, y, [
    ...face(focused ? C.white : C.ink),
    span("▄", { bg, fg: C.shadow }),
  ], width + 1);
  canvas.put(
    x + 1,
    y + 1,
    [span("▀".repeat(width), { bg, fg: C.shadow })],
    width,
  );
  return width + 1;
}
