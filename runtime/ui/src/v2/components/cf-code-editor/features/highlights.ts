/**
 * Ranges a host marks in the document, kept on the text they were placed
 * over while the text changes. The host names each range by an `id` of its
 * own and replaces the whole set at once. Between replacements the field maps
 * every range through each transaction, so an edit before or inside a range
 * moves or resizes it and an edit that empties it drops it. Nothing here
 * knows what a range means: a comment, a search hit, a suggestion are all the
 * host's business, and the host reads the mapped set back through
 * `highlightsOf()`.
 */

import {
  type ChangeDesc,
  type EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/** A range a host marks, in the coordinates of the document it was given. */
export interface HighlightRange {
  /**
   * The host's name for the range, which the rendered mark carries as its
   * `data-highlight-id` attribute.
   */
  id: string;

  /** Start of the range. */
  from: number;

  /** End of the range, exclusive and greater than `from`. */
  to: number;

  /**
   * A variant of the mark, rendered as the class `cm-highlight-<kind>`
   * beside `cm-highlight`.
   */
  kind?: string;
}

/**
 * Replaces the set with the ranges given, read in the coordinates of the
 * document the transaction produces. A range reaching past the document is
 * clamped to it, and one left empty by that is dropped.
 */
export const setHighlightsEffect = StateEffect.define<
  readonly HighlightRange[]
>();

/** Removes every range. */
export const clearHighlightsEffect = StateEffect.define<null>();

/** What the field holds: the ranges, and the marks that draw them. */
interface HighlightState {
  readonly ranges: readonly HighlightRange[];
  readonly decorations: DecorationSet;
}

/** The range after `changes`, or `undefined` once the edits leave it empty. */
function mapRange(
  range: HighlightRange,
  changes: ChangeDesc,
): HighlightRange | undefined {
  // Text inserted at either end stays outside the range: the start is
  // associated with the character after it and the end with the character
  // before it, which is how a mark decoration maps as well.
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  if (to <= from) return undefined;
  return from === range.from && to === range.to
    ? range
    : { ...range, from, to };
}

/** `ranges` after `changes`, without those the edits leave empty. */
export function mapHighlights(
  ranges: readonly HighlightRange[],
  changes: ChangeDesc,
): readonly HighlightRange[] {
  if (changes.empty || ranges.length === 0) return ranges;
  const mapped: HighlightRange[] = [];
  for (const range of ranges) {
    const next = mapRange(range, changes);
    if (next !== undefined) mapped.push(next);
  }
  return mapped;
}

/** `ranges` clamped to a document of `length`, without the empty ones. */
function clampRanges(
  ranges: readonly HighlightRange[],
  length: number,
): readonly HighlightRange[] {
  const clamped: HighlightRange[] = [];
  for (const range of ranges) {
    const from = Math.max(0, Math.min(range.from, length));
    const to = Math.max(0, Math.min(range.to, length));
    if (to <= from) continue;
    clamped.push(
      from === range.from && to === range.to
        ? { ...range }
        : { ...range, from, to },
    );
  }
  return clamped;
}

/** The marks drawing `ranges`, sorted as `Decoration.set` requires. */
function decorationsOf(ranges: readonly HighlightRange[]): DecorationSet {
  return Decoration.set(
    ranges.map((range) =>
      Decoration.mark({
        class: range.kind === undefined
          ? "cm-highlight"
          : `cm-highlight cm-highlight-${range.kind}`,
        attributes: { "data-highlight-id": range.id },
      }).range(range.from, range.to)
    ),
    true,
  );
}

/**
 * The field holding the ranges and the decorations drawing them. Every
 * transaction maps the ranges through its changes first, then applies its
 * effects, so a set effect's ranges are read against the new document.
 */
export const highlightField = StateField.define<HighlightState>({
  create: () => ({ ranges: [], decorations: Decoration.none }),
  update: (value, transaction) => {
    let ranges = mapHighlights(value.ranges, transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setHighlightsEffect)) {
        ranges = clampRanges(effect.value, transaction.newDoc.length);
      } else if (effect.is(clearHighlightsEffect)) {
        ranges = [];
      }
    }
    if (ranges === value.ranges) return value;
    return { ranges, decorations: decorationsOf(ranges) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * The ranges `state` holds, in its document's coordinates; none for a state
 * configured without the field.
 */
export function highlightsOf(state: EditorState): readonly HighlightRange[] {
  return state.field(highlightField, false)?.ranges ?? [];
}

/** Whether two lists hold the same ranges, in the same order. */
export function sameHighlights(
  a: readonly HighlightRange[],
  b: readonly HighlightRange[],
): boolean {
  return a.length === b.length && a.every((range, index) => {
    const other = b[index];
    return range.id === other.id && range.from === other.from &&
      range.to === other.to && range.kind === other.kind;
  });
}

/**
 * How a mark looks: a translucent wash over the text, and a stronger one for
 * the `selected` kind. A host that needs other kinds styles their classes
 * itself.
 */
export const highlightTheme = EditorView.baseTheme({
  ".cm-highlight": {
    backgroundColor:
      "color-mix(in srgb, var(--cf-theme-color-warning, #f5c400) 28%, transparent)",
    borderRadius: "2px",
  },
  ".cm-highlight-selected": {
    backgroundColor:
      "color-mix(in srgb, var(--cf-theme-color-warning, #f5c400) 60%, transparent)",
    boxShadow: "0 1px 0 var(--cf-theme-color-warning, #f5c400)",
  },
});
