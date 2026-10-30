/**
 * Where a comment's anchor sits in the body now. The stored range is trusted
 * while the body still holds the quote there; otherwise the quote is looked
 * for, and found only where it occurs once. These are pure functions over
 * strings, so the pattern's computeds, its verbs, and their tests share one
 * definition of "found".
 */

/** A range of the body, `from` inclusive and `to` exclusive. */
export interface AnchorRange {
  from: number;
  to: number;
}

/** What an anchor stores: the range, and the text it was placed over. */
export interface AnchorLike extends AnchorRange {
  quote: string;
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
 * Returns the range of `text` the anchor names: its stored range while that
 * still holds the quote, else the one place the quote occurs, else `null`,
 * for a quote the body has lost or holds more than once.
 */
export function resolveAnchor(
  text: string,
  anchor: AnchorLike,
): AnchorRange | null {
  const { from, to, quote } = anchor;
  if (quote !== "" && text.slice(from, to) === quote) return { from, to };
  const at = locateQuote(text, quote);
  return typeof at === "number" ? { from: at, to: at + quote.length } : null;
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
