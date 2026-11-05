/**
 * Draws a host's highlights over the anchors of a collaborative field, and
 * reports the main selection as a range of the text Memory has confirmed. A
 * highlight is the text from one anchor to another. Memory states where each
 * anchor is, and between its statements the editor carries every anchor
 * through its own edits by Memory's rule, so nothing here chooses an anchor's
 * position. `../docs/highlights.md` describes the whole arrangement.
 */

import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { FieldAnchors } from "@commonfabric/runtime-client";

import {
  type CodeMirrorSynchronizationSnapshot,
  mapFieldAnchors,
} from "../codemirror-collaboration.ts";
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
   * Adds the class `cm-highlight-<kind>` to the mark. Only lowercase letters,
   * digits and hyphens are used; anything else is ignored.
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

const highlightTheme = EditorView.baseTheme({
  ".cm-highlight": {
    backgroundColor:
      "var(--cf-code-editor-highlight, hsla(45, 100%, 50%, 0.25))",
    borderBottom: "2px solid var(--cf-code-editor-highlight-edge, " +
      "hsla(45, 100%, 40%, 0.7))",
    cursor: "pointer",
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
      if (found === undefined || to - from < found.to - found.from) {
        found = { id: value.spec.attributes["data-highlight-id"], from, to };
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
 * own, text a widget stands in for, is taken as under the point; a line
 * break, which draws nothing, is not.
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
    return view.state.sliceDoc(at, at + 1) === "\n" ? undefined : at;
  }
  return point.x >= box.left && point.x <= box.right ? at : undefined;
}

/**
 * Draws the host's highlights and calls `onClick` with the id of the
 * innermost highlight drawn over the character under a click: a press and
 * release of the primary button that leaves nothing selected. A press that
 * drags out a selection, or extends one, is a selection and not a click,
 * wherever it starts. The press itself is left to place the caret as usual,
 * and the click is read once the editor has made of it what it will.
 */
export function highlights(onClick: (id: string) => void): Extension {
  return [
    highlightField,
    highlightTheme,
    EditorView.domEventHandlers({
      click(event, view) {
        if (event.button !== 0 || !view.state.selection.main.empty) {
          return false;
        }
        const at = characterAt(view, { x: event.clientX, y: event.clientY });
        const id = at === undefined ? undefined : highlightAt(view.state, at);
        if (id !== undefined) onClick(id);
        return false;
      },
    }),
  ];
}

/**
 * The detail of `cf-selection-change`: the main selection as a range of the
 * text Memory has confirmed to this editor, with the text that range holds.
 * For a field with no collaborative edit that text is the field's stored
 * value. Outside collaboration the range is of the editor's own document.
 */
export interface SelectionReport {
  /** Start of the range, in UTF-16 code units. */
  from: number;

  /** End of the range, exclusive. */
  to: number;

  /** The text the range holds. */
  text: string;
}

/** The report of an empty selection, or of one no confirmed range states. */
export const NOTHING_SELECTED: Readonly<SelectionReport> = Object.freeze({
  from: 0,
  to: 0,
  text: "",
});

/** Whether `a` and `b` report the same range holding the same text. */
export const sameSelection = (
  a: SelectionReport,
  b: SelectionReport,
): boolean => a.from === b.from && a.to === b.to && a.text === b.text;

/**
 * Restates the main selection against the confirmed document. A selection
 * that covers an edit Memory has not yet confirmed has no such range, and
 * reports as nothing selected until Memory confirms the edit.
 */
export function selectionReport(
  state: EditorState,
  synchronization: CodeMirrorSynchronizationSnapshot | null,
): SelectionReport {
  const { from, to } = state.selection.main;
  if (from === to) return NOTHING_SELECTED;
  const text = state.sliceDoc(from, to);
  if (synchronization === null) return { from, to, text };
  const pending = composePendingChangeDesc(synchronization.pendingChanges);
  if (pending === undefined) return { from, to, text };
  if (pending.newLength !== state.doc.length) return NOTHING_SELECTED;
  const confirmedFrom = pending.invertedDesc.mapPos(from, 1);
  const confirmedTo = pending.invertedDesc.mapPos(to, -1);
  let touched = pending.mapPos(confirmedFrom, 1) !== from ||
    pending.mapPos(confirmedTo, -1) !== to;
  pending.iterChangedRanges((changeFrom, changeTo) => {
    if (changeFrom < confirmedTo && changeTo > confirmedFrom) touched = true;
  });
  return touched || confirmedFrom >= confirmedTo
    ? NOTHING_SELECTED
    : { from: confirmedFrom, to: confirmedTo, text };
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
