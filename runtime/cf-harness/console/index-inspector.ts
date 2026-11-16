/**
 * What the Index view reads out of the index's answers: the orderings and the
 * derived labels its panes render. These are functions of their arguments
 * alone, so the pane that shows a pattern's standing and the test that pins it
 * are reading the same rule.
 */

import type {
  PatternIndexListedPattern,
  PatternIndexSearchResult,
} from "@commonfabric/pattern-index/client";

/** One event type and how many times it was recorded against a pattern. */
export interface PatternEventBadge {
  eventType: string;
  count: number;
}

/**
 * The patterns in the order the table shows them: by score, highest first, and
 * by identity within a score so a redraw of the same answer keeps the same
 * order. The index sorts its own answer; this makes the order the table's
 * property rather than a claim about what the deployment happened to send.
 */
export const patternsByScore = (
  patterns: readonly PatternIndexListedPattern[],
): readonly PatternIndexListedPattern[] =>
  [...patterns].sort((left, right) =>
    right.score - left.score || left.patternId.localeCompare(right.patternId)
  );

/**
 * Returns a pattern's event counts by type, in type order. Counts come from the
 * listing, which records how many of each type a pattern collected and not who
 * recorded them. Zero counts produce no badge.
 */
export const eventBadges = (
  events: Readonly<Record<string, number>> | undefined,
): readonly PatternEventBadge[] =>
  Object.entries(events ?? {})
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([eventType, count]) => ({ eventType, count }));

/**
 * Where a pattern stands in discovery, as one short line: its listing state,
 * the bucket it ranks in, and whether an admin hid it or the index
 * grandfathered it. `undefined` for an answer that carries none of these.
 */
export const listingLabel = (
  pattern: Pick<
    PatternIndexListedPattern,
    "listing" | "listed" | "bucket" | "hidden" | "grandfathered"
  >,
): string | undefined => {
  const parts = [
    pattern.listing,
    pattern.listed === undefined
      ? undefined
      : pattern.listed
      ? "listed"
      : "unlisted",
    pattern.bucket,
    pattern.grandfathered ? "grandfathered" : undefined,
    pattern.hidden ? "hidden" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
};

/**
 * How much of a text query a hit carries, as `matched/asked`. Text matching is
 * disjunctive, so a hit is not a claim that everything matched and the ratio is
 * what says how close; a search with no text query has no ratio to report.
 */
export const matchRatio = (
  result: PatternIndexSearchResult,
): string | undefined =>
  result.queryTerms === undefined || result.queryTerms === 0
    ? undefined
    : `${result.matchedTerms ?? 0}/${result.queryTerms}`;

/** The head of an identifier, for a column that copies the whole on a click. */
export const truncateId = (value: string, length = 10): string =>
  value.length <= length ? value : `${value.slice(0, length)}…`;

/**
 * A timestamp to the second, as the index wrote it. The instant is not shifted
 * into the reading machine's zone: the index records UTC, and an operator
 * comparing a row here against a log line elsewhere is comparing the recorded
 * instants.
 */
export const formatIndexTime = (ts: string | null | undefined): string =>
  ts === null || ts === undefined || ts === ""
    ? "—"
    : ts.slice(0, 19).replace("T", " ");

/**
 * The search request a tags box, a text box and a limit box compose. Every
 * empty box is left out rather than sent empty, so the request shown beside the
 * results is exactly what the index was asked.
 */
export const searchRequestOf = (
  tagText: string,
  text: string,
  limitText: string,
): { tags?: readonly string[]; text?: string; limit?: number } => {
  const tags = tagText.split(",").map((tag) => tag.trim()).filter((tag) =>
    tag !== ""
  );
  const trimmedText = text.trim();
  const limit = Number(limitText.trim());
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(trimmedText === "" ? {} : { text: trimmedText }),
    ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {}),
  };
};
