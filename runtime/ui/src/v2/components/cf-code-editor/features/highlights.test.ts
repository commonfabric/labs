import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { type ChangeDesc, ChangeSet, EditorState } from "@codemirror/state";
import type { CodeMirrorSynchronizationSnapshot } from "../codemirror-collaboration.ts";
import {
  type EditorHighlight,
  highlightAt,
  highlightField,
  type HighlightRange,
  highlightRanges,
  localAnchorRanges,
  needsRestating,
  NOTHING_SELECTED,
  RESTATE_AFTER_VERSIONS,
  sameSelection,
  selectionReport,
  setHighlightRangesEffect,
  setHighlightsEffect,
} from "./highlights.ts";

const synchronization = (
  pendingChanges: readonly ChangeDesc[] = [],
  anchors: CodeMirrorSynchronizationSnapshot["anchors"] = [],
): CodeMirrorSynchronizationSnapshot => ({
  confirmedCursor: { epoch: 1, version: 4 },
  pendingChanges,
  field: { space: "did:key:s", branch: "", id: "of:a", scopeKey: "", path: [] },
  anchors,
});

const insert = (length: number, from: number, text: string): ChangeDesc =>
  ChangeSet.of({ from, insert: text }, length).desc;

const stateWith = (
  doc: string,
  ranges: readonly HighlightRange[],
  highlights: readonly EditorHighlight[],
): EditorState =>
  EditorState.create({ doc, extensions: [highlightField] }).update({
    effects: [
      setHighlightRangesEffect.of(ranges),
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

describe("highlights", () => {
  describe("highlightField", () => {
    it("marks the named anchors that cover text", () => {
      const state = stateWith("hello world", [
        { id: "a", from: 0, to: 5 },
        { id: "b", from: 6, to: 11 },
        { id: "gone", from: 3, to: 3 },
      ], [{ id: "b", kind: "active" }, { id: "gone" }, { id: "unknown" }]);

      expect(marks(state)).toEqual([{
        from: 6,
        to: 11,
        spec: {
          class: "cm-highlight cm-highlight-active",
          attributes: { "data-highlight-id": "b" },
        },
      }]);
    });

    it("leaves out a kind that is not a class-name fragment", () => {
      const state = stateWith("hello", [{ id: "a", from: 0, to: 5 }], [{
        id: "a",
        kind: "x y",
      }]);

      expect(marks(state)[0].spec).toEqual({
        class: "cm-highlight",
        attributes: { "data-highlight-id": "a" },
      });
    });

    it("moves ranges with each edit by Memory's anchor rule", () => {
      const state = stateWith("hello world", [
        { id: "a", from: 0, to: 5 },
        { id: "b", from: 6, to: 11 },
      ], [{ id: "a" }, { id: "b" }]);

      const next = state.update({
        changes: [{ from: 0, insert: ">" }, { from: 6, to: 11 }],
      }).state;

      expect(highlightRanges(next)).toEqual([
        { id: "a", from: 1, to: 6 },
        { id: "b", from: 7, to: 7 },
      ]);
      expect(marks(next).map(({ from, to }) => [from, to])).toEqual([[1, 6]]);
    });

    it("keeps its value for a transaction that changes nothing it holds", () => {
      const state = stateWith("hello", [{ id: "a", from: 0, to: 5 }], [{
        id: "a",
      }]);

      const next = state.update({ selection: { anchor: 2 } }).state;

      expect(next.field(highlightField)).toBe(state.field(highlightField));
    });

    it("returns no ranges from a state without the field", () => {
      expect(highlightRanges(EditorState.create({ doc: "x" }))).toEqual([]);
    });
  });

  describe("highlightAt", () => {
    const nested = stateWith("hello world", [
      { id: "outer", from: 0, to: 11 },
      { id: "inner", from: 6, to: 11 },
      { id: "hidden", from: 0, to: 2 },
    ], [{ id: "outer" }, { id: "inner" }]);

    it("returns the innermost drawn highlight over a position", () => {
      expect(highlightAt(nested, 7)).toBe("inner");
      expect(highlightAt(nested, 3)).toBe("outer");
      // "hidden" holds a range there but is not drawn.
      expect(highlightAt(nested, 1)).toBe("outer");
    });

    it("returns undefined where no highlight is drawn", () => {
      expect(highlightAt(nested, 11)).toBeUndefined();
      expect(highlightAt(EditorState.create({ doc: "x" }), 0))
        .toBeUndefined();
    });
  });

  describe("selectionReport", () => {
    const selected = (doc: string, anchor: number, head: number) =>
      EditorState.create({ doc, selection: { anchor, head } });

    it("reports an empty selection as nothing selected", () => {
      expect(selectionReport(selected("abc", 1, 1), synchronization()))
        .toEqual(NOTHING_SELECTED);
    });

    it("states the selection against the editor's document with no base outside collaboration", () => {
      expect(selectionReport(selected("hello", 3, 1), null)).toEqual({
        from: 1,
        to: 3,
        text: "el",
        base: null,
      });
    });

    it("names the confirmed cursor when nothing is pending", () => {
      expect(selectionReport(selected("hello", 1, 3), synchronization()))
        .toEqual({
          from: 1,
          to: 3,
          text: "el",
          base: { epoch: 1, version: 4 },
        });
    });

    it("maps the selection back over pending edits outside it", () => {
      // Confirmed "hello world"; the pending edit typed ">> " at the start.
      const state = selected(">> hello world", 9, 14);

      expect(selectionReport(state, synchronization([insert(11, 0, ">> ")])))
        .toEqual({
          from: 6,
          to: 11,
          text: "world",
          base: { epoch: 1, version: 4 },
        });
    });

    it("maps a selection that starts right after a pending insertion", () => {
      const state = selected("Xabc", 1, 3);

      expect(selectionReport(state, synchronization([insert(3, 0, "X")])))
        .toEqual({
          from: 0,
          to: 2,
          text: "ab",
          base: { epoch: 1, version: 4 },
        });
    });

    it("reports nothing selected over a pending edit", () => {
      const pending = [insert(3, 1, "X")];

      expect(selectionReport(selected("aXbc", 0, 3), synchronization(pending)))
        .toEqual(NOTHING_SELECTED);
      expect(selectionReport(selected("aXbc", 1, 2), synchronization(pending)))
        .toEqual(NOTHING_SELECTED);
      expect(selectionReport(selected("aXbc", 0, 2), synchronization(pending)))
        .toEqual(NOTHING_SELECTED);
    });

    it("reports nothing selected when the pending edits end elsewhere", () => {
      const state = selected("abcdef", 0, 2);

      expect(selectionReport(state, synchronization([insert(3, 0, "X")])))
        .toEqual(NOTHING_SELECTED);
    });
  });

  describe("needsRestating", () => {
    const held = {
      from: 1,
      to: 3,
      text: "el",
      base: { epoch: 1, version: 4 },
    };

    it("returns true once the base falls the restating distance behind", () => {
      expect(needsRestating(held, { epoch: 1, version: 4 })).toBe(false);
      expect(
        needsRestating(held, {
          epoch: 1,
          version: 4 + RESTATE_AFTER_VERSIONS - 1,
        }),
      ).toBe(false);
      expect(
        needsRestating(held, { epoch: 1, version: 4 + RESTATE_AFTER_VERSIONS }),
      ).toBe(true);
    });

    it("returns true for a base from another epoch", () => {
      expect(needsRestating(held, { epoch: 2, version: 0 })).toBe(true);
    });

    it("returns true for a range reported with no version", () => {
      expect(needsRestating({ ...held, base: null }, { epoch: 1, version: 4 }))
        .toBe(true);
    });

    it("returns false for a report with no range", () => {
      expect(needsRestating(NOTHING_SELECTED, { epoch: 9, version: 999 }))
        .toBe(false);
    });
  });

  describe("sameSelection", () => {
    it("compares range, text and base", () => {
      const report = {
        from: 1,
        to: 3,
        text: "el",
        base: { epoch: 1, version: 4 },
      };

      expect(sameSelection(report, { ...report })).toBe(true);
      expect(
        sameSelection(report, { ...report, base: { epoch: 1, version: 5 } }),
      ).toBe(false);
      expect(sameSelection(report, { ...report, base: null })).toBe(false);
      expect(sameSelection(report, { ...report, to: 4 })).toBe(false);
    });
  });

  describe("localAnchorRanges", () => {
    it("returns the confirmed ranges when nothing is pending", () => {
      const state = EditorState.create({ doc: "abc" });

      expect(localAnchorRanges(
        state,
        synchronization([], [{ id: "a", from: 1, to: 2 }]),
      )).toEqual([{ id: "a", from: 1, to: 2 }]);
    });

    it("maps the confirmed ranges over pending edits", () => {
      const state = EditorState.create({ doc: "XabcY" });
      const pending = [insert(3, 0, "X"), insert(4, 4, "Y")];

      expect(localAnchorRanges(
        state,
        synchronization(pending, [
          { id: "all", from: 0, to: 3 },
          { id: "point", from: 3, to: 3 },
        ]),
      )).toEqual([
        { id: "all", from: 1, to: 4 },
        { id: "point", from: 4, to: 4 },
      ]);
    });

    it("returns undefined when the pending edits end elsewhere", () => {
      const state = EditorState.create({ doc: "abcdef" });

      expect(localAnchorRanges(state, synchronization([insert(3, 0, "X")])))
        .toBeUndefined();
    });
  });
});
