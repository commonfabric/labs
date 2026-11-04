/**
 * The bound on how many times a model client issues one exchange, and the
 * backoff between issues.
 *
 * A model exchange has no side effect until the harness dispatches a tool
 * call from its result, and a client returns nothing until an attempt
 * completes, so issuing a failed attempt again is safe. What makes it worth
 * doing is that the failure was transient — a transport error, a 429 or 5xx
 * status, or a provider-stated overload — and what keeps it from becoming an
 * unbounded loop is this schedule. Every attempt, retried or not, is recorded
 * where the client records attempts, and an attempt that is followed by
 * another says so and says why.
 */

/**
 * Which kind of transient failure an attempt ended in: the request never got
 * a response, the response carried a 429 or 5xx status, or the provider
 * answered and then stated a transient error of its own.
 */
export type HarnessTransientFailureKind =
  | "transport_error"
  | "http_status"
  | "provider_error";

/**
 * What an attempt record carries when the attempt failed transiently and the
 * client issues another: the kind of failure, and the backoff before the next
 * attempt starts.
 */
export interface HarnessModelAttemptRetry {
  /** Which transient failure the attempt ended in. */
  kind: HarnessTransientFailureKind;

  /** Milliseconds waited before the next attempt. */
  delayMs: number;
}

/**
 * Waits out a backoff, rejecting with the signal's reason if it aborts first.
 * Production waits on a timer; a test injects one that records the delay it
 * was asked for and resolves at once, which is what keeps a retry test off the
 * wall clock.
 */
export type HarnessTransportRetryDelay = (
  ms: number,
  signal?: AbortSignal,
) => Promise<void>;

/** The retry controls a model client accepts. */
export interface HarnessTransportRetryOptions {
  /**
   * Attempts beyond the first. `0` issues each exchange once. Defaults to
   * `DEFAULT_TRANSPORT_RETRIES`.
   */
  transportRetries?: number;

  /**
   * Backoff before the second attempt, doubling before each attempt after
   * it. Defaults to `DEFAULT_TRANSPORT_RETRY_DELAY_MS`.
   */
  transportRetryDelayMs?: number;

  /** How a backoff is waited out. Defaults to `abortableDelay`. */
  transportRetryDelay?: HarnessTransportRetryDelay;
}

/** Attempts beyond the first, unless a client is configured otherwise. */
export const DEFAULT_TRANSPORT_RETRIES = 3;

/** Backoff before the second attempt, unless configured otherwise. */
export const DEFAULT_TRANSPORT_RETRY_DELAY_MS = 1_000;

const nonNegativeIntegerOrDefault = (
  input: number | undefined,
  fallback: number,
): number =>
  input !== undefined && Number.isInteger(input) && input >= 0
    ? input
    : fallback;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("transport retry aborted", "AbortError");

/**
 * Waits `ms` milliseconds on a timer, rejecting with the signal's reason as
 * soon as it aborts. A wait of zero or less resolves without arming a timer.
 */
export const abortableDelay: HarnessTransportRetryDelay = (ms, signal) => {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (ms <= 0) return Promise.resolve();
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * The attempts one exchange may take and the backoff between them. Attempts
 * are numbered from 1; the schedule says whether attempt `n` failing with a
 * given kind of failure is followed by attempt `n + 1`, and how long to wait
 * before it.
 */
export class TransportRetrySchedule {
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #delay: HarnessTransportRetryDelay;

  /** Constructs an instance from a client's retry options. */
  constructor(options: HarnessTransportRetryOptions = {}) {
    this.#maxAttempts = 1 + nonNegativeIntegerOrDefault(
      options.transportRetries,
      DEFAULT_TRANSPORT_RETRIES,
    );
    this.#baseDelayMs = nonNegativeIntegerOrDefault(
      options.transportRetryDelayMs,
      DEFAULT_TRANSPORT_RETRY_DELAY_MS,
    );
    this.#delay = options.transportRetryDelay ?? abortableDelay;
  }

  /** How many attempts one exchange may take, the first included. */
  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /**
   * Milliseconds of backoff before `attempt` starts: none before the first,
   * the base delay before the second, and double the previous backoff before
   * each attempt after that.
   */
  delayMsBefore(attempt: number): number {
    return attempt <= 1 ? 0 : this.#baseDelayMs * 2 ** (attempt - 2);
  }

  /**
   * The retry that follows `attempt` failing with `kind`, for its attempt
   * record, or `undefined` when nothing follows it: the failure was not
   * transient, or the attempt was the last the schedule allows.
   */
  retryAfter(
    attempt: number,
    kind: HarnessTransientFailureKind | undefined,
  ): HarnessModelAttemptRetry | undefined {
    if (kind === undefined || attempt >= this.#maxAttempts) return undefined;
    return { kind, delayMs: this.delayMsBefore(attempt + 1) };
  }

  /**
   * Waits out the backoff before `attempt`, rejecting with the signal's
   * reason if it aborts first.
   */
  async waitBefore(attempt: number, signal?: AbortSignal): Promise<void> {
    await this.#delay(this.delayMsBefore(attempt), signal);
  }
}
