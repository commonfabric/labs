/**
 * Tests the editor's side of the highlight round trip without a mounted
 * view: what it reports after an edit, what it does with a value the host
 * hands back, and how it stamps a report. The methods read the fields a
 * stand-in can carry and a view that is a state and a dispatch, so they run
 * over a real `EditorState` under `deno test`; the marks, the mousedown path,
 * and the whole mounted round trip are what the browser test beside this one
 * covers.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { collab } from "@codemirror/collab";
import {
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

import { CFCodeEditor } from "./cf-code-editor.ts";
import {
  highlightField,
  type HighlightRange,
  highlightsOf,
} from "./features/highlights.ts";

interface Emitted {
  name: string;
  detail: unknown;
}

/** The members the highlight methods read, over a view with no DOM. */
interface StandIn {
  highlights: HighlightRange[] | undefined;
  _unmatchedHighlightReport: readonly HighlightRange[] | undefined;
  _lastSelection: unknown;
  _collaboration: unknown;
  _editorView: { state: EditorState; dispatch(spec: TransactionSpec): void };
  emit(name: string, detail: unknown): void;
  _pushHighlights(): void;
  _trackHighlights(update: ViewUpdate, fromOutside: boolean): void;
  _reportSelection(state: EditorState): void;
  _documentVersion(state: EditorState): unknown;
}

interface Harness {
  self: StandIn;
  emitted: Emitted[];
  /** The ranges the view's field holds. */
  held(): readonly HighlightRange[];
  /** Applies `spec` to the view and tracks it as the update listener would. */
  edit(spec: TransactionSpec, options?: { remote?: boolean }): void;
}

/**
 * A stand-in editor over `doc`, holding `highlights` as the host set it and
 * the field already matching it, as after a push. With `collaboration` the
 * state carries the collab extension at version 7 and the stand-in a
 * synchronization snapshot in epoch 2.
 */
function standIn(
  doc: string,
  highlights: HighlightRange[],
  options: { collaboration?: boolean } = {},
): Harness {
  let state = EditorState.create({
    doc,
    extensions: [
      highlightField,
      ...(options.collaboration ? [collab({ startVersion: 7 })] : []),
    ],
  });
  const emitted: Emitted[] = [];
  const proto = CFCodeEditor.prototype as unknown as StandIn;
  const self: StandIn = {
    highlights,
    _unmatchedHighlightReport: undefined,
    _lastSelection: undefined,
    _collaboration: options.collaboration
      ? {
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 7 },
          pendingChanges: [],
        },
      }
      : undefined,
    _editorView: {
      get state() {
        return state;
      },
      dispatch(spec: TransactionSpec) {
        state = state.update(spec).state;
      },
    },
    emit(name, detail) {
      emitted.push({ name, detail });
    },
    _pushHighlights: proto._pushHighlights,
    _trackHighlights: proto._trackHighlights,
    _reportSelection: proto._reportSelection,
    _documentVersion: proto._documentVersion,
  };
  self._pushHighlights();
  return {
    self,
    emitted,
    held: () => highlightsOf(state),
    edit(spec, { remote = false } = {}) {
      const transaction = state.update({
        ...spec,
        annotations: remote ? Transaction.remote.of(true) : [],
      });
      state = transaction.state;
      self._trackHighlights(
        {
          state: transaction.state,
          startState: transaction.startState,
          transactions: [transaction],
          changes: transaction.changes,
          docChanged: transaction.docChanged,
        } as unknown as ViewUpdate,
        remote,
      );
    },
  };
}

const ONE = { id: "one", from: 6, to: 11 };

function reports(emitted: Emitted[]): unknown[] {
  return emitted.filter((each) => each.name === "cf-highlights-mapped").map((
    each,
  ) => each.detail);
}

describe("CFCodeEditor", () => {
  describe("instance members", () => {
    describe("_trackHighlights()", () => {
      it("reports where a local edit moved the ranges, without a version outside collaboration", () => {
        const { emitted, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "oh " } });
        expect(reports(emitted)).toEqual([
          { highlights: [{ id: "one", from: 9, to: 14 }] },
        ]);
      });

      it("stamps a report with the field's epoch and the version its pending edits reach", () => {
        const { emitted, edit } = standIn("hello world", [ONE], {
          collaboration: true,
        });
        edit({ changes: { from: 0, insert: "a" } });
        edit({ changes: { from: 0, insert: "b" } });
        expect(reports(emitted)).toEqual([
          {
            highlights: [{ id: "one", from: 7, to: 12 }],
            version: { epoch: 2, version: 8 },
          },
          {
            highlights: [{ id: "one", from: 8, to: 13 }],
            version: { epoch: 2, version: 9 },
          },
        ]);
      });

      it("reports nothing for a local edit that leaves the ranges on the host's value", () => {
        const { emitted, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 11, insert: "!" } });
        expect(reports(emitted)).toEqual([]);
      });

      it("reports an edit undone before the host answered, against the outstanding report", () => {
        const { emitted, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "a" } });
        edit({ changes: { from: 0, to: 1 } });
        expect(reports(emitted)).toEqual([
          { highlights: [{ id: "one", from: 7, to: 12 }] },
          { highlights: [{ id: "one", from: 6, to: 11 }] },
        ]);
      });

      it("reports a collaborator's edit only while a report of its own is outstanding", () => {
        const { emitted, edit, held } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "b" } }, { remote: true });
        expect(held()).toEqual([{ id: "one", from: 7, to: 12 }]);
        expect(reports(emitted)).toEqual([]);
        edit({ changes: { from: 0, insert: "a" } });
        edit({ changes: { from: 0, insert: "c" } }, { remote: true });
        expect(reports(emitted)).toEqual([
          { highlights: [{ id: "one", from: 8, to: 13 }] },
          { highlights: [{ id: "one", from: 9, to: 14 }] },
        ]);
      });

      it("sets the host's ranges again after a replacement of the whole document from outside", () => {
        const { self, emitted, edit, held } = standIn("", [ONE]);
        expect(held()).toEqual([]);
        self._unmatchedHighlightReport = [{ id: "one", from: 0, to: 0 }];
        edit({ changes: { from: 0, insert: "hello world" } }, { remote: true });
        expect(held()).toEqual([ONE]);
        expect(self._unmatchedHighlightReport).toBeUndefined();
        expect(reports(emitted)).toEqual([]);
      });
    });

    describe("_pushHighlights()", () => {
      it("leaves a value equal to the ranges the view holds alone, and clears the outstanding report", () => {
        const { self, held, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "a" } });
        self.highlights = [{ id: "one", from: 7, to: 12 }];
        self._pushHighlights();
        expect(held()).toEqual([{ id: "one", from: 7, to: 12 }]);
        expect(self._unmatchedHighlightReport).toBeUndefined();
      });

      it("takes a value behind the outstanding report for its ids and kinds, over the view's positions", () => {
        const { self, held, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "a" } });
        edit({ changes: { from: 0, insert: "b" } });
        self.highlights = [
          { id: "one", from: 7, to: 12, kind: "selected" },
          { id: "two", from: 0, to: 1 },
        ];
        self._pushHighlights();
        expect(held()).toEqual([
          { id: "one", from: 8, to: 13, kind: "selected" },
          { id: "two", from: 0, to: 1 },
        ]);
        expect(self._unmatchedHighlightReport).toEqual([
          { id: "one", from: 8, to: 13 },
        ]);
      });

      it("dispatches nothing for a value behind the report that names the view's ranges as they are", () => {
        const { self, held, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "a" } });
        edit({ changes: { from: 0, insert: "b" } });
        const before = held();
        self.highlights = [{ id: "one", from: 7, to: 12 }];
        self._pushHighlights();
        expect(held()).toBe(before);
      });

      it("sets a value that agrees with the outstanding report as given, and from then on every value", () => {
        const { self, held, edit } = standIn("hello world", [ONE]);
        edit({ changes: { from: 0, insert: "a" } });
        self.highlights = [{ id: "one", from: 7, to: 12, kind: "selected" }];
        self._pushHighlights();
        expect(self._unmatchedHighlightReport).toBeUndefined();
        expect(held()).toEqual([
          { id: "one", from: 7, to: 12, kind: "selected" },
        ]);
        self.highlights = [{ id: "one", from: 0, to: 5 }];
        self._pushHighlights();
        expect(held()).toEqual([{ id: "one", from: 0, to: 5 }]);
      });
    });

    describe("_reportSelection()", () => {
      it("emits the main selection with its text once, and a collapse once more", () => {
        const { self, emitted } = standIn("hello world", []);
        const view = self._editorView;
        view.dispatch({ selection: { anchor: 6, head: 11 } });
        self._reportSelection(view.state);
        self._reportSelection(view.state);
        view.dispatch({ selection: { anchor: 3 } });
        self._reportSelection(view.state);
        view.dispatch({ selection: { anchor: 4 } });
        self._reportSelection(view.state);
        expect(emitted).toEqual([
          {
            name: "cf-selection-change",
            detail: { from: 6, to: 11, text: "world" },
          },
          { name: "cf-selection-change", detail: { from: 3, to: 3, text: "" } },
        ]);
      });
    });

    describe("_documentVersion()", () => {
      it("returns undefined outside collaboration", () => {
        const { self } = standIn("hello world", []);
        expect(self._documentVersion(self._editorView.state)).toBeUndefined();
      });

      it("returns the confirmed epoch with the version this editor's pending edits reach", () => {
        const { self } = standIn("hello world", [], { collaboration: true });
        const view = self._editorView;
        expect(self._documentVersion(view.state)).toEqual({
          epoch: 2,
          version: 7,
        });
        view.dispatch({ changes: { from: 0, insert: "a" } });
        expect(self._documentVersion(view.state)).toEqual({
          epoch: 2,
          version: 8,
        });
      });
    });
  });
});
