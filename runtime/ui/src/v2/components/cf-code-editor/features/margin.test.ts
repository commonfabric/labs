// First, so that the document it installs is there when CodeMirror loads.
import { settle, window } from "../../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FieldAnchors } from "@commonfabric/runtime-client";

import {
  type EditorHighlight,
  highlightField,
  setHighlightAnchorsEffect,
  setHighlightsEffect,
} from "./highlights.ts";
import {
  arrangeMargin,
  margin,
  type MarginBox,
  type MarginGroup,
  placeMarginGroups,
} from "./margin.ts";

/** A shown group of `height` beside the text at `anchorTop`. */
const beside = (
  anchorTop: number | undefined,
  height = 20,
  active = false,
): MarginGroup => ({ anchorTop, height, active });

/** The box of the element `element`, `height` tall at `top`. */
const box = (
  element: string,
  top: number,
  height: number,
  anchor: string | null = null,
): MarginBox<string> => ({ element, top, bottom: top + height, anchor });

/** How far each line of {@link TEXT} is drawn below the top of the text. */
const LINE_HEIGHT = 20;

/** Twenty lines, `line 1` to `line 20`. */
const TEXT = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join(
  "\n",
);

/** Where the text of line `line` (from 1) starts in {@link TEXT}. */
const lineStart = (line: number) => TEXT.indexOf(`line ${line}\n`);

/** What {@link openMargin} sets up. */
interface OpenMargin {
  view: EditorView;

  /** Stands for the editor element, whose children the margin shows. */
  host: HTMLElement;

  layout: HTMLElement;
}

/** Every view {@link openMargin} has opened and not yet destroyed. */
const openViews: EditorView[] = [];

/**
 * Gives `element` the layout a browser would: its box is `height` tall,
 * `top` pixels down the page, and moved by its own `translate`. happy-dom
 * lays nothing out.
 */
function lay(element: HTMLElement, top: number, height: number): void {
  const shift = () =>
    Number.parseFloat(element.style.translate.split(" ")[1] ?? "0") || 0;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const at = top + shift();
      return DOMRect.fromRect({ x: 0, y: at, width: 100, height });
    },
  });
}

/**
 * A view of {@link TEXT}, each line {@link LINE_HEIGHT} tall from the top of
 * the page, with `anchors` and `highlights`, and a margin showing the
 * children of a host element. The margin's top is the page's top when it is
 * beside the text and below the text when `wrapped`.
 */
function openMargin(
  anchors: FieldAnchors = {},
  highlights: readonly EditorHighlight[] = [],
  { wrapped = false } = {},
): OpenMargin {
  const host = document.createElement("div");
  const layout = document.createElement("div");
  const column = document.createElement("div");
  column.style.rowGap = "10px";
  document.body.append(host, layout);
  const view = new EditorView({
    state: EditorState.create({
      doc: TEXT,
      extensions: [
        highlightField,
        margin({ host, layout, margin: column }),
      ],
    }),
    parent: layout,
  });
  layout.append(column);
  openViews.push(view);
  const textHeight = 20 * LINE_HEIGHT;
  lay(view.dom, 0, textHeight);
  lay(column, wrapped ? textHeight : 0, 0);
  Object.defineProperty(view, "coordsAtPos", {
    configurable: true,
    value: (pos: number) => {
      const top = (view.state.doc.lineAt(pos).number - 1) * LINE_HEIGHT;
      return { top, bottom: top + LINE_HEIGHT, left: 0, right: 0 };
    },
  });
  view.dispatch({
    effects: [
      setHighlightAnchorsEffect.of(anchors),
      setHighlightsEffect.of(highlights),
    ],
  });
  return { view, host, layout };
}

/**
 * A child of `host`, `height` tall where the column puts it at `top`, naming
 * `anchor` where one is given.
 */
function child(
  host: HTMLElement,
  top: number,
  height: number,
  anchor?: string,
): HTMLElement {
  const element = document.createElement("div");
  if (anchor !== undefined) element.setAttribute("data-anchor", anchor);
  lay(element, top, height);
  host.append(element);
  return element;
}

/** How far each of `elements` is moved down, as its `translate` says. */
const shifts = (...elements: HTMLElement[]) =>
  elements.map((element) => element.style.translate);

describe("margin", () => {
  afterEach(() => {
    for (const view of openViews.splice(0)) view.destroy();
    window.document.body.replaceChildren();
  });

  describe("placeMarginGroups()", () => {
    it("returns each group's anchor as its top when the groups have room", () => {
      const placed = placeMarginGroups([beside(0), beside(100)], 0, 10);

      expect(placed).toEqual({ tops: [0, 100], height: 120 });
    });

    it("returns a top `gap` below the group above for a group that would overlap it", () => {
      const placed = placeMarginGroups([beside(0, 50), beside(30)], 0, 10);

      expect(placed.tops).toEqual([0, 60]);
    });

    it("returns tops in the order the groups were given, placed in their anchors' order", () => {
      // The group given first is the lower of the two, so it is the one moved.

      const placed = placeMarginGroups([beside(30), beside(0, 50)], 0, 10);

      expect(placed.tops).toEqual([60, 0]);
    });

    it("returns tops at least `gap` below the leading children", () => {
      const placed = placeMarginGroups([beside(0)], 40, 10);

      expect(placed.tops).toEqual([50]);
    });

    it("returns the active group's anchor as its top, moving the groups above it up", () => {
      const placed = placeMarginGroups(
        [beside(100, 50), beside(120, 20, true), beside(130)],
        0,
        10,
      );

      expect(placed.tops).toEqual([60, 120, 150]);
    });

    it("returns a top below its anchor for an active group the leading children leave no room above", () => {
      const placed = placeMarginGroups(
        [beside(20, 30), beside(30, 20, true)],
        10,
        10,
      );

      expect(placed.tops).toEqual([20, 60]);
    });

    it("returns tops after the anchored groups for groups without an anchor, in the order given", () => {
      const placed = placeMarginGroups(
        [beside(undefined), beside(200), beside(undefined, 5)],
        0,
        10,
      );

      expect(placed).toEqual({ tops: [230, 200, 260], height: 265 });
    });

    it("returns a top of `0` for a group with no height, which takes no place", () => {
      const placed = placeMarginGroups(
        [beside(0, 0), beside(0), beside(5, 0, true)],
        0,
        10,
      );

      expect(placed).toEqual({ tops: [0, 0, 0], height: 20 });
    });

    it("returns the leading height as the height of a margin with no shown group", () => {
      expect(placeMarginGroups([], 40, 10)).toEqual({ tops: [], height: 40 });
    });
  });

  describe("arrangeMargin()", () => {
    /** Where the text at each anchor of these cases is drawn. */
    const TEXT_TOPS: Record<string, number> = { a: 100, b: 300 };
    const topOf = (anchor: string) => TEXT_TOPS[anchor];

    it("returns a run that moves nothing for the elements before the first that names an anchor", () => {
      const arranged = arrangeMargin(
        [box("header", 0, 30), box("note", 40, 20, "a")],
        topOf,
        new Set(),
        10,
      );

      expect(arranged.runs).toEqual([
        { elements: ["header"], shift: 0 },
        { elements: ["note"], shift: 60 },
      ]);
    });

    it("returns each element that names no anchor in the run of the element above it", () => {
      const arranged = arrangeMargin(
        [
          box("a", 0, 20, "a"),
          box("reply", 30, 20),
          box("b", 60, 20, "b"),
          box("actions", 90, 20),
        ],
        topOf,
        new Set(),
        10,
      );

      expect(arranged).toEqual({
        height: 350,
        runs: [
          { elements: [], shift: 0 },
          { elements: ["a", "reply"], shift: 100 },
          { elements: ["b", "actions"], shift: 240 },
        ],
      });
    });

    it("returns runs in the order the column puts the elements, whatever order they are given in", () => {
      const arranged = arrangeMargin(
        [box("b", 30, 20, "b"), box("a", 0, 20, "a")],
        topOf,
        new Set(),
        10,
      );

      expect(arranged.runs.map(({ elements }) => elements)).toEqual([
        [],
        ["a"],
        ["b"],
      ]);
    });

    it("returns a run that keeps its place beside its text for the element whose anchor is active", () => {
      // The two would overlap, and the lower one is the active one, so the
      // upper moves up rather than the lower down.

      const arranged = arrangeMargin(
        [box("a", 0, 50, "a"), box("b", 60, 20, "b")],
        (anchor) => ({ a: 100, b: 120 })[anchor],
        new Set(["b"]),
        10,
      );

      expect(arranged.runs.slice(1)).toEqual([
        { elements: ["a"], shift: 60 },
        { elements: ["b"], shift: 60 },
      ]);
    });

    it("returns a run below the rest for an element whose anchor the field does not hold", () => {
      const arranged = arrangeMargin(
        [box("gone", 0, 20, "gone"), box("a", 30, 20, "a")],
        topOf,
        new Set(),
        10,
      );

      expect(arranged.runs.slice(1)).toEqual([
        { elements: ["gone"], shift: 130 },
        { elements: ["a"], shift: 70 },
      ]);
    });

    it("returns a run that moves nothing for an element with no height", () => {
      const arranged = arrangeMargin(
        [box("empty", 40, 0, "a")],
        topOf,
        new Set(),
        10,
      );

      expect(arranged).toEqual({
        height: 0,
        runs: [
          { elements: [], shift: 0 },
          { elements: ["empty"], shift: 0 },
        ],
      });
    });
  });

  describe("margin()", () => {
    it("marks the layout `has-margin` while the host has an element child, and unmarks it once it has none", async () => {
      const { host, layout } = openMargin();
      expect(layout.classList.contains("has-margin")).toBe(false);

      const note = child(host, 0, 20);
      await settle();
      expect(layout.classList.contains("has-margin")).toBe(true);

      note.remove();
      await settle();
      expect(layout.classList.contains("has-margin")).toBe(false);
    });

    it("moves each child that names an anchor beside the line its anchor is on, with the children after it", async () => {
      const { host } = openMargin({ a: lineStart(5), b: lineStart(12) });
      const header = child(host, 0, 30);
      const first = child(host, 40, 20, "a");
      const reply = child(host, 70, 20);
      const second = child(host, 100, 20, "b");
      await settle();

      // Line 5 is 80px down and line 12 is 220px down.
      expect(shifts(header, first, reply, second)).toEqual([
        "",
        "0px 40px",
        "0px 40px",
        "0px 120px",
      ]);
    });

    it("lays out the children of a child that draws no box of its own", async () => {
      const { host } = openMargin({ a: lineStart(5) });
      const rows = document.createElement("span");
      rows.style.display = "contents";
      host.append(rows);
      const row = child(rows, 0, 20, "a");
      await settle();

      expect(shifts(rows, row)).toEqual(["", "0px 80px"]);
    });

    it("returns a child to the column once it no longer names an anchor", async () => {
      const { host } = openMargin({ a: lineStart(5) });
      const note = child(host, 0, 20, "a");
      await settle();
      expect(shifts(note)).toEqual(["0px 80px"]);

      note.removeAttribute("data-anchor");
      await settle();

      expect(shifts(note)).toEqual([""]);
    });

    it("leaves no translate on a child the host removes", async () => {
      const { host } = openMargin({ a: lineStart(5) });
      const note = child(host, 0, 20, "a");
      await settle();
      expect(shifts(note)).toEqual(["0px 80px"]);

      note.remove();
      await settle();

      expect(shifts(note)).toEqual([""]);
    });

    it("leaves no translate on a child that comes to draw no box of its own", async () => {
      const { host } = openMargin({ a: lineStart(5) });
      const note = child(host, 0, 20, "a");
      await settle();
      expect(shifts(note)).toEqual(["0px 80px"]);

      note.style.display = "contents";
      await settle();

      expect(shifts(note)).toEqual([""]);
    });

    it("leaves a hidden child where it is, and places the children after it", async () => {
      const { host } = openMargin({ a: lineStart(5), b: lineStart(12) });
      const hidden = child(host, 0, 20, "a");
      Object.defineProperty(hidden, "getClientRects", {
        configurable: true,
        value: () => [],
      });
      const shown = child(host, 0, 20, "b");
      await settle();

      expect(shifts(hidden, shown)).toEqual(["", "0px 220px"]);
    });

    it("leaves a child that is not an HTML element out of the margin", async () => {
      const { host } = openMargin({ a: lineStart(5) });
      const drawing = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      drawing.setAttribute("data-anchor", "a");
      host.append(drawing);
      const note = child(host, 0, 20, "a");
      await settle();

      expect(drawing.getAttribute("style")).toBe(null);
      expect(shifts(note)).toEqual(["0px 80px"]);
    });

    it("keeps the child of the active highlight beside its line, moving the one above it up", async () => {
      const { host } = openMargin(
        { a: lineStart(5), b: lineStart(6), "b:to": lineStart(7) },
        [{ id: "b", fromAnchor: "b", toAnchor: "b:to", kind: "active" }],
      );
      const first = child(host, 0, 30, "a");
      const second = child(host, 40, 20, "b");
      await settle();

      // Line 6 is 100px down, so the first child ends 10px above it.
      expect(shifts(first, second)).toEqual(["0px 60px", "0px 60px"]);
    });

    it("leaves every child in the column once the margin wraps below the text", async () => {
      const { host } = openMargin({ a: lineStart(5) }, [], { wrapped: true });
      const note = child(host, 0, 20, "a");
      note.style.translate = "0px 30px";
      await settle();

      expect(shifts(note)).toEqual([""]);
    });

    it("takes its translates and the `has-margin` class away when the view is destroyed", async () => {
      const { view, host, layout } = openMargin({ a: lineStart(5) });
      const note = child(host, 0, 20, "a");
      await settle();
      expect(shifts(note)).toEqual(["0px 80px"]);

      view.destroy();

      expect(shifts(note)).toEqual([""]);
      expect(layout.classList.contains("has-margin")).toBe(false);
    });
  });
});
