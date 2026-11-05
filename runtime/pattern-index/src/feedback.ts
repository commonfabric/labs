/** Verdict vocabulary and event recording shared by index callers. */

import type {
  PatternIndexClient,
  PatternIndexRecordEventRequest,
} from "./client.ts";

/** What a person made of a pattern's result. */
export type PatternFeedbackVerdict = "up" | "down";

/** The two index events available to a person recording a verdict. */
export type PatternFeedbackEventType = "thumbs_up" | "thumbs_down";

/** The index event each verdict is recorded as. */
const FEEDBACK_EVENT_TYPES: Record<
  PatternFeedbackVerdict,
  PatternFeedbackEventType
> = {
  up: "thumbs_up",
  down: "thumbs_down",
};

/**
 * The index event a verdict records as, or `undefined` for a value naming no
 * verdict. A verdict is the whole of what feedback records, so one the index
 * has no event for is refused rather than guessed at — and every surface that
 * takes a verdict asks this rather than listing the words again.
 */
export const feedbackEventType = (
  verdict: unknown,
): PatternFeedbackEventType | undefined =>
  // `hasOwn` first: a plain object literal inherits `constructor` and the
  // rest of `Object.prototype`, so an unchecked lookup answers a function for
  // words that are not verdicts.
  typeof verdict === "string" && Object.hasOwn(FEEDBACK_EVENT_TYPES, verdict)
    ? FEEDBACK_EVENT_TYPES[verdict as PatternFeedbackVerdict]
    : undefined;

/** What an index that answered made of the event it was sent. */
export type RecordPatternFeedbackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Records one verdict against the pattern index and says what became of it.
 *
 * Awaited, unlike the usage events a run reports on its own: recording is
 * what the caller called for, so whether it landed is the result — including
 * a 2xx answer that says the event was not taken, which is the `ok: false`
 * case here.
 *
 * @throws PatternIndexError when the index faulted the call, and whatever the
 * transport raised when it could not be reached at all. Those are failures of
 * the call rather than answers to it, and each caller phrases its own message
 * from the type, so they are not flattened to a string here.
 */
export const recordPatternFeedback = async (
  client: PatternIndexClient,
  request: Omit<PatternIndexRecordEventRequest, "did" | "eventType"> & {
    eventType: PatternFeedbackEventType;
  },
): Promise<RecordPatternFeedbackResult> => {
  const answer = await client.recordEvent(request);
  return answer.ok === true ? { ok: true } : {
    ok: false,
    message:
      `the pattern index answered but did not record the ${request.eventType} event`,
  };
};
