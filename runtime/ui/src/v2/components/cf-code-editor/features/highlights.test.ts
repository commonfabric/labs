import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type ChangeDesc,
  ChangeSet,
  EditorSelection,
  EditorState,
} from "@codemirror/state";
import type { FieldAnchors } from "@commonfabric/runtime-client";
import type { CodeMirrorSynchronizationSnapshot } from "../codemirror-collaboration.ts";
import {
  characterAt,
  type CharacterGeometry,
  type EditorHighlight,
  highlightAnchors,
  highlightAt,
  highlightClickHandler,
  highlightFaults,
  highlightField,
  highlights,
  localAnchors,
  NOTHING_SELECTED,
  sameSelection,
  selectionReport,
  setHighlightAnchorsEffect,
  setHighlightsEffect,
} from "./highlights.ts";

const synchronization = (
  pendingChanges: readonly ChangeDesc[] = [],
  anchors: FieldAnchors = {},
  confirmedCursor: CodeMirrorSynchronizationSnapshot["confirmedCursor"] = {
    epoch: 1,
    version: 4,
  },
): CodeMirrorSynchronizationSnapshot => ({
  confirmedCursor,
  pendingChanges,
  field: { space: "did:key:s", branch: "", id: "of:a", scopeKey: "", path: [] },
  anchors,
});

const insert = (length: number, from: number, text: string): ChangeDesc =>
  ChangeSet.of({ from, insert: text }, length).desc;

const stateWith = (
  doc: string,
  anchors: FieldAnchors,
  highlights: readonly EditorHighlight[],
): EditorState =>
  EditorState.create({ doc, extensions: [highlightField] }).update({
    effects: [
      setHighlightAnchorsEffect.of(anchors),
      setHighlightsEffect.of(highlights),
    ],
  }).state;

const marks = (state: EditorState) => {
  const found: Array<{ from: number; to: number; spec: unknown }> = [];
  state.field(highlightField).decorations.between(
    0,
    state.doc.length,
    (from, to, value) => {
      found.push({ from, to, spec: value.spec });
    },
  );
  return found;
};

/**
 * A stand-in for an editor view that lays `state`'s document out on a grid:
 * each character is 10 wide and each line 20 tall, with the first line's top
 * at y = 100 and its first character's left edge at x = 0. Like CodeMirror,
 * it resolves a point to the nearest position on the point's line and to the
 * side of that position the point is on, and resolves a point above or below
 * the lines to the document's start or end.
 */
const gridView = (state: EditorState): CharacterGeometry => ({
  state,
  documentTop: 100,
  posAndSideAtCoords: ({ x, y }) => {
    if (y < 100) return { pos: 0, assoc: 1 };
    if (y >= 100 + 20 * state.doc.lines) {
      return { pos: state.doc.length, assoc: -1 };
    }
    const line = state.doc.line(1 + Math.floor((y - 100) / 20));
    const column = Math.max(0, Math.min(line.length, Math.round(x / 10)));
    return {
      pos: line.from + column,
      assoc: column === line.length || x < column * 10 ? -1 : 1,
    };
  },
  lineBlockAt: (pos) => {
    const top = 20 * (state.doc.lineAt(pos).number - 1);
    return { top, bottom: top + 20 };
  },
  coordsForChar: (pos) => {
    const line = state.doc.lineAt(pos);
    if (pos === line.to) return null;
    const left = 10 * (pos - line.from);
    return { left, right: left + 10 };
  },
});

/** The ranges `state` draws marks over, in document order. */
const markedRanges = (state: EditorState): Array<[number, number]> =>
  marks(state).map(({ from, to }) => [from, to]);

describe("highlights", () => {
  describe("highlightField", () => {
    it("marks the text from each highlight's first anchor to its second", () => {
      const state = stateWith("hello world", {
        a: 0,
        b: 5,
        c: 6,
        d: 11,
      }, [
        { id: "first", fromAnchor: "a", toAnchor: "b" },
        { id: "second", fromAnchor: "c", toAnchor: "d", kind: "active" },
      ]);

      expect(marks(state)).toEqual([
        {
          from: 0,
          to: 5,
          spec: {
            class: "cm-highlight",
            attributes: { "data-highlight-id": "first" },
          },
        },
        {
          from: 6,
          to: 11,
          spec: {
            class: "cm-highlight cm-highlight-active",
            attributes: { "data-highlight-id": "second" },
          },
        },
      ]);
    });

    it("marks nothing for a highlight naming an anchor the field does not hold", () => {
      // `toString` is a name every object inherits, and the field holds no
      // anchor under it.

      const state = stateWith("hello world", { a: 0, b: 5 }, [
        { id: "no-start", fromAnchor: "missing", toAnchor: "b" },
        { id: "no-end", fromAnchor: "a", toAnchor: "missing" },
        { id: "inherited", fromAnchor: "a", toAnchor: "toString" },
        { id: "held", fromAnchor: "a", toAnchor: "b" },
      ]);

      expect(marks(state).map(({ spec }) => spec)).toEqual([{
        class: "cm-highlight",
        attributes: { "data-highlight-id": "held" },
      }]);
    });

    it("marks nothing for a highlight whose end is not after its start", () => {
      const state = stateWith("hello world", { a: 3, b: 3, c: 6 }, [
        { id: "empty", fromAnchor: "a", toAnchor: "b" },
        { id: "inverted", fromAnchor: "c", toAnchor: "a" },
        { id: "forward", fromAnchor: "a", toAnchor: "c" },
      ]);

      expect(markedRanges(state)).toEqual([[3, 6]]);
    });

    it("brings an anchor past the end of the text back to the end", () => {
      const state = stateWith("hello", { a: 2, b: 40, c: 41 }, [
        { id: "to-end", fromAnchor: "a", toAnchor: "b" },
        { id: "past-end", fromAnchor: "b", toAnchor: "c" },
      ]);

      expect(markedRanges(state)).toEqual([[2, 5]]);
    });

    it("leaves out a kind that is not a class-name fragment", () => {
      const state = stateWith("hello", { a: 0, b: 5 }, [{
        id: "h",
        fromAnchor: "a",
        toAnchor: "b",
        kind: "x y",
      }]);

      expect(marks(state)[0].spec).toEqual({
        class: "cm-highlight",
        attributes: { "data-highlight-id": "h" },
      });
    });

    it("moves each anchor through an edit by Memory's anchor rule", () => {
      const state = stateWith("hello world", { a: 0, b: 5, c: 6, d: 11 }, [
        { id: "first", fromAnchor: "a", toAnchor: "b" },
        { id: "second", fromAnchor: "c", toAnchor: "d" },
      ]);

      const next = state.update({
        changes: [{ from: 2, insert: ">" }, { from: 6, to: 11 }],
      }).state;

      expect(highlightAnchors(next)).toEqual({ a: 0, b: 6, c: 7, d: 7 });
      expect(markedRanges(next)).toEqual([[0, 6]]);
    });

    it("takes text inserted at a highlight's start into the mark", () => {
      // "Hello" with "el" marked.

      const state = stateWith("Hello", { from: 1, to: 3 }, [
        { id: "h", fromAnchor: "from", toAnchor: "to" },
      ]);

      const next = state.update({ changes: { from: 1, insert: "XY" } }).state;

      expect(highlightAnchors(next)).toEqual({ from: 1, to: 5 });
      expect(next.sliceDoc(1, 5)).toBe("XYel");
      expect(markedRanges(next)).toEqual([[1, 5]]);
    });

    it("leaves text inserted at a highlight's end out of the mark", () => {
      // "Hello" with "el" marked.

      const state = stateWith("Hello", { from: 1, to: 3 }, [
        { id: "h", fromAnchor: "from", toAnchor: "to" },
      ]);

      const next = state.update({ changes: { from: 3, insert: "XY" } }).state;

      expect(highlightAnchors(next)).toEqual({ from: 1, to: 3 });
      expect(markedRanges(next)).toEqual([[1, 3]]);
    });

    it("moves an anchor past the end of the text as one at the end", () => {
      const state = stateWith("hello", { a: 0, b: 40 }, [
        { id: "h", fromAnchor: "a", toAnchor: "b" },
      ]);

      const next = state.update({ changes: { from: 0, insert: ">> " } }).state;

      expect(highlightAnchors(next)).toEqual({ a: 0, b: 8 });
      expect(markedRanges(next)).toEqual([[0, 8]]);
    });

    it("moves an anchor whose id is `__proto__` like any other", () => {
      // An object literal would take the id as its prototype, so the map is
      // built from entries, which is how a decoded document holds it.

      const state = stateWith(
        "hello",
        Object.fromEntries([["__proto__", 1], ["to", 3]]),
        [{ id: "h", fromAnchor: "__proto__", toAnchor: "to" }],
      );

      const next = state.update({ changes: { from: 0, insert: ">" } }).state;

      expect(Object.entries(highlightAnchors(next))).toEqual([
        ["__proto__", 2],
        ["to", 4],
      ]);
      expect(markedRanges(next)).toEqual([[2, 4]]);
    });

    it("keeps its value for an edit that moves no anchor", () => {
      const state = stateWith("hello", { a: 0, b: 3 }, [{
        id: "h",
        fromAnchor: "a",
        toAnchor: "b",
      }]);

      const next = state.update({ changes: { from: 5, insert: "!" } }).state;

      expect(next.field(highlightField)).toBe(state.field(highlightField));
      expect(markedRanges(next)).toEqual([[0, 3]]);
    });

    it("keeps its value for a transaction that changes nothing it holds", () => {
      const state = stateWith("hello", { a: 0, b: 5 }, [{
        id: "h",
        fromAnchor: "a",
        toAnchor: "b",
      }]);

      const next = state.update({ selection: { anchor: 2 } }).state;

      expect(next.field(highlightField)).toBe(state.field(highlightField));
    });

    it("returns no anchors from a state without the field", () => {
      expect(highlightAnchors(EditorState.create({ doc: "x" }))).toEqual({});
    });
  });

  describe("highlightAt", () => {
    const nested = stateWith("hello world", { start: 0, middle: 6, end: 11 }, [
      { id: "outer", fromAnchor: "start", toAnchor: "end" },
      { id: "inner", fromAnchor: "middle", toAnchor: "end" },
    ]);

    it("returns the innermost drawn highlight over a position", () => {
      expect(highlightAt(nested, 7)).toBe("inner");
      expect(highlightAt(nested, 3)).toBe("outer");
    });

    it("returns the highlight over its first and its last character", () => {
      expect(highlightAt(nested, 6)).toBe("inner");
      expect(highlightAt(nested, 10)).toBe("inner");
      expect(highlightAt(nested, 5)).toBe("outer");
    });

    it("returns undefined where no highlight is drawn", () => {
      expect(highlightAt(nested, 11)).toBeUndefined();
      expect(highlightAt(EditorState.create({ doc: "x" }), 0))
        .toBeUndefined();
    });
  });

  describe("characterAt", () => {
    const view = gridView(EditorState.create({ doc: "ab\ncd" }));

    it("returns the character whose left half the point is on", () => {
      expect(characterAt(view, { x: 12, y: 110 })).toBe(1);
    });

    it("returns the character whose right half the point is on", () => {
      // CodeMirror resolves this point to position 2, after the character.

      expect(characterAt(view, { x: 18, y: 110 })).toBe(1);
      expect(characterAt(view, { x: 8, y: 130 })).toBe(3);
    });

    it("returns undefined for a point past the end of a line", () => {
      expect(characterAt(view, { x: 60, y: 110 })).toBeUndefined();
      expect(characterAt(view, { x: 60, y: 130 })).toBeUndefined();
    });

    it("returns undefined for a point above or below the document's lines", () => {
      expect(characterAt(view, { x: 5, y: 90 })).toBeUndefined();
      expect(characterAt(view, { x: 15, y: 170 })).toBeUndefined();
    });

    it("returns undefined where the editor resolves no position", () => {
      expect(
        characterAt({ ...view, posAndSideAtCoords: () => null }, {
          x: 5,
          y: 110,
        }),
      ).toBeUndefined();
    });

    it("returns undefined for a position with no character on the side the point is on", () => {
      // The start of the document has no character before it, and the end
      // has none after it.

      expect(
        characterAt({
          ...view,
          posAndSideAtCoords: () => ({ pos: 0, assoc: -1 }),
        }, { x: 5, y: 110 }),
      ).toBeUndefined();
      expect(
        characterAt({
          ...view,
          posAndSideAtCoords: () => ({ pos: 5, assoc: 1 }),
        }, { x: 15, y: 130 }),
      ).toBeUndefined();
    });

    it("returns undefined for a line break", () => {
      // A point CodeMirror resolves to the end of the first line, on the side
      // of the line break after it.

      expect(
        characterAt({
          ...view,
          posAndSideAtCoords: () => ({ pos: 2, assoc: 1 }),
        }, { x: 25, y: 110 }),
      ).toBeUndefined();
    });

    it("returns a character that has no box of its own", () => {
      // A widget standing in for text leaves the characters it replaces
      // without a box.

      expect(
        characterAt({ ...view, coordsForChar: () => null }, { x: 18, y: 110 }),
      ).toBe(1);
    });
  });

  describe("highlightClickHandler()", () => {
    // Each case clicks on "hello world", laid out on the grid as one line
    // with "world" marked as the highlight `h`, and collects the ids the
    // handler reports.

    const marked = stateWith("hello world", { from: 6, to: 11 }, [
      { id: "h", fromAnchor: "from", toAnchor: "to" },
    ]);

    /** A primary-button click `fraction` of the way across a character. */
    const clickOn = (at: number, fraction: number) => ({
      button: 0,
      clientX: 10 * (at + fraction),
      clientY: 110,
    });

    /** What the handler reports and returns for `click` on `state`. */
    const handle = (
      state: EditorState,
      click: { button: number; clientX: number; clientY: number },
      view: CharacterGeometry = gridView(state),
    ) => {
      const reported: string[] = [];
      const returned = highlightClickHandler((id) => reported.push(id))(
        click,
        view,
      );
      return { reported, returned };
    };

    it("reports the highlight under a primary-button click that leaves nothing selected", () => {
      expect(handle(marked, clickOn(6, 0.25)).reported).toEqual(["h"]);
      expect(handle(marked, clickOn(10, 0.75)).reported).toEqual(["h"]);
    });

    it("reports nothing for a click with another button", () => {
      expect(handle(marked, { ...clickOn(8, 0.5), button: 1 }).reported)
        .toEqual([]);
      expect(handle(marked, { ...clickOn(8, 0.5), button: 2 }).reported)
        .toEqual([]);
    });

    it("reports nothing for a click that leaves text selected", () => {
      const selecting = marked.update({
        selection: { anchor: 7, head: 9 },
      }).state;

      expect(handle(selecting, clickOn(8, 0.5)).reported).toEqual([]);
    });

    it("reports nothing for a click that leaves text selected in a range other than the main one", () => {
      // The main range is the caret the click placed in `world`; a second
      // range still holds `hel`.

      const twoRanges = EditorState.create({
        doc: "hello world",
        extensions: [
          highlightField,
          EditorState.allowMultipleSelections.of(true),
        ],
        selection: EditorSelection.create([
          EditorSelection.range(0, 3),
          EditorSelection.cursor(8),
        ], 1),
      }).update({
        effects: [
          setHighlightAnchorsEffect.of({ from: 6, to: 11 }),
          setHighlightsEffect.of([
            { id: "h", fromAnchor: "from", toAnchor: "to" },
          ]),
        ],
      }).state;

      expect(twoRanges.selection.main.empty).toBe(true);
      expect(handle(twoRanges, clickOn(8, 0.5)).reported).toEqual([]);
    });

    it("reports nothing for a click on a character outside every highlight", () => {
      expect(handle(marked, clickOn(2, 0.5)).reported).toEqual([]);
      expect(handle(marked, clickOn(5, 0.75)).reported).toEqual([]);
    });

    it("reports nothing for a click over no character", () => {
      // Past the end of the line, whose last character is marked, and below
      // it.

      expect(handle(marked, clickOn(20, 0.5)).reported).toEqual([]);
      expect(handle(marked, { ...clickOn(10, 0.5), clientY: 170 }).reported)
        .toEqual([]);
    });

    it("reports nothing where the editor resolves no position", () => {
      expect(
        handle(marked, clickOn(8, 0.5), {
          ...gridView(marked),
          posAndSideAtCoords: () => null,
        }).reported,
      ).toEqual([]);
    });

    it("returns `false` whether or not it reports a highlight", () => {
      expect(handle(marked, clickOn(8, 0.5)).returned).toBe(false);
      expect(handle(marked, clickOn(2, 0.5)).returned).toBe(false);
      expect(handle(marked, { ...clickOn(8, 0.5), button: 1 }).returned)
        .toBe(false);
    });
  });

  describe("highlights()", () => {
    it("returns an extension whose state draws the host's highlights", () => {
      const state = EditorState.create({
        doc: "hello world",
        extensions: highlights(() => {}),
      }).update({
        effects: [
          setHighlightAnchorsEffect.of({ from: 6, to: 11 }),
          setHighlightsEffect.of([
            { id: "h", fromAnchor: "from", toAnchor: "to" },
          ]),
        ],
      }).state;

      expect(highlightAnchors(state)).toEqual({ from: 6, to: 11 });
      expect(markedRanges(state)).toEqual([[6, 11]]);
      expect(highlightAt(state, 8)).toBe("h");
    });
  });

  describe("highlightFaults", () => {
    it("returns a message for a kind that cannot be part of a class name", () => {
      const state = stateWith("hello", { from: 1, to: 3 }, [
        { id: "h", fromAnchor: "from", toAnchor: "to", kind: "Big Mark" },
        { id: "ok", fromAnchor: "from", toAnchor: "to", kind: "active" },
      ]);

      const faults = highlightFaults(state);

      expect(faults).toHaveLength(1);
      expect(faults[0]).toContain("has the kind");
      expect(faults[0]).toContain("Big Mark");
    });

    it("returns a message for a highlight whose end anchor lies before its start", () => {
      const state = stateWith("hello", { from: 3, to: 1 }, [
        { id: "h", fromAnchor: "from", toAnchor: "to" },
      ]);

      const faults = highlightFaults(state);

      expect(faults).toHaveLength(1);
      expect(faults[0]).toContain("ends at the anchor");
      expect(faults[0]).toContain("drawn as nothing");
    });

    it("returns nothing for a highlight missing an anchor, or with both anchors at one offset", () => {
      const state = stateWith("hello", { from: 2, to: 2 }, [
        { id: "gone", fromAnchor: "from", toAnchor: "to" },
        { id: "unanchored", fromAnchor: "from", toAnchor: "missing" },
      ]);

      expect(highlightFaults(state)).toEqual([]);
    });
  });

  describe("selectionReport", () => {
    const selected = (doc: string, anchor: number, head: number) =>
      EditorState.create({ doc, selection: { anchor, head } });

    it("reports an empty selection as nothing selected", () => {
      expect(selectionReport(selected("abc", 1, 1))).toEqual(NOTHING_SELECTED);
    });

    it("states the selection against the editor's document, which it carries", () => {
      expect(selectionReport(selected("hello", 3, 1))).toEqual({
        from: 1,
        to: 3,
        text: "el",
        value: "hello",
      });
    });
  });

  describe("sameSelection", () => {
    it("returns `true` only for the same range of the same document", () => {
      const report = { from: 1, to: 3, text: "el", value: "hello" };

      expect(sameSelection(report, { ...report })).toBe(true);
      expect(sameSelection(report, { ...report, from: 0 })).toBe(false);
      expect(sameSelection(report, { ...report, to: 4 })).toBe(false);
      expect(sameSelection(report, { ...report, value: "hello!" })).toBe(false);
    });
  });

  describe("localAnchors", () => {
    it("returns the confirmed anchors when nothing is pending", () => {
      const state = EditorState.create({ doc: "abc" });

      expect(localAnchors(state, synchronization([], { a: 1, b: 2 })))
        .toEqual({ a: 1, b: 2 });
    });

    it("maps the confirmed anchors over pending edits", () => {
      // Confirmed "abc"; the pending edits typed "X" before it and "Y" after.
      // The insertion at an anchor lands after it.

      const state = EditorState.create({ doc: "XabcY" });
      const pending = [insert(3, 0, "X"), insert(4, 4, "Y")];

      expect(localAnchors(
        state,
        synchronization(pending, { start: 0, middle: 1, end: 3 }),
      )).toEqual({ start: 0, middle: 2, end: 4 });
    });

    it("maps the anchors of a field with no collaborative edit over pending edits", () => {
      const state = EditorState.create({ doc: "Xabc" });

      expect(localAnchors(
        state,
        synchronization([insert(3, 0, "X")], { from: 1, to: 3 }, null),
      )).toEqual({ from: 2, to: 4 });
    });

    it("returns undefined when the pending edits end elsewhere", () => {
      const state = EditorState.create({ doc: "abcdef" });

      expect(localAnchors(state, synchronization([insert(3, 0, "X")])))
        .toBeUndefined();
    });
  });
});
