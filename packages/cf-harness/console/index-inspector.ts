/**
 * What the Index view reads out of the index's answers: the orderings, the
 * filter and the derived labels the three panes render. These are functions of
 * their arguments alone, so the pane that shows a pattern's standing and the
 * test that pins it are reading the same rule.
 */

import type {
  PatternIndexEvent,
  PatternIndexListedPattern,
  PatternIndexSearchResult,
} from "../src/pattern-index/client.ts";

/** One event type counted against a pattern, attributed where known. */
export interface PatternEventBadge {
  eventType: string;
  count: number;

  /** Author DID; absent for the portion the index leaves unattributed. */
  did?: string;
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
 * Returns a pattern's event counts by type and author, with any unattributed
 * remainder kept separate. Counts come from the listing, never the bounded,
 * caller-scoped event stream. Zero counts produce no badge.
 */
export const eventBadges = (
  events: Readonly<Record<string, number>> | undefined,
  eventAuthors: PatternIndexListedPattern["eventAuthors"] = {},
): readonly PatternEventBadge[] =>
  Object.entries(events ?? {})
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([eventType, count]) => {
      const authors = Object.entries(eventAuthors[eventType] ?? {})
        .filter(([did, count]) => did !== "" && count > 0)
        .sort(([left], [right]) => left.localeCompare(right));
      const attributed = authors.reduce((sum, [, count]) => sum + count, 0);
      // An inconsistent breakdown cannot attribute the total reliably.
      if (attributed > count) return [{ eventType, count }];
      return [
        ...authors.map(([did, count]) => ({ eventType, count, did })),
        ...(attributed < count
          ? [{ eventType, count: count - attributed }]
          : []),
      ];
    });

/**
 * The events a filter box leaves showing. The needle is matched against every
 * field of an event rather than one chosen column, because the stream is read
 * to answer "what happened to this pattern" and "what did I do at 11:04" with
 * the same box. An empty needle filters nothing.
 */
export const filterEvents = (
  events: readonly PatternIndexEvent[],
  needle: string,
): readonly PatternIndexEvent[] => {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") {
    return events;
  }
  return events.filter((event) =>
    [event.patternId, event.did, event.eventType, event.ts ?? "", event.note]
      .some((field) => (field ?? "").toLowerCase().includes(wanted))
  );
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
