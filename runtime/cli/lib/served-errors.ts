/**
 * Errors thrown by served handler runs, for `cf test` on the server-execution
 * arm. There the test's runtime runs a handler speculatively and a serving
 * runtime runs it for real, and the serving runtime has no error handler of
 * the test's. A served run that throws reaches the test's runtime only as an
 * `errored` outcome of the event that fired it, which this module turns into
 * a runtime error of the test. It covers the events the test's runtime fired:
 * an event a served handler fires on its own account is no event of the
 * test's runtime, and has no outcome there.
 */

import type { Runtime } from "@commonfabric/runner";

/** Prefix that marks a runtime error as a served run's. */
export const SERVED_ERROR_PREFIX = "[served] ";

/** An error as `servedRuntimeErrors()` pairs it: its event and its text. */
export interface EventError {
  /** The event whose handling threw, if the error is a handler's. */
  readonly eventId?: string;

  /** The error's message. */
  readonly message: string;
}

/**
 * Records the error of every `errored` outcome `runtime` hears, for as long
 * as `runtime` lives, and returns the list they are recorded in. On the arm
 * without server execution the runtime has no outcomes, and the list stays
 * empty.
 */
export function collectServedErrors(runtime: Runtime): EventError[] {
  const errors: EventError[] = [];
  runtime.subscribeEventIntentOutcomes((outcome) => {
    if (outcome.kind === "errored") {
      errors.push({ eventId: outcome.eventId, message: outcome.reason });
    }
  });
  return errors;
}

/**
 * Returns the runtime errors to report for `served` errors beside the `local`
 * ones the test's runtime recorded, each marked with
 * {@link SERVED_ERROR_PREFIX}. A served error is left out when a local error
 * of the same event has the same text, since that is the event's speculative
 * run having thrown it too; one local error answers for one served error, so
 * each throw is reported once whichever run saw it. A local error of another
 * event, or of none, answers for nothing here, whatever its text.
 */
export function servedRuntimeErrors(
  served: readonly EventError[],
  local: readonly EventError[],
): string[] {
  const unmatched = new Map<string, number>();
  const keyOf = (eventId: string, message: string) =>
    JSON.stringify([eventId, message]);
  for (const { eventId, message } of local) {
    if (eventId === undefined) continue;
    const key = keyOf(eventId, message);
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const result: string[] = [];
  for (const { eventId, message } of served) {
    const key = eventId === undefined ? undefined : keyOf(eventId, message);
    const count = key === undefined ? 0 : unmatched.get(key) ?? 0;
    if (key !== undefined && count > 0) unmatched.set(key, count - 1);
    else result.push(`${SERVED_ERROR_PREFIX}${message}`);
  }
  return result;
}
