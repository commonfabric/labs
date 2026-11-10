/**
 * Checks a mounted editor's highlights and selection reports: which clicks
 * report `cf-highlight-click`, what a new editor reports as selected, and
 * what a collaborative editor draws for a field nobody has typed in. Which
 * character a point on the screen is over is for the browser's layout to
 * say, so the click tests run in one, and each is aimed with the box the
 * editor measures for a character. A dispatched press and release produce no
 * click of their own, so each test dispatches the click a browser would
 * follow them with. The collaborative test runs the editor and its
 * collaboration controller together against a stand-in for Memory. The tests
 * register through `Deno.test`, as `deno-web-test` requires.
 */

import { expect } from "@std/expect";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  type ApplyOpResolution,
  CODEMIRROR_CHANGESET_CODEC,
  type FieldAnchors,
  type OperationFieldSnapshot,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { createMockCellHandle } from "../../../test-utils/mock-cell-handle.ts";
import { CFCodeEditor } from "../index.ts";
import {
  highlightAnchors,
  highlightField,
  setHighlightAnchorsEffect,
} from "./highlights.ts";

/** A mounted editor, and what a test does with it. */
interface Mounted {
  /** The editor's CodeMirror view. */
  view: EditorView;

  /** Ids `cf-highlight-click` has reported, in order. */
  clicks: string[];

  /** Removes the editor from the page. */
  done(): void;
}

/**
 * Mounts an editor holding "Hello world" and "second" on two lines, with one
 * highlight `h` drawn from the anchor `from` to the anchor `to` of `anchors`.
 */
async function mount(anchors: FieldAnchors): Promise<Mounted> {
  const editor = new CFCodeEditor();
  editor.value = "Hello world\nsecond";
  editor.highlights = [{ id: "h", fromAnchor: "from", toAnchor: "to" }];
  const clicks: string[] = [];
  editor.addEventListener("cf-highlight-click", (event) => {
    if (event instanceof CustomEvent) clicks.push(event.detail.id);
  });
  document.body.append(editor);
  await editor.updateComplete;
  const view = editor.editorView;
  if (view === undefined) throw new Error("The editor view is missing.");
  view.dispatch({ effects: setHighlightAnchorsEffect.of(anchors) });
  return { view, clicks, done: () => editor.remove() };
}

/** The box the editor draws the character after `pos` in. */
function boxOf(view: EditorView, pos: number) {
  const box = view.coordsForChar(pos);
  if (box === null) throw new Error(`No character is drawn after ${pos}.`);
  return box;
}

/** A point of the screen. */
interface Point {
  /** Distance from the left edge of the viewport. */
  x: number;

  /** Distance from the top edge of the viewport. */
  y: number;
}

/**
 * Dispatches the mouse event `type` on the editor's content at `point`, with
 * the primary button held when `held`.
 */
function mouse(
  view: EditorView,
  type: "mousedown" | "mousemove" | "mouseup" | "click",
  point: Point,
  held: boolean,
): void {
  view.contentDOM.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      button: 0,
      buttons: held ? 1 : 0,
      detail: 1,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}

/** Clicks the primary button at a point of the screen. */
function pressAt(view: EditorView, x: number, y: number): void {
  mouse(view, "mousedown", { x, y }, true);
  mouse(view, "mouseup", { x, y }, false);
  mouse(view, "click", { x, y }, false);
}

/**
 * The point `fraction` of the way across the box of the character after
 * `pos`, from the left, at half its height.
 */
function pointOn(view: EditorView, pos: number, fraction: number): Point {
  const box = boxOf(view, pos);
  return {
    x: box.left + (box.right - box.left) * fraction,
    y: (box.top + box.bottom) / 2,
  };
}

/**
 * Clicks on the character after `pos`, `fraction` of the way across its box
 * from the left.
 */
function pressOn(view: EditorView, pos: number, fraction: number): void {
  const { x, y } = pointOn(view, pos, fraction);
  pressAt(view, x, y);
}

Deno.test("a press that drags out a selection inside a highlight reports nothing", async () => {
  // The highlight covers "Hello"; the drag starts on its "e" and ends on its
  // second "l", so the press and the release are both on the mark.

  const { view, clicks, done } = await mount({ from: 0, to: 5 });
  try {
    const start = pointOn(view, 1, 0.25);
    const end = pointOn(view, 3, 0.75);
    mouse(view, "mousedown", start, true);
    mouse(view, "mousemove", end, true);
    mouse(view, "mouseup", end, false);
    mouse(view, "click", end, false);

    expect(view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    )).toBe("ell");
    expect(clicks).toEqual([]);

    // A click on the mark, inside that selection, then reports the
    // highlight.
    pressOn(view, 2, 0.25);
    expect(view.state.selection.main.empty).toBe(true);
    expect(clicks).toEqual(["h"]);
  } finally {
    done();
  }
});

Deno.test("a newly mounted editor reports that nothing is selected", async () => {
  const editor = new CFCodeEditor();
  editor.value = "Hello world";
  const reports: unknown[] = [];
  editor.addEventListener("cf-selection-change", (event) => {
    if (event instanceof CustomEvent) reports.push(event.detail);
  });
  document.body.append(editor);
  try {
    await editor.updateComplete;
    const view = editor.editorView;
    if (view === undefined) throw new Error("The editor view is missing.");
    expect(reports).toEqual([{ from: 0, to: 0, text: "", value: "" }]);

    // Moving the caret and typing say nothing more; a selection does.
    view.dispatch({ selection: { anchor: 3 } });
    view.dispatch({
      changes: { from: 3, insert: "!" },
      selection: { anchor: 4 },
    });
    expect(reports).toHaveLength(1);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(reports).toEqual([
      { from: 0, to: 0, text: "", value: "" },
      { from: 0, to: 5, text: "Hel!l", value: "Hel!lo world" },
    ]);
  } finally {
    editor.remove();
  }
});

Deno.test("a press on either half of a highlighted character reports the highlight", async () => {
  // The highlight covers the one character "e", so each half of it is also
  // an edge of the highlight.

  const { view, clicks, done } = await mount({ from: 1, to: 2 });
  try {
    pressOn(view, 1, 0.25);
    expect(clicks).toEqual(["h"]);

    pressOn(view, 1, 0.75);
    expect(clicks).toEqual(["h", "h"]);
  } finally {
    done();
  }
});

Deno.test("a press on a character beside a highlight reports nothing", async () => {
  const { view, clicks, done } = await mount({ from: 1, to: 2 });
  try {
    // The right half of "H", which ends where the highlight starts, and the
    // left half of the first "l", which starts where it ends.
    pressOn(view, 0, 0.75);
    pressOn(view, 2, 0.25);

    expect(clicks).toEqual([]);
  } finally {
    done();
  }
});

Deno.test("a press past the end of a line that ends in a highlight reports nothing", async () => {
  // The highlight covers "world", the end of the first line.

  const { view, clicks, done } = await mount({ from: 6, to: 11 });
  try {
    pressOn(view, 10, 0.75);
    expect(clicks).toEqual(["h"]);

    const last = boxOf(view, 10);
    pressAt(view, last.right + 40, (last.top + last.bottom) / 2);

    expect(clicks).toEqual(["h"]);
  } finally {
    done();
  }
});

/** A widget standing in for text, as a mention pill does. */
class PillWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const pill = document.createElement("span");
    pill.textContent = "[pill]";
    return pill;
  }
}

Deno.test("a press to the right of a widget that ends a highlighted line reports nothing", async () => {
  // The highlight covers "world", the end of the first line, and a widget
  // stands in for it.

  const { view, clicks, done } = await mount({ from: 6, to: 11 });
  try {
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        StateField.define({
          create: () =>
            Decoration.set([
              Decoration.replace({ widget: new PillWidget() }).range(6, 11),
            ]),
          update: (decorations) => decorations,
          provide: (field) => EditorView.decorations.from(field),
        }),
      ),
    });
    const pill = view.coordsAtPos(6, 1);
    const end = view.coordsAtPos(11, -1);
    if (pill === null || end === null) {
      throw new Error("The widget is not drawn.");
    }
    const middle = (pill.top + pill.bottom) / 2;

    pressAt(view, (pill.left + end.right) / 2, middle);
    expect(clicks).toEqual(["h"]);

    pressAt(view, end.right + 40, middle);
    expect(clicks).toEqual(["h"]);
  } finally {
    done();
  }
});

Deno.test("a press below the last line of a document that ends in a highlight reports nothing", async () => {
  // The highlight covers "second", the whole of the last line.

  const { view, clicks, done } = await mount({ from: 12, to: 18 });
  try {
    pressOn(view, 17, 0.75);
    expect(clicks).toEqual(["h"]);

    const last = boxOf(view, 17);
    pressAt(view, (last.left + last.right) / 2, last.bottom + 200);

    expect(clicks).toEqual(["h"]);
  } finally {
    done();
  }
});

/** The text `state` draws highlight marks over, one entry per mark. */
function markedText(state: EditorState): string[] {
  const marked: string[] = [];
  state.field(highlightField).decorations.between(
    0,
    state.doc.length,
    (from, to) => {
      marked.push(state.sliceDoc(from, to));
    },
  );
  return marked;
}

/** Resolves on the next transition into an editable CodeMirror state. */
function nextEditableState(view: EditorView): Promise<void> {
  const editable = Promise.withResolvers<void>();
  view.dispatch({
    effects: StateEffect.appendConfig.of(EditorView.updateListener.of(
      (update) => {
        if (
          update.startState.facet(EditorState.readOnly) &&
          !update.state.facet(EditorState.readOnly)
        ) editable.resolve();
      },
    )),
  });
  return editable.promise;
}

Deno.test("a highlight on a field nobody has typed in is drawn, and stays drawn while the first edit gives the field a version", async () => {
  // The field stores "abc", has no version, and holds anchors around "bc",
  // as it does once a pattern's handler has written them. The stand-in for
  // Memory then confirms the editor's first edit as version 1.

  const cell = createMockCellHandle("abc", { schema: { type: "string" } });
  const ref = cell.ref();
  const address = {
    branch: "",
    id: ref.id,
    scopeKey: "",
    path: ref.path as OperationFieldSnapshot["path"],
  };
  const applying = Promise.withResolvers<
    Parameters<RuntimeClient["applyOperation"]>[1]
  >();
  const applied = Promise.withResolvers<ApplyOpResolution>();
  // The editor joins its presence room once the field has a version, after
  // it has taken that version's anchors, so the join marks that moment.
  const joining = Promise.withResolvers<void>();
  let joins = 0;
  const runtime = {
    operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
    queryOperationField: (_cell: unknown, cursor: unknown) =>
      Promise.resolve(
        cursor === undefined
          ? {
            ...address,
            active: false,
            codec: null,
            cursor: null,
            baselineHash: "baseline",
            materialized: "abc",
            anchors: { from: 1, to: 3 },
            operations: [],
          }
          : {
            ...address,
            active: true,
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 1 },
            baselineHash: "baseline",
            materialized: "Xabc",
            anchors: { from: 2, to: 4 },
            operations: [],
          },
      ),
    subscribeOperationField: () => Promise.resolve(() => {}),
    applyOperation: (
      _cell: unknown,
      request: Parameters<RuntimeClient["applyOperation"]>[1],
    ) => {
      applying.resolve(request);
      return applied.promise;
    },
    joinPresenceRoom: () => {
      joins++;
      joining.resolve();
      return Promise.withResolvers<never>().promise;
    },
    closeOperationSession: () => Promise.resolve(),
  };
  Object.defineProperties(cell, {
    runtime: { value: () => runtime },
    resolveAsCell: { value: () => Promise.resolve(cell) },
  });
  const editor = new CFCodeEditor();
  editor.value = cell;
  editor.participantName = "Ada";
  editor.highlights = [{ id: "h", fromAnchor: "from", toAnchor: "to" }];
  const failed = Promise.withResolvers<never>();
  editor.addEventListener("cf-error", (event) => {
    if (event instanceof CustomEvent) failed.reject(event.detail.error);
  });
  document.body.append(editor);
  try {
    await editor.updateComplete;
    const view = editor.editorView;
    if (view === undefined) throw new Error("The editor view is missing.");
    const ready = nextEditableState(view);
    editor.collaborative = true;
    await Promise.race([ready, failed.promise]);

    expect(markedText(view.state)).toEqual(["bc"]);
    expect(
      editor.shadowRoot?.querySelector('[data-highlight-id="h"]')?.textContent,
    ).toBe("bc");
    expect(joins).toBe(0);

    // What the editor marks after every update from here on.
    const marked: string[][] = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          marked.push(markedText(update.state));
        }),
      ),
    });
    view.dispatch({ changes: { from: 0, insert: "X" } });
    const request = await Promise.race([applying.promise, failed.promise]);
    expect(highlightAnchors(view.state)).toEqual({ from: 2, to: 4 });
    expect(joins).toBe(0);

    applied.resolve({
      operationIndex: 0,
      address,
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId: request.submissionId,
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: [{
        opId: "op:1",
        cursor: { epoch: 1, version: 1 },
        submissionId: request.submissionId,
        payload: request.payload,
      }],
      duplicate: false,
    });
    await Promise.race([joining.promise, failed.promise]);

    expect(view.state.doc.toString()).toBe("Xabc");
    expect(highlightAnchors(view.state)).toEqual({ from: 2, to: 4 });
    expect(marked.length).toBeGreaterThan(0);
    expect(marked).toEqual(marked.map(() => ["bc"]));
    expect(
      editor.shadowRoot?.querySelector('[data-highlight-id="h"]')?.textContent,
    ).toBe("bc");
    expect(joins).toBe(1);
  } finally {
    editor.remove();
  }
});
