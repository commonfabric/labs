/** Search request composition and safe status mapping for index callers. */

import { PatternIndexError, type PatternIndexSearchRequest } from "./client.ts";

/** Rebuilds a search from declared fields, omitting all other caller input. */
export const patternIndexSearchRequest = (
  body: Readonly<Record<string, unknown>>,
): PatternIndexSearchRequest => {
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    ...(tags !== undefined ? { tags } : {}),
    ...(typeof body.text === "string" ? { text: body.text } : {}),
    ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
  };
};

/** A refusal whose message can safely cross a frontend boundary. */
export type PatternIndexFailure = {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
};

/** Maps index failures to frontend statuses while withholding response detail. */
export const patternIndexFailure = (
  error: unknown,
): PatternIndexFailure | undefined => {
  if (!(error instanceof PatternIndexError)) return undefined;
  return {
    ok: false,
    status: error.status >= 400 && error.status < 500 ? error.status : 502,
    error: error.message,
  };
};
