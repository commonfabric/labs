import * as HttpStatusCodes from "stoker/http-status-codes";
import {
  AISDKError,
  APICallError,
  InvalidArgumentError,
  InvalidDataContentError,
  InvalidMessageRoleError,
  InvalidPromptError,
  InvalidToolInputError,
  MessageConversionError,
  RetryError,
  UnsupportedFunctionalityError,
} from "ai";

/**
 * The caller asked for something this service does not offer, or for a
 * combination it cannot serve. The caller has to change the request for it to
 * succeed.
 */
export class LLMRequestError extends Error {
  override readonly name = "LLMRequestError";
}

/**
 * A service these routes call failed: a model provider, or the annotation
 * service behind the feedback route. `upstreamStatus` is the HTTP status that
 * service answered with, where it answered at all.
 */
export class LLMUpstreamError extends Error {
  override readonly name = "LLMUpstreamError";
  readonly upstreamStatus: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; upstreamStatus?: number },
  ) {
    super(message, options);
    this.upstreamStatus = options?.upstreamStatus;
  }
}

/**
 * Digs the HTTP status out of a failure a provider call reported. A retried
 * call reports the attempts wrapped in a `RetryError`, which carries no status
 * of its own, so the wrapper and any chain of causes are opened up to reach
 * the call that carries one.
 */
export function upstreamStatusOf(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (APICallError.isInstance(current)) {
      return current.statusCode;
    }
    if (RetryError.isInstance(current)) {
      current = current.lastError;
      continue;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The AI SDK errors raised over what the caller sent, before any provider was
 * asked. They name a message, a content part, a tool definition or a setting
 * that this service built the request out of.
 */
function isRequestSideSdkError(error: unknown): boolean {
  return InvalidPromptError.isInstance(error) ||
    InvalidDataContentError.isInstance(error) ||
    InvalidMessageRoleError.isInstance(error) ||
    MessageConversionError.isInstance(error) ||
    InvalidArgumentError.isInstance(error) ||
    InvalidToolInputError.isInstance(error) ||
    UnsupportedFunctionalityError.isInstance(error);
}

// Anthropic answers 529 when a model is overloaded. It is not a registered
// status, and it means what 503 means.
const PROVIDER_OVERLOADED = 529;

export type LLMErrorStatus =
  | typeof HttpStatusCodes.BAD_REQUEST
  | typeof HttpStatusCodes.TOO_MANY_REQUESTS
  | typeof HttpStatusCodes.INTERNAL_SERVER_ERROR
  | typeof HttpStatusCodes.BAD_GATEWAY
  | typeof HttpStatusCodes.SERVICE_UNAVAILABLE
  | typeof HttpStatusCodes.GATEWAY_TIMEOUT;

function statusForUpstream(upstreamStatus: number | undefined): LLMErrorStatus {
  // The service never answered, or answered in a way that carried no status:
  // a connection that failed, a response that could not be read.
  if (upstreamStatus === undefined) {
    return HttpStatusCodes.BAD_GATEWAY;
  }
  // The service is asking for the request to be made again later, and waiting
  // is the caller's to do, so these reach the caller as themselves.
  if (upstreamStatus === HttpStatusCodes.TOO_MANY_REQUESTS) {
    return HttpStatusCodes.TOO_MANY_REQUESTS;
  }
  if (
    upstreamStatus === HttpStatusCodes.SERVICE_UNAVAILABLE ||
    upstreamStatus === PROVIDER_OVERLOADED
  ) {
    return HttpStatusCodes.SERVICE_UNAVAILABLE;
  }
  // The exchange with the service ran out of time.
  if (upstreamStatus === HttpStatusCodes.REQUEST_TIMEOUT) {
    return HttpStatusCodes.GATEWAY_TIMEOUT;
  }
  // A 5xx is the service breaking on a request it accepted.
  if (upstreamStatus >= 500) {
    return HttpStatusCodes.BAD_GATEWAY;
  }
  // Any other 4xx says the request this service sent was wrong. Where it was
  // wrong in what it carried, the caller wrote that: a prompt past the context
  // window, a schema the model will not accept.
  if (
    upstreamStatus === HttpStatusCodes.BAD_REQUEST ||
    upstreamStatus === HttpStatusCodes.REQUEST_TOO_LONG ||
    upstreamStatus === HttpStatusCodes.UNPROCESSABLE_ENTITY
  ) {
    return HttpStatusCodes.BAD_REQUEST;
  }
  // Where it was wrong in any other way — a key the service rejected, an
  // account it will not bill, a model named here that it does not carry — this
  // service is the one that has to change, and the caller can only report it.
  return HttpStatusCodes.INTERNAL_SERVER_ERROR;
}

/**
 * The status to answer a failed generation with. A caller distinguishes a
 * request it should change from one it should repeat later from one it can do
 * nothing about, and only the status tells it which it has.
 */
export function httpStatusForError(error: unknown): LLMErrorStatus {
  if (error instanceof LLMRequestError || isRequestSideSdkError(error)) {
    return HttpStatusCodes.BAD_REQUEST;
  }
  if (error instanceof LLMUpstreamError) {
    return statusForUpstream(error.upstreamStatus);
  }
  const upstreamStatus = upstreamStatusOf(error);
  if (upstreamStatus !== undefined) {
    return statusForUpstream(upstreamStatus);
  }
  // The provider was asked and what came back could not be used: a response
  // that failed to parse, a stream that broke its own protocol, an object that
  // never satisfied the schema.
  if (AISDKError.isInstance(error)) {
    return HttpStatusCodes.BAD_GATEWAY;
  }
  return HttpStatusCodes.INTERNAL_SERVER_ERROR;
}
