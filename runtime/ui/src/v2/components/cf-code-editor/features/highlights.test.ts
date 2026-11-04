import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type EditorState, EditorState as State } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import {
  clearHighlightsEffect,
  highlightField,
  type HighlightRange,
  highlightsOf,
  sameHighlights,
  setHighlightsEffect,
} from "./highlights.ts";

/** A headless state over `doc` holding `ranges`. */
function stateWith(doc: string, ranges: HighlightRange[] = []): EditorState {
  const state = State.create({ doc, extensions: [highlightField] });
  return ranges.length === 0
    ? state
    : state.update({ effects: setHighlightsEffect.of(ranges) }).state;
}

/** Each mark's class and attributes, in document order. */
function marksOf(state: EditorState): {
  from: number;
  to: number;
  class: string | undefined;
  id: string | undefined;
}[] {
  const marks: ReturnType<typeof marksOf> = [];
  const cursor = state.field(highlightField).decorations.iter();
  while (cursor.value !== null) {
    const spec = (cursor.value as Decoration).spec as {
      class?: string;
      attributes?: Record<string, string>;
    };
    marks.push({
      from: cursor.from,
      to: cursor.to,
      class: spec.class,
      id: spec.attributes?.["data-highlight-id"],
    });
    cursor.next();
  }
  return marks;
}

describe("highlights", () => {
  describe("highlightField", () => {
    it("holds no ranges until a set effect arrives", () => {
      expect(highlightsOf(stateWith("hello world"))).toEqual([]);
    });

    it("holds the ranges a set effect carries, and draws a mark for each", () => {
      const state = stateWith("hello world", [
        { id: "a", from: 0, to: 5 },
        { id: "b", from: 6, to: 11, kind: "selected" },
      ]);
      expect(highlightsOf(state)).toEqual([
        { id: "a", from: 0, to: 5 },
        { id: "b", from: 6, to: 11, kind: "selected" },
      ]);
      expect(marksOf(state)).toEqual([
        { from: 0, to: 5, class: "cm-highlight", id: "a" },
        {
          from: 6,
          to: 11,
          class: "cm-highlight cm-highlight-selected",
          id: "b",
        },
      ]);
    });

    it("replaces the set on a second set effect rather than adding to it", () => {
      const state = stateWith("hello world", [{ id: "a", from: 0, to: 5 }])
        .update({
          effects: setHighlightsEffect.of([{ id: "b", from: 6, to: 11 }]),
        })
        .state;
      expect(highlightsOf(state)).toEqual([{ id: "b", from: 6, to: 11 }]);
    });

    it("sorts the marks by position whatever order the set lists them in", () => {
      const state = stateWith("hello world", [
        { id: "b", from: 6, to: 11 },
        { id: "a", from: 0, to: 5 },
      ]);
      expect(marksOf(state).map((mark) => mark.id)).toEqual(["a", "b"]);
    });

    it("clamps a range reaching past the document, and keeps one left empty as a point without a mark", () => {
      const state = stateWith("hello", [
        { id: "a", from: 3, to: 9 },
        { id: "b", from: 5, to: 9 },
      ]);
      expect(highlightsOf(state)).toEqual([
        { id: "a", from: 3, to: 5 },
        { id: "b", from: 5, to: 5 },
      ]);
      expect(marksOf(state).map((mark) => mark.id)).toEqual(["a"]);
    });

    it("moves a range when text is inserted before it", () => {
      const state = stateWith("hello world", [{ id: "a", from: 6, to: 11 }])
        .update({ changes: { from: 0, insert: "oh " } }).state;
      expect(highlightsOf(state)).toEqual([{ id: "a", from: 9, to: 14 }]);
      expect(state.sliceDoc(9, 14)).toBe("world");
    });

    it("grows a range when text is inserted inside it", () => {
      const state = stateWith("hello world", [{ id: "a", from: 6, to: 11 }])
        .update({ changes: { from: 8, insert: "XX" } }).state;
      expect(highlightsOf(state)).toEqual([{ id: "a", from: 6, to: 13 }]);
      expect(state.sliceDoc(6, 13)).toBe("woXXrld");
    });

    it("leaves a range alone when text is inserted at either end or after it", () => {
      const before = stateWith("hello world", [{ id: "a", from: 6, to: 11 }]);
      const atStart = before.update({ changes: { from: 6, insert: "X" } })
        .state;
      expect(highlightsOf(atStart)).toEqual([{ id: "a", from: 7, to: 12 }]);
      expect(atStart.sliceDoc(7, 12)).toBe("world");
      const atEnd = before.update({ changes: { from: 11, insert: "X" } })
        .state;
      expect(highlightsOf(atEnd)).toEqual([{ id: "a", from: 6, to: 11 }]);
      const after = stateWith("hello world!", [{ id: "a", from: 6, to: 11 }])
        .update({ changes: { from: 12, insert: "!" } }).state;
      expect(highlightsOf(after)).toEqual([{ id: "a", from: 6, to: 11 }]);
    });

    it("shrinks a range when part of it is deleted", () => {
      const state = stateWith("hello world", [{ id: "a", from: 6, to: 11 }])
        .update({ changes: { from: 4, to: 8 } }).state;
      expect(highlightsOf(state)).toEqual([{ id: "a", from: 4, to: 7 }]);
      expect(state.sliceDoc(4, 7)).toBe("rld");
    });

    it("empties a range whose text is deleted, at the deletion's start, and keeps the others", () => {
      const state = stateWith("hello world", [
        { id: "a", from: 0, to: 5 },
        { id: "b", from: 6, to: 11 },
      ]).update({ changes: { from: 5, to: 11 } }).state;
      expect(highlightsOf(state)).toEqual([
        { id: "a", from: 0, to: 5 },
        { id: "b", from: 5, to: 5 },
      ]);
      expect(marksOf(state).map((mark) => mark.id)).toEqual(["a"]);
    });

    it("keeps an empty range a point, before text inserted at it", () => {
      const state = stateWith("hello world", [{ id: "b", from: 6, to: 11 }])
        .update({ changes: { from: 5, to: 11 } }).state
        .update({ changes: { from: 5, insert: "!" } }).state;
      expect(highlightsOf(state)).toEqual([{ id: "b", from: 5, to: 5 }]);
    });

    it("empties every range when the whole document is replaced", () => {
      const state = stateWith("hello world", [{ id: "a", from: 0, to: 5 }])
        .update({ changes: { from: 0, to: 11, insert: "hello world" } }).state;
      expect(highlightsOf(state)).toEqual([{ id: "a", from: 0, to: 0 }]);
    });

    it("reads a set effect against the document its transaction produces", () => {
      const state = stateWith("world").update({
        changes: { from: 0, insert: "hello " },
        effects: setHighlightsEffect.of([{ id: "a", from: 6, to: 11 }]),
      }).state;
      expect(highlightsOf(state)).toEqual([{ id: "a", from: 6, to: 11 }]);
      expect(state.sliceDoc(6, 11)).toBe("world");
    });

    it("holds nothing after a clear effect", () => {
      const state = stateWith("hello world", [{ id: "a", from: 0, to: 5 }])
        .update({ effects: clearHighlightsEffect.of(null) }).state;
      expect(highlightsOf(state)).toEqual([]);
      expect(marksOf(state)).toEqual([]);
    });

    it("keeps the same value through a transaction that touches nothing", () => {
      const before = stateWith("hello world", [{ id: "a", from: 0, to: 5 }]);
      const after = before.update({ selection: { anchor: 3 } }).state;
      expect(highlightsOf(after)).toBe(highlightsOf(before));
    });
  });

  describe("sameHighlights()", () => {
    it("returns `true` for lists holding the same ranges in the same order", () => {
      expect(sameHighlights(
        [{ id: "a", from: 0, to: 5, kind: "selected" }],
        [{ id: "a", from: 0, to: 5, kind: "selected" }],
      )).toBe(true);
    });

    it("returns `false` when a position, an id, a kind, or the length differs", () => {
      const list: HighlightRange[] = [{ id: "a", from: 0, to: 5 }];
      expect(sameHighlights(list, [{ id: "a", from: 1, to: 5 }])).toBe(false);
      expect(sameHighlights(list, [{ id: "a", from: 0, to: 6 }])).toBe(false);
      expect(sameHighlights(list, [{ id: "b", from: 0, to: 5 }])).toBe(false);
      expect(sameHighlights(list, [{ id: "a", from: 0, to: 5, kind: "x" }]))
        .toBe(false);
      expect(sameHighlights(list, [])).toBe(false);
    });
  });
});
