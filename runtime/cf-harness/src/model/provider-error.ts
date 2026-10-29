/**
 * The reason a provider gives for a failed exchange, in the provider's own
 * vocabulary, and whether that reason is transient. Every model client
 * reports a provider's stated failure in this one shape — whether it arrived
 * as an in-stream `error` event, a failed terminal response, or the body of a
 * non-2xx response — so an operator reading an attempt record or a failure
 * message sees the provider's type, code, and message wherever the failure
 * surfaced, and the retry decision keys off the same fields everywhere.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** A provider's stated reason for a failed exchange. */
export interface HarnessProviderError {
  /** Provider error class, such as `service_unavailable_error`. */
  type?: string;

  /** Provider error code, such as `server_is_overloaded`. */
  code?: string;

  /** The provider's own message. */
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Reads a provider error out of a payload that carries one. The fields are
 * read from the payload's `error` object when it has one, which is how the
 * OpenAI Responses `error` event, its failed terminal `response`, and its
 * non-2xx bodies are all shaped; otherwise from the payload itself, where a
 * `type` of `error` is the event's type rather than the error's and is left
 * out. Returns `undefined` for a payload that states no message, since an
 * error without one tells an operator nothing the status or event type did
 * not already.
 */
export const providerErrorFromPayload = (
  payload: unknown,
): HarnessProviderError | undefined => {
  if (!isRecord(payload)) return undefined;
  const nested = isRecord(payload.error);
  const source = nested ? payload.error as Record<string, unknown> : payload;
  const message = nonEmptyString(source.message);
  if (message === undefined) return undefined;
  const rawType = nonEmptyString(source.type);
  const type = !nested && rawType === "error" ? undefined : rawType;
  const code = nonEmptyString(source.code);
  return {
    ...(type !== undefined ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    message,
  };
};

/**
 * Like `providerErrorFromPayload()`, except the payload arrives as text that
 * may or may not be JSON. Text that is not a JSON object carries no provider
 * error, whatever it says.
 */
export const providerErrorFromJsonText = (
  text: string,
): HarnessProviderError | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return providerErrorFromPayload(parsed);
};

/**
 * Renders a provider error for a failure message: the type and code, when
 * present, ahead of the message, so `service_unavailable_error /
 * server_is_overloaded: Our servers are currently overloaded` reads as the
 * provider said it.
 */
export const describeProviderError = (error: HarnessProviderError): string => {
  const classification = [error.type, error.code].filter((part) =>
    part !== undefined
  ).join(" / ");
  return classification.length > 0
    ? `${classification}: ${error.message}`
    : error.message;
};

/**
 * Applies `redact` to every field of a provider error. A provider's message
 * is its own prose, and a client that redacts credential values from
 * everything it records applies the same redaction here.
 */
export const mapProviderError = (
  error: HarnessProviderError,
  redact: (text: string) => string,
): HarnessProviderError => ({
  ...(error.type !== undefined ? { type: redact(error.type) } : {}),
  ...(error.code !== undefined ? { code: redact(error.code) } : {}),
  message: redact(error.message),
});

/**
 * Error types a provider states for a failure that waiting alone can clear:
 * capacity, rate limiting, and its own internal faults.
 */
const TRANSIENT_PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "rate_limit_error",
  "server_error",
  "service_unavailable_error",
  "timeout_error",
]);

/** Error codes a provider states for the same transient failures. */
const TRANSIENT_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  "overloaded",
  "rate_limit_exceeded",
  "server_error",
  "server_is_overloaded",
  "service_unavailable",
  "timeout",
]);

/**
 * Whether a provider-stated error is one waiting alone can clear. The
 * decision rests on the provider's type or code alone: a message is prose,
 * and an error stating neither field is not transient, whatever it says.
 */
export const isTransientProviderError = (
  error: HarnessProviderError,
): boolean =>
  (error.type !== undefined &&
    TRANSIENT_PROVIDER_ERROR_TYPES.has(error.type)) ||
  (error.code !== undefined && TRANSIENT_PROVIDER_ERROR_CODES.has(error.code));

/**
 * Whether an HTTP status is one waiting alone can clear: rate limiting, and
 * every server-side status. A 4xx other than 429 states that the request
 * itself is refused, and issuing it again cannot change that.
 */
export const isTransientHttpStatus = (status: number): boolean =>
  status === 429 || status >= 500;
