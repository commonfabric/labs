/**
 * Where a comment's anchor sits in the body: a range stated against one
 * version of the text, and the mapping that carries it through an edit. The
 * mapping is the one `cf-code-editor` applies to its highlights, so a verb
 * that edits the body and maps the anchors itself leaves them where an open
 * editor maps them too. These are pure functions over strings and ranges, so
 * the pattern's verbs, its handlers, and their tests share one definition.
 */

import type { TextChange } from "commonfabric";

/**
 * A range of the body, `from` inclusive and `to` exclusive. One with
 * `from === to` names text the body no longer holds.
 */
export interface AnchorRange {
  from: number;
  to: number;
}

/**
 * A version of the body, as the collaborative field numbers it: epochs in
 * order, and versions in order within an epoch.
 */
export interface AnchorVersion {
  epoch: number;
  version: number;
}

/**
 * Returns whether `candidate` names an earlier body than `held`: an earlier
 * epoch, or an earlier version of the same epoch.
 */
export function precedes(
  candidate: AnchorVersion,
  held: AnchorVersion,
): boolean {
  return candidate.epoch !== held.epoch
    ? candidate.epoch < held.epoch
    : candidate.version < held.version;
}

/** Why `locateQuote()` found no place for a quote. */
export type QuoteMiss = "empty" | "absent" | "repeated";

/**
 * Returns the start of the one occurrence of `quote` in `text`, compared code
 * unit for code unit, or why there is none: `"empty"` for an empty quote,
 * `"absent"` for one that occurs nowhere, `"repeated"` for one that occurs
 * more than once.
 */
export function locateQuote(text: string, quote: string): number | QuoteMiss {
  if (quote === "") return "empty";
  const from = text.indexOf(quote);
  if (from === -1) return "absent";
  if (text.indexOf(quote, from + 1) !== -1) return "repeated";
  return from;
}

/**
 * Returns where `position` sits after `changes`, which run in ascending order
 * without overlap against the text `position` indexes, as `applyChanges()`
 * takes them. `side` says which neighbor the position belongs to when text
 * is inserted exactly there: `1` keeps it after the insertion, `-1` before.
 * A position inside replaced text lands at the replacement's start with
 * `-1`, at its end with `1`; the start of replaced text lands at the start
 * either way, and its end at the end. This is `ChangeDesc.mapPos()` of
 * CodeMirror, stated over `TextChange` lists.
 */
export function mapPosition(
  position: number,
  side: 1 | -1,
  changes: readonly TextChange[],
): number {
  let shift = 0;
  for (const change of changes) {
    const from = change.from;
    const to = change.to ?? from;
    const inserted = change.insert?.length ?? 0;
    if (position < from) break;
    if (position === from) {
      if (from < to || side < 0) break;
      shift += inserted;
      continue;
    }
    if (position < to) return side < 0 ? from + shift : from + shift + inserted;
    shift += inserted - (to - from);
  }
  return position + shift;
}

/**
 * Returns `range` after `changes`, as an open editor maps a highlight: the
 * start belongs to the character after it and the end to the character
 * before it, so text inserted at either end stays outside the range, text
 * inserted inside it grows it, a deletion overlapping it shrinks it, and a
 * deletion covering it empties it. An empty range stays a point, before text
 * inserted at it. Returns `range` itself when nothing moved.
 */
export function mapAnchor(
  range: AnchorRange,
  changes: readonly TextChange[],
): AnchorRange {
  if (range.from === range.to) {
    const at = mapPosition(range.from, -1, changes);
    return at === range.from ? range : { from: at, to: at };
  }
  const from = mapPosition(range.from, 1, changes);
  const to = mapPosition(range.to, -1, changes);
  if (to <= from) {
    const at = mapPosition(range.from, -1, changes);
    return { from: at, to: at };
  }
  return from === range.from && to === range.to ? range : { from, to };
}

/** How many code points of a quote a row shows before cutting it short. */
export const EXCERPT_CODE_POINTS = 60;

/**
 * Returns `quote` as a row shows it: whitespace runs collapsed to one space,
 * trimmed, and cut to `EXCERPT_CODE_POINTS` code points with an ellipsis.
 */
export function excerptOf(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= EXCERPT_CODE_POINTS
    ? flat
    : points.slice(0, EXCERPT_CODE_POINTS).join("") + "…";
}
