import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { mapAnchorRange, type OpCursor } from "@commonfabric/runtime-client";
import type { CodeMirrorSynchronizationSnapshot } from "../codemirror-collaboration.ts";
import { composePendingChangeDesc } from "../codemirror-presence.ts";

/** A field anchor the host asks the editor to draw, by the anchor's id. */
export interface EditorHighlight {
  id: string;

  /**
   * Adds the class `cm-highlight-<kind>` to the mark. Only lowercase letters,
   * digits and hyphens are used; anything else is ignored.
   */
  kind?: string;
}

/** An anchor's range in the editor's own document. */
export interface HighlightRange {
  id: string;
  from: number;
  to: number;
}

type HighlightState = {
  ranges: readonly HighlightRange[];
  highlights: readonly EditorHighlight[];
  decorations: DecorationSet;
};

/** Restates every anchor's range against the current document. */
export const setHighlightRangesEffect = StateEffect.define<
  readonly HighlightRange[]
>();

/** Replaces the set of anchors the host asks the editor to draw. */
export const setHighlightsEffect = StateEffect.define<
  readonly EditorHighlight[]
>();

const KIND = /^[a-z0-9-]+$/;

const decorationsOf = (
  ranges: readonly HighlightRange[],
  highlights: readonly EditorHighlight[],
  length: number,
): DecorationSet => {
  const byId = new Map(ranges.map((range) => [range.id, range]));
  const marks = [];
  for (const { id, kind } of highlights) {
    const range = byId.get(id);
    if (
      range === undefined || range.from >= range.to || range.from < 0 ||
      range.to > length
    ) {
      continue;
    }
    const kindClass = kind !== undefined && KIND.test(kind)
      ? ` cm-highlight-${kind}`
      : "";
    marks.push(
      Decoration.mark({
        class: `cm-highlight${kindClass}`,
        attributes: { "data-highlight-id": id },
      }).range(range.from, range.to),
    );
  }
  return Decoration.set(marks, true);
};

/**
 * Holds every anchor's range in the editor's document, follows each edit with
 * Memory's anchor rule until the host restates the ranges, and draws the
 * anchors the host names. An empty range is held and drawn as nothing.
 */
export const highlightField = StateField.define<HighlightState>({
  create: () => ({
    ranges: [],
    highlights: [],
    decorations: Decoration.none,
  }),
  update(value, transaction) {
    let ranges = transaction.docChanged
      ? value.ranges.map((range) => mapAnchorRange(range, transaction.changes))
      : value.ranges;
    let highlights = value.highlights;
    for (const effect of transaction.effects) {
      if (effect.is(setHighlightRangesEffect)) ranges = effect.value;
      if (effect.is(setHighlightsEffect)) highlights = effect.value;
    }
    if (ranges === value.ranges && highlights === value.highlights) {
      return value;
    }
    return {
      ranges,
      highlights,
      decorations: decorationsOf(
        ranges,
        highlights,
        transaction.newDoc.length,
      ),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

/** The anchor ranges the editor holds, in its own document. */
export const highlightRanges = (
  state: EditorState,
): readonly HighlightRange[] =>
  state.field(highlightField, false)?.ranges ?? [];

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
 * Draws the host's highlights and calls `onClick` with the id of the
 * innermost highlight under a primary-button press, leaving the press to
 * place the caret as usual.
 */
export function highlights(onClick: (id: string) => void): Extension {
  return [
    highlightField,
    highlightTheme,
    EditorView.domEventHandlers({
      mousedown(event) {
        if (event.button !== 0 || !(event.target instanceof Element)) {
          return false;
        }
        const id = event.target.closest("[data-highlight-id]")?.getAttribute(
          "data-highlight-id",
        );
        if (id) onClick(id);
        return false;
      },
    }),
  ];
}

/**
 * The detail of `cf-selection-change`: the main selection as a range of the
 * text at `base`, the field version Memory has confirmed, with the text it
 * covers. `base` is `null` when the editor has no confirmed version, outside
 * collaboration or before the field's first collaborative edit; the range is
 * then stated against the editor's own document.
 */
export interface SelectionReport {
  from: number;
  to: number;
  text: string;
  base: OpCursor | null;
}

/** The report of an empty selection, or of one no confirmed range states. */
export const NOTHING_SELECTED: SelectionReport = {
  from: 0,
  to: 0,
  text: "",
  base: null,
};

/**
 * How many versions a reported selection's `base` may fall behind the
 * confirmed version before the editor restates the selection. Memory keeps at
 * least its operation checkpoint interval of history, 100 operations by
 * default, and a base it no longer holds refuses the anchor added against it.
 */
export const RESTATE_AFTER_VERSIONS = 32;

/** Whether `a` and `b` report the same range at the same version. */
export const sameSelection = (
  a: SelectionReport,
  b: SelectionReport,
): boolean =>
  a.from === b.from && a.to === b.to && a.text === b.text &&
  a.base?.epoch === b.base?.epoch && a.base?.version === b.base?.version;

/**
 * Whether `report`, a selection reported before `confirmed` was the confirmed
 * version, should be stated again against it: it names no version, as one
 * made before collaboration began does, or a version far enough behind.
 */
export const needsRestating = (
  report: SelectionReport,
  confirmed: OpCursor,
): boolean =>
  report.from !== report.to &&
  (report.base === null || report.base.epoch !== confirmed.epoch ||
    confirmed.version - report.base.version >= RESTATE_AFTER_VERSIONS);

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
  if (synchronization === null) {
    return { from, to, text, base: null };
  }
  const base = { ...synchronization.confirmedCursor };
  const pending = composePendingChangeDesc(synchronization.pendingChanges);
  if (pending === undefined) return { from, to, text, base };
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
    : { from: confirmedFrom, to: confirmedTo, text, base };
}

/**
 * Restates the confirmed document's anchors against the editor's document,
 * over the edits Memory has not yet confirmed, or returns `undefined` when the
 * pending edits do not end at the editor's document.
 */
export function localAnchorRanges(
  state: EditorState,
  synchronization: CodeMirrorSynchronizationSnapshot,
): HighlightRange[] | undefined {
  const pending = composePendingChangeDesc(synchronization.pendingChanges);
  if (pending === undefined) {
    return synchronization.anchors.map(({ id, from, to }) => ({
      id,
      from,
      to,
    }));
  }
  if (pending.newLength !== state.doc.length) return undefined;
  return synchronization.anchors.map(({ id, from, to }) =>
    mapAnchorRange({ id, from, to }, pending)
  );
}
