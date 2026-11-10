/**
 * Draws a host's highlights over the anchors of a collaborative field, and
 * reports the main selection as a range of the editor's document. A
 * highlight is the text from one anchor to another. Memory states where each
 * anchor is, and between its statements the editor carries every anchor
 * through its own edits by Memory's rule, so nothing here chooses an anchor's
 * position. `../docs/highlights.md` describes the whole arrangement.
 */

import {
  EditorSelection,
  type EditorState,
  type Extension,
  type SelectionRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { debugStr } from "@commonfabric/data-model";
import {
  type FieldAnchors,
  mapFieldAnchors,
} from "@commonfabric/runtime-client";

import type { CodeMirrorSynchronizationSnapshot } from "../codemirror-collaboration.ts";
import { composePendingChangeDesc } from "../codemirror-presence.ts";

/**
 * A highlight the host asks the editor to draw: the text from one anchor of
 * the field to another.
 */
export interface EditorHighlight {
  /**
   * Identifies the highlight to the host. The mark carries it as
   * `data-highlight-id`, and `cf-highlight-click` reports it.
   */
  id: string;

  /** Id of the anchor the highlight starts at. */
  fromAnchor: string;

  /** Id of the anchor the highlight ends at, exclusive. */
  toAnchor: string;

  /**
   * Adds the class `cm-highlight-<kind>` to the mark. A kind made of anything
   * but lowercase letters, digits and hyphens is reported through
   * `cf-error`, and the mark is drawn without it.
   */
  kind?: string;
}

/** What {@link highlightField} holds. */
type HighlightState = {
  /** The field's anchors, as offsets in the editor's own document. */
  anchors: FieldAnchors;

  /** The highlights the host asks for. */
  highlights: readonly EditorHighlight[];

  /** The marks `highlights` draw over `anchors`. */
  decorations: DecorationSet;
};

/** Restates every anchor's offset against the current document. */
export const setHighlightAnchorsEffect = StateEffect.define<FieldAnchors>();

/** Replaces the highlights the host asks the editor to draw. */
export const setHighlightsEffect = StateEffect.define<
  readonly EditorHighlight[]
>();

/** What a highlight's `kind` holds when it can be part of a class name. */
const KIND = /^[a-z0-9-]+$/;

/**
 * Helper for `decorationsOf()`, which returns the offset `anchors` holds
 * under `id`, brought within a document of `length` code units, or
 * `undefined` when it holds no such anchor.
 */
const offsetOf = (
  anchors: FieldAnchors,
  id: string,
  length: number,
): number | undefined =>
  Object.hasOwn(anchors, id) ? Math.min(anchors[id], length) : undefined;

/**
 * Helper for {@link highlightField}, which builds the marks `highlights` draw
 * in a document of `length` code units. A highlight draws nothing when
 * `anchors` lacks either of its anchors, or when its end is not after its
 * start.
 */
const decorationsOf = (
  anchors: FieldAnchors,
  highlights: readonly EditorHighlight[],
  length: number,
): DecorationSet => {
  const marks = [];
  for (const { id, fromAnchor, toAnchor, kind } of highlights) {
    const from = offsetOf(anchors, fromAnchor, length);
    const to = offsetOf(anchors, toAnchor, length);
    if (from === undefined || to === undefined || to <= from) continue;
    const kindClass = kind !== undefined && KIND.test(kind)
      ? ` cm-highlight-${kind}`
      : "";
    marks.push(
      Decoration.mark({
        class: `cm-highlight${kindClass}`,
        attributes: { "data-highlight-id": id },
      }).range(from, to),
    );
  }
  return Decoration.set(marks, true);
};

/**
 * Holds every anchor's offset in the editor's document, moves each through
 * every edit by Memory's rule until the host restates them, and draws the
 * host's highlights between them. The two anchors of a highlight move
 * independently, so text inserted at its start joins it and text inserted at
 * its end does not.
 */
export const highlightField = StateField.define<HighlightState>({
  create: () => ({
    anchors: {},
    highlights: [],
    decorations: Decoration.none,
  }),
  update(value, transaction) {
    let anchors = transaction.docChanged
      ? mapFieldAnchors(value.anchors, transaction.changes)
      : value.anchors;
    let highlights = value.highlights;
    for (const effect of transaction.effects) {
      if (effect.is(setHighlightAnchorsEffect)) anchors = effect.value;
      if (effect.is(setHighlightsEffect)) highlights = effect.value;
    }
    if (anchors === value.anchors && highlights === value.highlights) {
      return value;
    }
    return {
      anchors,
      highlights,
      decorations: decorationsOf(
        anchors,
        highlights,
        transaction.newDoc.length,
      ),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

/** The anchors the editor holds, as offsets in its own document. */
export const highlightAnchors = (state: EditorState): FieldAnchors =>
  state.field(highlightField, false)?.anchors ?? {};

/**
 * What is wrong with the highlights `state` holds, one message each: a
 * highlight whose `kind` cannot be part of a class name, which is drawn
 * without one, and a highlight whose end anchor lies before its start
 * anchor, which is drawn as nothing. A highlight missing an anchor, or whose
 * two anchors are at one offset, is not wrong: the first is text not yet
 * anchored or anchors since removed, and the second text an edit deleted.
 * Edits move both anchors of a pair by one rule and never put the end before
 * the start, so such a pair comes from what the host wrote.
 */
export function highlightFaults(state: EditorState): string[] {
  const field = state.field(highlightField, false);
  if (field === undefined) return [];
  const length = state.doc.length;
  const faults: string[] = [];
  for (const { id, fromAnchor, toAnchor, kind } of field.highlights) {
    if (kind !== undefined && !KIND.test(kind)) {
      faults.push(
        debugStr`The highlight $quote${id} has the kind $quote${kind}, ` +
          "which is not made of lowercase letters, digits and hyphens; it " +
          "is drawn without one.",
      );
    }
    const from = offsetOf(field.anchors, fromAnchor, length);
    const to = offsetOf(field.anchors, toAnchor, length);
    if (from !== undefined && to !== undefined && to < from) {
      faults.push(
        debugStr`The highlight $quote${id} ends at the anchor ` +
          debugStr`$quote${toAnchor}, before the anchor $quote${fromAnchor} ` +
          "it starts at; it is drawn as nothing.",
      );
    }
  }
  return faults;
}

const highlightTheme = EditorView.baseTheme({
  ".cm-highlight": {
    backgroundColor:
      "var(--cf-code-editor-highlight, hsla(45, 100%, 50%, 0.25))",
    borderBottom: "2px solid var(--cf-code-editor-highlight-edge, " +
      "hsla(45, 100%, 40%, 0.7))",
  },
  ".cm-highlight-active": {
    backgroundColor:
      "var(--cf-code-editor-highlight-active, hsla(45, 100%, 50%, 0.5))",
  },
});

/**
 * The id of the innermost highlight the editor draws over the character at
 * offset `at`: the shortest drawn range that holds it, the earlier-starting
 * of two the same length.
 */
export function highlightAt(
  state: EditorState,
  at: number,
): string | undefined {
  let found: { id: string; from: number; to: number } | undefined;
  state.field(highlightField, false)?.decorations.between(
    at,
    at,
    (from, to, value) => {
      if (from > at || to <= at) return;
      // A mark's spec is CodeMirror's `any`; every mark this field draws
      // carries its highlight's id as a string.
      const id: unknown = value.spec.attributes?.["data-highlight-id"];
      if (typeof id !== "string") return;
      if (found === undefined || to - from < found.to - found.from) {
        found = { id, from, to };
      }
    },
  );
  return found?.id;
}

/**
 * What {@link characterAt} reads from an editor view, each member as
 * `EditorView` declares it.
 */
export interface CharacterGeometry {
  /** The editor's state, for its document. */
  readonly state: EditorState;

  /** Top of the document's first line, in screen coordinates. */
  readonly documentTop: number;

  /**
   * Resolves a point in screen coordinates to the nearest position and the
   * side of it the point is on, or to `null` for a point over text the editor
   * has not drawn.
   */
  posAndSideAtCoords(
    point: { x: number; y: number },
  ): { pos: number; assoc: -1 | 1 } | null;

  /**
   * Returns the vertical extent of the line holding `pos`, measured from
   * `documentTop`.
   */
  lineBlockAt(pos: number): { readonly top: number; readonly bottom: number };

  /**
   * Returns the horizontal extent, in screen coordinates, of the character
   * after `pos`, or `null` when that character has no box of its own.
   */
  coordsForChar(
    pos: number,
  ): { readonly left: number; readonly right: number } | null;

  /**
   * Returns the box, in screen coordinates, of the caret at `pos` on the
   * `side` of it given, or `null` when the editor has not drawn `pos`.
   */
  coordsAtPos(pos: number, side?: -1 | 1): { readonly right: number } | null;

  /**
   * Moves `start` to the start of its line, or with `forward` to the end;
   * with `includeWrap`, to the start or end of the row of a wrapped line it
   * is drawn on.
   */
  moveToLineBoundary(
    start: SelectionRange,
    forward: boolean,
    includeWrap?: boolean,
  ): SelectionRange;
}

/**
 * The offset of the character drawn under `point`, in screen coordinates, or
 * `undefined` when the point is on none.
 *
 * CodeMirror resolves a point to the nearest position and the side of it the
 * point is on: the position after a character for a point on that
 * character's right half, the position before it for one on its left half.
 * It resolves a point beside the text the same way, past a line's end or
 * outside the document's lines, so the character it names is checked against
 * the point: the point lies within the character's line vertically and
 * within the character's box horizontally. A character with no box of its
 * own, text a widget stands in for, is taken as under the point unless the
 * point lies past the end of the row the widget is drawn on, one of several
 * on a wrapped line; a line break, which draws nothing, is not.
 */
export function characterAt(
  view: CharacterGeometry,
  point: { x: number; y: number },
): number | undefined {
  const found = view.posAndSideAtCoords(point);
  if (found === null) return undefined;
  const at = found.assoc < 0 ? found.pos - 1 : found.pos;
  if (at < 0 || at >= view.state.doc.length) return undefined;
  const line = view.lineBlockAt(at);
  if (
    point.y < view.documentTop + line.top ||
    point.y > view.documentTop + line.bottom
  ) {
    return undefined;
  }
  const box = view.coordsForChar(at);
  if (box === null) {
    if (view.state.sliceDoc(at, at + 1) === "\n") return undefined;
    // CodeMirror resolves a point to the right of a widget that ends a row
    // to the widget, so such a point is checked against the end of the
    // widget's row. Of a wrapped line's rows, only the last ends where the
    // line does.
    const row = view.moveToLineBoundary(EditorSelection.cursor(at), true, true);
    const end = view.coordsAtPos(row.head, -1);
    return end !== null && point.x > end.right ? undefined : at;
  }
  return point.x >= box.left && point.x <= box.right ? at : undefined;
}

/** What {@link highlightClickHandler} reads of a `click` event. */
export interface HighlightClick {
  /** The button the click was made with; `0` is the primary one. */
  readonly button: number;

  /** Horizontal position of the pointer, in screen coordinates. */
  readonly clientX: number;

  /** Vertical position of the pointer, in screen coordinates. */
  readonly clientY: number;
}

/**
 * Returns the editor's handler for a `click` event, which calls `onClick`
 * with the id of the innermost highlight drawn over the character under the
 * click. A click is a press and release of the primary button that leaves
 * nothing selected in any of the editor's selection ranges: a press that
 * drags out a selection, or extends one, is a selection and not a click,
 * wherever it starts. The handler returns `false` for every event, which
 * leaves the editor to handle it as usual.
 */
export function highlightClickHandler(
  onClick: (id: string) => void,
): (click: HighlightClick, view: CharacterGeometry) => boolean {
  return (click, view) => {
    if (
      click.button !== 0 ||
      view.state.selection.ranges.some((range) => !range.empty)
    ) {
      return false;
    }
    const at = characterAt(view, { x: click.clientX, y: click.clientY });
    const id = at === undefined ? undefined : highlightAt(view.state, at);
    if (id !== undefined) onClick(id);
    return false;
  };
}

/**
 * Draws the host's highlights and reports a click on one to `onClick`, as
 * {@link highlightClickHandler} decides. The press itself is left to place
 * the caret, and the click is read once the editor has made of the press
 * what it will.
 */
export function highlights(onClick: (id: string) => void): Extension {
  return [
    highlightField,
    highlightTheme,
    EditorView.domEventHandlers({ click: highlightClickHandler(onClick) }),
  ];
}

/**
 * The detail of `cf-selection-change`: the main selection as a range of the
 * editor's document, the text that range holds, and the whole document. The
 * range is right for a field exactly when the field holds `value`, so a host
 * that anchors it checks that first: the field may hold other text by the
 * time the host's handler runs, edits that have reached it and not yet the
 * editor, or edits the editor has made that have not yet reached it.
 */
export interface SelectionReport {
  /** Start of the range, in UTF-16 code units. */
  from: number;

  /** End of the range, exclusive. */
  to: number;

  /** The text the range holds. */
  text: string;

  /**
   * The editor's document, which `from` and `to` are offsets into; empty
   * when nothing is selected.
   */
  value: string;
}

/** The report of an empty selection. */
export const NOTHING_SELECTED: Readonly<SelectionReport> = Object.freeze({
  from: 0,
  to: 0,
  text: "",
  value: "",
});

/** Whether `a` and `b` report the same range of the same document. */
export const sameSelection = (
  a: SelectionReport,
  b: SelectionReport,
): boolean => a.from === b.from && a.to === b.to && a.value === b.value;

/**
 * Reports the main selection of `state` against its document. Every empty
 * selection reports as {@link NOTHING_SELECTED}.
 */
export function selectionReport(state: EditorState): SelectionReport {
  const { from, to } = state.selection.main;
  if (from === to) return NOTHING_SELECTED;
  return {
    from,
    to,
    text: state.sliceDoc(from, to),
    value: state.doc.toString(),
  };
}

/**
 * Restates the confirmed document's anchors against the editor's document,
 * over the edits Memory has not yet confirmed, or returns `undefined` when the
 * pending edits do not end at the editor's document.
 */
export function localAnchors(
  state: EditorState,
  synchronization: CodeMirrorSynchronizationSnapshot,
): FieldAnchors | undefined {
  const pending = composePendingChangeDesc(synchronization.pendingChanges);
  if (pending === undefined) return synchronization.anchors;
  if (pending.newLength !== state.doc.length) return undefined;
  return mapFieldAnchors(synchronization.anchors, pending);
}
