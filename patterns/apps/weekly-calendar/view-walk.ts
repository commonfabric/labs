/**
 * Walks the weekly calendar's rendered view for its pattern tests: the day
 * columns and their slots, the event blocks, the two modals and their
 * inputs, and the header buttons.
 */
import {
  childNodes,
  findElements,
  hasExactText,
  hasText,
  isElement,
  propsOf,
  propValue,
  readValue,
  styleOf,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import { parseDate } from "./weekly-calendar.tsx";

/** The rendered children of `node`, with the arrays a `.map()` renders
 * spread in place. */
const kids = (node: unknown): unknown[] =>
  childNodes(node).flatMap((child) => {
    const value = readValue(child);
    return Array.isArray(value) ? kids(value) : [value];
  });

/** The first node under `root` that `predicate` accepts, in document
 * order, walking no further than that node. */
const find = (
  root: unknown,
  predicate: (node: unknown) => boolean,
): unknown | undefined => {
  const value = readValue(root);
  if (predicate(value)) return value;
  for (const child of kids(value)) {
    const found = find(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
};

// The view is a screen holding the header, the main area, the empty-state
// footer and the backlinks footer. The main area holds the two modals and
// the grid, whose one row holds the time labels, the seven day columns and
// then a block per event. The helpers below walk that shape.

const header = (ui: unknown) => kids(ui)[0];
const main = (ui: unknown) => kids(ui)[1];
export const emptyFooter = (ui: unknown) => kids(ui)[2];
export const backlinksFooter = (ui: unknown) => kids(ui)[3];

export const modal = (ui: unknown, label: string) =>
  kids(main(ui)).find((node) => propValue(node, "label") === label);

/** The children of the grid's one row. */
const row = (ui: unknown) =>
  kids(kids(find(main(ui), (node) => isElement(node, "cf-vscroll")))[0]);

/** The seven day columns, Monday first. */
export const columns = (ui: unknown) =>
  row(ui).filter((node) => styleOf(node, "minWidth") === "100px");

export const dropZone = (ui: unknown, index: number) =>
  kids(columns(ui)[index])[1];

/** The time slots of the column at `index`, 6 AM first. */
export const slots = (ui: unknown, index: number) => kids(dropZone(ui, index));

/** The block an event with `title` occupies on the grid. */
export const block = (ui: unknown, title: string) =>
  row(ui).find((node) =>
    styleOf(node, "zIndex") === "2" && hasExactText(node, title)
  );

/** Where the block for `title` sits: its display, top, height, left and
 * width. */
export const placement = (ui: unknown, title: string): string => {
  const node = block(ui, title);
  return ["display", "top", "height", "left", "width"]
    .map((key) => styleOf(node, key)).join(" | ");
};

/** The block's drag source for moving it, which a click on opens. */
export const moveSource = (ui: unknown, title: string) =>
  kids(block(ui, title)).find((node) => propValue(node, "type") === "event");

/** The date label heading the column at `index`, without the "Today" badge
 * that may sit under it. */
export const headerOf = (ui: unknown, index: number): string =>
  textContent(kids(kids(columns(ui)[index])[0])[0]);

/** The date labels of all seven columns, joined by " / ". */
export const headers = (ui: unknown): string =>
  columns(ui).map((_, index) => headerOf(ui, index)).join(" / ");

/** Which day columns carry the "Today" badge under their date, as a string
 * of 0s and 1s, Monday first. */
export const todayBadges = (ui: unknown): string =>
  columns(ui).map((column) => hasText(kids(column)[0], "Today") ? 1 : 0)
    .join("");

/** Which day columns show, as a string of 0s and 1s, Monday first. */
export const shownColumns = (ui: unknown): string =>
  columns(ui).map((column) => styleOf(column, "display") === "flex" ? 1 : 0)
    .join("");

export const isOpen = (ui: unknown, label: string): boolean =>
  propValue(modal(ui, label), "$open") === true;

/** The `index`th input of the modal labelled `label`: title, date, start,
 * end. */
export const input = (ui: unknown, label: string, index: number) =>
  findElements(modal(ui, label), "cf-input")[index];

/** What the input shows: its bound `$value`, or the `value` it is given. */
export const inputValue = (
  ui: unknown,
  label: string,
  index: number,
): unknown => {
  const node = input(ui, label, index);
  return propValue(node, "$value") ?? propValue(node, "value");
};

/** The swatch painted `color` in the modal labelled `label`. */
export const swatch = (ui: unknown, label: string, color: string) =>
  find(
    modal(ui, label),
    (node) =>
      propsOf(node)?.onClick !== undefined &&
      styleOf(node, "backgroundColor") === color,
  );

/** A header button, found by its whole text. */
export const headerButton = (ui: unknown, label: string) =>
  find(
    header(ui),
    (node) => propsOf(node)?.onClick !== undefined && hasExactText(node, label),
  );

/** The weekday 0-6 of a YYYY-MM-DD date, or -1 for anything else. */
export const weekdayOf = (date: unknown): number => {
  const day = typeof date === "string" ? parseDate(date).getUTCDay() : NaN;
  return Number.isNaN(day) ? -1 : day;
};
